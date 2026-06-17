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
import { basename, join } from 'node:path';
import { configuredPaths, configuredStrings, envPathList } from '../collector-config.mjs';
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
const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || 90);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getCodexHomes() {
  return envPathList(process.env.CODEX_HOME, configuredPaths('codex', 'homes'));
}

function getSessionRoots() {
  const subdirs = configuredStrings('codex', 'sessionSubdirs', ['sessions', 'archived_sessions']);
  return getCodexHomes().flatMap((home) => subdirs.map((subdir) => join(home, subdir)));
}

function getHeadlessRoots() {
  const roots = envPathList(
    process.env.AI_TOKEN_DASHBOARD_HEADLESS_DIR,
    configuredPaths('codex', 'headlessRoots')
  );
  return roots.map((root) => join(root, 'codex'));
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
  if (
    current.input < previous.input ||
    current.output < previous.output ||
    current.cached < previous.cached ||
    current.reasoning < previous.reasoning
  ) {
    return null;
  }

  return {
    input:     current.input     - previous.input,
    output:    current.output    - previous.output,
    cached:    current.cached    - previous.cached,
    reasoning: current.reasoning - previous.reasoning
  };
}

function summaryTotal(s) {
  return s.input + s.output + s.cached + s.reasoning;
}

function looksLikeStaleRegression(current, previous, last) {
  const previousTotal = summaryTotal(previous);
  const currentTotal = summaryTotal(current);
  const lastTotal = summaryTotal(last);

  if (previousTotal <= 0 || currentTotal <= 0 || lastTotal <= 0) return false;

  return currentTotal * 100 >= previousTotal * 98 ||
         currentTotal + lastTotal * 2 >= previousTotal;
}

// ---------------------------------------------------------------------------
// JSONL session parser
// ---------------------------------------------------------------------------

/**
 * Parse a single Codex JSONL session file.
 * Returns an array of { timestamp, date, model, workspace, tokens }.
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
        if (!summaryDelta(totalUsage, previousTotal) &&
            looksLikeStaleRegression(totalUsage, previousTotal, lastUsage)) {
          continue;
        }
        // Standard path: use last_token_usage as increment
        increment = lastUsage;
      } else if (lastUsage && totalUsage && !previousTotal) {
        // First event in session: use last to avoid overcounting resumed session context
        increment = lastUsage;
      } else if (!lastUsage && totalUsage && previousTotal) {
        // Fallback: delta of cumulative totals
        increment = summaryDelta(totalUsage, previousTotal);
        if (!increment) {
          // Total went backwards (session context reset or stale event).
          // Accept the new total as the new baseline to avoid future overcounting.
          previousTotal = totalUsage;
          continue;
        }
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
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';
      let date = 'unknown';
      if (timestamp) {
        date = localDateFromTimestamp(timestamp);
      }

      events.push({ timestamp, date, model, workspace, tokens });
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
  // Scan active, archived, and optional headless Codex outputs.
  const roots = [...getSessionRoots(), ...getHeadlessRoots()];
  const nestedPaths = await Promise.all(roots.map((root) => collectJsonlFiles(root)));
  const filePaths = [...new Set(nestedPaths.flat())];

  const dailyMap = new Map();   // "date::model" -> aggregated
  const wmMap    = new Map();   // "workspace::model" -> aggregated
  const events   = [];
  const seenEventKeys = new Set();

  for (const filePath of filePaths) {
    const sessionId = basename(filePath).replace(/\.jsonl$/, '');
    const parsedEvents = await parseSessionFile(filePath, sessionId);

    for (const { timestamp, date, model, workspace, tokens } of parsedEvents) {
      const eventKey = codexEventDedupKey({ timestamp, model, tokens });
      if (eventKey && seenEventKeys.has(eventKey)) continue;
      if (eventKey) seenEventKeys.add(eventKey);

      const workspaceKey = workspace || sessionId;
      if (keepTimeEvent(timestamp)) {
        events.push({
          client: CLIENT_KEY,
          eventKey: eventKey || `${filePath}::${timestamp}`,
          eventTime: timestamp,
          usageDate: date,
          sessionId,
          workspaceKey,
          workspaceLabel: decodeWorkspace(workspaceKey),
          model,
          tokens,
          cost: calculateCost(model, tokens, pricingData)
        });
      }

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

  return { ...buildOutput(dailyMap, wmMap, pricingData), eventsJson: { events } };
}

function codexEventDedupKey({ timestamp, model, tokens }) {
  if (!timestamp) return null;
  return [
    timestamp,
    model,
    tokens.input,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheWrite,
    tokens.reasoning
  ].join('::');
}

function keepTimeEvent(timestamp) {
  const ms = Date.parse(timestamp || '');
  return Number.isFinite(ms) && ms >= EVENT_CUTOFF_MS;
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
    const date = typeof row.date === 'string' && row.date ? row.date : 'unknown';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
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
          cost: calculateCost(row.model, tokens, pricingData, null, { tiered: false }),
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
      cost: calculateCost(wm.model, tokens, pricingData, null, { tiered: false }),
    };
  });

  return { graphJson: { contributions }, modelsJson: { entries } };
}
