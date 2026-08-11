// One-off probe: fetch full public data for an arbitrary CopyMT5 provider.
// Runs on the cloud runner so it works even when the local IP is blocked.
// Usage: PROVIDER_MARK='xxx==' node probe.js
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

    const data = await page.evaluate(async (pm) => {
      const g = async (u) => (await fetch(u, { headers: { accept: 'application/json' } })).json();
      const [info, income, open, hist, trend] = await Promise.all([
        g(`/x-api/fapi/copymt5/public/v1/pub-provider/info?providerMark=${pm}`),
        g(`/x-api/fapi/copymt5/public/v1/common/provider-income-detail?providerMark=${pm}`),
        g(`/x-api/fapi/copymt5/public/v1/provider/open-position?providerMark=${pm}`),
        g(`/x-api/fapi/copymt5/public/v1/provider/get-history-position?providerMark=${pm}&pageAction=PAGE_ACTION_FIRST_PAGE&pageSize=50`),
        g(`/x-api/fapi/copymt5/public/v1/provider/dynamic-yield-trend?dayCycleType=DAY_CYCLE_TYPE_ONE_HUNDRED_EIGHTY_DAY&period=PERIOD_DAY&providerMark=${pm}`),
      ]);
      return { info, income, open, hist, trend };
    }, PM);

    console.log('PROBE_RESULT_BEGIN');
    console.log(JSON.stringify(data));
    console.log('PROBE_RESULT_END');
  } catch (e) {
    console.error('probe failed: ' + e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
