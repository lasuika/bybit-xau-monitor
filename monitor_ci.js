// Cloud (GitHub Actions) variant of the Bybit red-light monitor.
// Cadence is controlled by the workflow cron; state persists via actions/cache.
// Alerts go to ntfy.sh only (topic from NTFY_TOPIC env).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'state.json');
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_SERVER = 'https://ntfy.sh';
const PROVIDER_NAME = 'XAUUSDx SECURE TRADER';
const GC_SPOT_OFFSET = 75;
const R = {
  stackMinPositions: 3,
  stackMinOldestAgeMin: 30,
  goldTrendPct: 1.5,
  silentMinutes: 120,
  divergenceDropPct: 2.0,
  cooldownHours: 2,
  failAlertAfter: 3,
  failCooldownHours: 6,
};

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
    execFile(process.execPath, [path.join(DIR, 'fetch_bybit.js')], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
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
  const cd = hours(cooldownH ?? R.cooldownHours);
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
    if (state.failCount >= R.failAlertAfter) {
      await alert(state, 'blind', '⚠️ 雲端監控失明',
        `GitHub Actions 連續 ${state.failCount} 次抓不到 Bybit 資料(可能被 Akamai 擋雲端 IP)。本機監控不受影響。`,
        R.failCooldownHours);
    }
    saveState(state);
    process.exit(0);
  }

  let gold = null;
  try { gold = await getGold(); } catch (e) { log({ goldError: e.message }); }

  const openList = bybit.open.result.openPositionList || [];
  const hist = bybit.hist.result.historyPositionList || [];

  if (openList.length) {
    const byDir = {};
    for (const p of openList) (byDir[p.side] = byDir[p.side] || []).push(p);
    for (const [side, ps] of Object.entries(byDir)) {
      const oldestMs = Math.min(...ps.map((p) => Date.parse(p.openTime.replace(' ', 'T') + 'Z')));
      const ageMin = Math.round((nowMs() - oldestMs) / 60000);
      const entries = ps.map((p) => +p.entryPrice);
      const avgEntry = entries.reduce((a, b) => a + b, 0) / entries.length;
      let floatTxt = '';
      if (gold) {
        const perOz = (side === 'Buy' ? 1 : -1) * (gold.last - GC_SPOT_OFFSET - avgEntry);
        floatTxt = `,估計浮動 ${perOz >= 0 ? '+' : ''}${perOz.toFixed(0)}$/oz(約略)`;
      }
      if (ps.length >= R.stackMinPositions && ageMin >= R.stackMinOldestAgeMin) {
        await alert(state, 'stack-' + side, '🔴 紅燈:他在堆疊扛單',
          `${PROVIDER_NAME}:${ps.length} 筆同向 ${side} 堆疊中,最老倉齡 ${ageMin} 分鐘,均價 ${avgEntry.toFixed(1)}${floatTxt}。這是 8/5 爆倉前的型態,考慮撤退。`);
      }
    }
  }

  if (gold && !gold.stale && Math.abs(gold.movePct) >= R.goldTrendPct && hist.length) {
    const silentMin = Math.round((nowMs() - Date.parse(hist[0].closeTime.replace(' ', 'T') + 'Z')) / 60000);
    if (silentMin >= R.silentMinutes) {
      await alert(state, 'silent-trend', '🔴 紅燈:單邊行情+他消失了',
        `黃金今天 ${gold.movePct >= 0 ? '+' : ''}${gold.movePct.toFixed(1)}%(GC=F ${gold.last.toFixed(0)}),而他已 ${Math.floor(silentMin / 60)} 小時 ${silentMin % 60} 分沒有平倉紀錄 = 大概率在扛浮虧。`);
    }
  }

  try {
    const lines = {};
    for (const l of bybit.trend.result.metricList) lines[l.line] = l.metricLineValue;
    const cum = lines.cumRoe, daily = lines.dailyRoe;
    if (cum && cum.length >= 2 && daily) {
      const c1 = +cum[cum.length - 1].value, c0 = +cum[cum.length - 2].value;
      const d1 = +daily[daily.length - 1].value;
      const dayKey = new Date(+daily[daily.length - 1].statisticDateE3).toISOString().slice(0, 10);
      const dropPct = (c1 - c0) / 100;
      if (d1 <= -1000) {
        await alert(state, 'blowup-' + dayKey, '🔴 已爆:單日虧損超過 10%',
          `他今天已實現 ${(d1 / 100).toFixed(1)}%。這是離場點,不是攤平點。`, 48);
      } else if (d1 >= 0 && dropPct <= -R.divergenceDropPct) {
        await alert(state, 'divergence-' + dayKey, '🟡 黃燈:浮虧扛單背離',
          `已實現當日 +${(d1 / 100).toFixed(1)}% 但權益掉 ${dropPct.toFixed(1)}% = 檯面下在扛浮虧。建議 48 小時內減倉或下車。`, 48);
      }
    }
  } catch (e) { log({ trendError: e.message }); }

  log({
    ok: true,
    open: openList.length,
    lastClose: hist[0]?.closeTime || null,
    gold: gold ? { last: gold.last, movePct: +gold.movePct.toFixed(2), stale: gold.stale } : null,
  });
  saveState(state);
})();
