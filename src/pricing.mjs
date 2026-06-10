/**
 * Pricing module.
 *
 * Lookup priority:
 *   1. In-memory singleton (cleared per process)
 *   2. Bundled disk pricing at data/pricing-litellm.json
 *   3. Runtime fetch from LiteLLM only when explicitly enabled
 *   4. Optional OpenRouter cache fallback for models missing from LiteLLM
 *   5. Stale disk cache fallback
 *   6. Hardcoded Cursor overrides for models not yet in upstream pricing
 *   7. 0 cost if nothing matches
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalProvider, inferProviderFromModel } from './collectors/utils.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour, used only for explicit live refresh.
const OPENROUTER_FETCH_TIMEOUT_MS = 30_000;
const OPENROUTER_CONCURRENCY = 10;
const MAX_PREFIX_STRIP_SEGMENTS = 2;
const MAX_SUFFIX_STRIP_SEGMENTS = 4;

/** Subscription-based providers whose $0 pricing is meaningless for per-token estimation. */
const EXCLUDED_PREFIXES = ['github_copilot/'];

/**
 * Hardcoded Cursor overrides for models not yet in LiteLLM upstream.
 * All prices are per-token (i.e. $/1M ÷ 1_000_000).
 * Verified against: cursor.com/en-US/docs/models and llm-stats.com
 */
const CURSOR_OVERRIDES = {
  // GPT-5.3 family: $1.75/$14.00 per 1M, cache read $0.175/1M
  'gpt-5.3':              { input: 1.75e-6, output: 1.4e-5,  cacheRead: 1.75e-7 },
  'gpt-5.3-codex':        { input: 1.75e-6, output: 1.4e-5,  cacheRead: 1.75e-7 },
  'gpt-5.3-codex-spark':  { input: 1.75e-6, output: 1.4e-5,  cacheRead: 1.75e-7 },
  // Composer 1: $1.25/$10.00 per 1M, cache read $0.125/1M
  'composer 1':           { input: 1.25e-6, output: 1.0e-5,  cacheRead: 1.25e-7 },
  'composer-1':           { input: 1.25e-6, output: 1.0e-5,  cacheRead: 1.25e-7 },
  // Composer 1.5: $3.50/$17.50 per 1M, cache read $0.35/1M
  'composer 1.5':         { input: 3.5e-6,  output: 1.75e-5, cacheRead: 3.5e-7  },
  'composer-1.5':         { input: 3.5e-6,  output: 1.75e-5, cacheRead: 3.5e-7  },
  // Composer 2: $0.50/$2.50 per 1M, cache read $0.20/1M, cache write free
  'composer 2':           { input: 5e-7,    output: 2.5e-6,  cacheRead: 2e-7    },
  'composer-2':           { input: 5e-7,    output: 2.5e-6,  cacheRead: 2e-7    },
  // Composer 2 Fast: $1.50/$7.50 per 1M, cache read $0.35/1M
  'composer 2 fast':      { input: 1.5e-6,  output: 7.5e-6,  cacheRead: 3.5e-7  },
  'composer-2-fast':      { input: 1.5e-6,  output: 7.5e-6,  cacheRead: 3.5e-7  },
};

/**
 * DeepSeek official compatibility aliases can lag in upstream pricing caches.
 * Prices are per-token ($/1M ÷ 1_000_000).
 * Source: https://api-docs.deepseek.com/quick_start/pricing
 */
const DEEPSEEK_OVERRIDES = {
  'deepseek-chat': { input: 1.4e-7, output: 2.8e-7, cacheRead: 2.8e-9 },
  'deepseek-reasoner': { input: 1.4e-7, output: 2.8e-7, cacheRead: 2.8e-9 },
  'deepseek-v4-flash': { input: 1.4e-7, output: 2.8e-7, cacheRead: 2.8e-9 },
  'deepseek-v4-pro': { input: 4.35e-7, output: 8.7e-7, cacheRead: 3.625e-9 }
};

// ---------------------------------------------------------------------------
// In-memory singleton
// ---------------------------------------------------------------------------

let _pricingData = null; // { fetchedAt: number, data: object } | null
const _lookupCacheByDataset = new WeakMap();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load LiteLLM pricing data and return it as a plain object.
 *
 * @param {string} cachePath  Absolute path to the on-disk cache JSON file.
 * @returns {Promise<object|null>}  Raw LiteLLM dataset or null on total failure.
 */
