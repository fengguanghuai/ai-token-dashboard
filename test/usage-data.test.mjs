import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTimeRange, fetchTimePage, fetchTimeSummary, summaryRangeForFilters, eventQueryForFilters, projectTotals, timeRangeForFilters } from '../src/client/shared/usage-data.js';
import { U } from '../src/client/shared/utils.js';
import { event } from './helpers/server.mjs';

test('precise loader reads all pages and propagates partial failures instead of returning day totals', async () => {
  let page = 0;
  const range = { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' };
  const rows = await fetchTimeRange(range, { fetcher: async url => {
    assert.match(url, /start=/); assert.match(url, /limit=2000/);
    return { ok: true, json: async () => ++page === 1 ? { time: [{ id: 'a' }], nextCursor: 'next' } : { time: [{ id: 'b' }], nextCursor: null } };
  } });
  assert.deepEqual(rows.map(r => r.id), ['a', 'b']);
  page = 0;
  await assert.rejects(fetchTimeRange(range, { fetcher: async () => ++page === 1 ? { ok: true, json: async () => ({ time: [{ id: 'a' }], nextCursor: 'next' }) } : { ok: false, status: 503 } }), /503/);
  assert.deepEqual(await fetchTimeRange(range, { fetcher: async () => ({ ok: true, json: async () => ({ time: [], nextCursor: null }) }) }), []);
});

test('project totals use date, model, device and source filtered event rows and actual activity', () => {
  const rows = [event(), event({ eventKey: 'b', projectPath: '/project/B' }), event({ usageDate: '2026-08-01' }), event({ model: 'other' })];
  const filtered = U.filterDaily(rows, { startDate: '2026-09-01', endDate: '2026-09-01', models: new Set(['test-model']), devices: new Set(['laptop']), sources: new Set(['Codex CLI']) });
  const projects = projectTotals(filtered);
  assert.equal(projects.length, 2);
  assert.ok(projects.every(row => row.totalTokens === 110 && row.lastActivity === '2026-09-01T00:00:00.000Z'));
});

test('precise request includes the comparison interval and rejects invalid bounds', () => {
  const f = { startDateTime: '2026-09-01T00:00:00Z', endDateTime: '2026-09-01T01:00:00Z', compare: true };
  assert.deepEqual(timeRangeForFilters(f), { start: '2026-08-31T22:59:00.000Z', end: '2026-09-01T01:00:00.000Z' });
  assert.throws(() => timeRangeForFilters({ ...f, endDateTime: 'invalid' }));
});

test('summary makes one request and detail loading fetches only the requested page', async () => {
  const range = { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' };
  let calls = 0;
  await fetchTimeSummary(range, { fetcher: async url => {
    calls++; assert.match(url, /^\/api\/time\/summary\?/);
    return { ok: true, json: async () => ({ current: { daily: [], projectDaily: [], hourly: [] }, previous: null }) };
  } });
  assert.equal(calls, 1);
  const page = await fetchTimePage({ ...range, source: ['Claude Code', 'Codex CLI'], project: ['/a&b'] }, { fetcher: async url => {
    calls++; const params = new URL(url, 'http://local').searchParams;
    assert.equal(params.get('limit'), '50'); assert.deepEqual(params.getAll('source'), ['Claude Code', 'Codex CLI']); assert.equal(params.get('project'), '/a&b');
    return { ok: true, json: async () => ({ time: [{ id: 'first' }], nextCursor: 'next' }) };
  } });
  assert.equal(calls, 2); assert.equal(page.nextCursor, 'next');
  await assert.rejects(fetchTimeSummary(range, { fetcher: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(fetchTimeSummary(range, { fetcher: async () => ({ ok: true, json: async () => ({ time: [] }) }) }), /统计数据/);
});

test('summary separates exact current/comparison bounds; drawer and export preserve active dimensions', () => {
  const filters = { startDateTime: '2026-09-01T00:00:00Z', endDateTime: '2026-09-01T01:00:00Z', compare: true,
    sources: new Set(['Codex CLI', 'Claude Code']), devices: new Set(['laptop']), models: new Set(['m']) };
  assert.deepEqual(summaryRangeForFilters(filters), { start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T01:00:00.000Z', compareStart: '2026-08-31T22:59:00.000Z', compareEnd: '2026-08-31T23:59:00.000Z' });
  const query = eventQueryForFilters(filters, 'Codex CLI', { kind: 'session', row: { source: 'Codex CLI', device: 'laptop', model: 'm', projectPath: '/a' } });
  assert.deepEqual(query.source, ['Codex CLI']); assert.deepEqual(query.project, ['/a']); assert.equal(query.compareStart, undefined);
  assert.equal(query.start, '2026-09-01T00:00:00.000Z');
});
