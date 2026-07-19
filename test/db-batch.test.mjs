import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { batchUpsertTimeUsage, getTimeWatermark } from '../src/db-batch.mjs';

function tmpDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'tokbatch-'));
  return { path: join(dir, 'usage.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function timeRow(i) {
  return {
    device: 'D', source: 'S', eventKey: `k${i}`,
    eventTime: `2026-07-10T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
    usageDate: '2026-07-10', model: 'm', projectPath: null, sessionId: null,
    inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0,
    reasoningOutputTokens: 0, totalTokens: 2, costUSD: 0.001
  };
}

test('batchUpsertTimeUsage crosses chunk boundaries and is idempotent', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    const rows = Array.from({ length: 401 }, (_, i) => timeRow(i));
    await batchUpsertTimeUsage(db, rows);
    let { c } = await db.get('SELECT COUNT(*) AS c FROM time_usage');
    assert.equal(c, 401);
    await batchUpsertTimeUsage(db, rows); // 重跑不产生重复
    ({ c } = await db.get('SELECT COUNT(*) AS c FROM time_usage'));
    assert.equal(c, 401);
    await batchUpsertTimeUsage(db, []); // 空批不报错
    await db.close();
  } finally { cleanup(); }
});

test('getTimeWatermark returns MAX(event_time) per device+source, null when empty', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    assert.equal(await getTimeWatermark(db, 'D', 'S'), null);
    await batchUpsertTimeUsage(db, [timeRow(1), timeRow(2)]);
    const wm = await getTimeWatermark(db, 'D', 'S');
    assert.equal(wm, '2026-07-10T00:00:02.002Z');
    assert.equal(await getTimeWatermark(db, 'D', 'other'), null);
    await db.close();
  } finally { cleanup(); }
});