export async function loadPricing(cachePath) {
  const refresh = shouldRefreshPricing();

  // 1. In-memory hit
  if (_pricingData && !refresh) {
    return attachOpenRouterPricing(_pricingData.data);
  }

  // 2. Bundled disk pricing. Normal collection should be fast and offline.
  if (!refresh && cachePath && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'));
      if (raw?.data) {
        _pricingData = raw;
        const data = await attachOpenRouterPricing(raw.data);
        console.log(`[pricing] loaded bundled LiteLLM data (${Object.keys(raw.data).length} models)`);
        return data;
      }
    } catch { /* fall through to fetch */ }
  }

  if (!refresh) {
    console.warn('[pricing] bundled LiteLLM data missing — run npm run pricing:update');
    return null;
  }

  // 3. Live fetch from LiteLLM
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const data = await res.json();
      _pricingData = { fetchedAt: Date.now(), data };
      // Persist to disk
      if (cachePath) {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, JSON.stringify(_pricingData), 'utf8');
      }
      console.log(`[pricing] fetched from LiteLLM (${Object.keys(data).length} models)`);
      return attachOpenRouterPricing(data);
    }
    console.warn(`[pricing] LiteLLM HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[pricing] fetch failed: ${err.message}`);
  }

  // 4. Stale disk cache fallback
  if (cachePath && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'));
      if (raw?.data) {
        _pricingData = raw;
        console.warn('[pricing] using stale cache as fallback');
        return attachOpenRouterPricing(raw.data);
      }
    } catch { /* nothing */ }
  }

  console.warn('[pricing] no pricing data available — costs will be 0');
  return null;
}

/**
 * Calculate USD cost for a model + token breakdown.
 *
 * @param {string} model
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number, reasoning?: number }} tokens
 * @param {object|null} pricingData  Dataset bundle from loadPricing()
 * @param {{ tiered?: boolean }} [options]  Set tiered=false when tokens are already aggregated
 * @returns {number}  Cost in USD (0 if model unknown)
 */
export function calculateCost(model, tokens, pricingData, provider = null, options = {}) {
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0 } = tokens;
  const p = lookupPricingCached(model, pricingData, provider);
  if (!p) return 0;

  if (options.tiered === false) {
    return (
      input * validPrice(p.input) +
      (output + reasoning) * validPrice(p.output) +
      cacheRead * validPrice(p.cacheRead) +
      cacheWrite * validPrice(p.cacheWrite)
    );
  }

  return (
    tieredCost(input, p.input, [
      [128_000, p.inputAbove128k],
      [200_000, p.inputAbove200k],
      [256_000, p.inputAbove256k],
      [272_000, p.inputAbove272k]
    ]) +
    tieredCost(output + reasoning, p.output, [
      [128_000, p.outputAbove128k],
      [200_000, p.outputAbove200k],
      [256_000, p.outputAbove256k],
      [272_000, p.outputAbove272k]
    ]) +
    tieredCost(cacheRead, p.cacheRead, [
      [200_000, p.cacheReadAbove200k],
      [272_000, p.cacheReadAbove272k]
    ]) +
    tieredCost(cacheWrite, p.cacheWrite, [
      [200_000, p.cacheWriteAbove200k]
    ])
  );
}

