import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { syncDatabase } from '../src/sync.mjs';
import { writeSnapshot } from '../src/usage-store.mjs';
import { startServer, event, usage } from './helpers/server.mjs';
import { exerciseSyncJournal } from './helpers/sync.mjs';

const dateQuery = 'start=2026-01-01T00:00:00.000Z&end=2026-12-01T00:00:00.000Z&limit=2000';

test('HTTP sync replays partially accepted baselines without advancing progress or duplicating events', async () => {
  const app = await startServer({ INGEST_TOKEN: 'sync-token' });
  const root = mkdtempSync(join(tmpdir(), 'sync-journal-'));
  let db = await openDb(join(root, 'local.sqlite'));
  const options = { url: app.base + '/api/ingest', token: 'sync-token', device: 'laptop' };
  try {
    await writeSnapshot(db, { daily: [usage()], sessions: [], time: Array.from({ length: 1001 }, (_, i) => event({ eventKey: `e-${i}`, eventTime: '2026-01-01T00:00:00.000Z' })) });
    let calls = 0;
    await assert.rejects(syncDatabase({ ...options, db, fetcher: async (...args) => { if (++calls === 2) throw new Error('offline'); return fetch(...args); } }), /offline/);
    assert.equal((await db.get('SELECT acknowledged_revision FROM sync_targets')).acknowledged_revision, null);
    await db.close(); db = await openDb(join(root, 'local.sqlite'));
    assert.equal((await syncDatabase({ ...options, db })).rows.time, 1001);
    const stored = await (await fetch(app.base + `/api/time?${dateQuery}`, { headers: { authorization: 'Bearer sync-token' } })).json();
    assert.equal(stored.time.length, 1001);
    assert.equal((await syncDatabase({ ...options, db })).requests, 0);
    await writeSnapshot(db, { daily: [], sessions: [], time: [event({ eventKey: 'e-0', costUSD: 2 })] });
    let lost = true;
    await assert.rejects(syncDatabase({ ...options, db, fetcher: async (...args) => {
      const response = await fetch(...args);
      if (lost) { lost = false; await response.json(); throw new Error('response lost'); }
      return response;
    } }), /response lost/);
    assert.equal((await syncDatabase({ ...options, db })).rows.time, 1);
    const updated = await (await fetch(app.base + `/api/time?${dateQuery}`, { headers: { authorization: 'Bearer sync-token' } })).json();
    assert.equal(updated.time.find(row => row.eventKey === 'e-0').costUSD, 2);
    await writeSnapshot(db, { daily: [], time: [], sessions: [] }, { full: true, scopes: [{ device: 'laptop', source: 'Codex CLI' }] });
    assert.equal((await syncDatabase({ ...options, db })).requests, 1);
    assert.equal((await (await fetch(app.base + `/api/time?${dateQuery}`, { headers: { authorization: 'Bearer sync-token' } })).json()).time.length, 0);
  } finally { await db.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SQLite journal: deltas, source/target isolation, rollback, leases, pruning and baseline upgrade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-contract-'));
  const db = await openDb(join(root, 'usage.sqlite'));
  try { await exerciseSyncJournal(db, 'sync-device'); }
  finally { await db.close(); rmSync(root, { recursive: true, force: true }); }
});
