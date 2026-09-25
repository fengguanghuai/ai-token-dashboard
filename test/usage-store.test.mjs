import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { readSnapshot, reconcileSnapshot, writeSnapshot } from '../src/usage-store.mjs';
import { event, usage } from './helpers/server.mjs';

const empty = () => ({ daily: [], time: [], sessions: [] });
const base = () => ({ daily: [usage({ costBasis: 'legacy_unknown' })], time: [event({ costBasis: 'legacy_unknown' })], sessions: [] });

test('unchanged usage preserves its historical amount across price refreshes', () => {
  const previous = base();
  const incoming = { daily: [usage({ costUSD: 100 })], time: [event({ costUSD: 100, costBasis: 'estimated' })], sessions: [] };
  const next = reconcileSnapshot(previous, incoming);
  assert.equal(next.daily[0].costUSD, 1);
  assert.equal(next.time[0].costUSD, 1);
  assert.equal(next.daily[0].costBasis, 'legacy_unknown');
});

test('late historical events add their cost to an existing day without repricing old events', () => {
  const previous = base();
  const incoming = { daily: [usage({ inputTokens: 200, outputTokens: 20, totalTokens: 220, costUSD: 102 })],
    time: [event({ costUSD: 100 }), event({ eventKey: 'late', costUSD: 2, costBasis: 'recorded' })], sessions: [] };
  const next = reconcileSnapshot(previous, incoming);
  assert.equal(next.daily[0].costUSD, 3);
  assert.deepEqual(next.time.map(row => row.costUSD), [1, 2]);
  assert.equal(reconcileSnapshot(next, incoming).daily[0].costUSD, 3, 'repeated collection must not add the late event twice');
});

test('backfilling detail already present in a historical summary does not double its amount', () => {
  const previous = { daily: [usage({ costUSD: 7, costBasis: 'legacy_unknown' })], time: [], sessions: [] };
  const next = reconcileSnapshot(previous, { daily: [usage()], time: [event()], sessions: [] });
  assert.equal(next.daily[0].costUSD, 7);
  assert.equal(next.time[0].costUSD, 1);
  assert.equal(next.daily[0].costBasis, 'legacy_unknown');
});

test('partial logs do not reduce a stored day, and a smaller corrected event cannot reprice its historical amount', () => {
  const previous = base();
  previous.daily[0] = usage({ inputTokens: 200, outputTokens: 20, totalTokens: 220, costUSD: 2 });
  previous.time.push(event({ eventKey: 'rotated' }));
  const next = reconcileSnapshot(previous, base());
  assert.equal(next.daily[0].totalTokens, 220);
  assert.equal(next.daily[0].costUSD, 2);
  const smaller = reconcileSnapshot(base(), { daily: [usage({ inputTokens: 50, totalTokens: 60, costUSD: 0.5 })],
    time: [event({ inputTokens: 50, totalTokens: 60, costUSD: 0.5, costBasis: 'recorded' })], sessions: [] });
  assert.equal(smaller.daily[0].costUSD, 1);
  assert.equal(smaller.time[0].costUSD, 1);
});

test('new daily totals sum preserved event costs and unavailable project activity stays unknown', () => {
  const incoming = base();
  incoming.sessions.push({ ...usage(), sessionId: 'local:codex:/project/A:test-model', projectPath: '/project/A' }, { ...usage(), sessionId: 'local:codex:/unknown:test-model', projectPath: '/unknown' });
  const next = reconcileSnapshot(empty(), incoming);
  assert.equal(next.daily[0].costUSD, 1);
  assert.equal(next.sessions[0].lastActivity, incoming.time[0].eventTime);
  assert.equal(next.sessions[1].lastActivity, null);
});

test('full replacement deletes obsolete daily and workspace rows only within its scope and rolls back failed writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-rebuild-'));
  const db = await openDb(join(root, 'usage.sqlite'));
  try {
    const before = base();
    before.daily.push(usage({ model: 'obsolete' }), usage({ source: 'other' }));
    before.sessions.push({ ...usage(), sessionId: 'obsolete-session' });
    await writeSnapshot(db, before);
    await writeSnapshot(db, empty(), { full: true, scopes: [{ device: 'laptop', source: 'Codex CLI' }] });
    const after = await readSnapshot(db);
    assert.deepEqual(after.daily.map(r => r.source), ['other']);
    assert.equal(after.time.length, 0); assert.equal(after.sessions.length, 0);
    await assert.rejects(writeSnapshot(db, { ...empty(), daily: [{ model: 'broken' }] }, { full: true, scopes: [{ device: 'laptop', source: 'other' }] }));
    assert.equal((await readSnapshot(db)).daily.length, 1);
  } finally { await db.close(); rmSync(root, { recursive: true, force: true }); }
});
