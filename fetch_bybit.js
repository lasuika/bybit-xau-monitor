// Fetch Bybit public data for all configured providers via headless Chrome
// (bypasses Akamai TLS fingerprinting). Supports two separate products:
//   product: "mt5"    -> CopyMT5 (gold/FX), endpoints under /copymt5/
//   product: "crypto" -> Copy Trading Classic, endpoints under /beehive/
// One browser session serves both. Output: { fetchedAt, providers: { <name>: {...} } }
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PROVIDERS = CFG.providers;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const MT5_HOME = 'https://www.bybit.com/en/copyMt5/trade-center';
const CRYPTO_HOME = 'https://www.bybit.com/en/copyTrade/';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await ctx.newPage();
    const providers = {};
    const bad = [];

    // Group by product so we only load each product's page once. The API calls
    // must originate from that product's own origin/session.
    const groups = { mt5: [], crypto: [] };
    for (const p of PROVIDERS) groups[p.product === 'crypto' ? 'crypto' : 'mt5'].push(p);

    if (groups.mt5.length) {
      const first = encodeURIComponent(groups.mt5[0].mark);
      await page.goto(`https://www.bybit.com/en/copyMt5/trade-center/detail?providerMark=${first}`,
        { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);

      for (const p of groups.mt5) {
        const data = await page.evaluate(async (pm) => {
          const get = async (u) => (await fetch(u, { headers: { accept: 'application/json' } })).json();
          const [open, hist, income, trend, info] = await Promise.all([
            get(`/x-api/fapi/copymt5/public/v1/provider/open-position?providerMark=${pm}`),
            get(`/x-api/fapi/copymt5/public/v1/provider/get-history-position?providerMark=${pm}&pageAction=PAGE_ACTION_FIRST_PAGE&pageSize=50`),
            get(`/x-api/fapi/copymt5/public/v1/common/provider-income-detail?providerMark=${pm}`),
            get(`/x-api/fapi/copymt5/public/v1/provider/dynamic-yield-trend?dayCycleType=DAY_CYCLE_TYPE_SEVEN_DAY&period=PERIOD_DAY&providerMark=${pm}`),
            get(`/x-api/fapi/copymt5/public/v1/pub-provider/info?providerMark=${pm}`),
          ]);
          return { open, hist, income, trend, info };
        }, encodeURIComponent(p.mark));

        const missing = ['open', 'hist', 'income', 'trend', 'info']
          .filter((k) => (data[k]?.ret_code ?? data[k]?.retCode) !== 0);
        if (missing.length) { bad.push(`${p.name}: ${missing.join(',')}`); continue; }
        providers[p.name] = { product: 'mt5', ...data };
      }
    }

    if (groups.crypto.length) {
      await page.goto(CRYPTO_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);

      for (const p of groups.crypto) {
        const data = await page.evaluate(async (lm) => {
          const get = async (u) => (await fetch(u, { headers: { accept: 'application/json' } })).json();
          const [info, pos, trend] = await Promise.all([
            get(`/x-api/fapi/beehive/private/v1/pub-leader/info?leaderMark=${lm}`),
            get(`/x-api/fapi/beehive/public/v1/common/position/list?leaderMark=${lm}`),
            get(`/x-api/fapi/beehive/public/v2/leader/dynamic-yield-trend?dayCycleType=DAY_CYCLE_TYPE_SEVEN_DAY&period=PERIOD_DAY&leaderMark=${lm}`),
          ]);
          return { info, pos, trend };
        }, encodeURIComponent(p.mark));

        const missing = ['info', 'pos', 'trend']
          .filter((k) => (data[k]?.ret_code ?? data[k]?.retCode) !== 0);
        if (missing.length) { bad.push(`${p.name}: ${missing.join(',')}`); continue; }
        providers[p.name] = { product: 'crypto', ...data };
      }
    }

    // Fail loudly only when nothing came back; a single dead provider should not
    // blind the monitor for everyone else.
    if (!Object.keys(providers).length) {
      console.error('no providers fetched: ' + bad.join(' | '));
      process.exit(1);
    }
    console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), providers, failed: bad }));
  } catch (e) {
    console.error('fetch failed: ' + e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
