const REASONING_TIERS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'none']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function localDateFromTimestamp(value, fallback = 'unknown') {
  if (value == null || value === '') return fallback;

  let ms;
  if (typeof value === 'number') {
    ms = value > 1e12 ? value : value * 1000;
  } else {
    ms = new Date(value).getTime();
  }

  if (!Number.isFinite(ms)) return fallback;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return fallback;

  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join('-');
}

export function normalizeModelForGrouping(modelId) {
  let name = String(modelId || 'unknown').trim().toLowerCase();
  if (!name) return 'unknown';

  if (name.endsWith(')')) {
    const openIndex = name.lastIndexOf('(');
    if (openIndex > 0) {
      const base = name.slice(0, openIndex);
      const tier = name.slice(openIndex + 1, -1);
      if (base.trim() === base && REASONING_TIERS.has(tier)) {
        name = base;
      }
    }
  }

  if (name.length > 9) {
    const suffix = name.slice(-8);
    if (/^\d{8}$/.test(suffix) && name.at(-9) === '-') {
      name = name.slice(0, -9);
    }
  }

  if (name.includes('claude')) {
    name = name.replace(/(?<=\d)\.(?=\d)/g, '-');
  }

  return name;
}

export function canonicalProvider(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().replace(/-/g, '_').split(/[/.]/);
  for (const part of parts) {
    const value = part.trim().toLowerCase();
    if (!value || value === 'unknown') continue;
    if (value === 'x_ai' || value === 'xai') return 'xai';
    if (value === 'z_ai' || value === 'zai') return 'zai';
    if (value === 'moonshot' || value === 'moonshotai') return 'moonshotai';
    if (value === 'meta' || value === 'meta_llama') return 'meta_llama';
    if (value === 'azure' || value === 'azure_ai') return 'azure_ai';
    if (value === 'anthropic' || value === 'vertex' || value === 'vertex_ai') return 'anthropic';
    if (value === 'together' || value === 'together_ai') return 'together_ai';
    if (value === 'fireworks' || value === 'fireworks_ai') return 'fireworks_ai';
    if (value === 'google' || value === 'gemini') return 'google';
    if (value === 'openai' || value === 'openai_codex') return 'openai';
    if (value === 'mistral' || value === 'mistralai') return 'mistralai';
    if (value === 'ai21') return 'ai21';
    if (!/\d/.test(value)) return value;
  }
  return null;
}

export function inferProviderFromModel(model) {
  const lower = String(model || '').toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic') || /\b(opus|sonnet|haiku)\b/.test(lower)) return 'anthropic';
  if (lower.includes('gpt') || lower.includes('openai') || /\b(o1|o3|o4)\b/.test(lower)) return 'openai';
  if (lower.includes('gemini') || lower.includes('google')) return 'google';
  if (lower.includes('grok')) return 'xai';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('mimo') || lower.includes('xiaomi')) return 'xiaomi';
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistral';
  if (lower.includes('llama') || /\bmeta\b/.test(lower)) return 'meta';
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('glm')) return 'zai';
  return null;
}
