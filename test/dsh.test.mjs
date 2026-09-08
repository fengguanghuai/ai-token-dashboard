import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the parse cache at a throwaway dir before the module reads the env at import.
process.env.AI_TOKEN_DASHBOARD_CACHE_DIR = mkdtempSync(join(tmpdir(), 'dsh-cache-'));

const { collect, parseSessionFile } = await import('../src/collectors/dsh.mjs');
const { localDateFromTimestamp } = await import('../src/collectors/utils.mjs');

const FIXTURES = join(import.meta.dirname, 'fixtures');
const T = Date.UTC(2026, 7, 18, 10, 0, 0);

const PRICING = {
  litellm: {
    'glm-5.3': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
      cache_read_input_token_cost: 1e-7
    },
    'kimi-k3': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6
    }
  }
};

/** Materialize fixtures into a fake ~/.dsh/sessions tree and run collect() against it. */
async function withSessions(fixtures, work) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'));
  try {
    for (const [fixture, relDir] of fixtures) {
      const dir = join(root, relDir, 'session-0000');
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(FIXTURES, fixture), join(dir, 'session.jsonl.zstd'));
    }
    process.env.DSH_SESSIONS = root;
    return await work();
  } finally {
    delete process.env.DSH_SESSIONS;
    rmSync(root, { recursive: true, force: true });
  }
}

test('single step usage is aggregated across a multi-frame container', async () => {
  await withSessions([['dsh-single-step.jsonl.zstd', 'proj-a']], async () => {
    const { graphJson, modelsJson, eventsJson } = await collect(PRICING);

    assert.equal(graphJson.contributions.length, 1);
    const client = graphJson.contributions[0].clients[0];
    assert.equal(client.client, 'dsh');
    assert.equal(client.modelId, 'glm-5.3');
    assert.deepEqual(client.tokens, {
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 0,
      reasoning: 0
    });

    const entry = modelsJson.entries[0];
    assert.equal(entry.workspaceKey, '/home/me/proj-a');
    assert.equal(entry.workspaceLabel, 'proj-a');
    assert.equal(entry.model, 'glm-5.3');
    assert.equal(entry.input, 1000);
    assert.equal(entry.cacheRead, 5000);

    assert.equal(eventsJson.events.length, 1);
    assert.equal(eventsJson.events[0].eventKey, 'session-fixsingle:2');
    assert.ok(client.cost > 0, 'cost must be non-zero');
  });
});

test('usage is attributed to the current model across a mid-session switch', async () => {
  await withSessions([['dsh-model-switch.jsonl.zstd', 'proj-b']], async () => {
    const { graphJson, eventsJson } = await collect(PRICING);

    const byModel = new Map(graphJson.contributions[0].clients.map(c => [c.modelId, c.tokens]));
    assert.equal(byModel.size, 2);
    assert.deepEqual(byModel.get('glm-5.3-flash'), {
      input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0
    });
    assert.deepEqual(byModel.get('kimi-k3'), {
      input: 300, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0
    });

    const models = eventsJson.events.map(e => e.model).sort();
    assert.deepEqual(models, ['glm-5.3-flash', 'kimi-k3']);
  });
});

test('usage date comes from the event timestamp', async () => {
  await withSessions([['dsh-single-step.jsonl.zstd', 'proj-a']], async () => {
    const { graphJson, eventsJson } = await collect(PRICING);
    const event = eventsJson.events[0];

    assert.equal(event.usageDate, localDateFromTimestamp(T));
    assert.equal(new Date(event.eventTime).getTime(), T);
    assert.equal(graphJson.contributions[0].date, event.usageDate);
  });
});

test('event cost is derived from pricing data', async () => {
  await withSessions([['dsh-single-step.jsonl.zstd', 'proj-a']], async () => {
    const { eventsJson } = await collect(PRICING);
    const event = eventsJson.events[0];
    // 1000*1e-6 + 200*2e-6 + 5000*1e-7
    assert.ok(Math.abs(event.cost - 0.0019) < 1e-9, `got ${event.cost}`);
  });
});

test('collect returns empty results when zstd decompression is unavailable', async () => {
  const saved = zlib.zstdDecompressSync;
  delete zlib.zstdDecompressSync;
  try {
    await withSessions([['dsh-single-step.jsonl.zstd', 'proj-a']], async () => {
      const { graphJson, modelsJson, eventsJson } = await collect(PRICING);
      assert.deepEqual(graphJson.contributions, []);
      assert.deepEqual(modelsJson.entries, []);
      assert.deepEqual(eventsJson.events, []);
    });
  } finally {
    zlib.zstdDecompressSync = saved;
  }
});

test('parseSessionFile tolerates corrupt frames and returns no records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-corrupt-'));
  try {
    const good = zlib.zstdCompressSync(Buffer.from(JSON.stringify({
      type: 'session', id: 'session-x', cwd: '/w'
    }) + '\n'));
    const file = join(dir, 'session.jsonl.zstd');
    // good frame + corrupt frame + truncated tail
    writeFileSync(file, Buffer.concat([good, Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 1, 2, 3]), good.subarray(0, 10)]));
    const records = await parseSessionFile(file, 'fallback');
    assert.deepEqual(records, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
