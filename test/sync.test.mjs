import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncSnapshot } from '../src/sync.mjs';
import { startServer, event, usage } from './helpers/server.mjs';

const dateQuery = 'start=2026-01-01T00:00:00.000Z&end=2026-12-01T00:00:00.000Z&limit=2000';

test('sync includes pre-existing old records on first connection, retries partial failures, then skips acknowledged content', async () => {
  const app = await startServer({ INGEST_TOKEN: 'sync-token' });
  const stateDir = mkdtempSync(join(tmpdir(), 'sync-state-'));
  const snapshot = { daily: [usage()], sessions: [], time: Array.from({ length: 1001 }, (_, i) => event({ eventKey: `e-${i}`, eventTime: '2026-01-01T00:00:00.000Z' })) };
  const options = { url: app.base + '/api/ingest', token: 'sync-token', device: 'laptop', snapshot, stateDir };
  try {
    let calls = 0;
    await assert.rejects(syncSnapshot({ ...options, fetcher: async (...args) => { if (++calls === 2) throw new Error('offline'); return fetch(...args); } }), /offline/);
    const retried = await syncSnapshot(options);
    assert.equal(retried.rows.time, 1001, 'failure must not advance the acknowledgment');
    const stored = await (await fetch(app.base + `/api/time?${dateQuery}`, { headers: { authorization: 'Bearer sync-token' } })).json();
    assert.equal(stored.time.length, 1001, 'retry must not duplicate accepted events');
    assert.equal((await syncSnapshot(options)).requests, 0);
    snapshot.time[0].costUSD = 2;
    assert.equal((await syncSnapshot(options)).rows.time, 1, 'old event corrections must sync regardless of event timestamp');
    const secondTarget = await startServer({ INGEST_TOKEN: 'sync-token' });
    try { assert.equal((await syncSnapshot({ ...options, url: secondTarget.base + '/api/ingest' })).rows.time, 1001); }
    finally { await secondTarget.close(); }
  } finally { await app.close(); rmSync(stateDir, { recursive: true, force: true }); }
});
