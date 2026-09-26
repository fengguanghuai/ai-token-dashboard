import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, usage, event } from './helpers/server.mjs';
import { dailyRangeForFilters, hourlyRangeForFilters, fetchDailyRange, fetchHourlyRange } from '../src/client/shared/usage-data.js';
import { RU } from '../src/client/review/utils.js';
import { createRangeQuery } from '../src/client/shared/range-query.js';

test('bounded daily and hourly APIs preserve totals, global options and timezone boundaries', async () => {
  const app = await startServer();
  try {
    const dates = ['2025-01-01', '2026-08-31', '2026-09-01', '2026-09-02'];
    await app.ingest({
      daily: dates.map((usageDate, i) => usage({ usageDate, device: i ? 'laptop' : 'historical-device', model: i ? 'test-model' : 'old-model', costUSD: i + 1 })),
      time: dates.map((usageDate, i) => event({ usageDate, eventKey: String(i), eventTime: `${usageDate}T12:00:00.000Z`, projectPath: i % 2 ? '/A' : '/a', costUSD: i + 1 }))
    });
    const json = async path => { const r = await fetch(app.base + path); assert.equal(r.status, 200); return r.json(); };
    const all = await json('/api/data');
    const filters = { startDate: '2026-09-01', endDate: '2026-09-01', compare: true };
    const range = dailyRangeForFilters(filters);
    const limited = await json('/api/data?' + new URLSearchParams(range));
    const inRange = row => row.usageDate >= range.startDate && row.usageDate <= range.endDate;
    assert.deepEqual(limited.daily, all.daily.filter(inRange));
    assert.deepEqual(limited.projectDaily, all.projectDaily.filter(inRange));
    assert.deepEqual(limited.dateRange, { start: dates[0], end: dates.at(-1) });
    assert.deepEqual(limited.dimensions, all.dimensions);
    assert.ok(limited.dimensions.devices.includes('historical-device'));
    assert.ok(limited.dimensions.models.includes('old-model'));
    assert.equal(limited.daily.reduce((sum, row) => sum + row.costUSD, 0), 5);
    const empty = await json('/api/data?startDate=2024-01-01&endDate=2024-01-02');
    assert.deepEqual(empty.daily, []); assert.deepEqual(empty.projectDaily, []);
    assert.deepEqual(empty.dateRange, all.dateRange); assert.deepEqual(empty.dimensions, all.dimensions);
    // Stored usage_date is deliberately inconsistent with display timezone.
    await app.ingest({ time: [event({ eventKey: 'cross-midnight', usageDate: '2026-09-01', eventTime: '2026-09-01T17:00:00.000Z' })] });
    const hourlyAll = await json('/api/hourly');
    const hourly = await json('/api/hourly?startDate=2026-09-02&endDate=2026-09-02');
    assert.deepEqual(hourly.hourly, hourlyAll.hourly.filter(row => row.usageDate === '2026-09-02'));
    assert.ok(hourly.hourly.some(row => row.hour === 1));
    for (const path of ['/api/data', '/api/hourly']) {
      for (const query of ['startDate=2026-02-30', 'startDate=2026-09-02&endDate=2026-09-01', 'endDate=not-a-date'])
        assert.equal((await fetch(app.base + path + '?' + query)).status, 400);
    }
  } finally { await app.close(); }
});

