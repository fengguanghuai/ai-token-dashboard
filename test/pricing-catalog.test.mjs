import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateCost, calculateCacheSavings } from '../src/pricing.mjs';

const catalog = name => JSON.parse(readFileSync(new URL(`../data/pricing-${name}.json`, import.meta.url))).data;
const litellm = catalog('litellm');
const openrouter = catalog('openrouter');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

// Official USD / million tokens, checked 2026-11-06. See docs/pricing-verification.md.
test('Mistral Large 4 aliases and fallback use official USD rates', () => {
  for (const model of ['mistral-large-4', 'mistral-large-4-0', 'mistral/mistral-large-4-0', 'mistralai/mistral-large-4-0']) {
    // Only the primary catalog has the undated mistral-large-4 alias.
    const datasets = model === 'mistral-large-4' ? [{ litellm, openrouter }] : [{ litellm, openrouter }, { openrouter }];
    for (const data of datasets) {
      close(calculateCost(model, { input: 1e6, output: 1e6, cacheRead: 1e6 }, data), 2.87);
      close(calculateCacheSavings(model, { cacheRead: 1e6 }, data), 0.63);
    }
  }
});

test('OpenAI standard fallback prices are not batch prices', () => {
  const rows = [
    ['gpt-6-astra', 10, 50, 1, 12.5], ['gpt-6.1-sol', 2, 10, 0.1, 2.5],
    ['gpt-6-sol', 2, 10, 0.2, 2.5], ['gpt-6-luna', 0.1, 0.5, 0.01, 0.125],
    ['gpt-5.6-sol', 4, 20, 0.4, 5], ['gpt-5.6-terra', 2, 12, 0.2, 2.5],
    ['gpt-5.6-luna', 0.2, 1.2, 0.02, 0.25], ['gpt-5.5', 5, 30, 0.5],
    ['gpt-5.5-pro', 30, 180], ['gpt-5.4', 2.5, 15, 0.25], ['gpt-5.4-pro', 30, 180],
    ['gpt-5.4-mini', 0.75, 4.5, 0.075], ['gpt-5.4-nano', 0.2, 1.25, 0.02],
    ['gpt-5.2', 1.75, 14, 0.175], ['gpt-5.1', 1.25, 10, 0.125],
    ['gpt-5-mini', 0.25, 2, 0.025], ['gpt-5-nano', 0.05, 0.4, 0.005]
  ];
  for (const [model, ...prices] of rows) {
    for (const [index, token] of ['input', 'output', 'cacheRead', 'cacheWrite'].entries()) {
      if (prices[index] == null) continue;
      // Aggregated totals explicitly disable request-level long-context selection.
      for (const data of [{ litellm, openrouter }, { openrouter }]) {
        close(calculateCost(`openai/${model}`, { [token]: 1e6 }, data, 'openai', { tiered: false }), prices[index]);
      }
    }
  }
  close(openrouter['openai/gpt-6-astra:batch'].input_cost_per_token * 1e6, 5);
});

test('OpenAI fallback honors the supported whole-request long-context boundary', () => {
  const data = { openrouter };
  const short = { input: 100_000, cacheRead: 171_999, cacheWrite: 1, output: 100, reasoning: 100 };
  close(calculateCost('gpt-6-astra', short, data), 1.1820115);
  close(calculateCost('gpt-6-astra', { ...short, cacheWrite: 2 }, data), 2.359048);
});
