// Cloud (GitHub Actions) variant of the Bybit red-light monitor (multi-provider).
// Cadence is controlled by the workflow cron; state persists via actions/cache.
// Alerts go to ntfy.sh only (topic from NTFY_TOPIC env). Providers/rules in config.json.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const news = require('./news.js');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_FILE = path.join(DIR, 'state.json');
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_SERVER = 'https://ntfy.sh';

const nowMs = () => Date.now();
const hours = (h) => h * 3600 * 1000;
const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function fetchBybit() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(DIR, 'fetch_bybit.js')], { timeout: 150000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error('fetch_bybit failed: ' + (stderr || err.message).slice(0, 300)));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('bad JSON from fetch_bybit')); }
      });
  });
}

function notifyPhone(title, msg, priority) {
  return new Promise((resolve) => {
    if (!NTFY_TOPIC) { log({ warn: 'NTFY_TOPIC not set, alert not sent', title }); return resolve(); }
    const req = https.request(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: Buffer.from('[雲端] ' + title).toString('base64'),
        'X-Title-Encoding': 'base64',
        Priority: priority || 'high',
        Tags: 'cloud,rotating_light',
      },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(msg);
  });
}

async function alert(state, key, title, msg, cooldownH) {
  const cd = hours(cooldownH ?? CFG.rules.cooldownHours);
  const last = state.alerts?.[key] || 0;
  if (nowMs() - last < cd) { log({ suppressed: key }); return; }
  state.alerts = state.alerts || {};
  state.alerts[key] = nowMs();
  await notifyPhone(title, msg);
  log({ alert: key, title, msg });
}

async function getGold() {
  const j = await httpsGetJson('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=1d');
  const r = j.chart.result[0];
  const opens = r.indicators.quote[0].open.filter((x) => x != null);
  const last = r.meta.regularMarketPrice;
  const lastTs = r.meta.regularMarketTime * 1000;
  return {
    last,
    movePct: ((last - opens[0]) / opens[0]) * 100,
    stale: nowMs() - lastTs > 90 * 60 * 1000,
  };
}

// The public open-position API returns no open timestamp, so position age is
// derived from when this monitor first observed each position. Ages are exact
// only when the previous run was recent enough to have witnessed the opening.
function trackPositionAges(state, name, openList, prevRunMs) {
  state.seenPositions = state.seenPositions || {};
  const seen = state.seenPositions;
  const continuous = prevRunMs && nowMs() - prevRunMs < 20 * 60 * 1000;
  const live = new Set();
  const dup = {};

  for (const p of openList) {
    // positionValueE8 is size x current market price, so it moves every tick and
    // must stay out of the identity key. entryPrice is fixed for a position;
    // a counter disambiguates two positions opened at the same price.
    const base = [name, p.symbol, p.side, p.entryPrice].join('|');
    const key = base + '#' + (dup[base] = (dup[base] || 0) + 1);
    live.add(key);
    if (!seen[key]) seen[key] = { firstSeen: nowMs(), exact: !!continuous };
    p._ageMin = Math.round((nowMs() - seen[key].firstSeen) / 60000);
    p._ageExact = seen[key].exact;
  }
  for (const key of Object.keys(seen)) {
    if (key.startsWith(name + '|') && !live.has(key)) delete seen[key];
  }
}

