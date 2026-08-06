// Fetch Bybit CopyMT5 public data for a provider via headless Chrome (bypasses Akamai TLS fingerprinting).
// Outputs one JSON object to stdout. Exit 0 = ok, 1 = fetch failed.
const { chromium } = require('playwright-core');

const PROVIDER_MARK = 'm7Fvf7pQjGK4D+ycPy2SWQ==';
const PM = encodeURIComponent(PROVIDER_MARK);
const PAGE_URL = `https://www.bybit.com/en/copyMt5/trade-center/detail?providerMark=${PM}`;
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
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const data = await page.evaluate(async (pm) => {
      const get = async (path) => {
        const r = await fetch(path, { headers: { accept: 'application/json' } });
        return r.json();
      };
      const [open, hist, income, trend] = await Promise.all([
        get(`/x-api/fapi/copymt5/public/v1/provider/open-position?providerMark=${pm}`),
        get(`/x-api/fapi/copymt5/public/v1/provider/get-history-position?providerMark=${pm}&pageAction=PAGE_ACTION_FIRST_PAGE&pageSize=50`),
        get(`/x-api/fapi/copymt5/public/v1/common/provider-income-detail?providerMark=${pm}`),
        get(`/x-api/fapi/copymt5/public/v1/provider/dynamic-yield-trend?dayCycleType=DAY_CYCLE_TYPE_SEVEN_DAY&period=PERIOD_DAY&providerMark=${pm}`),
      ]);
      return { open, hist, income, trend };
    }, PM);

    const bad = ['open', 'hist', 'income', 'trend'].filter(
      (k) => (data[k]?.ret_code ?? data[k]?.retCode) !== 0
    );
    if (bad.length) {
      console.error('non-zero retCode for: ' + bad.join(','));
      process.exit(1);
    }
    console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), ...data }));
  } catch (e) {
    console.error('fetch failed: ' + e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
