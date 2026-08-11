// Cross-product verification: screen both CopyMT5 (gold/FX) and Copy Trading
// Classic (crypto) leaderboards with one consistent set of criteria, then report
// each survivor's actual daily-return distribution from its 180-day curve.
//
// Runs on the cloud runner (clean IP). Rates are deliberately gentle.
const { chromium } = require('playwright-core');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A trader survives only if losses are actually realised. A 100% win rate or a
// profit/loss ratio with a zero denominator means losers are being held, not cut.
const SCREEN = {
  minTradeDays: 120,
  maxWinRate: 95,
  minWinRate: 35,
  minExpectancy: 0.05,
  minDrawdown: 0.5,
  maxDrawdown: 45,
  minFollowerProfit: 0,
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const out = { gold: [], crypto: [], errors: [] };
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await ctx.newPage();

    // ---------- CopyMT5 (gold / FX) ----------
    await page.goto('https://www.bybit.com/en/copyMt5/trade-center',
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    out.gold = await page.evaluate(async () => {
      const g = async (u) => (await fetch(u, { headers: { accept: 'application/json' } })).json();
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const seen = {};
      const sorts = ['PROVIDER_SORT_FIELD_SORT_ROE', 'PROVIDER_SORT_FIELD_SORT_SHARPE_RATIO',
        'PROVIDER_SORT_FIELD_SORT_FOLLOWERS_PNL', 'PROVIDER_SORT_FIELD_SORT_PROFIT_TO_LOSS_RATE'];
      for (const sf of sorts) {
        for (const cyc of ['DAY_CYCLE_TYPE_NINETY_DAY', 'DAY_CYCLE_TYPE_THIRTY_DAY']) {
          const j = await g(`/x-api/fapi/copymt5/public/v1/common/dynamic-provider-list?pageNo=1&pageSize=50&sortField=${sf}&sortType=SORT_TYPE_DESC&dayCycleType=${cyc}`);
          for (const p of (j.result?.providerDetailsList || [])) seen[p.providerMark] = p;
          await nap(400);
        }
      }
      const rows = [];
      for (const [mark, p] of Object.entries(seen)) {
        try {
          const pm = encodeURIComponent(mark);
          const [info, inc, trend, open] = await Promise.all([
            g(`/x-api/fapi/copymt5/public/v1/pub-provider/info?providerMark=${pm}`),
            g(`/x-api/fapi/copymt5/public/v1/common/provider-income-detail?providerMark=${pm}`),
            g(`/x-api/fapi/copymt5/public/v1/provider/dynamic-yield-trend?dayCycleType=DAY_CYCLE_TYPE_ONE_HUNDRED_EIGHTY_DAY&period=PERIOD_DAY&providerMark=${pm}`),
            g(`/x-api/fapi/copymt5/public/v1/provider/open-position?providerMark=${pm}`),
          ]);
          const i = info.result || {}, e = inc.result || {};
          const lines = {};
          for (const l of (trend.result?.metricList || [])) lines[l.line] = l.metricLineValue;
          const daily = (lines.dailyRoe || []).map((x) => +x.value / 100);
          const cum = (lines.cumRoe || []).map((x) => +x.value / 100);
          const ol = open.result?.openPositionList || [];
          rows.push({
            name: i.providerUserName, mark, days: +i.tradingDays || 0,
            assets: +i.totalAssetsE8 / 1e8, aum: +i.aumE8 / 1e8, followers: +i.followers || 0,
            share: i.shareProfitRateE2,
            roe90: +e.ninetyDayRoeE4 / 100, wr90: +e.ninetyDayWinRateE4 / 100,
            pl90: +e.ninetyDayProfitToLossRatioE2 / 100, dd90: +e.ninetyDayMaxDrawdownE4 / 100,
            fpnl90: +e.ninetyDayFollowersPnlE8 / 1e8, sharpe90: +e.ninetyDaySharpeRatioE4 / 10000,
            plStr: e.ninetyDayProfitToLossRatioE2,
            openN: ol.length,
            withSL: ol.filter((x) => parseFloat(x.stopLossPrice || 0) > 0).length,
            notional: ol.reduce((a, x) => a + +x.positionValueE8 / 1e8, 0),
            daily, cum,
            intro: (i.providerUserIntroduction || '').slice(0, 120),
          });
        } catch (err) { /* skip this provider */ }
        await nap(250);
      }
      return rows;
    });

    // ---------- Copy Trading Classic (crypto) ----------
    await page.goto('https://www.bybit.com/en/copyTrade/',
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    out.crypto = await page.evaluate(async () => {
      const g = async (u) => (await fetch(u, { headers: { accept: 'application/json' } })).json();
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const seen = {};
      const sorts = ['LEADER_SORT_FIELD_SORT_FOLLOWERS_YIELD', 'LEADER_SORT_FIELD_SORT_ROI',
        'LEADER_SORT_FIELD_SORT_SHARPE_RATIO', 'LEADER_SORT_FIELD_SORT_YIELD_LOSS_RATIO'];
      for (const sf of sorts) {
        for (let p = 1; p <= 2; p++) {
          const j = await g(`/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${p}&pageSize=50&dataDuration=DATA_DURATION_NINETY_DAY&sortField=${sf}&sortType=SORT_TYPE_DESC`);
          for (const x of (j.result?.leaderDetails || [])) seen[x.leaderMark] = x;
          await nap(400);
        }
      }
      const rows = [];
      for (const [mark, x] of Object.entries(seen)) {
        try {
          const lm = encodeURIComponent(mark);
          const [info, trend, pos] = await Promise.all([
            g(`/x-api/fapi/beehive/private/v1/pub-leader/info?leaderMark=${lm}`),
            g(`/x-api/fapi/beehive/public/v2/leader/dynamic-yield-trend?dayCycleType=DAY_CYCLE_TYPE_NINETY_DAY&period=PERIOD_DAY&leaderMark=${lm}`),
            g(`/x-api/fapi/beehive/public/v1/common/position/list?leaderMark=${lm}`),
          ]);
          const i = info.result || {};
          const lines = {};
          for (const l of (trend.result?.metricList || [])) lines[l.line] = l.metricLineValue;
          const daily = (lines.yieldRate || []).map((v) => +v.value / 100);
          const cum = (lines.cumResetRoi || []).map((v) => +v.value / 100);
          const pr = pos.result || {};
          const pd = Array.isArray(pr.data) ? pr.data : [];
          rows.push({
            name: x.nickName, mark, metrics: x.metricValues,
            tags: (x.userTag || []).map((t) => t.title),
            days: +i.tradeDays || 0, cumFollowers: +i.cumFollowerCount || 0,
            followers: +i.currentFollowerCount || 0, aum: +i.aumE8 / 1e8,
            share: +i.shareProfitRateE8 / 1e6,
            win: +i.profitCount || 0, loss: +i.lossCount || 0,
            stable: parseFloat(i.stableScoreLevelFormat) || 0,
            d7: +i.last7DaysYieldRateE4 / 100, d7fy: +i.last7DaysFollowerYieldE8 / 1e8,
            hidden: pr.openTradeInfoProtection === 1,
            openN: pd.length,
            withSL: pd.filter((p) => p.stopLossPrice && parseFloat(p.stopLossPrice) > 0).length,
            levs: pd.map((p) => +p.leverageE2 / 100),
            daily, cum,
          });
        } catch (err) { /* skip */ }
        await nap(250);
      }
      return rows;
    });
  } catch (e) {
    out.errors.push(e.message);
  } finally {
    await browser.close();
  }
  const payload = JSON.stringify({ screen: SCREEN, ...out });
  require('fs').writeFileSync('verify-result.json', payload);
  console.log(`VERIFY_DONE gold=${out.gold.length} crypto=${out.crypto.length} bytes=${payload.length}`);
})();
