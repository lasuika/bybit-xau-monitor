// Fetch Bybit CopyMT5 public data for all configured providers via headless Chrome
// (bypasses Akamai TLS fingerprinting). One browser session, all providers.
// Outputs one JSON object to stdout: { fetchedAt, providers: { <name>: {open,hist,income,trend,info} } }
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PROVIDERS = CFG.providers;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await ctx.newPage();
    const firstPm = encodeURIComponent(PROVIDERS[0].mark);
    await page.goto(`https://www.bybit.com/en/copyMt5/trade-center/detail?providerMark=${firstPm}`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await page.waitForTimeout(4000);

    const providers = {};
    for (const p of PROVIDERS) {
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

      const bad = ['open', 'hist', 'income', 'trend', 'info'].filter(
        (k) => (data[k]?.ret_code ?? data[k]?.retCode) !== 0
      );
      if (bad.length) {
        console.error(`non-zero retCode for ${p.name}: ${bad.join(',')}`);
        process.exit(1);
      }
      providers[p.name] = data;
    }
    console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), providers }));
  } catch (e) {
    console.error('fetch failed: ' + e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
