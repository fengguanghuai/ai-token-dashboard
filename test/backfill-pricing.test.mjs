import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../src/db.mjs';
import { readSnapshot, writeSnapshot } from '../src/usage-store.mjs';
import { usage, event } from './helpers/server.mjs';

test('backfill previews, preserves recorded zero, and fills only complete stored event costs with a backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pricing-recovery-'));
  const path = join(root, 'usage.sqlite');
  const db = await openDb(path);
  const run = (...args) => spawnSync(process.execPath, [resolve('src/backfill-pricing.mjs'), '--db', path, ...args], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  try {
    await writeSnapshot(db, { daily: [usage({ costUSD: 0 }), usage({ model: 'recorded-zero', costUSD: 0, costBasis: 'recorded' }),
      usage({ model: 'no-detail', costUSD: 0 }), usage({ model: 'incomplete', costUSD: 0 })],
    time: [event(), event({ model: 'recorded-zero', eventKey: 'zero' }), event({ model: 'incomplete', eventKey: 'incomplete', inputTokens: 99, outputTokens: 11 })], sessions: [] });
    let result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /recoverable=1/);
    assert.equal((await readSnapshot(db)).daily.reduce((n, r) => n + r.costUSD, 0), 0);
    result = run('--apply'); assert.equal(result.status, 0, result.stderr);
    const after = await readSnapshot(db);
    assert.equal(after.daily.find(row => row.model === 'test-model').costUSD, 1);
    assert.ok(after.daily.filter(row => row.model !== 'test-model').every(row => row.costUSD === 0));
    assert.equal(readdirSync(join(root, 'data', 'backups')).length, 1);
  } finally { await db.close(); rmSync(root, { recursive: true, force: true }); }
});
