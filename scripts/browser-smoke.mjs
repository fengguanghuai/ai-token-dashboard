import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer, event, usage } from '../test/helpers/server.mjs';

// A real built frontend and isolated backend; no personal database, credentials
// or vendor quota calls. Fixed time crosses the UTC/Shanghai month boundary.
const app = await startServer({}, { staticDir: 'dist' });
let browser;
try {
  const time = Array.from({ length: 51 }, (_, index) => event({ usageDate: '2026-10-01', eventKey: `browser-${index}`,
    eventTime: new Date(Date.parse('2026-09-30T17:00:00Z') + index * 60_000).toISOString() }));
  assert.equal((await app.ingest({ time, daily: [
    usage({ usageDate: '2026-10-01', inputTokens: 5100, outputTokens: 510, totalTokens: 5610, costUSD: 51 }),
    usage({ usageDate: '2026-09-30' }), usage({ usageDate: '2026-09-20', inputTokens: 200, outputTokens: 20, totalTokens: 220 })
  ] })).status, 200);
  browser = await chromium.launch();
  const context = await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  // External fonts are irrelevant to behavior and should not make CI depend on Google.
  await context.route('https://fonts.**', route => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  // Keep time advancing: resize debouncers rely on elapsed Date.now().
  await page.clock.install({ time: new Date('2026-09-30T18:00:00Z') });
  const pageErrors = [], requests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  let configFailure = true;
  await page.route('**/api/config', route => configFailure ? (configFailure = false, route.fulfill({ status: 503, body: '{}' })) : route.continue());
  await page.goto(app.base);
  await page.getByRole('alert').filter({ hasText: '展示配置加载失败' }).waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('heading', { name: 'Token Studio', exact: true }).waitFor();
  await page.getByText('时间（Asia/Shanghai）', { exact: true }).waitFor();
  assert.match(await page.locator('.dt-range-trigger').innerText(), /2026-10-01/);
  assert.ok(!requests.some(url => /\/ReviewApp-.*\.js/.test(url)), 'dashboard must not load the review bundle');

  const total = page.locator('.kpi').first().locator('.visually-hidden');
  const expectTotal = value => page.waitForFunction(value => document.querySelector('.kpi .visually-hidden')?.textContent === value, value);
  await expectTotal('5,940');
  // Deliver an older request after a newer range is already rendered.
  let releaseOld, oldStarted;
  const started = new Promise(resolve => { oldStarted = resolve; });
  const held = new Promise(resolve => { releaseOld = resolve; });
  const delayed = async route => {
    if (new URL(route.request().url()).searchParams.get('startDate') === '2026-09-18') {
      const response = await route.fetch(); oldStarted(); await held;
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  };
  await page.route('**/api/data?**', delayed);
  await page.getByRole('button', { name: '7 天', exact: true }).click();
  await started;
  const cancelledOld = page.waitForEvent('requestfailed', { predicate: request => request.url().includes('/api/data?') && new URL(request.url()).searchParams.get('startDate') === '2026-09-18' });
  const newerResponse = page.waitForResponse(response => response.url().includes('/api/data?') && new URL(response.url()).searchParams.get('startDate') === '2026-09-04');
  await page.getByRole('button', { name: '14 天', exact: true }).click();
  await Promise.all([newerResponse, cancelledOld]);
  await expectTotal('5,940'); releaseOld();
  await page.unroute('**/api/data?**', delayed);
  assert.equal(await total.textContent(), '5,940');

  await page.getByRole('button', { name: '今天', exact: true }).click();
  await expectTotal('5,610');
  let summaryFailure = true;
  await page.route('**/api/time/summary?**', route => summaryFailure ? (summaryFailure = false, route.fulfill({ status: 503, body: '{}' })) : route.continue());
  await page.locator('.dt-range-trigger').click();
  if (!(await page.locator('.dt-title').innerText()).includes('2026年10月')) await page.locator('.dt-nav').last().click();
  assert.equal(await page.locator('.dt-title').innerText(), '2026年10月');
  const day = page.locator('.dt-day:not(.muted)').filter({ hasText: /^1$/ });
  await day.click(); await day.click();
  await page.getByRole('button', { name: '重试统计' }).click();
  await expectTotal('5,610');
  const summaryUrl = new URL(requests.filter(url => url.includes('/api/time/summary?')).at(-1));
  assert.equal(summaryUrl.searchParams.get('start'), '2026-09-30T16:00:00.000Z');
  assert.equal(summaryUrl.searchParams.get('end'), '2026-10-01T15:59:00.000Z');

  await page.locator('.table-panel tbody tr').first().click();
  const details = page.getByRole('region', { name: '事件明细' });
  await details.getByText('第 1 页 · 本页 50 条').waitFor();
  assert.equal(await details.locator('tbody tr').count(), 50);
  assert.equal(await details.locator('tbody tr').first().locator('td').first().innerText(), '2026-10-01 01:00');
  let detailFailure = true;
  await page.route('**/api/time?**', route => detailFailure ? (detailFailure = false, route.fulfill({ status: 503, body: '{}' })) : route.continue());
  await details.getByRole('button', { name: '下一页' }).click();
  await details.getByRole('button', { name: '重试明细' }).click();
  await details.getByText('第 2 页 · 本页 1 条').waitFor();
  assert.equal(await details.locator('tbody tr').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.export-menu summary').click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '用量明细', exact: true }).click();
  const download = await downloadReady;
  const csv = await readFile(await download.path(), 'utf8');
  assert.equal(csv.trim().split('\n').length, 52);
  assert.equal(new URL(download.url()).searchParams.get('start'), summaryUrl.searchParams.get('start'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.filterbar').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth).catch(async error => {
    console.error(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 15).map(node => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right }))));
    throw error;
  });
  await page.getByRole('link', { name: '复盘', exact: true }).click();
  await page.locator('.period-current').filter({ hasText: '2026 年 10 月 · Asia/Shanghai' }).waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth).catch(async error => {
    console.error(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12).map(node => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right }))));
    throw error;
  });
  assert.deepEqual(pageErrors, []);
  await context.close();

  // A failed optional chart chunk must leave controls usable and offer recovery.
  const chartPage = await browser.newPage({ reducedMotion: 'reduce' });
  chartPage.setDefaultTimeout(15_000);
  await chartPage.clock.install({ time: new Date('2026-09-30T18:00:00Z') });
  await chartPage.route('https://fonts.**', route => route.abort());
  await chartPage.route('**/chart-runtime-*.js', route => route.abort());
  await chartPage.goto(app.base + '/review');
  await chartPage.locator('.donut-wrap').scrollIntoViewIfNeeded();
  const retryChart = chartPage.getByRole('button', { name: '图表加载失败，重新加载页面' }).first();
  await retryChart.waitFor();
  await chartPage.unroute('**/chart-runtime-*.js');
  await Promise.all([chartPage.waitForEvent('load'), retryChart.click()]);
  await chartPage.locator('.donut-wrap').scrollIntoViewIfNeeded();
  await chartPage.locator('canvas').first().waitFor();
  await chartPage.close();
  console.log('Browser smoke passed: timezone, config retry, stale response, precise summary, detail pagination/retry, CSV, mobile, review, chart recovery.');
} finally {
  await browser?.close();
  await app.close();
}