// A sharp move against his open direction is how unscheduled news actually
// reaches us: the price reacts before any headline is readable.
async function checkAdverseSpike(state, name, openList, spike, R) {
  if (!spike || !openList.length) return;
  const net = news.netDirection(openList);
  if (!net) return;
  const adverse = net > 0 ? -spike.moveUsd : spike.moveUsd;
  if (adverse < R.spikeUsd) return;

  const dir = net > 0 ? '\u505a\u591a' : '\u505a\u7a7a';
  const float = openList.reduce((a, p) => a + (+p.profitE8 || 0) / 1e8, 0);
  const heads = await news.topHeadlines(2);
  const headTxt = heads.length ? `\n\u53ef\u80fd\u76f8\u95dc\uff1a${heads.join(' / ')}` : '';
  await alert(state, name + ':spike', '\ud83d\udd34 \u7d05\u71c8\uff1a\u6025\u5674\u65b9\u5411\u8207\u4ed6\u76f8\u53cd',
    `${name} \u76ee\u524d${dir}\uff08${openList.length} \u7b46\uff09\uff0c\u4f46\u9ec3\u91d1 ${spike.windowMin} \u5206\u9418\u5167${spike.moveUsd > 0 ? '\u6025\u6f32' : '\u6025\u8dcc'} $${Math.abs(spike.moveUsd).toFixed(1)}/oz \u5230 ${spike.last.toFixed(0)}\uff0c\u9006\u8457\u4ed6\u7684\u90e8\u4f4d\u3002` +
    `\u76ee\u524d\u6d6e\u52d5 ${float >= 0 ? '+' : ''}${float.toFixed(0)} USD\u3002\u7121\u505c\u640d\u4e0b\u9019\u7a2e\u884c\u60c5\u6700\u5371\u96aa\u3002${headTxt}`,
    (R.spikeCooldownMin || 30) / 60);
}

async function checkProvider(state, name, data, R, gold) {
  const openList = data.open.result.openPositionList || [];
  const hist = data.hist.result.historyPositionList || [];
  const assets = +(data.info.result.totalAssetsE8 || 0) / 1e8;

  if (openList.length && assets > 0) {
    const totalFloat = openList.reduce((a, p) => a + (+p.profitE8 || 0) / 1e8, 0);
    const floatPct = (totalFloat / assets) * 100;
    if (floatPct <= -R.floatCritPct) {
      await alert(state, name + ':float-crit', '🔴 紅燈:浮虧達 20%,該下車了',
        `${name}:未實現虧損 ${totalFloat.toFixed(0)} USD = 他權益的 ${(-floatPct).toFixed(0)}%(${openList.length} 筆持倉)。無停損策略下這只會更深 — 這是下車點。`, 1);
    } else if (floatPct <= -R.floatWarnPct) {
      await alert(state, name + ':float-warn', '🟡 黃燈:浮虧達 10%,該減碼了',
        `${name}:未實現虧損 ${totalFloat.toFixed(0)} USD = 他權益的 ${(-floatPct).toFixed(0)}%(${openList.length} 筆持倉)。你說過這時要減碼 — 現在部位還只是小虧,動手比等便宜。`, 1);
    }
  }

  if (openList.length) {
    const byDir = {};
    for (const p of openList) (byDir[p.side] = byDir[p.side] || []).push(p);
    for (const [side, ps] of Object.entries(byDir)) {
      const ageMin = Math.max(...ps.map((p) => p._ageMin));
      const ageExact = ps.some((p) => p._ageMin === ageMin && p._ageExact);
      const agePrefix = ageExact ? '' : '≥';
      const avgEntry = ps.reduce((a, p) => a + +p.entryPrice, 0) / ps.length;
      const float = ps.reduce((a, p) => a + (+p.profitE8 || 0) / 1e8, 0);
      // Only a losing stack is the blow-up pattern; a winning stack is just a good day.
      if (ps.length >= R.stackMinPositions && ageMin >= R.stackMinOldestAgeMin && float < 0) {
        await alert(state, name + ':stack-' + side, '🔴 紅燈:他在堆疊扛單',
          `${name}:${ps.length} 筆同向 ${side} 堆疊,最老倉齡 ${agePrefix}${ageMin} 分鐘,均價 ${avgEntry.toFixed(1)},浮虧 ${float.toFixed(0)} USD。爆倉前的型態,考慮撤退。`);
      }
    }
  }

  // Requires open positions: silence with nothing open means he stopped trading
  // (or blew up), not that he is sitting on losses.
  if (openList.length && gold && !gold.stale && Math.abs(gold.movePct) >= R.goldTrendPct && hist.length) {
    const silentMin = Math.round((nowMs() - Date.parse(hist[0].closeTime.replace(' ', 'T') + 'Z')) / 60000);
    if (silentMin >= R.silentMinutes) {
      await alert(state, name + ':silent-trend', '🔴 紅燈:單邊行情+他消失了',
        `${name}:黃金今天 ${gold.movePct >= 0 ? '+' : ''}${gold.movePct.toFixed(1)}%(GC=F ${gold.last.toFixed(0)}),而他已 ${Math.floor(silentMin / 60)} 小時 ${silentMin % 60} 分沒有平倉紀錄 = 大概率在扛浮虧。`);
    }
  }

  try {
    const lines = {};
    for (const l of data.trend.result.metricList) lines[l.line] = l.metricLineValue;
    const cum = lines.cumRoe, daily = lines.dailyRoe;
    if (cum && cum.length >= 2 && daily && daily.length) {
      const c1 = +cum[cum.length - 1].value, c0 = +cum[cum.length - 2].value;
      const d1 = +daily[daily.length - 1].value;
      const dayMs = +daily[daily.length - 1].statisticDateE3;
      const dayKey = new Date(dayMs).toISOString().slice(0, 10);
      // A dormant/blown-up account keeps reporting its last bad day forever.
      const staleDay = nowMs() - dayMs > 48 * 3600 * 1000;
      const dropPct = (c1 - c0) / 100;
      if (staleDay) {
        log({ skipStaleDay: name, dayKey, dailyRoePct: d1 / 100 });
      } else if (d1 <= -1000) {
        await alert(state, name + ':blowup-' + dayKey, '🔴 已爆:單日虧損超過 10%',
          `${name}:今天已實現 ${(d1 / 100).toFixed(1)}%。這是離場點,不是攤平點。`, 48);
      } else if (d1 >= 0 && dropPct <= -R.divergenceDropPct) {
        await alert(state, name + ':divergence-' + dayKey, '🟡 黃燈:浮虧扛單背離',
          `${name}:已實現當日 +${(d1 / 100).toFixed(1)}% 但權益掉 ${dropPct.toFixed(1)}% = 檯面下在扛浮虧。建議 48 小時內減倉或下車。`, 48);
      }
    }
  } catch (e) { log({ trendError: e.message, provider: name }); }

  return { open: openList.length, lastClose: hist[0]?.closeTime || null };
}

