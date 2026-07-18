import { test } from 'node:test';
import assert from 'node:assert/strict';
import { U } from '../src/client/shared/utils.js';
import { resolveTheme } from '../src/client/dashboard/theme.js';

const rows = [
  { source: 'Claude Code', model: 'claude-opus-4-8', totalTokens: 700, costUSD: 5 },
  { source: 'Claude Code', model: 'claude-fable-5', totalTokens: 100, costUSD: 2 },
  { source: 'Codex CLI', model: 'gpt-5.6-sol', totalTokens: 200, costUSD: 1 }
];

test('sourceBreakdown aggregates per source with share and top model', () => {
  const out = U.sourceBreakdown(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'Claude Code');
  assert.equal(out[0].totalTokens, 800);
  assert.equal(out[0].costUSD, 7);
  assert.equal(out[0].topModel, 'claude-opus-4-8');
  assert.equal(Math.round(out[0].share), 80);
  assert.equal(out[1].source, 'Codex CLI');
});

test('sourceBreakdown handles empty input and missing fields', () => {
  assert.deepEqual(U.sourceBreakdown([]), []);
  const out = U.sourceBreakdown([{ source: null, model: null, totalTokens: 'x', costUSD: null }]);
  assert.equal(out[0].source, '未标记');
  assert.equal(out[0].totalTokens, 0);
  assert.equal(out[0].topModel, null);
});

test('resolveTheme defaults to light and only accepts dark', () => {
  assert.equal(resolveTheme(null), 'light');
  assert.equal(resolveTheme('banana'), 'light');
  assert.equal(resolveTheme('dark'), 'dark');
  assert.equal(resolveTheme('light'), 'light');
});
