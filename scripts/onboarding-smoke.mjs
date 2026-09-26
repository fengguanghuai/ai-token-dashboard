// Runs entirely against synthetic logs and a temporary SQLite database.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { onboardingFixture } from '../test/helpers/onboarding.mjs';
import { startServer } from '../test/helpers/server.mjs';

const f = onboardingFixture();
let server;
function run(script, args = []) {
  const result = f.run(script, args);
  assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  return result.stdout;
}
try {
  const first = JSON.parse(run('src/doctor.mjs', ['--json', '--device', 'onboarding']));
  assert.equal(first.checks.find(check => check.id === 'database').status, 'warn');
  assert.equal(existsSync(f.dbPath), false);
  run('src/db-init.mjs');
  f.seed();
  const collectArgs = ['--device', 'onboarding', '--source', 'Pi Agent'];
  run('src/collect.mjs', collectArgs);
  run('src/collect.mjs', collectArgs);
  run('src/db-check.mjs');
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    for (const table of ['daily_usage', 'time_usage', 'session_usage']) {
      const row = db.prepare(`SELECT COUNT(*) AS count, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost FROM ${table}`).get();
      assert.deepEqual({ ...row }, { count: 1, tokens: 110, cost: 0.25 }, `${table} must be idempotent`);
    }
  } finally { db.close(); }
  const ready = JSON.parse(run('src/doctor.mjs', ['--json', '--device', 'onboarding']));
  assert.equal(ready.summary.error, 0);
  assert.equal(ready.checks.find(check => check.id === 'collection.pi').status, 'ok');
  server = await startServer(f.env, { staticDir: resolve('dist') });
  for (const path of ['/', '/review']) {
    const page = await fetch(server.base + path);
    assert.equal(page.status, 200);
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
    assert.ok(assets.length > 0, 'built page must reference assets');
    for (const asset of assets) assert.equal((await fetch(server.base + asset)).status, 200);
  }
  const dataResponse = await fetch(server.base + '/api/data');
  assert.equal(dataResponse.status, 200);
  const data = await dataResponse.json();
  assert.equal(data.daily.length, 1);
  assert.equal(data.daily[0].totalTokens, 110);
  assert.equal(data.daily[0].costUSD, 0.25);
  assert.equal((await fetch(server.base + '/api/hourly')).status, 200);
  console.log('Onboarding passed: doctor → db:init → collect twice → db:check → built pages/assets → usage APIs (110 tokens, $0.25, no duplicates).');
} finally {
  if (server) await server.close();
  f.close();
}
