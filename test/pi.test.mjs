import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cache = mkdtempSync(join(tmpdir(), 'pi-test-cache-'));
process.env.AI_TOKEN_DASHBOARD_CACHE_DIR = cache;
after(() => rmSync(cache, { recursive: true, force: true }));
const { collect, parseSessionFile, sessionRoots } = await import('../src/collectors/pi.mjs');
const T = Date.now() - 60000;
const usage = { input: 100, output: 40, cacheRead: 300, cacheWrite: 20, reasoning: 10,
  totalTokens: 460, cost: { total: 0.25 } };
const pricing = { 'model-one': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
  cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.2e-6 } };

function header(id, extra = {}) {
  return { type: 'session', version: 3, id, cwd: '/work/project', timestamp: new Date(T - 1000).toISOString(), ...extra };
}

function reply(id, extra = {}) {
  return { type: 'message', id, parentId: null, timestamp: new Date(T).toISOString(),
    message: { role: 'assistant', model: 'model-one', provider: 'test-provider', stopReason: 'stop', usage }, ...extra };
}

async function withSessions(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'pi-test-sessions-'));
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  for (const [path, rows] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  }
  try { return await run(root); } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('Pi preserves additive totals and the log cost across all output views', async () => {
  await withSessions({ 'project/session.jsonl': [header('s'), reply('a')] }, async () => {
    const result = await collect(pricing);
    const event = result.eventsJson.events[0];
    assert.equal(event.client, 'pi');
    assert.equal(event.workspaceKey, '/work/project');
    assert.deepEqual(event.tokens, { input: 100, output: 30, cacheRead: 300, cacheWrite: 20, reasoning: 10 });
    assert.equal(Object.values(event.tokens).reduce((a, b) => a + b), usage.totalTokens);
    assert.equal(event.cost, 0.25);
    assert.equal(result.graphJson.contributions[0].clients[0].cost, 0.25);
    assert.equal(result.modelsJson.entries[0].cost, 0.25);
    assert.deepEqual(await collect(pricing), result);
  });
});

test('zero cost is retained; missing and invalid costs use per-call pricing', async () => {
  const messages = [0, undefined, -1, 'invalid'].map((cost, index) => reply(`a${index}`, {
    message: { role: 'assistant', model: 'model-one', usage: { ...usage, cost: { total: cost } } }
  }));
  await withSessions({ 's.jsonl': [header('s'), ...messages] }, async () => {
    const { eventsJson } = await collect(pricing);
    assert.equal(eventsJson.events[0].cost, 0);
    for (const event of eventsJson.events.slice(1)) {
      assert.ok(Math.abs(event.cost - (100e-6 + 40 * 2e-6 + 300e-7 + 20 * 1.2e-6)) < 1e-12);
    }
  });
});

test('model and provider fallbacks follow the tree, including billed summaries', async () => {
  const change = (id, parentId, modelId) => ({ type: 'model_change', id, parentId, modelId, provider: 'provider' });
  const summary = (id, parentId, type) => ({ type, id, parentId, timestamp: T, usage });
  await withSessions({ 's.jsonl': [header('s'), change('m1', null, 'branch-a'), change('m2', 'm1', 'branch-b'),
    summary('a', 'm1', 'compaction'), summary('b', 'm2', 'branch_summary'),
    reply('c', { parentId: 'm1', message: { role: 'assistant', model: 'alias', responseModel: 'actual', usage } })
  ] }, async () => {
    const { eventsJson } = await collect();
    assert.deepEqual(eventsJson.events.map(event => event.model), ['branch-a', 'branch-b', 'actual']);
    assert.ok(eventsJson.events.every(event => event.provider === 'provider'));
  });
});

test('fork copies are excluded only for a matching scanned parent', async () => {
  const copied = reply('copied');
  await withSessions({
    'parent.jsonl': [header('parent'), copied, reply('abandoned-branch')],
    'child.jsonl': [header('child', { parentSession: './parent.jsonl', timestamp: T + 1000 }), copied, reply('child-new')],
    'orphan.jsonl': [header('orphan', { parentSession: './missing.jsonl', timestamp: T + 1000 }), copied],
    'unrelated.jsonl': [header('unrelated'), copied]
  }, async () => {
    const result = await collect();
    const ids = result.eventsJson.events.map(event => event.sessionId);
    assert.equal(ids.filter(id => id === 'parent').length, 2, 'abandoned branches still incurred usage');
    assert.equal(ids.filter(id => id === 'child').length, 1);
    assert.equal(ids.filter(id => id === 'orphan').length, 1);
    assert.equal(ids.filter(id => id === 'unrelated').length, 1);
  });
});

