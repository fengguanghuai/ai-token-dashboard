import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAppendOnly, validAppendCheckpoint } from '../src/collectors/parse-continuation.mjs';
import { parseSessionText, parseSessionFile, mergeSessionRecords } from '../src/collectors/claude-code.mjs';

const line = value => JSON.stringify(value) + '\n';
const reply = (output = 2, extra = {}) => ({ type: 'assistant', sessionId: 'session', requestId: 'request',
  timestamp: '2026-10-01T12:00:00.000Z', message: { id: 'message', model: 'unknown', usage: { input_tokens: 10, output_tokens: output } }, ...extra });

test('Claude byte continuation preserves revisions, advisor usage, line identities and uncommitted tails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-continuation-'));
  const file = join(root, 'log.jsonl');
  let checkpoint;
  const check = async () => {
    let bytes = 0;
    checkpoint = await parseAppendOnly(file, checkpoint, parseSessionText, { appendOnly: true, onRead: n => { bytes += n; } });
    const saved = JSON.stringify(checkpoint);
    const records = mergeSessionRecords(checkpoint.events);
    assert.deepEqual(records, await parseSessionFile(file));
    assert.equal(JSON.stringify(checkpoint), saved, 'deduplication must not mutate the checkpoint');
    assert.equal(validAppendCheckpoint(checkpoint), true);
    checkpoint = JSON.parse(saved);
    return { records, bytes };
  };
  try {
    const initial = line(reply(2, { timestamp: null })) + '\n{malformed}\nnull\n'
      + line({ type: 'user', padding: 'x'.repeat(4 * 1024 * 1024) });
    await writeFile(file, initial);
    assert.equal((await check()).bytes, Buffer.byteLength(initial));
    assert.equal((await check()).bytes, 0);
    const revision = reply(5);
    revision.message.model = 'claude-sonnet-4-6';
    revision.message.usage.iterations = [{ type: 'advisor_message', model: 'claude-opus-4-6', usage: { input_tokens: 3, output_tokens: 1 } }];
    await appendFile(file, line(revision));
    const revised = await check();
    assert.equal(revised.bytes, Buffer.byteLength(line(revision)));
    assert.equal(revised.records.length, 1);
    assert.equal(revised.records[0].usage.output_tokens, 5);
    assert.equal(revised.records[0].model, revision.message.model);
    assert.equal(revised.records[0].timestamp, revision.timestamp);
    assert.equal(revised.records[0].usage.iterations[0].usage.input_tokens, 3);

    const committed = await readFile(file, 'utf8');
    await appendFile(file, line(reply(900)).trimEnd());
    assert.equal((await check()).records[0].usage.output_tokens, 900);
    // Replacing an uncommitted tail must not leave its former maximum behind.
    await writeFile(file, committed + line(reply(6)) + line({ type: 'user' }));
    assert.equal((await check()).records[0].usage.output_tokens, 6);

    const idless = reply(7); delete idless.message.id;
    const unicode = Buffer.from(line({ ...idless, message: { ...idless.message, model: '模型' } }));
    const split = unicode.indexOf(Buffer.from('模')) + 1;
    await appendFile(file, unicode.subarray(0, split)); await check();
    await appendFile(file, unicode.subarray(split));
    assert.equal((await check()).bytes, unicode.length);
    await appendFile(file, line(idless) + line(idless));
    const complete = await check();
    assert.equal(new Set(complete.records.map(row => row.lineIndex)).size, 4, 'idless replies keep absolute line identities');
    checkpoint.state.lineIndex++;
    assert.equal(validAppendCheckpoint(checkpoint), false);
    assert.ok((await check()).bytes > 4 * 1024 * 1024);
    await writeFile(file, line(reply(1)));
    assert.equal((await check()).records[0].usage.output_tokens, 1);
    const replacement = join(root, 'replacement');
    await writeFile(replacement, initial); await rename(replacement, file);
    assert.equal((await check()).bytes, Buffer.byteLength(initial));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude collector restarts, mode changes and corrupt cache hits match uncached full collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-cache-'));
  const project = join(root, 'logs', 'projects', '%2Fsynthetic%2Fproject');
  const file = join(project, 'parent.jsonl'), cache = join(root, 'cache', 'claude.json');
  const run = (mode, cacheEnabled = '1') => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { collect } from ${JSON.stringify(new URL('../src/collectors/claude-code.mjs', import.meta.url).href)}; console.log(JSON.stringify(await collect({})));`],
    { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), CLAUDE_CONFIG_DIR: join(root, 'logs'),
      AI_TOKEN_DASHBOARD_CACHE_DIR: join(root, 'cache'), CLAUDE_LOG_APPEND_ONLY: mode, PARSE_CACHE: cacheEnabled, DISPLAY_TZ: 'UTC' } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const check = mode => {
    const result = run(mode);
    assert.deepEqual(result, run('0', '0'));
    return result;
  };
  try {
    await mkdir(join(project, 'subagents'), { recursive: true });
    await writeFile(file, line(reply())); check('1');
    const revised = reply(8);
    revised.message.usage.iterations = [{ type: 'advisor_message', model: 'advisor', input_tokens: 3, output_tokens: 1 }];
    await appendFile(file, line(revised));
    await writeFile(join(project, 'subagents', 'child.jsonl'), line({ ...revised, isSidechain: true, requestId: 'copy' }));
    const result = check('1');
    assert.equal(result.eventsJson.events.length, 2, 'one parent and one advisor, no sidechain copy');
    assert.equal(result.eventsJson.events[0].tokens.output, 8);
    assert.equal(result.eventsJson.events[1].tokens.input, 3);
    const saved = JSON.parse(await readFile(cache, 'utf8'));
    saved.files[file].records.events[0].usage.input_tokens = 999;
    await writeFile(cache, JSON.stringify(saved)); check('1');
    assert.equal(validAppendCheckpoint(JSON.parse(await readFile(cache, 'utf8')).files[file].records), true);
    check('0');
    assert.match(JSON.parse(await readFile(cache, 'utf8')).version, /:full:/);
    // Default mode catches old content edits, even when the file also grows.
    await writeFile(file, line(reply(50)) + line(revised) + line({ type: 'user' }));
    assert.equal(check('0').eventsJson.events[0].tokens.output, 50);
    check('1');
    assert.match(JSON.parse(await readFile(cache, 'utf8')).version, /:append-only:/);
    assert.deepEqual(run('1', '0'), run('0', '0'), 'disabled cache still gives complete results');
    await writeFile(cache, '{broken'); check('1');
  } finally { await rm(root, { recursive: true, force: true }); }
});
