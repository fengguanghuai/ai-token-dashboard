import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost } from '../src/pricing.mjs';

test('calculateCost returns 0 when pricing data is missing', () => {
  assert.equal(calculateCost('gpt-4o', { input: 1000, output: 500 }, null), 0);
  assert.equal(calculateCost('gpt-4o', { input: 1000 }, undefined), 0);
});

test('calculateCost returns 0 for an unknown model', () => {
  assert.equal(calculateCost('no-such-model-zzz-123', { input: 1000, output: 500 }, {}), 0);
});

test('calculateCost has no cost for zero tokens', () => {
  assert.equal(calculateCost('gpt-4o', { input: 0, output: 0 }, {}), 0);
});