test('fork identity includes tokens, model and cost, and never matches future records', async () => {
  const changed = reply('same', { message: { role: 'assistant', model: 'model-two', usage: { ...usage, cost: { total: 0.5 } } } });
  await withSessions({
    'parent.jsonl': [header('parent'), reply('same'), reply('future', { timestamp: T + 5000 })],
    'child.jsonl': [header('child', { parentSession: 'parent.jsonl', timestamp: T + 1000 }), changed, reply('future', { timestamp: T + 5000 })]
  }, async () => {
    assert.equal((await collect()).eventsJson.events.length, 4);
  });
});

test('nested fork lineage deduplicates but cycles retain usage', async () => {
  const copied = reply('copy');
  await withSessions({
    'a.jsonl': [header('a'), copied],
    'b.jsonl': [header('b', { parentSession: 'a.jsonl', timestamp: T + 1000 }), copied],
    'c.jsonl': [header('c', { parentSession: 'b.jsonl', timestamp: T + 2000 }), copied, reply('new')],
    'x.jsonl': [header('x', { parentSession: 'y.jsonl', timestamp: T + 1000 }), copied],
    'y.jsonl': [header('y', { parentSession: 'x.jsonl', timestamp: T + 1000 }), copied]
  }, async () => {
    assert.equal((await collect()).eventsJson.events.length, 4);
  });
});

test('copies of the same session dedupe without merging separate same-time messages', async () => {
  const rows = [header('s'), reply('a'), reply('b')];
  await withSessions({ 'original.jsonl': rows, 'backup/copy.jsonl': rows }, async () => {
    const events = (await collect()).eventsJson.events;
    assert.equal(events.length, 2);
    assert.notEqual(events[0].eventKey, events[1].eventKey);
  });
});

test('appended usage gets a new stable key and updates cached aggregation', async () => {
  await withSessions({ 's.jsonl': [header('s'), reply('a')] }, async root => {
    const before = await collect();
    appendFileSync(join(root, 's.jsonl'), JSON.stringify(reply('b')) + '\n');
    const after = await collect();
    assert.equal(after.eventsJson.events.length, 2);
    assert.equal(after.eventsJson.events[0].eventKey, before.eventsJson.events[0].eventKey);
    assert.equal(after.modelsJson.entries[0].cost, 0.5);
  });
});

test('legacy routing, malformed lines, pending messages, zero tokens and explicit tool usage', async () => {
  await withSessions({ 's.jsonl': [header('s', { version: 1 }), 'not-json', 'null',
    { type: 'model_change', modelId: 'legacy-model', provider: 'provider' },
    reply(null, { message: { role: 'assistant', usage } }),
    reply('pending', { message: { role: 'assistant', stopReason: 'pending', usage } }),
    reply('zero', { message: { role: 'assistant', usage: {} } }),
    reply('user', { message: { role: 'user', usage } }),
    reply('tool', { message: { role: 'toolResult', usage } }),
    reply('bad-time', { timestamp: 'invalid' })
  ] }, async root => {
    const parsed = await parseSessionFile(join(root, 's.jsonl'));
    assert.deepEqual(parsed.events.map(event => event.model), ['legacy-model', 'unknown']);
    await collect();
    const stored = readFileSync(join(cache, 'pi.json'), 'utf8');
    assert.ok(!stored.includes('not-json'), 'cache must not retain raw transcript content');
  });
});

test('timestamp forms agree, reasoning is clamped, and local midnight changes the date', async () => {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const ms = midnight.getTime();
  await withSessions({ 's.jsonl': [header('s'), reply('a', { timestamp: ms - 1000 }),
    reply('b', { timestamp: (ms + 1000) / 1000 }), reply('c', {
      timestamp: new Date(ms + 1000).toISOString(), message: { role: 'assistant', usage: { ...usage, reasoning: 999 } }
    })] }, async () => {
    const result = await collect();
    assert.equal(result.graphJson.contributions.length, 2);
    assert.equal(result.eventsJson.events[1].eventTime, result.eventsJson.events[2].eventTime);
    assert.equal(result.eventsJson.events[2].tokens.reasoning, 40);
    assert.equal(result.eventsJson.events[2].tokens.output, 0);
  });
});

test('missing session directories yield empty results and env paths use official semantics', async () => {
  await withSessions({}, async root => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = '/custom/pi-agent';
      assert.deepEqual(sessionRoots(), [root]);
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      assert.deepEqual(sessionRoots(), ['/custom/pi-agent/sessions']);
      process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'missing');
      assert.deepEqual(await collect(), { graphJson: { contributions: [] }, modelsJson: { entries: [] }, eventsJson: { events: [] } });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
