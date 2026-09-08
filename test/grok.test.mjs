import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolve } from 'node:path';
import { loadPricing } from '../src/pricing.mjs';

// Keep cache writes out of the worktree data/ dir; set env before importing.
process.env.AI_TOKEN_DASHBOARD_CACHE_DIR = mkdtempSync(join(tmpdir(), 'grok-cache-'));
const { collect, parseSessionFile } = await import('../src/collectors/grok.mjs');

function epochSeconds(offsetMs = 0) {
  return Math.floor((Date.now() + offsetMs) / 1000);
}

function localDate(ts) {
  const d = new Date(ts * 1000);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

/**
 * Build a fake ~/.grok/sessions tree:
 *   <home>/sessions/<encoded-cwd>/<session-id>/{updates.jsonl, events.jsonl?, summary.json?}
 */
function withSessions(sessions, work) {
  const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
  const enc = encodeURIComponent('/home/dev/project');
  for (const session of sessions) {
    const dir = join(home, 'sessions', enc, session.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'updates.jsonl'), `${session.updates.map(l => JSON.stringify(l)).join('\n')}\n`);
    if (session.events) {
      writeFileSync(join(dir, 'events.jsonl'), `${session.events.map(l => JSON.stringify(l)).join('\n')}\n`);
    }
    if (session.summary) {
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(session.summary));
    }
  }
  process.env.GROK_HOME = home;
  return Promise.resolve(work()).finally(() => {
    delete process.env.GROK_HOME;
    rmSync(home, { recursive: true, force: true });
  });
}

function turnCompleted(ts, usage, sessionId = '11111111-1111-1111-1111-111111111111') {
  return {
    timestamp: ts,
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'turn_completed', usage } }
  };
}

test('single-model turn expands to one event with split tokens', async () => {
  const ts = epochSeconds();
  await withSessions([
    {
      id: '11111111-1111-1111-1111-111111111111',
      updates: [
        turnCompleted(ts, {
          inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
          cachedReadTokens: 200, cacheCreationTokens: 0, reasoningTokens: 100,
          modelCalls: 2, apiDurationMs: 5000, numTurns: 1,
          modelUsage: { 'GLM-5.3': { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedReadTokens: 200, cacheCreationTokens: 0, reasoningTokens: 100 } }
        })
      ]
    }
  ], async () => {
    const { graphJson, modelsJson, eventsJson } = await collect(null);
    assert.equal(eventsJson.events.length, 1);
    const event = eventsJson.events[0];
    assert.equal(event.model, 'glm-5.3');
    assert.equal(event.sessionId, '11111111-1111-1111-1111-111111111111');
    assert.deepEqual(event.tokens, {
      input: 800,        // 1000 - 200 cached
      output: 400,       // 500 - 100 reasoning
      cacheRead: 200,
      cacheWrite: 0,
      reasoning: 100
    });
    assert.equal(event.usageDate, localDate(ts));
    assert.match(event.eventTime, new RegExp(`^${new Date(ts * 1000).toISOString().slice(0, 10)}`));
    assert.equal(event.workspaceKey, '/home/dev/project');
    assert.equal(event.workspaceLabel, '/home/dev/project');

    assert.equal(graphJson.contributions.length, 1);
    assert.equal(graphJson.contributions[0].date, localDate(ts));
    assert.equal(graphJson.contributions[0].clients[0].modelId, 'glm-5.3');
    assert.equal(modelsJson.entries.length, 1);
    assert.equal(modelsJson.entries[0].workspaceKey, '/home/dev/project');
  });
});

test('multi-model turn splits usage into one event per modelUsage bucket', async () => {
  const ts = epochSeconds();
  await withSessions([
    {
      id: '22222222-2222-2222-2222-222222222222',
      updates: [
        turnCompleted(ts, {
          inputTokens: 1500, outputTokens: 300, totalTokens: 1800,
          cachedReadTokens: 500, cacheCreationTokens: 0, reasoningTokens: 100,
          modelCalls: 3, apiDurationMs: 8000, numTurns: 2,
          modelUsage: {
            'gpt-5.5': { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedReadTokens: 300, cacheCreationTokens: 0, reasoningTokens: 60 },
            'GLM-5.3': { inputTokens: 500, outputTokens: 100, totalTokens: 600, cachedReadTokens: 200, cacheCreationTokens: 0, reasoningTokens: 40 }
          }
        })
      ]
    }
  ], async () => {
    const { eventsJson } = await collect(null);
    assert.equal(eventsJson.events.length, 2);
    const byModel = Object.fromEntries(eventsJson.events.map(e => [e.model, e]));
    assert.deepEqual(byModel['gpt-5.5'].tokens, { input: 700, output: 140, cacheRead: 300, cacheWrite: 0, reasoning: 60 });
    assert.deepEqual(byModel['glm-5.3'].tokens, { input: 300, output: 60, cacheRead: 200, cacheWrite: 0, reasoning: 40 });
    assert.notEqual(byModel['gpt-5.5'].eventKey, byModel['glm-5.3'].eventKey);
    assert.equal(new Set(eventsJson.events.map(e => e.eventKey)).size, 2);
  });
});

