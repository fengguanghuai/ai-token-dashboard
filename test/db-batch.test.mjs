import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import {
  batchUpsertDaily, batchUpsertSession, batchUpsertTimeUsage, getTimeWatermark
} from '../src/db-batch.mjs';

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

function dailyRow(overrides = {}) {
  return {
    device: 'D', source: 'S', usageDate: '2026-01-01', model: 'm',
    inputTokens: 5, outputTokens: 3, cacheCreationTokens: 1, cacheReadTokens: 2,
    reasoningOutputTokens: 1, totalTokens: 12, costUSD: 1, ...overrides
  };
}

test('batchUpsertDaily keeps historical cost locked but updates tokens', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    await batchUpsertDaily(db, [dailyRow()]); // 历史日期,首次写入
    await batchUpsertDaily(db, [dailyRow({ costUSD: 99, totalTokens: 20 })]);
    const row = await db.get('SELECT cost_usd, total_tokens, pricing_locked_at FROM daily_usage WHERE usage_date = ?', ['2026-01-01']);
    assert.equal(row.cost_usd, 1, 'historical cost must stay locked');
    assert.equal(row.total_tokens, 20, 'tokens still update');
    assert.ok(row.pricing_locked_at, 'lock timestamp set for historical dates');
    await db.close();
  } finally { cleanup(); }
});

test('batchUpsertDaily updates cost for today', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD 本地时区
    await batchUpsertDaily(db, [dailyRow({ usageDate: today, costUSD: 1 })]);
    await batchUpsertDaily(db, [dailyRow({ usageDate: today, costUSD: 2 })]);
    const row = await db.get('SELECT cost_usd, pricing_locked_at FROM daily_usage WHERE usage_date = ?', [today]);
    assert.equal(row.cost_usd, 2);
    assert.equal(row.pricing_locked_at, null);
    await db.close();
  } finally { cleanup(); }
});

test('batchUpsertSession upserts by (device, source, session_id)', async () => {
  const { path, cleanup } = tmpDbPath();
  try {
    const db = await openDb(path);
    const row = {
      device: 'D', source: 'S', sessionId: 'sess1', lastActivity: '2026-07-19T00:00:00Z',
      projectPath: '/p', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0,
      cacheReadTokens: 0, reasoningOutputTokens: 0, totalTokens: 2, costUSD: 0.1
    };
    await batchUpsertSession(db, [row]);
    await batchUpsertSession(db, [{ ...row, totalTokens: 5, costUSD: 0.2 }]);
    const { c } = await db.get('SELECT COUNT(*) AS c FROM session_usage');
    assert.equal(c, 1);
    const got = await db.get('SELECT total_tokens, cost_usd FROM session_usage WHERE session_id = ?', ['sess1']);
    assert.equal(got.total_tokens, 5);
    assert.equal(got.cost_usd, 0.2);
    await db.close();
  } finally { cleanup(); }
});
