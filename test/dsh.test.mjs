import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the parse cache at a throwaway dir before the module reads the env at import.
process.env.AI_TOKEN_DASHBOARD_CACHE_DIR = mkdtempSync(join(tmpdir(), 'dsh-cache-'));
process.env.TIME_USAGE_HISTORY_DAYS = '36500'; // historical bundled fixtures
const zstdOptions = { skip: typeof zlib.zstdDecompressSync !== 'function' };

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

test('single step usage is aggregated across a multi-frame container', zstdOptions, async () => {
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
    assert.equal(eventsJson.events[0].eventKey, 'session-fixsingle:turn:1:step:1');
    assert.ok(client.cost > 0, 'cost must be non-zero');
  });
});

test('usage is attributed to the current model across a mid-session switch', zstdOptions, async () => {
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

test('usage date comes from the event timestamp', zstdOptions, async () => {
  await withSessions([['dsh-single-step.jsonl.zstd', 'proj-a']], async () => {
    const { graphJson, eventsJson } = await collect(PRICING);
    const event = eventsJson.events[0];

    assert.equal(event.usageDate, localDateFromTimestamp(T));
    assert.equal(new Date(event.eventTime).getTime(), T);
    assert.equal(graphJson.contributions[0].date, event.usageDate);
  });
});

test('event cost is derived from pricing data', zstdOptions, async () => {
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

test('parseSessionFile tolerates corrupt frames and returns no records', zstdOptions, async () => {
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

async function withTranscript(rows, work, encode = b => b) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-regression-'));
  const savedRoot = process.env.DSH_SESSIONS;
  const file = join(root, 'project', 'session', 'session.jsonl');
  mkdirSync(join(root, 'project', 'session'), { recursive: true });
  writeFileSync(file, encode(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')));
  process.env.DSH_SESSIONS = root;
  try { return await work(file); } finally {
    if (savedRoot === undefined) delete process.env.DSH_SESSIONS;
    else process.env.DSH_SESSIONS = savedRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

const header = { type: 'session', id: 's', cwd: '/work/项目' };
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500 };
function message(seq, extra = {}) {
  return { type: 'assistant/message', seq, time: T, data: {
    turn: 1, step: seq, usage,
    message: { id: `msg-${seq}`, source: { model: 'alias', replayState: { response: { responseModel: 'glm-5.3' } } } }
  }, ...extra };
}

test('final messages replace streaming usage, count compaction, and use served model', async () => {
  await withTranscript([header,
    { type: 'assistant/chunk', seq: 1, time: T, data: { turn: 1, step: 2, chunk: { type: 'usage', usage } } },
    message(2), message(2),
    { type: 'compaction/summary', seq: 3, time: T, data: { compactionId: 'summary-1', usage,
      message: { source: { model: 'glm-5.3' } } } }
  ], async () => {
    const result = await collect(PRICING);
    assert.equal(result.eventsJson.events.length, 2);
    assert.equal(result.graphJson.contributions[0].clients[0].tokens.input, 200);
    assert.ok(result.eventsJson.events.every(e => e.model === 'glm-5.3'));
    const total = result.eventsJson.events.reduce((sum, event) => sum + event.cost, 0);
    assert.equal(result.graphJson.contributions[0].clients[0].cost, total);
    assert.equal(result.modelsJson.entries[0].cost, total);
    assert.deepEqual(await collect(PRICING), result);
  });
});

test('fork seed is excluded and seconds, milliseconds and ISO timestamps agree', async () => {
  await withTranscript([{ ...header, seedLength: 2 }, message(1), message(2, { time: T / 1000 }),
    message(3, { time: new Date(T).toISOString() }), message(4, { time: 'invalid' })], async () => {
    const { eventsJson } = await collect(PRICING);
    assert.equal(eventsJson.events.length, 2);
    assert.ok(eventsJson.events.every(event => event.eventTime === new Date(T).toISOString()));
  });
});

test('plain transcripts work without Node zstd support', async () => {
  const saved = zlib.zstdDecompressSync;
  delete zlib.zstdDecompressSync;
  try {
    await withTranscript([header, message(1)], async () => {
      assert.equal((await collect()).eventsJson.events.length, 1);
    });
  } finally { zlib.zstdDecompressSync = saved; }
});

test('multi-frame decoding preserves UTF-8 and complete usage before a torn tail', zstdOptions, async () => {
  await withTranscript([header, message(1)], async file => {
    const records = await parseSessionFile(file, 's');
    assert.equal(records.length, 1);
    assert.equal(records[0].workspace, '/work/项目');
  }, bytes => {
    const boundary = bytes.indexOf(Buffer.from('项目')) + 1;
    return Buffer.concat([zlib.zstdCompressSync(bytes.subarray(0, boundary)),
      zlib.zstdCompressSync(bytes.subarray(boundary)), Buffer.from([40, 181, 47, 253, 0])]);
  });
});

test('magic bytes inside a raw zstd block do not split its frame', zstdOptions, async () => {
  await withTranscript([header, message(1)], async file => {
    assert.equal((await parseSessionFile(file, 's')).length, 1);
  }, bytes => {
    const payload = Buffer.concat([Buffer.from([40, 181, 47, 253, 10]), bytes]);
    const frame = Buffer.alloc(12 + payload.length);
    frame.set([40, 181, 47, 253, 0xa0]); // single segment, 4-byte content size
    frame.writeUInt32LE(payload.length, 5);
    frame.writeUIntLE((payload.length << 3) | 1, 9, 3); // last raw block
    payload.copy(frame, 12);
    return frame;
  });
});

test('final usage retains the stream event key across incremental collection', async () => {
  await withTranscript([header,
    { type: 'assistant/chunk', seq: 1, time: T, data: { turn: 1, step: 2, chunk: { type: 'usage', usage } } }
  ], async file => {
    const first = await collect(PRICING);
    appendFileSync(file, JSON.stringify(message(2)) + '\n');
    const second = await collect(PRICING);
    assert.equal(first.eventsJson.events.length, 1);
    assert.equal(second.eventsJson.events.length, 1);
    assert.equal(first.eventsJson.events[0].eventKey, second.eventsJson.events[0].eventKey);
    assert.equal(second.eventsJson.events[0].model, 'glm-5.3');
  });
});
