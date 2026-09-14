import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCacheSavings, calculateCost, mergePricingSnapshots, hasModelPricing } from '../src/pricing.mjs';

test('pricing availability distinguishes missing models from zero-priced models', () => {
  assert.equal(hasModelPricing('missing-test-model', {}), false);
  assert.equal(hasModelPricing('free-test-model', {
    'free-test-model': { input_cost_per_token: 0, output_cost_per_token: 0 }
  }), true);
});

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

test('long-context pricing switches the whole request including cached prompts and short outputs', () => {
  const rates = { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.25e-6,
    input_cost_per_token_above_272k_tokens: 2e-6, output_cost_per_token_above_272k_tokens: 3e-6,
    cache_read_input_token_cost_above_272k_tokens: 2e-7,
    cache_creation_input_token_cost_above_272k_tokens: 2.5e-6 };
  const data = { 'gpt-6-astra': rates };
  const short = { input: 100_000, cacheRead: 172_000, output: 100 };
  assert.ok(Math.abs(calculateCost('gpt-6-astra', short, data) - 0.1174) < 1e-12);
  const long = { ...short, cacheWrite: 1 };
  assert.ok(Math.abs(calculateCost('gpt-6-astra', long, data) - 0.2347025) < 1e-12);
  assert.ok(Math.abs(calculateCost('gpt-6-astra', long, data, null, { tiered: false }) - 0.11740125) < 1e-12);
});

test('Grok prompt threshold is inclusive and output does not select the tier', () => {
  const data = { 'grok-4.5': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7, input_cost_per_token_above_200k_tokens: 2e-6,
    output_cost_per_token_above_200k_tokens: 4e-6, cache_read_input_token_cost_above_200k_tokens: 2e-7 } };
  assert.ok(Math.abs(calculateCost('grok-4.5', { input: 1, cacheRead: 199_999, output: 100 }, data) - 0.0404018) < 1e-12);
  assert.ok(Math.abs(calculateCost('grok-4.5', { input: 1, output: 250_000 }, data) - 0.500001) < 1e-12);
});

test('pricing refresh retains retired entries but does not retain removed tiers on current entries', () => {
  const old = { retired: { input_cost_per_token: 1 }, active: { input_cost_per_token: 2, output_cost_per_token_above_272k_tokens: 4 } };
  const fresh = { active: { input_cost_per_token: 0 }, added: { input_cost_per_token: 3 } };
  assert.deepEqual(mergePricingSnapshots(old, fresh), { retired: old.retired, ...fresh });
  assert.equal(old.active.input_cost_per_token, 2);
  assert.throws(() => mergePricingSnapshots(old, {}));
});

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

test('DeepSeek prices come from the current dataset, including cache-hit aliases', () => {
  const data = { 'deepseek-v4-flash': { input_cost_per_token: 4.4e-7,
    output_cost_per_token: 1.32e-6, input_cost_per_token_cache_hit: 1.4e-8 } };
  const cost = calculateCost('deepseek-v4-flash', { input: 1e6, output: 1e6, cacheRead: 1e6 }, data);
  assert.ok(Math.abs(cost - 1.774) < 1e-12);
  const updated = { 'deepseek-v4-flash': { ...data['deepseek-v4-flash'], input_cost_per_token: 5e-7 } };
  assert.ok(Math.abs(calculateCost('deepseek-v4-flash', { input: 1e6 }, updated) - 0.5) < 1e-12);
});

test('canonical cache-read pricing, including zero, takes precedence over aliases', () => {
  const data = { 'test-cache-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 0, input_cost_per_token_cache_hit: 1e-7 } };
  assert.equal(calculateCost('test-cache-model', { cacheRead: 1e6 }, data), 0);
});
