import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppendOnly } from '../src/collectors/parse-continuation.mjs';
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
