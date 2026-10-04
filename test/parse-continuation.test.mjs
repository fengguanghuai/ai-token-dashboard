import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAppendOnly, validAppendCheckpoint } from '../src/collectors/parse-continuation.mjs';
import { parseSessionText, parseSessionFile } from '../src/collectors/codex.mjs';

const line = x => JSON.stringify(x) + '\n';
const context = model => line({ type: 'turn_context', payload: { model, turn_id: 'turn' } });
const event = (total, second) => line({ type: 'event_msg', timestamp: `2026-09-26T00:00:${String(second).padStart(2, '0')}Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 2 } } } });

test('Codex continuation matches full parsing through partial UTF-8, replay, resets and edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'continuation-'));
  const file = join(dir, 'log.jsonl');
  let checkpoint, parsedBytes;
  const parse = (text, state) => { parsedBytes += Buffer.byteLength(text); return parseSessionText(text, 'fallback', state); };
  async function check() {
    parsedBytes = 0;
    checkpoint = await parseAppendOnly(file, checkpoint, parse);
    assert.deepEqual(checkpoint.events, await parseSessionFile(file, 'fallback'));
    return parsedBytes;
  }
  try {
    let initial = line({ type: 'session_meta', payload: { id: 'session', cwd: '/项目', forked_from_id: 'parent' } }) + context('gpt-5') + event(100, 1) + event(150, 1) + event(170, 2);
    await writeFile(file, initial); await check();
    assert.equal(await check(), 0, 'no committed JSON is reparsed');
    const addition = event(200, 3);
    await appendFile(file, addition); assert.equal(await check(), Buffer.byteLength(addition));
    await appendFile(file, event(200, 4) + event(10, 5) + event(20, 6)); await check();
    const unicode = Buffer.from(context('模型'));
    const split = unicode.indexOf(Buffer.from('模')) + 1;
    await appendFile(file, unicode.subarray(0, split)); await check();
    await appendFile(file, unicode.subarray(split)); await check();
    const unterminated = event(30, 7).trimEnd();
    await appendFile(file, unterminated); await check();
    await appendFile(file, '\n' + event(40, 8)); await check();
    await writeFile(file, initial.replace('gpt-5', 'gpt-4') + event(220, 9));
    assert.ok(await check() > Buffer.byteLength(event(220, 9)), 'prefix edits force complete parsing');
    await writeFile(file, context('gpt-5') + event(5, 0)); await check();
    await writeFile(file, ''); await check();
    await appendFile(file, initial); await check();
    checkpoint.hash = 'corrupt'; await check();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('append checkpoint resumes in a fresh process with no old-prefix read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'append-restart-'));
  const file = join(root, 'session.jsonl'), cache = join(root, 'checkpoint.json');
  const worker = `
    import { readFile, writeFile } from 'node:fs/promises';
    import { parseAppendOnly } from ${JSON.stringify(new URL('../src/collectors/parse-continuation.mjs', import.meta.url).href)};
    import { parseSessionText } from ${JSON.stringify(new URL('../src/collectors/codex.mjs', import.meta.url).href)};
    let previous; try { previous = JSON.parse(await readFile(process.argv[2], 'utf8')); } catch {}
    let readBytes = 0;
    const result = await parseAppendOnly(process.argv[1], previous, (text, state) => parseSessionText(text, 'restart', state),
      { appendOnly: true, onRead: n => { readBytes += n; } });
    await writeFile(process.argv[2], JSON.stringify(result));
    console.log(JSON.stringify({ readBytes, events: result.events }));
  `;
  const run = () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', worker, file, cache], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  try {
    await writeFile(file, context('gpt-5') + event(100, 1)); run();
    const addition = event(200, 2); await appendFile(file, addition);
    const resumed = run();
    assert.equal(resumed.readBytes, Buffer.byteLength(addition));
    assert.deepEqual(resumed.events, await parseSessionFile(file, 'restart'));
    await writeFile(cache, '{broken');
    assert.ok(run().readBytes > Buffer.byteLength(addition));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('collector mode changes invalidate persisted checkpoints and corrupt cache hits rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mode-'));
  try {
    await mkdir(join(root, 'logs'));
    const file = join(root, 'logs', 'session.jsonl'), config = join(root, 'config.json');
    const cache = join(root, 'cache', 'codex.json');
    await writeFile(config, JSON.stringify({ collectors: { codex: { homes: [root], sessionSubdirs: ['logs'], headlessRoots: [] } } }));
    await writeFile(file, context('gpt-5') + event(100, 1));
    const run = mode => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {collect} from ${JSON.stringify(new URL('../src/collectors/codex.mjs', import.meta.url).href)}; await collect();`],
      { encoding: 'utf8', env: { PATH: process.env.PATH, AI_TOKEN_DASHBOARD_CONFIG: config,
        AI_TOKEN_DASHBOARD_CACHE_DIR: join(root, 'cache'), CODEX_LOG_APPEND_ONLY: mode, DISPLAY_TZ: 'UTC' } });
      assert.equal(child.status, 0, child.stderr);
    };
    run('1');
    let saved = JSON.parse(await readFile(cache, 'utf8'));
    assert.match(saved.version, /append-only/);
    saved.files[file].records.state.currentModel = 'corrupt';
    await writeFile(cache, JSON.stringify(saved));
    run('1');
    saved = JSON.parse(await readFile(cache, 'utf8'));
    assert.equal(validAppendCheckpoint(saved.files[file].records), true);
    assert.equal(saved.files[file].records.state.currentModel, 'gpt-5');
    run('0');
    saved = JSON.parse(await readFile(cache, 'utf8'));
    assert.match(saved.version, /verified/);
    assert.equal(saved.files[file].records.mode, undefined);
    assert.equal(typeof saved.files[file].records.hash, 'string');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opt-in append reading survives checkpoints, partial lines, replacement and truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'append-io-'));
  const file = join(dir, 'log.jsonl');
  const parse = (text, state) => parseSessionText(text, 'fallback', state);
  let checkpoint, readBytes;
  const check = async () => {
    readBytes = 0;
    checkpoint = await parseAppendOnly(file, checkpoint, parse, { appendOnly: true, onRead: n => { readBytes += n; } });
    assert.deepEqual(checkpoint.events, await parseSessionFile(file, 'fallback'));
    assert.equal(validAppendCheckpoint(checkpoint), true);
    // A new process only has the serialized checkpoint, not a live hash object.
    checkpoint = JSON.parse(JSON.stringify(checkpoint));
    return readBytes;
  };
  try {
    const initial = context('gpt-5') + line({ type: 'ignored', padding: 'x'.repeat(4 * 1024 * 1024) }) + event(100, 1);
    await writeFile(file, initial);
    assert.equal(await check(), Buffer.byteLength(initial));
    assert.equal(await check(), 0);
    const addition = event(200, 2);
    await appendFile(file, addition);
    assert.equal(await check(), Buffer.byteLength(addition), 'read only the appended bytes');
    const unicode = Buffer.from(context('模型'));
    const split = unicode.indexOf(Buffer.from('模')) + 1;
    await appendFile(file, unicode.subarray(0, split)); await check();
    await appendFile(file, unicode.subarray(split)); assert.equal(await check(), unicode.length);
    const tail = event(300, 3).trimEnd();
    await appendFile(file, tail); await check();
    await appendFile(file, '\n' + event(10, 4) + event(20, 5)); await check();
    checkpoint.state.currentModel = 'corrupt';
    assert.equal(validAppendCheckpoint(checkpoint), false);
    assert.ok(await check() > 4 * 1024 * 1024, 'corrupt checkpoint must fully rebuild');
    await writeFile(file, context('gpt-4') + event(5, 0));
    assert.equal(await check(), Buffer.byteLength(context('gpt-4') + event(5, 0)));
    const replacement = join(dir, 'replacement');
    await writeFile(replacement, initial);
    await rename(replacement, file);
    assert.equal(await check(), Buffer.byteLength(initial), 'a replacement inode establishes a new baseline');
    await writeFile(file, initial.replace('gpt-5', 'gpt-4'));
    assert.equal(await check(), Buffer.byteLength(initial), 'same-size rewrites force a baseline');
    // Restore strict mode: even a historical edit followed by append is found.
    await writeFile(file, initial + addition);
    checkpoint = await parseAppendOnly(file, checkpoint, parse);
    assert.deepEqual(checkpoint.events, await parseSessionFile(file, 'fallback'));
    assert.equal(checkpoint.mode, undefined);
    await writeFile(file, ''); checkpoint = null; await check();
    await appendFile(file, addition); await check();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