function lookupPricingCached(model, pricingData, provider) {
  if (!pricingData || typeof pricingData !== 'object') {
    return lookupPricing(model, pricingData, provider);
  }

  let cache = _lookupCacheByDataset.get(pricingData);
  if (!cache) {
    cache = new Map();
    _lookupCacheByDataset.set(pricingData, cache);
  }

  const key = `${provider || ''}::${model || ''}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const value = lookupPricing(model, pricingData, provider);
  cache.set(key, value);
  return value;
}

// ---------------------------------------------------------------------------
// Internal lookup
// ---------------------------------------------------------------------------

/**
 * Resolve per-token prices for a model ID.
 * Priority: LiteLLM exact → OpenRouter fallback → Cursor overrides → null
 */
function lookupPricing(modelId, pricingData, provider = null) {
  const id = (modelId ?? '').trim().toLowerCase();
  if (!id) return null;

  const datasets = splitPricingData(pricingData);
  const providerHint = canonicalProvider(provider) || inferProviderFromModel(id);
  const candidates = modelCandidates(id, providerHint);
  const deepseekOverride = deepseekPricingOverride(candidates);
  if (deepseekOverride) return deepseekOverride;

  let litellmHit = null;
  if (datasets.litellm) {
    litellmHit = firstPricingHit(candidates.litellm, datasets.litellm, findInDataset);
  }

  let openrouterHit = null;
  if (datasets.openrouter) {
    openrouterHit = firstPricingHit(candidates.openrouter, datasets.openrouter, findInOpenRouter);
  }

  const exactHit = choosePricingHit(litellmHit, openrouterHit);
  if (exactHit) return exactHit;

  // 3. Cursor model-price overrides only, no Cursor account/sync integration.
  const override = candidates.bareIds.map(candidate => CURSOR_OVERRIDES[candidate]).find(Boolean);
  if (override) return override;

  // 4. Last resort: light fuzzy matching for aliases like "minimax-m2.5".
  if (datasets.litellm) {
    const hit = firstPricingHit(candidates.litellm, datasets.litellm, findFuzzyPricing);
    if (hit) return hit;
  }
  if (datasets.openrouter) {
    const hit = firstPricingHit(candidates.openrouter, datasets.openrouter, findFuzzyPricing);
    if (hit) return hit;
  }

  return null;
}

function choosePricingHit(litellmHit, openrouterHit) {
  if (!litellmHit) return openrouterHit;
  if (!openrouterHit) return litellmHit;

  if (!hasCachePricing(litellmHit) && hasCachePricing(openrouterHit)) {
    return openrouterHit;
  }

  return litellmHit;
}

function hasCachePricing(pricing) {
  return validPrice(pricing?.cacheRead) > 0 || validPrice(pricing?.cacheWrite) > 0;
}

function modelCandidates(id, providerHint) {
  const base = bareModelId(id);
  const bareIds = unique([
    id,
    base,
    normalizeVersionSeparator(id),
    normalizeVersionSeparator(base),
    ...stripUnknownSuffixes(id),
    ...stripUnknownSuffixes(base),
    ...stripUnknownPrefixes(id),
    ...stripUnknownPrefixes(base)
  ].filter(Boolean));

  const withProvider = (prefixer) => {
    const values = [];
    for (const candidate of bareIds) {
      const bare = bareModelId(candidate);
      if (providerHint) values.push(`${prefixer(providerHint)}/${bare}`);
      values.push(candidate, bare);
    }
    return unique(values);
  };

  return {
    bareIds,
    litellm: withProvider(providerToDatasetPrefix),
    openrouter: withProvider(providerToOpenRouterPrefix)
  };
}

function firstPricingHit(candidates, data, finder) {
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const hit = finder(candidate, data);
    if (hit) return hit;
  }
  return null;
}

function findInDataset(id, data) {
  // Exact key match
  const entry = data[id] ?? data[`openai/${id}`];
  if (entry && !isExcluded(id)) return litellmEntryToRates(entry);

  // Case-insensitive full scan (slower, only when needed)
  for (const [key, val] of Object.entries(data)) {
    if (isExcluded(key)) continue;
    if (key.toLowerCase() === id) return litellmEntryToRates(val);
  }

  return null;
}

function findFuzzyPricing(id, data) {
  return findFuzzyDatasetHit(bareModelId(id), data);
}

function findInOpenRouter(id, data) {
  const exact = findInDataset(id, data);
  if (exact) return exact;

  const bare = id.includes('/') ? id.split('/').at(-1) : id;
  for (const [key, val] of Object.entries(data)) {
    const keyBare = key.toLowerCase().split('/').at(-1);
    if (keyBare === bare) return litellmEntryToRates(val);
  }

  return null;
}

function splitPricingData(pricingData) {
  if (!pricingData) return {};
  if (pricingData.litellm || pricingData.openrouter) return pricingData;
  return { litellm: pricingData };
}

async function attachOpenRouterPricing(litellm) {
  const openrouter = await loadOpenRouterCache();
  return { litellm, openrouter };
}

async function loadOpenRouterCache() {
  const refresh = shouldRefreshPricing();
  const cachePath = join(process.cwd(), 'data', 'pricing-openrouter.json');

  if (!refresh && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'));
      if (raw?.data) {
        console.log(`[pricing] loaded bundled OpenRouter data (${Object.keys(raw.data).length} models)`);
        return raw.data;
      }
    } catch { /* fall through to fetch */ }
  }

  if (!refresh) {
    return null;
  }

  try {
    const data = await fetchOpenRouterPricing();
    if (Object.keys(data).length > 0) {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
      console.log(`[pricing] fetched from OpenRouter (${Object.keys(data).length} models)`);
      return data;
    }
  } catch (err) {
    console.warn(`[pricing] OpenRouter fetch failed: ${err.message}`);
  }

  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'));
      if (raw?.data) {
        console.warn('[pricing] using stale OpenRouter cache as fallback');
        return raw.data;
      }
    } catch { /* nothing */ }
  }

  return null;
}

function deepseekPricingOverride(candidates) {
  return candidates.bareIds
    .map(candidate => DEEPSEEK_OVERRIDES[bareModelId(candidate)])
    .find(Boolean);
}

function shouldRefreshPricing() {
  return process.env.PRICING_REFRESH === '1' || process.env.PRICING_REFRESH === 'true';
}

async function fetchOpenRouterPricing() {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(OPENROUTER_FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`models API HTTP ${res.status}`);

  const body = await res.json();
  const models = Array.isArray(body?.data) ? body.data : [];
  const queue = models
    .filter(model => authorProviderName(model.id))
    .map(model => ({
      id: model.id,
      fallback: openRouterListPricingToRates(model.pricing)
    }));

  const result = {};
  await mapWithConcurrency(queue, OPENROUTER_CONCURRENCY, async ({ id, fallback }) => {
    const pricing = await fetchOpenRouterAuthorPricing(id, fallback);
    if (pricing) result[id] = pricing;
  });

  return result;
}

async function fetchOpenRouterAuthorPricing(modelId, fallback) {
  const authorName = authorProviderName(modelId);
  if (!authorName) return fallback;

  try {
    const url = `https://openrouter.ai/api/v1/models/${modelId}/endpoints`;
    const res = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(OPENROUTER_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return fallback;

    const body = await res.json();
    const endpoints = body?.data?.endpoints;
    if (!Array.isArray(endpoints)) return fallback;

    const authorEndpoint = endpoints.find(ep => ep?.provider_name === authorName);
    const pricing = authorEndpoint?.pricing;
    if (!pricing) return fallback;

    const input = parseOpenRouterPrice(pricing.prompt);
    const output = parseOpenRouterPrice(pricing.completion);
    if (input == null || output == null) return fallback;

    return {
      input_cost_per_token: input,
      output_cost_per_token: output,
      cache_read_input_token_cost: parseOpenRouterPrice(pricing.input_cache_read),
      cache_creation_input_token_cost: parseOpenRouterPrice(pricing.input_cache_write)
    };
  } catch {
    return fallback;
  }
}

