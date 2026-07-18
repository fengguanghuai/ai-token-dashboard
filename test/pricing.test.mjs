import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCacheSavings, calculateCost } from '../src/pricing.mjs';

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

const CACHE_PRICING_FIXTURE = {
  'test-cache-model': {
    mode: 'chat',
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6
  }
};

test('calculateCacheSavings = uncached cost minus actual cost', () => {
  const tokens = { input: 1000, output: 500, cacheRead: 100_000, cacheWrite: 2000 };
  // uncached: (1000+100000+2000)*1e-6 + 500*2e-6                    = 0.104
  // actual:   1000*1e-6 + 500*2e-6 + 100000*1e-7 + 2000*1.25e-6     = 0.0145
  const saved = calculateCacheSavings('test-cache-model', tokens, CACHE_PRICING_FIXTURE);
  assert.ok(Math.abs(saved - 0.0895) < 1e-9, `got ${saved}`);
});

test('calculateCacheSavings is 0 with no cache tokens or unknown model', () => {
  assert.equal(calculateCacheSavings('test-cache-model', { input: 1000, output: 500 }, CACHE_PRICING_FIXTURE), 0);
  assert.equal(calculateCacheSavings('no-such-model-zzz-123', { input: 1, cacheRead: 1000 }, {}), 0);
});
