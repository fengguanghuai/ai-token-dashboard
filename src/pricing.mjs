/**
 * Pricing module.
 *
 * Lookup priority:
 *   1. In-memory singleton (cleared per process)
 *   2. Disk cache at data/pricing-litellm.json with 1-hour TTL
 *   3. Runtime fetch from LiteLLM
 *   4. Optional OpenRouter cache fallback for models missing from LiteLLM
 *   5. Stale disk cache fallback
 *   6. Hardcoded Cursor overrides for models not yet in upstream pricing
 *   7. 0 cost if nothing matches
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalProvider, inferProviderFromModel } from './collectors/utils.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

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

// ---------------------------------------------------------------------------
// In-memory singleton
// ---------------------------------------------------------------------------

let _pricingData = null; // { fetchedAt: number, data: object } | null

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
  // 1. In-memory hit
  if (_pricingData && Date.now() - _pricingData.fetchedAt < CACHE_MAX_AGE_MS) {
    return attachOpenRouterPricing(_pricingData.data);
  }

  // 2. Fresh disk cache
  if (cachePath && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'));
      if (raw?.data && Date.now() - (raw.fetchedAt ?? 0) < CACHE_MAX_AGE_MS) {
        _pricingData = raw;
        const data = await attachOpenRouterPricing(raw.data);
        console.log(`[pricing] loaded from cache (${Object.keys(raw.data).length} models)`);
        return data;
      }
    } catch { /* fall through to fetch */ }
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
 * @returns {number}  Cost in USD (0 if model unknown)
 */
export function calculateCost(model, tokens, pricingData, provider = null) {
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0 } = tokens;
  const p = lookupPricing(model, pricingData, provider);
  if (!p) return 0;

  if (canonicalProvider(provider) === 'xiaomi') {
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

  return (
    input      * (p.input      ?? 0) +
    (output + reasoning) * (p.output ?? 0) +
    cacheRead  * (p.cacheRead  ?? 0) +
    cacheWrite * (p.cacheWrite ?? 0)
  );
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

  // Strip provider prefix for recursive lookup ("openai/gpt-5.3" → "gpt-5.3")
  const slashIdx = id.indexOf('/');
  const bare = slashIdx !== -1 ? id.slice(slashIdx + 1) : id;

  // 1. LiteLLM
  if (datasets.litellm) {
    const litellmCandidates = providerHint ? [`${providerToDatasetPrefix(providerHint)}/${bare}`, id, bare] : [id, bare];
    const hit = firstPricingHit(litellmCandidates, datasets.litellm, findInDataset);
    if (hit) return hit;
  }

  // 2. OpenRouter fallback for models missing from LiteLLM.
  if (datasets.openrouter) {
    const openrouterCandidates = providerHint ? [`${providerToOpenRouterPrefix(providerHint)}/${bare}`, id, bare] : [id, bare];
    const hit = firstPricingHit(openrouterCandidates, datasets.openrouter, findInOpenRouter);
    if (hit) return hit;
  }

  // 2. Cursor overrides (exact match on bare id, case-insensitive)
  const override = CURSOR_OVERRIDES[bare] ?? CURSOR_OVERRIDES[id];
  if (override) return override;

  return null;
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
  const candidates = [
    join(process.cwd(), 'data', 'pricing-openrouter.json'),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      if (raw?.data) return raw.data;
    } catch {
      // Try next cache location.
    }
  }

  return null;
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
    zai: 'z-ai'
  };
  return prefixes[provider] || provider;
}

function providerToOpenRouterPrefix(provider) {
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
