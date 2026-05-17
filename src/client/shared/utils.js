/* =============================================================
   Shared helpers, formatters, and aggregations
   ============================================================= */

const PALETTE = {
  // Claude family → indigo
  'Claude Code':        'oklch(0.55 0.16 265)',
  'Claude Code (JS)':   'oklch(0.55 0.16 265)',
  // Codex / OpenAI → violet
  'Codex CLI':          'oklch(0.60 0.15 295)',
  'Codex CLI (JS)':     'oklch(0.60 0.15 295)',
  // Hermes → blue
  'Hermes Agent':       'oklch(0.58 0.14 240)',
  'Hermes Agent (JS)':  'oklch(0.58 0.14 240)',
  // OpenClaw → teal
  'OpenClaw':           'oklch(0.65 0.11 200)',
  'OpenClaw (JS)':      'oklch(0.65 0.11 200)',
  'openclaw, hermes':   'oklch(0.65 0.11 200)',
  // OpenCode → cyan
  'OpenCode':           'oklch(0.62 0.12 195)',
  // Gemini → amber
  'Gemini CLI':         'oklch(0.72 0.14 75)',
  'Gemini CLI (JS)':    'oklch(0.72 0.14 75)',
  // Cursor → sky
  'Cursor':             'oklch(0.68 0.12 220)',
  // Aider → green
  'Aider':              'oklch(0.65 0.13 155)',
  // Amp → rose
  'Amp':                'oklch(0.62 0.16 20)',
  // pi-agent → pink
  'pi-agent':           'oklch(0.63 0.14 330)',
};

const PALETTE_FALLBACK = [
  'oklch(0.55 0.16 265)', 'oklch(0.60 0.15 295)', 'oklch(0.65 0.11 200)',
  'oklch(0.72 0.14 75)',  'oklch(0.65 0.12 150)', 'oklch(0.62 0.16 20)',
  'oklch(0.58 0.14 240)', 'oklch(0.63 0.14 330)', 'oklch(0.68 0.12 220)',
];

// Deterministic color for any source name (even future ones not in PALETTE)
function getSourceColor(name) {
  if (!name) return 'var(--muted)';
  if (PALETTE[name]) return PALETTE[name];
  // Hash the name to pick a consistent fallback color
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE_FALLBACK[h % PALETTE_FALLBACK.length];
}

const fmt   = new Intl.NumberFormat('zh-CN');
const fmtUS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUS4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

function compact(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return fmt.format(v);
}

function compactCN(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿';
  if (a >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万';
  return fmt.format(v);
}

function pct(num, den) {
  if (!num || !den) return 0;
  return (num / den) * 100;
}

function deltaPct(curr, prev) {
  if (prev == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function formatTs(v) {
  if (!v) return '—';
  return v.replace('T', ' ').slice(0, 16);
}

function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function rangeDates(startStr, endStr) {
  const out = [];
  const s = new Date(startStr), e = new Date(endStr);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Apply filters to daily rows
function filterDaily(rows, f) {
  return rows.filter(r =>
    r.usageDate >= f.startDate && r.usageDate <= f.endDate &&
    (f.sources.size === 0 || f.sources.has(r.source)) &&
    (f.devices.size === 0 || f.devices.has(r.device)) &&
    (f.models.size  === 0 || f.models.has(r.model))
  );
}

// Aggregate totals across rows
function aggregateTotals(rows) {
  let total = 0, inp = 0, out = 0, cacheRd = 0, cacheCr = 0, reason = 0, cost = 0;
  for (const r of rows) {
    total += r.totalTokens;
    inp   += r.inputTokens;
    out   += r.outputTokens;
    cacheRd += r.cacheReadTokens;
    cacheCr += r.cacheCreationTokens;
    reason += r.reasoningOutputTokens;
    cost  += r.costUSD;
  }
  return {
    totalTokens: total,
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: cacheRd,
    cacheCreationTokens: cacheCr,
    cacheTokens: cacheRd + cacheCr,
    reasoningTokens: reason,
    costUSD: cost,
    cacheHitRate: total ? (cacheRd / total) * 100 : 0
  };
}

// Group by date + dimension
function groupByDate(rows, dim = 'source') {
  const map = new Map(); // date -> {dim -> total}
  for (const r of rows) {
    const d = r.usageDate;
    if (!map.has(d)) map.set(d, {});
    const k = r[dim];
    map.get(d)[k] = (map.get(d)[k] || 0) + r.totalTokens;
  }
  return map;
}

function uniqueValues(rows, field) {
  const s = new Set();
  for (const r of rows) if (r[field]) s.add(r[field]);
  return Array.from(s).sort();
}

// CSV download
function downloadCSV(filename, rows, columns) {
  const header = columns.map(c => c.title).join(',');
  const body = rows.map(r =>
    columns.map(c => {
      const v = typeof c.value === 'function' ? c.value(r) : r[c.field];
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Project path label from sessionId
function projectLabel(s) {
  return s.projectPath || s.sessionId;
}

// Mix two oklch colors by t  via color-mix string
function alpha(color, a) {
  return `color-mix(in oklab, ${color}, transparent ${100 - a * 100}%)`;
}

export const U = {
  PALETTE, PALETTE_FALLBACK, getSourceColor,
  fmt, fmtUS, fmtUS4,
  compact, compactCN, pct, deltaPct, formatTs,
  daysAgo, rangeDates,
  filterDaily, aggregateTotals, groupByDate, uniqueValues,
  downloadCSV, projectLabel, alpha
};
