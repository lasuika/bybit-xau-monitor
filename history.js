// Pull as much closed-trade history as the API will page through for one
// provider. Runs on the cloud runner so it works while the local IP is blocked.
// Usage: PROVIDER_MARK='xxx==' node history.js
const { chromium } = require('playwright-core');

const MARK = process.env.PROVIDER_MARK;
if (!MARK) { console.error('PROVIDER_MARK not set'); process.exit(1); }
const PM = encodeURIComponent(MARK);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto(`https://www.bybit.com/en/copyMt5/trade-center/detail?providerMark=${PM}`,
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const out = await page.evaluate(async (pm) => {
      const g = async (u) => (await fetch(u, { headers: { accept: 'application/json' } })).json();
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const base = `/x-api/fapi/copymt5/public/v1/provider/get-history-position?providerMark=${pm}&pageSize=50`;
      const seen = new Map();
      let cursor = '';
      let action = 'PAGE_ACTION_FIRST_PAGE';
      const pages = [];

      for (let i = 0; i < 60; i++) {
        const url = base + `&pageAction=${action}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const j = await g(url);
        if ((j.ret_code ?? j.retCode) !== 0) { pages.push({ i, err: j.ret_msg || j.retMsg }); break; }
        const list = j.result?.historyPositionList || [];
        let fresh = 0;
        for (const t of list) {
          const k = [t.openTime, t.closeTime, t.entryPrice, t.closedProfitE8].join('|');
          if (!seen.has(k)) { seen.set(k, t); fresh++; }
        }
        pages.push({ i, got: list.length, fresh, isLast: j.result?.isLastPage });
        // The cursor stops advancing once the feed is exhausted; bail rather
        // than spin on the same page.
        if (!fresh || j.result?.isLastPage || !list.length) break;
        cursor = j.result?.cursor || '';
        action = 'PAGE_ACTION_NEXT_PAGE';
        await nap(350);
      }
      return { trades: [...seen.values()], pages };
    }, PM);

    console.log('HISTORY_RESULT_BEGIN');
    console.log(JSON.stringify(out));
    console.log('HISTORY_RESULT_END');
    console.error(`fetched ${out.trades.length} unique trades over ${out.pages.length} pages`);
  } catch (e) {
    console.error('history failed: ' + e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
