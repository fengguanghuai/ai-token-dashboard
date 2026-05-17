/**
 * Codex CLI data collector (pure JS).
 *
 * Scans two roots:
 *   ~/.codex/sessions/          — active sessions (recursive JSONL)
 *   ~/.codex/archived_sessions/ — archived sessions (recursive JSONL)
 * (CODEX_HOME env var overrides ~/.codex)
 *
 * The Codex JSONL format has three relevant event types:
 *   session_meta  – workspace (cwd), session ID, provider, agent nickname
 *   turn_context  – current model for the upcoming turn
 *   event_msg     – when payload.type === "token_count", carries token usage
 *
 * Token counting strategy:
 *   • Primary source: last_token_usage  (per-request increment)
 *   • Fallback:        delta of total_token_usage between consecutive events
 *   • Dedup:           skip events where total_token_usage unchanged
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { calculateCost } from '../pricing.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

/** Recursively collect all .jsonl file paths under a directory. */
async function collectJsonlFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

export const CLIENT_KEY = 'codex';
export const SOURCE_LABEL = 'Codex CLI';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getCodexHome() {
  // Honour CODEX_HOME env var override
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function getSessionsDir() {
  return join(getCodexHome(), 'sessions');
}

function getArchivedSessionsDir() {
  return join(getCodexHome(), 'archived_sessions');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pos(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addInto(agg, t) {
  agg.input     += t.input;
  agg.output    += t.output;
  agg.cacheRead  += t.cacheRead;
  agg.cacheWrite += t.cacheWrite;
  agg.reasoning  += t.reasoning;
}

/** Extract a { input, output, cached, reasoning } summary from a token-usage object. */
function usageSummary(u) {
  return {
    input:     pos(u.input_tokens),
    output:    pos(u.output_tokens),
    // Codex uses cached_input_tokens OR cache_read_input_tokens interchangeably
    cached:    Math.max(pos(u.cached_input_tokens), pos(u.cache_read_input_tokens)),
    reasoning: pos(u.reasoning_output_tokens)
  };
}

/**
 * Convert a Codex cumulative summary to our token breakdown.
 * cached is clamped to <= input to avoid inflated totals.
 */
function summaryToTokens(s) {
  const clamped = Math.min(s.cached, s.input);
  return {
    input:     Math.max(0, s.input - clamped),
    output:    s.output,
    cacheRead:  clamped,
    cacheWrite: 0,
    reasoning:  s.reasoning
  };
}

function summaryIsZero(s) {
  return s.input === 0 && s.output === 0 && s.cached === 0 && s.reasoning === 0;
}

function summaryEqual(a, b) {
  return a.input === b.input && a.output === b.output &&
         a.cached === b.cached && a.reasoning === b.reasoning;
}

function summaryDelta(current, previous) {
  return {
    input:     Math.max(0, current.input     - previous.input),
    output:    Math.max(0, current.output    - previous.output),
    cached:    Math.max(0, current.cached    - previous.cached),
    reasoning: Math.max(0, current.reasoning - previous.reasoning)
  };
}

// ---------------------------------------------------------------------------
// JSONL session parser
// ---------------------------------------------------------------------------

/**
 * Parse a single Codex JSONL session file.
 * Returns an array of { date, model, workspace, tokens }.
 */
async function parseSessionFile(filePath, sessionId) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  // Per-file state
  let currentModel     = null;
  let previousTotal    = null;   // last seen total_token_usage summary
  let workspace        = null;

  const events = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const type = entry.type;

    // ── session_meta ──────────────────────────────────────────────────
    if (type === 'session_meta') {
      const payload = entry.payload || {};
      if (payload.cwd) {
        workspace = payload.cwd;
      }
      continue;
    }

    // ── turn_context ──────────────────────────────────────────────────
    if (type === 'turn_context') {
      const payload = entry.payload || {};
      currentModel = extractModel(payload) || currentModel;
      continue;
    }

    // ── event_msg / token_count ────────────────────────────────────────
    if (type === 'event_msg') {
      const payload = entry.payload || {};
      if (payload.type !== 'token_count') continue;

      const info = payload.info || {};

      // Model resolution: payload.model → info.model → state.currentModel
      const model = normalizeModelForGrouping(
        extractModel(payload) ||
        extractModel(info)    ||
        currentModel          ||
        'unknown'
      );

      currentModel = model;

      const lastUsage  = info.last_token_usage  ? usageSummary(info.last_token_usage)  : null;
      const totalUsage = info.total_token_usage ? usageSummary(info.total_token_usage) : null;

      // Dedup: skip if total hasn't changed since last event
      if (totalUsage && previousTotal && summaryEqual(totalUsage, previousTotal)) continue;

      // Choose token increment
      let increment;
      if (lastUsage && totalUsage && previousTotal) {
        // Standard path: use last_token_usage as increment
        increment = lastUsage;
      } else if (lastUsage && totalUsage && !previousTotal) {
        // First event in session: use last to avoid overcounting resumed session context
        increment = lastUsage;
      } else if (!lastUsage && totalUsage && previousTotal) {
        // Fallback: delta of cumulative totals
        increment = summaryDelta(totalUsage, previousTotal);
      } else if (!lastUsage && totalUsage) {
        // Very first event, no last — use full total (legacy/degraded)
        increment = totalUsage;
      } else if (lastUsage) {
        increment = lastUsage;
      } else {
        continue;
      }

      if (totalUsage) previousTotal = totalUsage;

      if (summaryIsZero(increment)) continue;

      const tokens = summaryToTokens(increment);

      // Date from event timestamp
      let date = 'unknown';
      if (entry.timestamp) {
        date = localDateFromTimestamp(entry.timestamp);
      }

      events.push({ date, model, workspace, tokens });
    }
  }

  return events;
}

function extractModel(obj) {
  if (!obj) return null;
  const v =
    obj.model ||
    obj.model_name ||
    obj.model_info?.slug ||
    null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  // Scan both active and archived sessions
  const [activePaths, archivedPaths] = await Promise.all([
    collectJsonlFiles(getSessionsDir()),
    collectJsonlFiles(getArchivedSessionsDir()),
  ]);
  const filePaths = [...activePaths, ...archivedPaths];

  const dailyMap = new Map();   // "date::model" → aggregated
  const wmMap    = new Map();   // "workspace::model" → aggregated

  for (const filePath of filePaths) {
    const sessionId = filePath.split('/').pop().replace(/\.jsonl$/, '');
    const events    = await parseSessionFile(filePath, sessionId);

    for (const { date, model, workspace, tokens } of events) {
      const workspaceKey = workspace || sessionId;

      // Daily
      const dk = `${date}::${model}`;
      if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model, ...zero(), cost: 0 });
      addInto(dailyMap.get(dk), tokens);

      // Workspace+model
      const wmk = `${workspaceKey}::${model}`;
      if (!wmMap.has(wmk)) {
        wmMap.set(wmk, {
          workspace:      workspaceKey,
          workspaceLabel: decodeWorkspace(workspaceKey),
          model,
          ...zero(),
          cost: 0
        });
      }
      addInto(wmMap.get(wmk), tokens);
    }
  }

  return buildOutput(dailyMap, wmMap, pricingData);
}