function openRouterListPricingToRates(pricing) {
  if (!pricing) return null;
  const input = parseOpenRouterPrice(pricing.prompt);
  const output = parseOpenRouterPrice(pricing.completion);
  if (input == null || output == null) return null;
  return {
    input_cost_per_token: input,
    output_cost_per_token: output
  };
}

function parseOpenRouterPrice(value) {
  if (value == null || value === '') return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function authorProviderName(modelId) {
  const prefix = String(modelId || '').split('/')[0].toLowerCase();
  const names = {
    'z-ai': 'Z.AI',
    'x-ai': 'xAI',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    'meta-llama': 'Meta',
    mistralai: 'Mistral',
    deepseek: 'DeepSeek',
    qwen: 'Alibaba',
    xiaomi: 'Xiaomi',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    moonshotai: 'Moonshot AI'
  };
  return names[prefix] || null;
}

async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function providerToDatasetPrefix(provider) {
  const prefixes = {
    azure_ai: 'azure_ai',
    fireworks_ai: 'fireworks_ai',
    meta_llama: 'meta-llama',
    mistralai: 'mistralai',
    moonshotai: 'moonshotai',
    openai: 'openai',
    anthropic: 'anthropic',
    google: 'google',
    deepseek: 'deepseek',
    qwen: 'qwen',
    xai: 'x-ai',
    zai: 'zai'
  };
  return prefixes[provider] || provider;
}

function providerToOpenRouterPrefix(provider) {
  if (provider === 'zai') return 'z-ai';
  return providerToDatasetPrefix(provider);
}

function isExcluded(key) {
  const lower = key.toLowerCase();
  return EXCLUDED_PREFIXES.some(p => lower.startsWith(p));
}

function litellmEntryToRates(entry) {
  if (!entry) return null;
  const input  = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (input == null && output == null) return null;
  return {
    input:              input  ?? 0,
    inputAbove128k:     entry.input_cost_per_token_above_128k_tokens,
    inputAbove200k:     entry.input_cost_per_token_above_200k_tokens,
    inputAbove256k:     entry.input_cost_per_token_above_256k_tokens,
    inputAbove272k:     entry.input_cost_per_token_above_272k_tokens,
    output:             output ?? 0,
    outputAbove128k:    entry.output_cost_per_token_above_128k_tokens,
    outputAbove200k:    entry.output_cost_per_token_above_200k_tokens,
    outputAbove256k:    entry.output_cost_per_token_above_256k_tokens,
    outputAbove272k:    entry.output_cost_per_token_above_272k_tokens,
    cacheRead:          entry.cache_read_input_token_cost ?? 0,
    cacheReadAbove200k: entry.cache_read_input_token_cost_above_200k_tokens,
    cacheReadAbove272k: entry.cache_read_input_token_cost_above_272k_tokens,
    cacheWrite:         entry.cache_creation_input_token_cost ?? 0,
    cacheWriteAbove200k: entry.cache_creation_input_token_cost_above_200k_tokens,
  };
}

function findFuzzyDatasetHit(id, data) {
  if (!id || id.length < 5) return null;
  const normalizedId = normalizeComparableModelId(id);
  if (!normalizedId || normalizedId.length < 5) return null;

  const entries = Object.entries(data).sort((a, b) => fuzzyKeyScore(b[0], id) - fuzzyKeyScore(a[0], id));
  for (const [key, val] of entries) {
    if (isExcluded(key)) continue;
    const keyBare = bareModelId(key.toLowerCase());
    const normalizedKey = normalizeComparableModelId(keyBare);
    if (!normalizedKey || normalizedKey.length < 5) continue;

    const related =
      normalizedKey === normalizedId ||
      normalizedKey.startsWith(`${normalizedId}-`) ||
      normalizedId.startsWith(`${normalizedKey}-`);
    if (!related) continue;

    const rates = litellmEntryToRates(val);
    if (rates) return rates;
  }
  return null;
}

function fuzzyKeyScore(key, id) {
  const lower = key.toLowerCase();
  const provider = id.split(/[-.]/)[0];
  let score = key.length;
  if (provider && lower.startsWith(`${provider}/`)) score += 10_000;
  if (lower.startsWith('openrouter/')) score -= 5_000;
  if (lower.startsWith('vertex_ai/') || lower.startsWith('bedrock/')) score -= 2_000;
  if (lower.includes('/')) score += 100;
  return score;
}

function bareModelId(id) {
  return String(id || '').toLowerCase().split('/').at(-1);
}

function normalizeComparableModelId(id) {
  return normalizeVersionSeparator(String(id || '').toLowerCase()) || String(id || '').toLowerCase();
}

function normalizeVersionSeparator(id) {
  const chars = String(id || '').split('');
  let changed = false;
  const result = chars.map((char, index) => {
    if (char !== '-' || index === 0 || index === chars.length - 1) return char;
    if (!isAsciiDigit(chars[index - 1]) || !isAsciiDigit(chars[index + 1])) return char;
    const multiDigitBefore = index >= 2 && isAsciiDigit(chars[index - 2]);
    const multiDigitAfter = index + 2 < chars.length && isAsciiDigit(chars[index + 2]);
    if (multiDigitBefore || multiDigitAfter) return char;
    changed = true;
    return '.';
  }).join('');
  return changed ? result : null;
}

function stripUnknownSuffixes(id) {
  const parts = String(id || '').split('-');
  const maxStrip = Math.min(parts.length - 1, MAX_SUFFIX_STRIP_SEGMENTS);
  const results = [];
  for (let strip = 1; strip <= maxStrip; strip += 1) {
    const candidate = parts.slice(0, parts.length - strip).join('-');
    if (candidate.length >= 2) results.push(candidate);
  }
  return results;
}

function stripUnknownPrefixes(id) {
  const parts = String(id || '').split('-');
  const maxSkip = Math.min(parts.length - 1, MAX_PREFIX_STRIP_SEGMENTS);
  const results = [];
  for (let skip = 1; skip <= maxSkip; skip += 1) {
    const candidate = parts.slice(skip).join('-');
    if (candidate.length >= 2) {
      results.push(candidate, ...stripUnknownSuffixes(candidate));
    }
  }
  return results;
}

function isAsciiDigit(char) {
  return char >= '0' && char <= '9';
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function tieredCost(tokens, basePrice, tiers) {
  const safeTokens = Math.max(0, Number(tokens || 0));
  let price = validPrice(basePrice);
  let lower = 0;
  let cost = 0;

  for (const [threshold, tierPriceRaw] of tiers) {
    const tierPrice = validPrice(tierPriceRaw);
    if (tierPriceRaw == null || !Number.isFinite(threshold) || threshold <= lower) continue;
    if (safeTokens <= threshold) {
      return cost + Math.max(0, safeTokens - lower) * price;
    }
    cost += (threshold - lower) * price;
    lower = threshold;
    price = tierPrice;
  }

  return cost + Math.max(0, safeTokens - lower) * price;
}

function validPrice(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
