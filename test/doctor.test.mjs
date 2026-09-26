import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { supportedNode, inspectRoot } from '../src/doctor-checks.mjs';
import { onboardingFixture } from './helpers/onboarding.mjs';

const report = (f, env = {}, args = []) => {
  const result = f.run('src/doctor.mjs', ['--json', ...args], env);
  assert.equal(result.error, undefined);
  return { ...JSON.parse(result.stdout), exit: result.status, output: result.stdout + result.stderr };
};
const check = (r, id) => r.checks.find(check => check.id === id);

test('doctor diagnoses a fresh installation without creating a database or cache', () => {
  const f = onboardingFixture();
  try {
    const r = report(f);
    assert.equal(r.exit, 0, r.output);
    assert.equal(check(r, 'database').status, 'warn');
    assert.equal(check(r, 'source.pi').details.roots[0].state, 'empty');
    assert.equal(check(r, 'source.hermes').details.roots[0].state, 'missing');
    assert.equal(check(r, 'frontend').status, 'warn');
    assert.equal(existsSync(f.dbPath), false);
    assert.equal(existsSync(join(f.root, 'cache')), false);
    assert.equal(existsSync(join(f.root, 'data')), false);
    mkdirSync(join(f.root, 'dist'));
    writeFileSync(join(f.root, 'dist/index.html'), '<html></html>');
    assert.equal(check(report(f), 'frontend').status, 'ok');
  } finally { f.close(); }
});

test('doctor reports invalid config, timezone, binding, arguments and DB URLs without leaking values', () => {
  const f = onboardingFixture();
  const secret = 'private-sentinel-DO-NOT-PRINT';
  try {
    for (const content of ['{invalid json', '{"collectors":{"pi":{"roots":"wrong-type"}}}', 'null']) {
      writeFileSync(f.config, content);
      const r = report(f, { DATABASE_URL: `bad://${secret}`, DISPLAY_TZ: secret, HOST: '0.0.0.0', INGEST_TOKEN: '' });
      assert.equal(r.exit, 1);
      for (const id of ['config', 'timezone', 'access', 'database']) assert.equal(check(r, id).status, 'error', id);
      assert.ok(!r.output.includes(secret));
    }
    const r = report(f, { AI_TOKEN_DASHBOARD_CONFIG: join(f.root, secret) });
    assert.equal(check(r, 'config').status, 'error');
    assert.ok(!r.output.includes(secret));
    assert.equal(report(f, {}, ['--unknown']).exit, 2);
    assert.equal(report(f, {}, ['--device']).exit, 2);
  } finally { f.close(); }
});

test('doctor reads latest runs for the selected device, preserves DB bytes and hides raw messages', () => {
  const f = onboardingFixture();
  try {
    assert.equal(f.run('src/db-init.mjs').status, 0);
    const db = new DatabaseSync(f.dbPath);
    db.exec('PRAGMA journal_mode=DELETE');
    const insert = db.prepare('INSERT INTO collection_runs(device, source, status, message, collected_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('device-a', 'Pi Agent', 'error', 'private-error', '2026-09-01T00:00:00Z');
    insert.run('device-a', 'Pi Agent', 'ok', 'private-path', '2026-09-02T00:00:00Z');
    insert.run('device-b', 'Pi Agent', 'error', 'private-secret', '2026-09-03T00:00:00Z');
    db.close();
    const before = readFileSync(f.dbPath);
    const r = report(f, {}, ['--device', 'device-a']);
    assert.equal(r.exit, 0, r.output);
    assert.equal(check(r, 'database.schema').status, 'ok');
    assert.equal(check(r, 'collection.pi').status, 'ok');
    assert.ok(!r.output.includes('private-'));
    assert.deepEqual(readFileSync(f.dbPath), before);
    assert.equal(check(report(f, {}, ['--device', 'device-b']), 'collection.pi').status, 'warn');
    assert.equal(existsSync(join(f.root, 'cache')), false);
    // Invalid config should not prevent the independent database check.
    writeFileSync(f.config, 'null');
    assert.equal(check(report(f), 'database.schema').status, 'ok');
  } finally { f.close(); }
});

test('doctor detects an uninitialized schema without creating tables', () => {
  const f = onboardingFixture();
  try {
    new DatabaseSync(f.dbPath).close();
    const before = readFileSync(f.dbPath);
    assert.equal(check(report(f), 'database').status, 'error');
    assert.deepEqual(readFileSync(f.dbPath), before);
  } finally { f.close(); }
});

test('doctor treats a live listener as a warning and never closes it', async () => {
  const f = onboardingFixture();
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = String(server.address().port);
    const r = report(f, { API_PORT: port });
    assert.equal(check(r, 'port.API_PORT').status, 'warn');
    assert.ok(server.listening);
    assert.equal(check(report(f, { API_PORT: port, CLIENT_PORT: port }), 'ports').status, 'error');
    assert.equal(check(report(f, { CLIENT_PORT: 'NaN' }), 'port.CLIENT_PORT').status, 'error');
  } finally { await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('source metadata scan is bounded, distinguishes missing/empty/wrong type and never parses logs', async () => {
  const f = onboardingFixture();
  const root = { path: f.sessions, kind: 'directory', match: name => name.endsWith('.jsonl') };
  try {
    writeFileSync(join(f.sessions, 'unparseable.jsonl'), 'not JSON and should never be parsed');
    const result = await inspectRoot(root);
    assert.equal(result.candidates, 1);
    assert.equal(result.state, 'readable');
    assert.equal((await inspectRoot(root, { limit: 0 })).incomplete, true);
    assert.equal((await inspectRoot({ ...root, path: f.config })).state, 'invalid');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(f.sessions, 0);
      try { assert.equal((await inspectRoot(root)).state, 'unreadable'); }
      finally { chmodSync(f.sessions, 0o700); }
    }
  } finally { f.close(); }
});

test('runtime version check rejects runtimes before the supported SQLite baseline', () => {
  for (const version of ['20.20.0', '22.14.0']) assert.equal(supportedNode(version), false);
  for (const version of ['22.15.0', '22.22.2', '24.0.0']) assert.equal(supportedNode(version), true);
});
