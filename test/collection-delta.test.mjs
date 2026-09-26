import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { prepareCollectionDelta } from '../src/collection-delta.mjs';
import { readCollectionState, collectionScopeKey } from '../src/collection-state.mjs';
import { readSnapshot, reconcileSnapshot, writeSnapshot, rowKey } from '../src/usage-store.mjs';
import { batchUpsertTimeUsage } from '../src/db-batch.mjs';
import { event, usage } from './helpers/server.mjs';

const scope = { device: 'laptop', source: 'Codex CLI' };
const ordered = snapshot => Object.fromEntries(Object.entries(snapshot).map(([kind, rows]) => [kind,
  rows.map(({ pricingLockedAt, ...row }) => row).sort((a, b) => rowKey(kind, a).localeCompare(rowKey(kind, b)))]));
const input = time => {
  const days = new Map(), sessions = new Map();
  for (const row of time) {
    const key = JSON.stringify([row.usageDate, row.model]);
    const day = days.get(key) || usage({ ...scope, usageDate: row.usageDate, model: row.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 });
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'costUSD']) day[field] += row[field];
    days.set(key, day);
    sessions.set(`${row.projectPath}:${row.model}`, { ...usage(), model: row.model, sessionId: `local:codex:${row.projectPath}:${row.model}`, projectPath: row.projectPath, lastActivity: null });
  }
  return { daily: [...days.values()], time, sessions: [...sessions.values()] };
};

test('date-scoped reconciliation matches full-history reconciliation for late events, corrections and rotated logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collect-delta-'));
  const db = await openDb(join(root, 'incremental.sqlite'));
  const reference = await openDb(join(root, 'reference.sqlite'));
  const queries = [];
  const tracked = { ...db, all: async (sql, values) => { queries.push([sql, values]); return db.all(sql, values); } };
  const apply = async incoming => {
    const previous = await readSnapshot(reference, scope.device, scope.source);
    await writeSnapshot(reference, reconcileSnapshot(previous, incoming), { previous });
    const delta = await prepareCollectionDelta(tracked, scope, incoming);
    if (!delta.unchanged) await writeSnapshot(db, reconcileSnapshot(delta.previous, delta.incoming), {
      previous: delta.previous, checkpoint: { scope, signature: delta.signature }
    });
    assert.deepEqual(ordered(await readSnapshot(db)), ordered(await readSnapshot(reference)));
    return delta;
  };
  try {
    const older = event({ eventKey: 'old', usageDate: '2025-01-01', eventTime: '2025-01-01T12:00:00.000Z', costBasis: 'legacy_unknown' });
    const newer = event({ eventKey: 'new', usageDate: '2026-09-01', eventTime: '2026-09-01T12:00:00.000Z', costBasis: 'recorded' });
    await apply(input([older, newer]));
    queries.length = 0;
    assert.equal((await apply(input([older, newer]))).unchanged, true);
    assert.equal(queries.length, 0, 'unchanged input must not load any usage table');
    const late = { ...older, eventKey: 'late', costUSD: 2, costBasis: 'recorded' };
    queries.length = 0;
    assert.deepEqual((await apply(input([older, late, newer]))).dates, ['2025-01-01']);
    const reads = queries.filter(([sql]) => sql.startsWith('SELECT * FROM time_usage'));
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0][1], ['laptop', 'Codex CLI', '2025-01-01']);
    assert.equal((await readSnapshot(db)).sessions[0].lastActivity, newer.eventTime, 'a late old event must not move project activity backwards');
    const moved = { ...newer, usageDate: '2025-01-02', eventTime: '2025-01-02T12:00:00.000Z', projectPath: '/project/B' };
    await apply(input([older, late, moved]));
    await apply(input([moved])); // Missing log files retain stored history.
    await apply(input([{ ...moved, inputTokens: 50, totalTokens: 60, costUSD: 0.5 }]));
    await apply(input([{ ...moved, inputTokens: 150, totalTokens: 160, costUSD: 3 }]));
    // A restored/replaced scope must not retain a stale signature.
    await writeSnapshot(db, { daily: [], time: [], sessions: [] }, { full: true, scopes: [scope] });
    assert.equal(await readCollectionState(db, scope), null);
    assert.equal((await prepareCollectionDelta(db, scope, input([moved]))).unchanged, false);
  } finally { await db.close(); await reference.close(); rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint advances only on commit and other writers invalidate it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collect-checkpoint-'));
  const db = await openDb(join(root, 'usage.sqlite'));
  try {
    const incoming = input([event()]);
    const delta = await prepareCollectionDelta(db, scope, incoming);
    await writeSnapshot(db, reconcileSnapshot(delta.previous, incoming), { checkpoint: { scope, signature: delta.signature } });
    const before = await readCollectionState(db, scope);
    await assert.rejects(writeSnapshot(db, { daily: [], sessions: [], time: [{ ...event(), eventKey: null }] }, {
      checkpoint: { scope, signature: { version: 999 } }
    }));
    assert.deepEqual(await readCollectionState(db, scope), before);
    await batchUpsertTimeUsage(db, [event({ eventKey: 'external' })]);
    assert.equal(await readCollectionState(db, scope), null);
    await db.run('UPDATE collection_checkpoints SET state_json = ? WHERE scope_key = ?', ['invalid-json', collectionScopeKey(scope)]);
    assert.equal((await prepareCollectionDelta(db, scope, incoming)).dates, null, 'corrupt checkpoint must fall back to full reconciliation');
  } finally { await db.close(); rmSync(root, { recursive: true, force: true }); }
});
