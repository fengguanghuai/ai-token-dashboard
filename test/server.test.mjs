import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startServer, event, usage } from './helpers/server.mjs';
import { serverAccess } from '../src/http-security.mjs';

const range = 'start=2026-09-01T00:00:00.000Z&end=2026-09-02T00:00:00.000Z';

test('HTTP: static directories return 404 and leave the server alive', async () => {
  const app = await startServer();
  try {
    assert.equal((await fetch(app.base + '/assets')).status, 404);
    assert.equal((await fetch(app.base + '/')).status, 200);
    assert.equal((await fetch(app.base + '/api/data')).status, 200);
  } finally { await app.close(); }
});

test('HTTP: read and write authentication, local origin checks, and remote startup requirements', async () => {
  assert.throws(() => serverAccess({ HOST: '0.0.0.0' }), /requires/);
  const app = await startServer({ INGEST_TOKEN: 'writer-secret', DASHBOARD_TOKEN: 'reader-secret' });
  try {
    assert.equal((await fetch(app.base + '/api/data')).status, 401);
    assert.equal((await fetch(app.base + '/')).status, 401);
    assert.equal((await fetch(app.base + '/api/data', { headers: { authorization: 'Bearer writer-secret' } })).status, 401);
    assert.equal((await fetch(app.base + '/api/data', { headers: { authorization: `Basic ${Buffer.from('user:reader-secret').toString('base64')}` } })).status, 200);
    assert.equal((await app.ingest({ daily: [usage()] }, 'reader-secret')).status, 401);
    assert.equal((await app.ingest({ daily: [usage()] })).status, 200);
    assert.equal((await fetch(app.base + '/api/collect', { method: 'POST', headers: { authorization: 'Bearer reader-secret', origin: 'https://foreign.example' } })).status, 403);
  } finally { await app.close(); }
  const local = await startServer();
  try {
    assert.equal(await new Promise((resolve, reject) => { const req = request(local.base + '/api/data', { headers: { host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }), 403);
  } finally { await local.close(); }
});

test('HTTP: reject malformed usage before mutation; full replacements require explicit scopes', async () => {
  const app = await startServer();
  try {
    for (const bad of [usage({ totalTokens: -1 }), usage({ costUSD: -1 }), usage({ inputTokens: '10' }), usage({ usageDate: '2026-02-30' })]) {
      assert.equal((await app.ingest({ daily: [bad] })).status, 400);
    }
    assert.equal((await app.ingest({ mode: 'typo' })).status, 400);
    assert.equal((await app.ingest({ mode: 'full', daily: [usage()] })).status, 400);
    assert.equal((await app.ingest({ mode: 'full', scopes: [{ device: 'other', source: 'Codex CLI' }], daily: [usage()] })).status, 400);
    assert.equal((await (await fetch(app.base + '/api/data')).json()).daily.length, 0);
    assert.equal((await app.ingest({ daily: [usage()], time: [event()] })).status, 200);
    assert.equal((await app.ingest({ daily: [usage({ model: 'second' })] })).status, 200);
    const response = await app.ingest({ mode: 'full', scopes: [{ device: 'laptop', source: 'Codex CLI' }], daily: [], time: [], sessions: [] });
    assert.equal(response.status, 200);
    assert.equal((await (await fetch(app.base + '/api/data')).json()).daily.length, 0);
    assert.equal((await (await fetch(app.base + `/api/time?${range}`)).json()).time.length, 0);
  } finally { await app.close(); }
});

test('HTTP: projects use their actual events, historical differences remain visible, and hourly buckets respect DISPLAY_TZ', async () => {
  const app = await startServer();
  try {
    await app.ingest({ daily: [usage({ totalTokens: 220, inputTokens: 200, outputTokens: 20, costUSD: 3 })], time: [event(), event({ eventKey: 'b', projectPath: '/project/B', sessionId: 'session-b' })] });
    const data = await (await fetch(app.base + '/api/data')).json();
    assert.equal(data.daily[0].projectPath, null);
    assert.deepEqual(data.projectDaily.map(row => row.projectPath).sort(), ['/project/A', '/project/B']);
    assert.equal(data.daily[0].reconciliation, 'cost_difference');
    assert.equal(data.daily[0].costUSD, 3);
    assert.equal(data.daily[0].eventCostUSD, 2);
    const hourly = await (await fetch(app.base + '/api/hourly')).json();
    assert.equal(hourly.hourly[0].hour, 8);
    await app.ingest({ time: [event({ eventKey: 'midnight', eventTime: '2026-09-01T17:00:00.000Z' })] });
    const after = await (await fetch(app.base + '/api/hourly')).json();
    assert.ok(after.hourly.some(row => row.usageDate === '2026-09-02' && row.hour === 1));
    await app.ingest({ time: [event({ eventKey: 'unknown-project', projectPath: 'session-uuid' })] });
    const projects = await (await fetch(app.base + '/api/data')).json();
    assert.ok(projects.projectDaily.some(row => row.projectPath === null), 'session identity must not be presented as a project path');
  } finally { await app.close(); }
});

test('HTTP: event pagination includes equal timestamps once, enforces ranges, and rejects invalid cursors', async () => {
  const app = await startServer();
  try {
    await app.ingest({ time: [event(), event({ eventKey: 'b' }), event({ eventKey: 'outside', eventTime: '2026-08-01T00:00:00.000Z' })] });
    const first = await (await fetch(app.base + `/api/time?${range}&limit=1`)).json();
    assert.equal(first.time.length, 1); assert.ok(first.nextCursor);
    const second = await (await fetch(app.base + `/api/time?${range}&limit=1&cursor=${first.nextCursor}`)).json();
    assert.equal(second.time.length, 1); assert.equal(second.nextCursor, null);
    assert.notEqual(first.time[0].id, second.time[0].id);
    assert.equal((await fetch(app.base + `/api/time?${range}&limit=5000`)).status, 400);
    assert.equal((await fetch(app.base + `/api/time?${range}&cursor=garbage`)).status, 400);
  } finally { await app.close(); }
});
