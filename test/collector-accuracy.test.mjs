import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

const root = mkdtempSync(join(tmpdir(), 'collector-accuracy-'));
after(() => rmSync(root, { recursive: true, force: true }));
const paths = Object.fromEntries(['claude', 'codex', 'opencode', 'openclaw', 'hermes'].map(name => [name, join(root, name)]));
for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
process.env.AI_TOKEN_DASHBOARD_CONFIG = join(root, 'config.json');
process.env.AI_TOKEN_DASHBOARD_CACHE_DIR = join(root, 'cache');
process.env.CLAUDE_CONFIG_DIR = paths.claude;
process.env.CODEX_HOME = paths.codex;
process.env.HERMES_HOME = paths.hermes;
delete process.env.OPENCODE_DB;
writeFileSync(process.env.AI_TOKEN_DASHBOARD_CONFIG, JSON.stringify({ collectors: {
  codex: { sessionSubdirs: ['sessions'], headlessRoots: [] },
  opencode: { dataDir: paths.opencode }, openclaw: { agentRoots: [paths.openclaw] }
} }));
const claude = await import('../src/collectors/claude-code.mjs');
const codex = await import('../src/collectors/codex.mjs');
const opencode = await import('../src/collectors/opencode.mjs');
const openclaw = await import('../src/collectors/openclaw.mjs');
const hermes = await import('../src/collectors/hermes.mjs');
const now = Date.now() - 60_000;
const timestamp = new Date(now).toISOString();
const pricing = { 'audit-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const totals = result => result.graphJson.contributions.flatMap(day => day.clients)
  .reduce((n, row) => n + Object.values(row.tokens).reduce((a, b) => a + b, 0), 0);

test('Codex bills inclusive output once and daily cost equals request costs', async () => {
  const usage = { input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40 };
  write(join(paths.codex, 'sessions', 's.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 's' } },
    { type: 'turn_context', payload: { model: 'audit-model' } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } }
  ]));
  const result = await codex.collect(pricing);
  const expected = 100 * 2e-6;
  assert.equal(result.eventsJson.events[0].cost, expected);
  assert.equal(result.graphJson.contributions[0].clients[0].cost, expected);
  assert.equal(result.modelsJson.entries[0].cost, expected);
});

test('Claude excludes replayed sidechain records and keeps advisor and independent sessions', async () => {
  const record = { type: 'assistant', sessionId: 'parent', timestamp, requestId: 'request',
    message: { id: 'reply', model: 'audit-model', usage: { input_tokens: 100, output_tokens: 10,
      iterations: [{ type: 'advisor_message', model: 'advisor-model', input_tokens: 20, output_tokens: 5 }] } } };
  write(join(paths.claude, 'projects', 'p', 'parent.jsonl'), jsonl([record]));
  write(join(paths.claude, 'projects', 'p', 'subagents', 'child.jsonl'), jsonl([
    { ...record, isSidechain: true, requestId: 'replay' }
  ]));
  let result = await claude.collect(pricing);
  assert.equal(totals(result), 135);
  assert.deepEqual(new Set(result.modelsJson.entries.map(row => row.model)), new Set(['audit-model', 'advisor-model']));
  assert.deepEqual(await claude.collect(pricing), result, 'cache must not change aggregation');
  write(join(paths.claude, 'projects', 'p', 'other.jsonl'), jsonl([{ ...record, sessionId: 'independent' }]));
  result = await claude.collect(pricing);
  assert.equal(totals(result), 270);
  assert.equal(new Set(result.eventsJson.events.map(row => row.eventKey)).size, 4);
});

test('OpenCode no-id filenames are scoped to their paths', async () => {
  for (const [session, input] of [['a', 100], ['b', 200]]) {
    write(join(paths.opencode, 'storage', 'message', session, 'same.json'), JSON.stringify({
      role: 'assistant', sessionID: session, modelID: 'audit-model', time: { created: now },
      tokens: { input, output: input / 10 }
    }));
  }
  assert.equal(totals(await opencode.collect(pricing)), 330);
});

test('Claude keeps idless same-time replies and late advisor usage snapshots', async () => {
  const before = totals(await claude.collect(pricing));
  const message = { type: 'assistant', sessionId: 'streamed', timestamp,
    message: { id: 'new-reply', model: 'audit-model', usage: { input_tokens: 10, output_tokens: 1 } } };
  const completed = { ...message, message: { ...message.message, usage: { ...message.message.usage,
    iterations: [{ type: 'advisor_message', model: 'advisor-model', input_tokens: 20, output_tokens: 2 }] } } };
  const idless = { ...message, message: { model: 'audit-model', usage: { input_tokens: 3, output_tokens: 0 } } };
  write(join(paths.claude, 'projects', 'p', 'streamed.jsonl'), jsonl([message, completed, idless, idless, null]));
  assert.equal(totals(await claude.collect(pricing)) - before, 39);
});

