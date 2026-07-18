import { test } from 'node:test';
import assert from 'node:assert/strict';
import { U } from '../src/client/shared/utils.js';

test('aggregateTotals sums cacheSavedUSD, defaulting missing values to 0', () => {
  const rows = [
    { totalTokens: 100, inputTokens: 10, outputTokens: 20, cacheReadTokens: 60,
      cacheCreationTokens: 10, reasoningOutputTokens: 0, costUSD: 1, cacheSavedUSD: 2.5 },
    { totalTokens: 50, inputTokens: 50, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningOutputTokens: 0, costUSD: 0.5 } // no cacheSavedUSD
  ];
  const t = U.aggregateTotals(rows);
  assert.equal(t.cacheSavedUSD, 2.5);
  assert.equal(t.totalTokens, 150);
});
