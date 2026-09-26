import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';
import { batchUpsertTimeUsage } from '../src/db-batch.mjs';
import { queryTime, queryTimeSummary } from '../src/usage-query.mjs';
import { U } from '../src/client/shared/utils.js';
import { projectTotals, filterDimensions } from '../src/client/shared/usage-data.js';
import { event } from './helpers/server.mjs';

const pricing = { 'cache-fixture': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.25e-6 } };
const params = new URLSearchParams({ start: '2026-09-01T12:00:00Z', end: '2026-09-02T12:00:00Z', compareStart: '2026-08-31T11:59:00Z', compareEnd: '2026-09-01T11:59:00Z' });
async function allEvents(db, range) {
  const query = new URLSearchParams(range), rows = [];
  for (;;) {
    const page = await queryTime(db, query, pricing); rows.push(...page.time);
    if (!page.nextCursor) return rows;
    query.set('cursor', page.nextCursor);
  }
}
function equalTotals(actual, expected) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'costUSD', 'cacheSavedUSD'])
    assert.ok(Math.abs(actual[field] - expected[field]) < 1e-8, `${field}: ${actual[field]} vs ${expected[field]}`);
}

test('complete range aggregates match every event beyond page one, including comparison, filters, projects and per-event savings clamp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-summary-'));
  const db = await openDb(join(root, 'db.sqlite'));
  try {
    const rows = Array.from({ length: 2505 }, (_, i) => event({ eventKey: String(i), model: 'cache-fixture',
      eventTime: '2026-09-01T17:00:00.000Z', device: i % 2 ? 'laptop' : 'Desktop',
      projectPath: i % 3 ? '/project/A' : '/project/a', source: i % 5 ? 'Codex CLI' : 'Claude Code',
      reasoningOutputTokens: i % 7, cacheReadTokens: i % 2 ? 100 : 0, cacheCreationTokens: i % 2 ? 0 : 100, totalTokens: 210, costUSD: i % 2 ? 0.1 : 0.2 }));
    rows.push(event({ eventKey: 'start', eventTime: '2026-09-01T12:00:00.000Z' }), event({ eventKey: 'end', eventTime: '2026-09-02T12:00:00.000Z', usageDate: '2026-09-02' }),
      event({ eventKey: 'previous', eventTime: '2026-09-01T11:59:00.000Z', projectPath: null }),
      event({ eventKey: 'gap', eventTime: '2026-09-01T11:59:30.000Z' }), event({ eventKey: 'outside', eventTime: '2026-09-02T12:00:00.001Z' }));
    await batchUpsertTimeUsage(db, rows);
    const result = await queryTimeSummary(db, params, pricing);
    assert.equal(result.current.eventCount, 2507); assert.equal(result.previous.eventCount, 1);
    assert.ok(result.current.daily.length < 20); assert.ok(result.current.projectDaily.length < 30);
    for (const [part, range] of [[result.current, result.range], [result.previous, result.previousRange]]) {
      const events = await allEvents(db, range);
      equalTotals(U.aggregateTotals(part.daily), U.aggregateTotals(events));
      equalTotals(U.aggregateTotals(part.projectDaily), U.aggregateTotals(events));
      assert.equal(part.hourly.reduce((sum, row) => sum + row.eventCount, 0), events.length);
      const filters = { sources: new Set(['Codex CLI']), devices: new Set(['laptop']), models: new Set(['cache-fixture']) };
      equalTotals(U.aggregateTotals(filterDimensions(part.daily, filters)), U.aggregateTotals(filterDimensions(events, filters)));
      const projects = projectTotals(part.projectDaily), expected = projectTotals(events);
      assert.deepEqual(projects.map(r => r.sessionId).sort(), expected.map(r => r.sessionId).sort());
      for (const row of projects) equalTotals(U.aggregateTotals([row]), U.aggregateTotals([expected.find(r => r.sessionId === row.sessionId)]));
    }
    const filtered = new URLSearchParams({ ...result.range, limit: '2', source: 'Codex CLI', device: 'laptop', model: 'cache-fixture', project: '/project/A' });
    const first = await queryTime(db, filtered, pricing); assert.equal(first.time.length, 2); assert.ok(first.nextCursor);
    filtered.set('cursor', first.nextCursor);
    const next = await queryTime(db, filtered, pricing); assert.ok(next.time.every(row => !first.time.some(r => r.id === row.id)));
    filtered.set('project', '/project/a'); await assert.rejects(queryTime(db, filtered, pricing), /cursor/);
    const empty = await queryTimeSummary(db, new URLSearchParams({ start: '2020-01-01', end: '2020-01-02' }), pricing);
    assert.equal(empty.current.eventCount, 0); assert.deepEqual(empty.current.daily, []); assert.equal(empty.previous, null);
    await assert.rejects(queryTimeSummary(db, new URLSearchParams({ ...result.range, compareStart: result.range.start, compareEnd: result.range.end }), pricing), /precede/);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
