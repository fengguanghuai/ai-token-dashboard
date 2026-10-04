// The frozen schema is from 193277e1d5a8f71c90c192e926e12db42032c729,
// before PR #30 introduced the sync journal. All data below is synthetic.
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.mjs';
import { syncDatabase } from '../src/sync.mjs';
import { onboardingFixture } from '../test/helpers/onboarding.mjs';
import { startServer } from '../test/helpers/server.mjs';

const f = onboardingFixture();
const backup = join(f.root, 'before-upgrade.sqlite');
const tables = ['daily_usage', 'time_usage', 'session_usage'];
let db, hub;
function run(script, args = []) {
  const result = f.run(script, args);
  assert.equal(result.status, 0, `${script}: ${result.stderr}`);
}
function history(path) {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return tables.map(table => reader.prepare(`SELECT * FROM ${table} WHERE device = 'upgrade' ORDER BY rowid`).all());
  } finally { reader.close(); }
}
try {
  const legacy = new DatabaseSync(f.dbPath);
  try {
    legacy.exec(readFileSync(new URL('../test/fixtures/pre-journal.sqlite.sql', import.meta.url), 'utf8'));
    // Recorded zero, unusual historical estimate, and unknown provenance must
    // survive schema initialization without being repriced from today's rates.
    for (const [i, cost, basis] of [[1, 0, 'recorded'], [2, 4.00001, 'estimated'], [3, 8.345668, 'legacy_unknown']]) {
      const date = `2026-06-0${i}`, time = `${date}T12:00:00.000Z`;
      const common = ['upgrade', 'Codex CLI', 100, 10, 110, cost, time];
      const columns = 'device, source, input_tokens, output_tokens, total_tokens, cost_usd, updated_at';
      legacy.prepare(`INSERT INTO daily_usage (${columns}, usage_date, model, cost_basis, pricing_version, pricing_locked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...common, date, 'retired-model', basis, 'historical-price', time);
      legacy.prepare(`INSERT INTO time_usage (${columns}, event_key, event_time, usage_date, model, project_path, session_id, cost_basis, pricing_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...common, `event-${i}`, time, date, 'retired-model', '/synthetic/legacy', `session-${i}`, basis, 'historical-price');
      legacy.prepare(`INSERT INTO session_usage (${columns}, session_id, project_path, last_activity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...common, `session-${i}`, '/synthetic/legacy', time);
    }
  } finally { legacy.close(); }
  // Same read-only, consistent SQLite backup command documented for operators.
  const backupReader = new DatabaseSync(f.dbPath, { readOnly: true });
  try { backupReader.prepare('VACUUM INTO ?').run(backup); }
  finally { backupReader.close(); }
  const before = history(backup);
  run('src/db-init.mjs');
  run('src/db-init.mjs');
  assert.deepEqual(history(f.dbPath), before, 'repeated upgrades must preserve every historical usage field');
  f.seed();
  run('src/collect.mjs', ['--device', 'onboarding', '--source', 'Pi Agent']);
  assert.deepEqual(history(f.dbPath), before, 'new collection must preserve unrelated historical usage');

  hub = await startServer({ INGEST_TOKEN: 'synthetic-upgrade-token' });
  const options = { url: hub.base + '/api/ingest', token: 'synthetic-upgrade-token', device: 'upgrade' };
  db = await openDb(f.dbPath);
  const baseline = await syncDatabase({ ...options, db });
  assert.deepEqual(baseline.rows, { daily: 3, time: 3, sessions: 3 });
  await db.close(); db = await openDb(f.dbPath);
  assert.equal((await syncDatabase({ ...options, db })).requests, 0, 'acknowledgment must survive restart');
  const remote = new DatabaseSync(join(hub.root, 'usage.sqlite'), { readOnly: true });
  try {
    for (let i = 0; i < tables.length; i++) {
      const stored = remote.prepare(`SELECT * FROM ${tables[i]} ORDER BY rowid`).all();
      assert.equal(stored.length, before[i].length);
      for (let j = 0; j < stored.length; j++) {
        for (const key of Object.keys(before[i][j]).filter(key => !['updated_at', 'pricing_locked_at'].includes(key))) {
          assert.equal(stored[j][key], before[i][j][key], `${tables[i]}.${key}`);
        }
      }
    }
  } finally { remote.close(); }
  assert.deepEqual(history(f.dbPath), before);
  await db.close(); db = null;

  // All writers to this disposable DB are stopped before swapping files.
  for (const suffix of ['', '-wal', '-shm']) rmSync(f.dbPath + suffix, { force: true });
  copyFileSync(backup, f.dbPath);
  assert.deepEqual(history(f.dbPath), before, 'rollback must restore the complete pre-upgrade history');
  const restored = new DatabaseSync(f.dbPath, { readOnly: true });
  try { assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'sync_%'").get().n, 0); }
  finally { restored.close(); }
  run('src/db-init.mjs');
  assert.deepEqual(history(f.dbPath), before, 'restored database must remain upgradeable');
  console.log('Upgrade passed: frozen pre-journal SQLite → backup → initialize twice → collect → HTTP baseline → restart/no-op sync → restore/re-upgrade; historical fields preserved.');
} finally {
  if (db) await db.close();
  if (hub) await hub.close();
  f.close();
}
