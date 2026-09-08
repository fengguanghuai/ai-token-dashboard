/**
 * Grok CLI data collector (pure JS).
 *
 * Scans the Grok CLI session store:
 *   ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/updates.jsonl
 *
 * Only updates.jsonl carries usage. Relevant rows look like:
 *   { timestamp: <epoch seconds>, method: "session/update" | "_x.ai/session/update",
 *     params: { sessionId, update: { sessionUpdate: "turn_completed", usage: {...} } } }
 *
 * Token counting strategy:
 *   • update.usage.modelUsage buckets usage per model (one turn may span
 *     several models) — expanded into one event per bucket.
 *   • When modelUsage is absent, the whole usage falls back to the model of
 *     the session's last turn_started (events.jsonl) or summary.json
 *     current_model_id.
 *   • inputTokens includes cachedReadTokens and outputTokens includes
 *     reasoningTokens, so both are split out to keep totals additive.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { configuredPaths, envPathList } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';

export const CLIENT_KEY = 'grok';
export const SOURCE_LABEL = 'Grok CLI';
const CACHE_VERSION = 1;   // bump when parseSessionFile behavior or output changes
const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || 90);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getSessionRoots() {
  const envRoots = envPathList(process.env.GROK_HOME ? join(process.env.GROK_HOME, 'sessions') : null);
  if (envRoots.length) return envRoots;
  return configuredPaths('grok', 'roots', [`${homedir()}/.grok/sessions`]);
}

async function discoverSessionDirs() {
  const sessions = [];
  for (const root of getSessionRoots()) {
    for (const workspaceName of await safeReaddir(root)) {
      const workspaceDir = join(root, workspaceName);
      for (const sessionName of await safeReaddir(workspaceDir)) {
        const sessionDir = join(workspaceDir, sessionName);
        if (await fileExists(join(sessionDir, 'updates.jsonl'))) {
          sessions.push({ sessionDir, workspace: decodeWorkspace(workspaceName) });
        }
      }
    }
  }
  return sessions;
}

async function safeReaddir(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Session directories are named after the URL-encoded absolute cwd,
 * e.g. "%2FUsers%2Fjohn%2Fmy-project". Fall back to the raw name when
 * decoding fails.
 */
function decodeWorkspace(dirName) {
  try {
    const decoded = decodeURIComponent(dirName);
    if (decoded.startsWith('/') || /^[A-Za-z]:\\/.test(decoded)) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return dirName;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function pos(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addInto(agg, t) {
  agg.input += t.input;
  agg.output += t.output;
  agg.cacheRead += t.cacheRead;
  agg.cacheWrite += t.cacheWrite;
  agg.reasoning += t.reasoning;
}

function bucketToTokens(bucket) {
  const cachedRead = pos(bucket.cachedReadTokens);
  const reasoning = pos(bucket.reasoningTokens);
  return {
    input: Math.max(0, pos(bucket.inputTokens) - cachedRead),
    output: Math.max(0, pos(bucket.outputTokens) - reasoning),
    cacheRead: cachedRead,
    cacheWrite: pos(bucket.cacheCreationTokens),
    reasoning
  };
}

function tokensIsZero(t) {
  return t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite === 0 && t.reasoning === 0;
}

/** Parse events.jsonl turn_started records for fallback model resolution. */
async function parseEventsFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const records = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'turn_started') continue;
    const ms = typeof entry.ts === 'number'
      ? (entry.ts < 10_000_000_000 ? entry.ts * 1000 : entry.ts)
      : Date.parse(entry.ts || '');
    if (!Number.isFinite(ms)) continue;
    records.push({ ts: ms, modelId: typeof entry.model_id === 'string' ? entry.model_id : null });
  }
  return records;
}

