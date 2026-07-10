import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionFile } from '../src/collectors/codex.mjs';
import { tokenTotal } from '../src/collectors/utils.mjs';

function withSession(lines, work) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-session-'));
  const file = join(dir, 'rollout-test.jsonl');
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return Promise.resolve(work(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function tokenEvent(timestamp, input, cached, output, reasoning, totals) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning
        },
        total_token_usage: {
          input_tokens: totals.input,
          cached_input_tokens: totals.cached,
          output_tokens: totals.output,
          reasoning_output_tokens: totals.reasoning
        }
      }
    }
  };
}

test('forked session skips replayed parent history and keeps child usage', async () => {
  await withSession([
    {
      timestamp: '2026-07-10T09:18:30.687Z',
      type: 'session_meta',
      payload: { id: 'child', forked_from_id: 'parent', thread_source: 'subagent' }
    },
    { timestamp: '2026-07-10T09:18:30.688Z', type: 'turn_context', payload: { model: 'gpt-5' } },
    tokenEvent('2026-07-10T09:18:30.688Z', 100, 20, 10, 2,
      { input: 100, cached: 20, output: 10, reasoning: 2 }),
    tokenEvent('2026-07-10T09:18:30.712Z', 120, 25, 12, 3,
      { input: 220, cached: 45, output: 22, reasoning: 5 }),
    tokenEvent('2026-07-10T09:18:44.913Z', 30, 5, 4, 1,
      { input: 250, cached: 50, output: 26, reasoning: 6 })
  ], async (file) => {
    const events = await parseSessionFile(file, 'child');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].tokens, {
      input: 25,
      output: 4,
      cacheRead: 5,
      cacheWrite: 0,
      reasoning: 1
    });
  });
});

test('regular session keeps token events from its first second', async () => {
  await withSession([
    { timestamp: '2026-07-10T09:18:30.687Z', type: 'session_meta', payload: { id: 'root' } },
    { timestamp: '2026-07-10T09:18:30.688Z', type: 'turn_context', payload: { model: 'gpt-5' } },
    tokenEvent('2026-07-10T09:18:30.688Z', 100, 20, 10, 2,
      { input: 100, cached: 20, output: 10, reasoning: 2 })
  ], async (file) => {
    const events = await parseSessionFile(file, 'root');
    assert.equal(events.length, 1);
  });
});

test('Codex total does not add reasoning twice', () => {
  const tokens = { input: 25, output: 4, cacheRead: 5, cacheWrite: 0, reasoning: 1 };
  assert.equal(tokenTotal(tokens, 'codex'), 34);
  assert.equal(tokenTotal(tokens, 'other'), 35);
});