/**
 * Attempt to produce a human-readable label from a raw workspace path.
 * Codex cwd values are already absolute paths, so just return as-is.
 */
function decodeWorkspace(raw) {
  return raw;
}

// ---------------------------------------------------------------------------
// Convert to common collector JSON
// ---------------------------------------------------------------------------

function buildOutput(dailyMap, wmMap, pricingData) {
  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map(row => {
        const tokens = {
          input:     row.input,
          output:    row.output,
          cacheRead:  row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning:  row.reasoning,
        };
        return {
          client:  CLIENT_KEY,
          modelId: row.model,
          tokens,
          cost: calculateCost(row.model, tokens, pricingData),
        };
      })
    }));

  const entries = [...wmMap.values()].map(wm => {
    const tokens = {
      input:     wm.input,
      output:    wm.output,
      cacheRead:  wm.cacheRead,
      cacheWrite: wm.cacheWrite,
      reasoning:  wm.reasoning,
    };
    return {
      client:         CLIENT_KEY,
      workspaceKey:   wm.workspace,
      workspaceLabel: wm.workspaceLabel,
      model:          wm.model,
      ...tokens,
      cost: calculateCost(wm.model, tokens, pricingData),
    };
  });

  return { graphJson: { contributions }, modelsJson: { entries } };
}