async function readSummaryModel(sessionDir) {
  try {
    const summary = JSON.parse(await readFile(join(sessionDir, 'summary.json'), 'utf8'));
    const model = summary?.current_model_id;
    return typeof model === 'string' && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

function modelFromTurnStarted(records, turnMs) {
  let match = null;
  for (const record of records) {
    if (record.ts <= turnMs && record.modelId) match = record.modelId;
  }
  return match;
}

/**
 * Parse a single updates.jsonl. Returns an array of
 * { timestamp (epoch seconds), sessionId, model, tokens }.
 */
export async function parseSessionFile(filePath, workspace) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const sessionDir = dirname(filePath);
  const events = [];
  let fallbackRecords = null;
  let fallbackSummaryModel = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const update = entry.params?.update;
    if (update?.sessionUpdate !== 'turn_completed') continue;
    const usage = update.usage;
    if (!usage) continue;   // cancelled/aborted turns carry no usage

    const timestamp = pos(entry.timestamp);
    if (!timestamp) continue;

    const sessionId = entry.params?.sessionId || basename(sessionDir || '') || 'unknown';
    const modelUsage = usage.modelUsage && typeof usage.modelUsage === 'object'
      ? Object.entries(usage.modelUsage)
      : [];

    const turnMs = timestamp * 1000;
    const emit = (model, bucket) => {
      const tokens = bucketToTokens(bucket);
      if (tokensIsZero(tokens)) return;
      events.push({ timestamp, sessionId, workspace, model, tokens });
    };

    if (modelUsage.length > 0) {
      for (const [modelName, bucket] of modelUsage) {
        emit(normalizeModelForGrouping(modelName), bucket);
      }
      continue;
    }

    // No per-model buckets: fall back to the session's current model.
    if (fallbackRecords === null && sessionDir) {
      fallbackRecords = await cachedParse(
        CLIENT_KEY, CACHE_VERSION, join(sessionDir, 'events.jsonl'),
        p => parseEventsFile(p)
      ).catch(() => []);
      fallbackSummaryModel = await readSummaryModel(sessionDir);
    }
    const fallbackModel = modelFromTurnStarted(fallbackRecords || [], turnMs)
      || fallbackSummaryModel
      || 'unknown';
    emit(normalizeModelForGrouping(fallbackModel), usage);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  const dailyMap = new Map();   // "date::model" -> aggregated
  const wmMap = new Map();      // "workspace::model" -> aggregated
  const events = [];

  for (const { sessionDir, workspace } of await discoverSessionDirs()) {
    const parsedEvents = await cachedParse(
      CLIENT_KEY, CACHE_VERSION, join(sessionDir, 'updates.jsonl'),
      fp => parseSessionFile(fp, workspace)
    );

    for (const { timestamp, sessionId, model, tokens } of parsedEvents) {
      const ms = timestamp * 1000;
      const date = localDateFromTimestamp(timestamp);
      const cost = calculateCost(model, tokens, pricingData, null, { tiered: false });

      if (ms >= EVENT_CUTOFF_MS) {
        events.push({
          client: CLIENT_KEY,
          eventKey: [sessionId, timestamp, model].join('::'),
          eventTime: new Date(ms).toISOString(),
          usageDate: date,
          sessionId,
          workspaceKey: workspace,
          workspaceLabel: workspace,
          model,
          tokens,
          cost
        });
      }

      const dk = `${date}::${model}`;
      if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model, ...zero(), cost: 0 });
      addInto(dailyMap.get(dk), tokens);
      dailyMap.get(dk).cost += cost;

      const wmk = `${workspace}::${model}`;
      if (!wmMap.has(wmk)) {
        wmMap.set(wmk, { workspace, model, ...zero(), cost: 0 });
      }
      addInto(wmMap.get(wmk), tokens);
      wmMap.get(wmk).cost += cost;
    }
  }

  await flushCache(CLIENT_KEY);
  return { ...buildOutput(dailyMap, wmMap), eventsJson: { events } };
}

function buildOutput(dailyMap, wmMap) {
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
        client: CLIENT_KEY,
        modelId: row.model,
        tokens: {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning: row.reasoning
        },
        cost: row.cost
      }))
    }));

  const entries = [...wmMap.values()].map(wm => ({
    client: CLIENT_KEY,
    workspaceKey: wm.workspace,
    workspaceLabel: wm.workspace,
    model: wm.model,
    input: wm.input,
    output: wm.output,
    cacheRead: wm.cacheRead,
    cacheWrite: wm.cacheWrite,
    reasoning: wm.reasoning,
    cost: wm.cost
  }));

  return { graphJson: { contributions }, modelsJson: { entries } };
}
