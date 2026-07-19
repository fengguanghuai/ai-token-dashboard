import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, pruneCollectionRuns, upsertDaily, upsertTimeUsage,
  upsertSession, deleteTimeUsageForSource, recordRun
} from '../src/db.mjs';

function tmpDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'tokdb-'));
  return { path: join(dir, 'usage.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const dailyRow = {
  device: 'D', source: 'S', usageDate: '2026-06-22', model: 'm',
  inputTokens: 5, outputTokens: 3, cacheCreationTokens: 1, cacheReadTokens: 2,
  reasoningOutputTokens: 1, totalTokens: 12, costUSD: 0.01
};

test('openDb drops the legacy cached_input_tokens column', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    // Build a legacy daily_usage that still has cached_input_tokens.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE daily_usage (
      device TEXT NOT NULL, source TEXT NOT NULL, usage_date TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (device, source, usage_date, model))`);
    legacy.prepare(`INSERT INTO daily_usage (device,source,usage_date,model,total_tokens) VALUES ('D','S','2026-06-01','m',99)`).run();
    legacy.close();

    const db = await openDb(path);
    const cols = (await db.all('PRAGMA table_info(daily_usage)')).map(c => c.name);
    assert.ok(!cols.includes('cached_input_tokens'), 'column should be dropped');
    // existing data survives the migration
    const row = await db.get('SELECT total_tokens FROM daily_usage WHERE usage_date = ?', ['2026-06-01']);
    assert.equal(row.total_tokens, 99);
    await db.close();
  } finally {
    cleanup();
  }
});

test('an explicit SQLite path takes precedence over DATABASE_URL', async () => {
  const { path, cleanup } = tmpDbPath();
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://invalid.example/test';
  try {
    const db = await openDb(path);
    assert.equal(db.driver, 'sqlite');
    await db.close();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    cleanup();
  }
});

test('daily/time/session upserts round-trip with the current schema', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    await upsertDaily(db, dailyRow);
    await upsertTimeUsage(db, { ...dailyRow, eventKey: 'k1', eventTime: '2026-06-22T10:00:00Z' });
    await upsertSession(db, { ...dailyRow, sessionId: 's1', lastActivity: '2026-06-22' });

    assert.equal((await db.get('SELECT total_tokens FROM daily_usage')).total_tokens, 12);
    assert.equal((await db.get('SELECT cache_read_tokens FROM time_usage')).cache_read_tokens, 2);
    assert.equal((await db.get('SELECT session_id FROM session_usage')).session_id, 's1');
    await db.close();
  } finally {
    cleanup();
  }
});

test('upsertDaily updates token counts on primary-key conflict', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    await upsertDaily(db, dailyRow);
    await upsertDaily(db, { ...dailyRow, inputTokens: 50, totalTokens: 60 });
    const rows = await db.get('SELECT COUNT(*) n, MAX(total_tokens) t FROM daily_usage');
    assert.equal(rows.n, 1, 'conflict should update, not duplicate');
    assert.equal(rows.t, 60);
    await db.close();
  } finally {
    cleanup();
  }
});

test('deleteTimeUsageForSource only removes the matching device/source', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    await upsertTimeUsage(db, { ...dailyRow, source: 'S', eventKey: 'a', eventTime: '2026-06-22T10:00:00Z' });
    await upsertTimeUsage(db, { ...dailyRow, source: 'OTHER', eventKey: 'b', eventTime: '2026-06-22T11:00:00Z' });
    await deleteTimeUsageForSource(db, 'D', 'S');
    const remaining = (await db.all('SELECT source FROM time_usage')).map(r => r.source);
    assert.deepEqual(remaining, ['OTHER']);
    await db.close();
  } finally {
    cleanup();
  }
});

test('pruneCollectionRuns keeps only the newest N rows', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    for (let i = 0; i < 10; i++) {
      await recordRun(db, { device: 'D', source: 'S', status: 'ok', message: String(i), collectedAt: '2026-06-22T00:00:00Z' });
    }
    await pruneCollectionRuns(db, 3);
    const rows = (await db.all('SELECT message FROM collection_runs ORDER BY id')).map(r => r.message);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows, ['7', '8', '9'], 'should retain the most recent inserts');
    await db.close();
  } finally {
    cleanup();
  }
});

test('MySQL upserts bind every placeholder and use duplicate-key updates', async () => {
  const calls = [];
  const db = {
    driver: 'mysql',
    async run(sql, params = []) {
      assert.equal((sql.match(/\?/g) || []).length, params.length);
      calls.push({ sql, params });
    }
  };

  await upsertDaily(db, dailyRow);
  await upsertTimeUsage(db, { ...dailyRow, eventKey: 'event', eventTime: '2026-06-22T10:00:00Z' });
  await upsertSession(db, { ...dailyRow, sessionId: 'session' });

  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.sql.includes('ON DUPLICATE KEY UPDATE')));
  assert.ok(calls.every(call => /^[a-f0-9]{64}$/.test(call.params[0])), 'row keys should be SHA-256 hashes');
});