test('OpenCode reads both SQLite schemas and refreshes live WAL writes', async () => {
  const path = join(paths.opencode, 'opencode.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('s', '/work/example');`);
    const payload = { model: { id: 'audit-model', providerID: 'test' }, tokens: { input: 10, output: 5 } };
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run('new', 's', 'assistant', now, JSON.stringify(payload));
    const legacy = { role: 'assistant', modelID: 'audit-model', time: { created: now }, tokens: { input: 10, output: 5 } };
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('old', 's', JSON.stringify(legacy));
    // Identical token values do not prove that two distinct message IDs are copies.
    assert.equal(totals(await opencode.collect(pricing)), 360);
    db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({ ...payload, tokens: { input: 30, output: 5 } }), 'new');
    assert.equal(totals(await opencode.collect(pricing)), 380);
  } finally { db.close(); }
});

test('Hermes prefers per-model rows but retains sessions without detail', async () => {
  const db = new DatabaseSync(join(paths.hermes, 'state.db'));
  try {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, billing_provider TEXT, started_at REAL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL);
      CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL);`);
    const session = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?)');
    session.run('multi', 'final-model', 'a', now, 300, 30, 0.3);
    session.run('legacy', 'audit-model', 'a', now, 50, 5, 0.1);
    const detail = db.prepare('INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)');
    detail.run('multi', 'first-model', 'a', 100, 10, 0, 0.1);
    detail.run('multi', 'final-model', 'b', 200, 20, 0.2, 0.9);
  } finally { db.close(); }
  const result = await hermes.collect(pricing);
  assert.equal(totals(result), 385);
  assert.equal(result.eventsJson.events.length, 3);
  assert.equal(new Set(result.eventsJson.events.map(row => row.eventKey)).size, 3);
  assert.ok(Math.abs(result.modelsJson.entries.reduce((n, row) => n + row.cost, 0) - 0.4) < 1e-12);
});

test('OpenClaw reads SQLite and archives once, excludes checkpoints, preserves reported zero cost', async () => {
  const agent = join(paths.openclaw, 'main');
  mkdirSync(join(agent, 'agent'), { recursive: true });
  const header = { type: 'session', id: 'session', version: 3 };
  const reply = { type: 'message', id: 'reply', timestamp, message: { role: 'assistant', model: 'audit-model',
    usage: { input: 100, output: 10, cost: { total: 0 } } } };
  const rows = [header, reply];
  const db = new DatabaseSync(join(agent, 'agent', 'openclaw-agent.sqlite'));
  try {
    db.exec(`CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);
      CREATE TABLE session_transcript_archives (session_id TEXT, generation TEXT, archive_blob BLOB, created_at INTEGER);`);
    const insert = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?)');
    rows.forEach((row, index) => insert.run('session', index, JSON.stringify(row), now));
    db.prepare('INSERT INTO session_transcript_archives VALUES (?, ?, ?, ?)').run('session', 'old', Buffer.from(jsonl(rows)), now);
  } finally { db.close(); }
  write(join(agent, 'sessions', 'session.jsonl'), jsonl(rows));
  write(join(agent, 'session-sqlite-import-archive', 'old.jsonl.gz'), gzipSync(jsonl(rows)));
  write(join(agent, 'sessions', 'checkpoints', 'snapshot.jsonl'), jsonl([header, { ...reply, id: 'snapshot' }]));
  write(join(agent, 'sessions', 'second.jsonl.gz'), gzipSync(jsonl([{ ...header, id: 'second' }, { ...reply, id: 'new' }])));
  const result = await openclaw.collect(pricing);
  assert.equal(totals(result), 220);
  assert.equal(result.eventsJson.events.length, 2);
  assert.equal(result.modelsJson.entries[0].cost, 0);
  assert.deepEqual(await openclaw.collect(pricing), result);
});

test('OpenClaw owns dedicated Codex turns and replaces only mirrors with readable rollouts', async () => {
  const agent = join(paths.openclaw, 'main');
  const home = join(agent, 'agent', 'codex-home');
  const mirror = (turn, input) => ({ type: 'message', id: turn, timestamp,
    message: { role: 'assistant', model: 'audit-model', idempotencyKey: `codex-app-server:thread:${turn}:assistant`,
      usage: { input, output: 2, cost: { total: 0.8 } } } });
  write(join(agent, 'sessions', 'mirror.jsonl'), jsonl([
    { type: 'session', id: 'owner' }, mirror('known', 1000), mirror('missing', 20)
  ]));
  const usage = { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 4 };
  write(join(home, 'sessions', 'thread.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'thread' } },
    { type: 'turn_context', payload: { model: 'audit-model', turn_id: 'known' } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } }
  ]));
  const result = await openclaw.collect(pricing);
  assert.equal(totals(result), 352);
  assert.equal(result.eventsJson.events.length, 4);
  const originalHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = home;
    assert.equal(totals(await codex.collect(pricing)), 0, 'dedicated agent logs are not also Codex CLI usage');
  } finally { process.env.CODEX_HOME = originalHome; }
});