test('hourly date filtering handles a DST transition using display dates', async () => {
  const app = await startServer({ DISPLAY_TZ: 'America/New_York' });
  try {
    const times = ['2026-03-08T04:59:59.000Z', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.000Z', '2026-03-09T04:00:00.000Z'];
    await app.ingest({ time: times.map((eventTime, i) => event({ eventTime, eventKey: String(i) })) });
    const data = await (await fetch(app.base + '/api/hourly?startDate=2026-03-08&endDate=2026-03-08')).json();
    assert.equal(data.hourly.reduce((sum, row) => sum + row.eventCount, 0), 2);
    assert.deepEqual(data.hourly.map(row => row.hour).sort((a, b) => a - b), [0, 23]);
  } finally { await app.close(); }
});

test('dashboard and review query ranges include comparison; all uses global bounds', () => {
  assert.deepEqual(dailyRangeForFilters({ startDate: '2026-09-01', endDate: '2026-09-30', compare: true }), { startDate: '2026-08-02', endDate: '2026-09-30' });
  assert.deepEqual(dailyRangeForFilters({ startDate: '2026-09-01', endDate: '2026-09-30', compare: false }), { startDate: '2026-09-01', endDate: '2026-09-30' });
  assert.deepEqual(hourlyRangeForFilters({ startDate: '2025-01-01', endDate: '2026-09-30' }), { startDate: '2026-09-03', endDate: '2026-09-30' });
  assert.deepEqual(hourlyRangeForFilters({ startDate: '2026-09-30', endDate: '2026-09-30' }), { startDate: '2026-09-30', endDate: '2026-09-30' });
  assert.throws(() => dailyRangeForFilters({ startDate: '2026-02-30', endDate: '2026-03-01' }));
  const today = new Date(2026, 8, 26);
  const globalRange = { start: '2025-01-01', end: '2026-09-26' };
  assert.equal(RU.getPeriod('all', today, globalRange).start, '2025-01-01');
  for (const id of ['week', 'month', 'prev', '90d', 'all']) {
    const p = RU.getPeriod(id, today, globalRange);
    const q = dailyRangeForFilters({ startDate: p.prev?.start || p.start, endDate: p.end });
    assert.ok(q.startDate <= p.start && q.endDate >= p.end);
    if (p.prev) assert.ok(q.startDate <= p.prev.start && q.endDate >= p.prev.end);
    const all = ['2025-01-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-09-26'].map(usageDate => usage({ usageDate }));
    const loaded = all.filter(row => row.usageDate >= q.startDate && row.usageDate <= q.endDate);
    assert.deepEqual(RU.filterByPeriod(loaded, p), RU.filterByPeriod(all, p));
    if (p.prev) assert.deepEqual(RU.filterByPeriod(loaded, p.prev), RU.filterByPeriod(all, p.prev));
  }
});

test('range loaders send explicit dates, propagate errors and reject old server metadata', async () => {
  const range = { startDate: '2026-09-01', endDate: '2026-09-30' };
  for (const loader of [fetchDailyRange, fetchHourlyRange]) {
    await assert.rejects(loader(range, { fetcher: async url => {
      assert.match(url, /startDate=2026-09-01&endDate=2026-09-30/);
      return { ok: false, status: 503 };
    } }), /503/);
  }
  await assert.rejects(fetchDailyRange(range, { fetcher: async () => ({ ok: true, json: async () => ({ daily: [], projectDaily: [] }) }) }), /服务端已升级/);
});

test('range cache cancels superseded requests, ignores stale responses and retries failures', async () => {
  const pending = [], states = [];
  const resource = createRangeQuery((query, options) => new Promise((resolve, reject) => pending.push({ query, ...options, resolve, reject })), state => states.push(state));
  const first = resource.load({ id: 'old' });
  const second = resource.load({ id: 'new' });
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ daily: [usage({ totalTokens: 42 })] }); await second;
  pending[0].resolve({ daily: [usage({ totalTokens: 999 })] }); await first;
  assert.equal(states.at(-1).data.daily[0].totalTokens, 42);
  const failed = resource.load({ id: 'failed' }); pending[2].reject(new Error('offline')); await failed;
  assert.equal(states.at(-1).error, 'offline'); assert.equal(states.at(-1).data, null);
  const retry = resource.load({ id: 'failed' }); pending[3].resolve({ daily: [] }); await retry;
  assert.deepEqual(states.at(-1).data.daily, []);
  const cancelled = resource.load({ id: 'cancelled' }); resource.clear();
  const count = states.length; pending[4].resolve({ daily: [usage()] }); await cancelled;
  assert.equal(states.length, count);
});

test('cache reuse is bounded by time, entry count, row count and refresh invalidation', async () => {
  let clock = 0, calls = 0;
  const resource = createRangeQuery(async () => { calls++; return { daily: [usage()] }; }, () => {}, { now: () => clock, ttl: 10, maxEntries: 2 });
  await resource.load({ id: 1 }); await resource.load({ id: 1 }); assert.equal(calls, 1);
  clock = 11; await resource.load({ id: 1 }); assert.equal(calls, 2);
  await resource.load({ id: 2 }); await resource.load({ id: 3 }); await resource.load({ id: 1 }); assert.equal(calls, 5);
  await resource.load({ id: 1 }, { force: true }); assert.equal(calls, 6);
  resource.clear(); await resource.load({ id: 1 }); assert.equal(calls, 7);
  const large = createRangeQuery(async () => { calls++; return { daily: [usage(), usage()] }; }, () => {}, { maxRows: 1 });
  await large.load({ id: 1 }); await large.load({ id: 1 }); assert.equal(calls, 9);
});
