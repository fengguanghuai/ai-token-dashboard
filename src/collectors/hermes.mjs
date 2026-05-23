/**
 * Hermes Agent data collector (pure JS).
 *
 * Reads aggregated session rows from Hermes Agent's SQLite state database:
 *   ~/.hermes/state.db   (default)
 *   $HERMES_HOME/state.db  (if env var is set)
 *
 * Requires Node.js >= 22.5.0 (built-in node:sqlite).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configuredPath, expandPath } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { canonicalProvider, inferProviderFromModel, localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

export const CLIENT_KEY = 'hermes';
export const SOURCE_LABEL = 'Hermes Agent';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getDbPath() {
  const hermesHome = process.env.HERMES_HOME;
  if (hermesHome) return join(expandPath(hermesHome), 'state.db');
  return configuredPath('hermes', 'dbPath');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pos(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function posFloat(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Convert a Hermes started_at float (seconds or ms) to a YYYY-MM-DD string. */
function tsToDate(started_at) {
  if (!started_at) return 'unknown';
  const n = Number(started_at);
  if (!Number.isFinite(n)) return 'unknown';
  return localDateFromTimestamp(n);
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function add(agg, t) {
  agg.input     += t.input;
  agg.output    += t.output;
  agg.cacheRead  += t.cacheRead;
  agg.cacheWrite += t.cacheWrite;
  agg.reasoning  += t.reasoning;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * @returns {{ graphJson: object, modelsJson: object }}
 */
export async function collect(pricingData = null) {
  const empty = {
    graphJson:  { contributions: [] },
    modelsJson: { entries: [] }
  };

  const dbPath = getDbPath();
  if (!existsSync(dbPath)) return empty;

  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    return empty;
  }

  let rows;
  try {
    rows = db.prepare(`
      SELECT
        id,
        model,
        billing_provider,
        started_at,
        COALESCE(input_tokens, 0)        AS input_tokens,
        COALESCE(output_tokens, 0)       AS output_tokens,
        COALESCE(cache_read_tokens, 0)   AS cache_read_tokens,
        COALESCE(cache_write_tokens, 0)  AS cache_write_tokens,
        COALESCE(reasoning_tokens, 0)    AS reasoning_tokens,
        COALESCE(actual_cost_usd, estimated_cost_usd, 0) AS cost_usd
      FROM sessions
      WHERE model IS NOT NULL
        AND TRIM(model) != ''
        AND (
          COALESCE(input_tokens, 0) > 0 OR
          COALESCE(output_tokens, 0) > 0 OR
          COALESCE(cache_read_tokens, 0) > 0 OR
          COALESCE(cache_write_tokens, 0) > 0 OR
          COALESCE(reasoning_tokens, 0) > 0 OR
          COALESCE(actual_cost_usd, estimated_cost_usd, 0) > 0
        )
    `).all();
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return empty;
  }

  try { db.close(); } catch { /* ignore */ }

  const dailyMap = new Map();   // "date::model" -> aggregated
  const wmMap    = new Map();   // sessionId -> session-level record

  for (const row of rows) {
    const date     = tsToDate(row.started_at);
    const model    = normalizeModelForGrouping(row.model || 'unknown');
    const provider = canonicalProvider(row.billing_provider) || inferProviderFromModel(model) || 'hermes';
    const tokens   = {
      input:     pos(row.input_tokens),
      output:    pos(row.output_tokens),
      cacheRead:  pos(row.cache_read_tokens),
      cacheWrite: pos(row.cache_write_tokens),
      reasoning:  pos(row.reasoning_tokens)
    };
    const originalCost = posFloat(row.cost_usd);
    const calculatedCost = calculateCost(model, tokens, pricingData, provider);
    const cost = originalCost > 0 ? originalCost : calculatedCost;
    const sessId   = String(row.id || 'unknown');

    // Daily aggregation
    const dk = `${date}::${model}`;
    if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model, provider, ...zero(), cost: 0 });
    const d = dailyMap.get(dk);
    add(d, tokens);
    d.cost += cost;

    // Per-session record (each Hermes row IS a fully-aggregated session)
    wmMap.set(sessId, {
      workspace:      sessId,
      workspaceLabel: sessId,
      model,
      provider,
      ...tokens,
      cost
    });
  }

  return buildOutput(dailyMap, wmMap);
}

// ---------------------------------------------------------------------------
// Convert to common collector JSON
// ---------------------------------------------------------------------------

function buildOutput(dailyMap, wmMap) {
  // Graph JSON
  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map(row => ({
        client:  CLIENT_KEY,
        modelId: row.model,
        tokens: {
          input:     row.input,
          output:    row.output,
          cacheRead:  row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning:  row.reasoning
        },
        cost: row.cost
      }))
    }));

  // Models JSON
  const entries = [...wmMap.values()].map(wm => ({
    client:         CLIENT_KEY,
    workspaceKey:   wm.workspace,
    workspaceLabel: wm.workspaceLabel,
    model:          wm.model,
    provider:       wm.provider,
    input:          wm.input,
    output:         wm.output,
    cacheRead:       wm.cacheRead,
    cacheWrite:      wm.cacheWrite,
    reasoning:       wm.reasoning,
    cost:            wm.cost
  }));

  return { graphJson: { contributions }, modelsJson: { entries } };
}
