// Shared news/calendar/spike detection for both the local and cloud monitors.
// Kept in one file and copied to the cloud repo so the two stay in sync.
const https = require('https');

const nowMs = () => Date.now();

function httpsGet(url, json) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, json));
      }
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(json ? JSON.parse(b) : b); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ---- adverse spike -----------------------------------------------------
// Gold's typical 10-minute move is ~$2.5; $9 sits around the 97th percentile,
// so it marks a genuinely unusual jolt rather than ordinary drift.
//
// Price comes from Bybit's own marketPrice on the open positions rather than a
// chart feed: Yahoo's 1-minute futures data lags ~10 minutes, and Bybit's quote
// is both live and the one his P&L is actually marked against. We keep our own
// rolling history because the API only ever reports the current tick.
function recordPrice(state, openList, windowMin) {
  const px = openList.map((p) => +p.marketPrice).filter((v) => v > 0)[0];
  state.priceHistory = (state.priceHistory || []).filter(
    (s) => nowMs() - s.t <= (windowMin + 20) * 60 * 1000);
  if (px) state.priceHistory.push({ t: nowMs(), p: px });
  return px || null;
}

function getSpikeFromHistory(state, windowMin) {
  const hist = state.priceHistory || [];
  if (hist.length < 2) return null;
  const last = hist[hist.length - 1];
  const targetT = last.t - windowMin * 60 * 1000;

  // Nearest sample at or before the window start; reject if the gap is so large
  // that we would be comparing across a monitoring outage.
  let ref = null;
  for (const s of hist) if (s.t <= targetT) ref = s;
  if (!ref) return null;
  const spanMin = (last.t - ref.t) / 60000;
  if (spanMin > windowMin * 2.5) return null;

  return { last: last.p, moveUsd: last.p - ref.p, windowMin: Math.round(spanMin) };
}

// Net exposure across a provider's open positions, weighted by notional.
function netDirection(openList) {
  let net = 0;
  for (const p of openList) {
    const v = (+p.positionValueE8 || 0) / 1e8;
    net += p.side === 'Sell' ? -v : v;
  }
  return net; // >0 net long, <0 net short
}

async function topHeadlines(n) {
  try {
    const xml = await httpsGet(
      'https://news.google.com/rss/search?q=gold+price+when:1d&hl=en-US&gl=US&ceid=US:en', false);
    const items = xml.split('<item>').slice(1, n + 1);
    return items
      .map((it) => {
        const m = it.match(/<title>(.*?)<\/title>/s);
        return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
      })
      .filter(Boolean);
  } catch { return []; }
}

// ---- economic calendar -------------------------------------------------
// The feed rate-limits hard (HTTP 429) and only publishes the current week, so
// we cache for hours and back off rather than retry on every poll. A stale
// calendar is still useful; hammering the feed gets us nothing at all.
async function fetchCalendar(state, cacheMin) {
  const cached = state.calendar;
  const fresh = cacheMin || 360;
  const retry = 30;
  if (cached) {
    const ageMin = (nowMs() - cached.at) / 60000;
    if (ageMin < (cached.failed ? retry : fresh)) return cached.events || [];
  }

  let list = null;
  try {
    const r = await httpsGet('https://nfs.faireconomy.media/ff_calendar_thisweek.json', true);
    if (Array.isArray(r) && r.length) list = r;
  } catch { /* rate limited or offline */ }

  if (!list) {
    // Keep whatever we had; only the retry clock advances.
    state.calendar = { at: nowMs(), events: cached?.events || [], failed: true };
    return state.calendar.events;
  }

  const events = list
    .map((e) => ({
      title: e.title,
      country: e.country,
      impact: e.impact,
      forecast: e.forecast || '',
      previous: e.previous || '',
      at: Date.parse(e.date),
    }))
    .filter((e) => e.at && !Number.isNaN(e.at));

  state.calendar = { at: nowMs(), events, failed: false };
  return events;
}

function relevantEvents(events, R) {
  const impacts = R.calendarImpact || ['High'];
  const countries = R.calendarCountries || ['USD'];
  return events.filter((e) => impacts.includes(e.impact) && countries.includes(e.country));
}

// Fires two warnings per event. Windows are wider than the poll interval so a
// scheduled check cannot step over them.
async function checkCalendar(state, events, R, alert, log) {
  // CPI alone publishes as four separate rows at one timestamp; releases that
  // land together are one event to a trader, so group them into one alert.
  const groups = new Map();
  for (const e of relevantEvents(events, R)) {
    const slot = `${e.country}@${new Date(e.at).toISOString().slice(0, 16)}`;
    if (!groups.has(slot)) groups.set(slot, { at: e.at, country: e.country, items: [] });
    groups.get(slot).items.push(e);
  }

  for (const [slot, g] of groups) {
    const minsAway = (g.at - nowMs()) / 60000;
    const when = new Date(g.at).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const names = [...new Set(g.items.map((x) => x.title))].join('、');
    const fc = g.items.find((x) => x.forecast);
    const detail = fc ? `,${fc.title} 市場預期 ${fc.forecast}(前值 ${fc.previous || '-'})` : '';

    if (minsAway >= 23 * 60 && minsAway <= 25 * 60) {
      await alert(state, 'cal1d:' + slot, '📅 明天有高影響數據',
        `${g.country} ${names} — 台灣時間 ${when}${detail}。這類數據常讓黃金瞬間跳動 $10-30,若那時還有跟單部位,提前決定要不要減碼。`, 24 * 7);
    } else if (minsAway >= 6 && minsAway <= 14) {
      await alert(state, 'cal10m:' + slot, '⏰ 10 分鐘後數據公布',
        `${g.country} ${names} 即將於台灣時間 ${when} 公布${detail}。公布瞬間點差會擴大、價格可能急跳 — 這是無停損策略最危險的幾分鐘。`, 24 * 7);
    }
  }
}

module.exports = { recordPrice, getSpikeFromHistory, netDirection, topHeadlines, fetchCalendar, checkCalendar };
