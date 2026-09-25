import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTimeRange, projectTotals, timeRangeForFilters } from '../src/client/shared/usage-data.js';
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