(async () => {
  if (process.env.TEST_ALERT === '1') {
    await notifyPhone('✅ 測試通知', '這則來自 GitHub Actions runner。看到它 = 雲端推播路徑正常,Mac 關機也收得到警報。', 'default');
    log({ testAlert: 'sent' });
    process.exit(0);
  }

  const state = loadState();
  let bybit;
  try {
    bybit = await fetchBybit();
    state.failCount = 0;
  } catch (e) {
    state.failCount = (state.failCount || 0) + 1;
    log({ fetchError: e.message, failCount: state.failCount });
    if (state.failCount >= CFG.rules.failAlertAfter) {
      await alert(state, 'blind', '⚠️ 雲端監控失明',
        `GitHub Actions 連續 ${state.failCount} 次抓不到 Bybit 資料(可能被 Akamai 擋雲端 IP)。本機監控不受影響。`,
        CFG.rules.failCooldownHours);
    }
    saveState(state);
    process.exit(0);
  }

  let gold = null;
  try { gold = await getGold(); } catch (e) { log({ goldError: e.message }); }

  const prevRunMs = state.lastRunMs || 0;
  state.lastRunMs = nowMs();

  try {
    const events = await news.fetchCalendar(state, CFG.rules.calendarCacheMin);
    await news.checkCalendar(state, events, CFG.rules, alert, log);
  } catch (e) { log({ calendarError: e.message }); }

  const summary = {};
  for (const p of CFG.providers) {
    const data = bybit.providers[p.name];
    if (!data) { log({ missingProvider: p.name }); continue; }
    const R = { ...CFG.rules, ...(p.rules || {}) };
    const ol = data.open.result.openPositionList || [];
    trackPositionAges(state, p.name, ol, prevRunMs);
    news.recordPrice(state, ol, CFG.rules.spikeWindowMin || 10);
    await checkAdverseSpike(state, p.name, ol,
      news.getSpikeFromHistory(state, CFG.rules.spikeWindowMin || 10), R);
    summary[p.name] = await checkProvider(state, p.name, data, R, gold);
  }

  log({
    ok: true,
    providers: summary,
    gold: gold ? { last: gold.last, movePct: +gold.movePct.toFixed(2), stale: gold.stale } : null,
  });
  saveState(state);
})();
