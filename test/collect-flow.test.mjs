import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const collector = resolve('src/collect.mjs');

test('CLI collection, late usage, full preview, backup and replacement preserve amounts and scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'collect-flow-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ collectors: { pi: { roots: [sessions] } } }));
  const dbPath = join(root, 'usage.sqlite');
  const env = { PATH: process.env.PATH, AI_TOKEN_DASHBOARD_CONFIG: config, AI_TOKEN_DASHBOARD_CACHE_DIR: join(root, 'cache'), DISPLAY_TZ: 'UTC' };
  const run = (...args) => spawnSync(process.execPath, [collector, '--db', dbPath, '--device', 'test-device', '--source', 'Pi Agent', ...args], { cwd: root, env, encoding: 'utf8' });
  const message = (id, day) => ({ type: 'message', id, timestamp: `${day}T12:00:00.000Z`, message: { role: 'assistant', model: 'test-model', usage: { input: 100, output: 10, cost: { total: 0.25 } } } });
  const save = rows => writeFileSync(join(sessions, 's.jsonl'), [{ type: 'session', version: 3, id: 's', cwd: '/project/A' }, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');
  const query = sql => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); } };
  try {
    save([message('old', '2025-01-01')]);
    let result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM time_usage')[0].n, 1, 'old events must not silently expire at collection');
    save([message('old', '2025-01-01'), message('late', '2025-01-01'), message('other-day', '2025-01-02')]);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query("SELECT cost_usd FROM daily_usage WHERE usage_date='2025-01-01'")[0].cost_usd, 0.5);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT SUM(cost_usd) cost FROM daily_usage')[0].cost, 0.75);
    save([message('other-day', '2025-01-02')]);
    result = run('--full'); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /preview/);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 2, 'preview must leave the database untouched');
    result = run('--full', '--apply'); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 1);
    assert.equal(query('SELECT SUM(cost_usd) cost FROM daily_usage')[0].cost, 0.25);
    const files = readdirSync(join(root, 'data', 'backups'));
    assert.equal(files.length, 1);
    const backup = JSON.parse(readFileSync(join(root, 'data', 'backups', files[0]), 'utf8'));
    assert.equal(backup.daily.length, 2); assert.equal(backup.time.length, 3);
    save([]);
    result = run('--full', '--apply'); assert.notEqual(result.status, 0); assert.match(result.stderr, /refusing to erase history/);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 1);
    const restore = (...args) => spawnSync(process.execPath, [resolve('src/restore-usage.mjs'), '--db', dbPath, '--file', join(root, 'data', 'backups', files[0]), ...args], { cwd: root, env, encoding: 'utf8' });
    result = restore(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 1, 'restore also defaults to preview');
    result = restore('--apply'); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 2);
    assert.equal(query('SELECT SUM(cost_usd) cost FROM daily_usage')[0].cost, 0.75);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