test('turn without modelUsage falls back to events.jsonl turn_started model', async () => {
  const ts = epochSeconds();
  await withSessions([
    {
      id: '33333333-3333-3333-3333-333333333333',
      updates: [
        turnCompleted(ts, {
          inputTokens: 100, outputTokens: 50, totalTokens: 150,
          cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 10,
          modelCalls: 1, apiDurationMs: 1000, numTurns: 1
        })
      ],
      events: [
        { ts: new Date((ts - 60) * 1000).toISOString(), type: 'turn_started', session_id: '33333333-3333-3333-3333-333333333333', turn_number: 0, model_id: 'Kimi-K3' }
      ]
    }
  ], async () => {
    const { eventsJson } = await collect(null);
    assert.equal(eventsJson.events.length, 1);
    assert.equal(eventsJson.events[0].model, 'kimi-k3');
  });
});

test('turn without modelUsage or events.jsonl falls back to summary.json current_model_id', async () => {
  const ts = epochSeconds();
  await withSessions([
    {
      id: '44444444-4444-4444-4444-444444444444',
      updates: [
        turnCompleted(ts, {
          inputTokens: 100, outputTokens: 50, totalTokens: 150,
          cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 10,
          modelCalls: 1, apiDurationMs: 1000, numTurns: 1
        })
      ],
      summary: { current_model_id: 'gpt-5.5' }
    }
  ], async () => {
    const { eventsJson } = await collect(null);
    assert.equal(eventsJson.events.length, 1);
    assert.equal(eventsJson.events[0].model, 'gpt-5.5');
  });
});

test('cancelled turns without usage are skipped', async () => {
  const ts = epochSeconds();
  await withSessions([
    {
      id: '55555555-5555-5555-5555-555555555555',
      updates: [
        turnCompleted(ts, undefined),
        turnCompleted(ts + 1, {
          inputTokens: 100, outputTokens: 50, totalTokens: 150,
          cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
          modelCalls: 1, apiDurationMs: 1000, numTurns: 1,
          modelUsage: { 'gpt-5.5': { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 } }
        })
      ]
    }
  ], async () => {
    const { eventsJson } = await collect(null);
    assert.equal(eventsJson.events.length, 1);
  });
});

test('usage date follows the event timestamp across local midnight', async () => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const lastNight = Math.floor(midnight.getTime() / 1000) - 1;   // 23:59:59 previous day
  await withSessions([
    {
      id: '66666666-6666-6666-6666-666666666666',
      updates: [
        turnCompleted(lastNight, {
          inputTokens: 10, outputTokens: 5, totalTokens: 15,
          cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
          modelCalls: 1, apiDurationMs: 100, numTurns: 1,
          modelUsage: { 'gpt-5.5': { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 } }
        }),
        turnCompleted(lastNight + 2, {
          inputTokens: 10, outputTokens: 5, totalTokens: 15,
          cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
          modelCalls: 1, apiDurationMs: 100, numTurns: 1,
          modelUsage: { 'gpt-5.5': { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 } }
        })
      ]
    }
  ], async () => {
    const { graphJson, eventsJson } = await collect(null);
    const dates = eventsJson.events.map(e => e.usageDate).sort();
    assert.equal(dates[0], localDate(lastNight));
    assert.equal(dates[1], localDate(lastNight + 2));
    assert.notEqual(dates[0], dates[1], 'turns on either side of local midnight land on different dates');
    assert.equal(graphJson.contributions.length, 2);
  });
});

test('cost is computed from pricing data and is non-zero', async () => {
  const ts = epochSeconds();
  await withSessions([
    {
      id: '77777777-7777-7777-7777-777777777777',
      updates: [
        turnCompleted(ts, {
          inputTokens: 100000, outputTokens: 50000, totalTokens: 150000,
          cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
          modelCalls: 1, apiDurationMs: 1000, numTurns: 1,
          modelUsage: { 'gpt-5.5': { inputTokens: 100000, outputTokens: 50000, totalTokens: 150000, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 } }
        })
      ]
    }
  ], async () => {
    const pricingData = await loadPricing(resolve('data', 'pricing-litellm.json'));
    const { eventsJson, graphJson, modelsJson } = await collect(pricingData);
    assert.ok(eventsJson.events[0].cost > 0, 'event cost must be positive');
    assert.ok(graphJson.contributions[0].clients[0].cost > 0, 'daily cost must be positive');
    assert.ok(modelsJson.entries[0].cost > 0, 'workspace cost must be positive');
  });
});

test('parseSessionFile ignores malformed lines and non-turn rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-file-'));
  const file = join(dir, 'updates.jsonl');
  writeFileSync(file, [
    'not-json',
    JSON.stringify({ timestamp: epochSeconds(), method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message' } } }),
    JSON.stringify(turnCompleted(epochSeconds(), {
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
      cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
      modelUsage: { 'gpt-5.5': { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 } }
    }))
  ].join('\n'));
  try {
    const events = await parseSessionFile(file, '/x');
    assert.equal(events.length, 1);
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
});
