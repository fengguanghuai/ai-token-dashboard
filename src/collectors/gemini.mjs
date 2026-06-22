/**
 * Gemini CLI data collector (pure JS).
 *
 * Scans ~/.gemini/tmp/ for session files in two layouts:
 *
 *   Legacy JSON    ~/.gemini/tmp/session-<id>.json
 *   Modern JSON    ~/.gemini/tmp/<project_hash>/chats/<file>.json
 *   Modern JSONL   ~/.gemini/tmp/<project_hash>/chats/<file>.jsonl
 *                  (also: root-level session-*.jsonl)
 *
 * Token-count normalisation:
 *   Gemini's "input" in session files is cache-inclusive, i.e. it already
 *   contains the cached portion. We separate them:
 *     net_input  = input − cached   (clamped to ≥ 0)
 *     cache_read = cached
 *
 * Cache normalization uses Gemini's own total fields where available,
 * including the "total" cross-check for session-format files.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { calculateCost } from '../pricing.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';

export const CLIENT_KEY = 'gemini';
export const SOURCE_LABEL = 'Gemini CLI';
const CACHE_VERSION = 1;   // bump when parsed event shape changes

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getTmpDir() {
  return join(homedir(), '.gemini', 'tmp');
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

async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileMtime(filePath) {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return Date.now();
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

// ---------------------------------------------------------------------------
// Cache normalisation
// ---------------------------------------------------------------------------

/**
 * "Headless" path (stats object): Gemini's promptTokenCount is cache-inclusive,
 * so subtract the cached portion from input.
 */
function normaliseHeadlessInputAndCache(input, cached) {
  const i = Math.max(0, input);
  const c = Math.max(0, cached);
  const cPortion = Math.min(c, i);
  return { netInput: i - cPortion, cacheRead: c };
}

/**
 * "Session" path (full session format):
 * Use the total field (when available) to determine whether input is already
 * net (exclusive) or still cache-inclusive.
 *
 * If total == input + output + reasoning + tool  (inclusive formula matches),
 * then input still contains cached, so subtract.
 *
 * If total == input + output + reasoning + tool + cached  (exclusive formula
 * matches), then input is already net — keep as-is.
 */
function normaliseSessionInputAndCache(input, cached, output, reasoning, tool, total) {
  const i  = Math.max(0, input);
  const c  = Math.max(0, cached);
  const o  = Math.max(0, output);
  const r  = Math.max(0, reasoning);
  const tk = Math.max(0, tool);

  if (total == null) {
    // No total hint — fall back to headless logic
    const cPortion = Math.min(c, i);
    return { netInput: i - cPortion, cacheRead: c };
  }

  const t = Math.max(0, total);
  const inclusiveTotal  = i + o + r + tk;          // cached still inside input
  const exclusiveTotal  = inclusiveTotal + c;       // cached separately added

  // If total matches the inclusive formula (and not exclusive), input is still
  // cache-inclusive → subtract.
  if (c > 0 && t === inclusiveTotal && t !== exclusiveTotal) {
    const cPortion = Math.min(c, i);
    return { netInput: i - cPortion, cacheRead: c };
  }

  // Otherwise treat input as already net
  return { netInput: i, cacheRead: c };
}

// ---------------------------------------------------------------------------
// Session-format JSON parser  (full GeminiSession structure)
// ---------------------------------------------------------------------------

function parseSessionJson(obj, fallbackDate) {
  const events = [];
  const sessionId = obj.sessionId || obj.session_id || 'unknown';
  const messages = Array.isArray(obj.messages) ? obj.messages : [];

  for (const msg of messages) {
    if (msg.type !== 'gemini') continue;
    const model  = msg.model;
    if (!model) continue;
    const tokens = msg.tokens;
    if (!tokens) continue;

    let date = fallbackDate;
    if (msg.timestamp) {
      date = localDateFromTimestamp(msg.timestamp, fallbackDate);
    }

    const input     = pos(tokens.input);
    const output    = pos(tokens.output);
    const cached    = pos(tokens.cached);
    const reasoning = pos(tokens.thoughts);
    const tool      = pos(tokens.tool);
    const total     = tokens.total != null ? pos(tokens.total) : null;

    const { netInput, cacheRead } = normaliseSessionInputAndCache(
      input, cached, output, reasoning, tool, total
    );

    events.push({
      sessionId,
      date,
      model: normalizeModelForGrouping(model),
      tokens: {
        input:     netInput + tool,   // tool tokens count as input (mirrors Rust)
        output,
        cacheRead,
        cacheWrite: 0,
        reasoning
      }
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Headless JSON parser  (stats object)
// ---------------------------------------------------------------------------

function parseHeadlessStats(stats, modelHint, date, sessionId) {
  const events = [];

  // Try per-model breakdown first
  const models = stats.models;
  if (models && typeof models === 'object') {
    for (const [modelName, data] of Object.entries(models)) {
      const t = data.tokens || {};
      const input     = pos(t.prompt   ?? t.input        ?? t.input_tokens);
      const output    = pos(t.candidates ?? t.output      ?? t.output_tokens);
      const cached    = pos(t.cached   ?? t.cached_tokens);
      const reasoning = pos(t.thoughts ?? t.reasoning);

      if (input === 0 && output === 0 && cached === 0 && reasoning === 0) continue;

      const { netInput, cacheRead } = normaliseHeadlessInputAndCache(input, cached);
      events.push({
        sessionId,
        date,
        model: normalizeModelForGrouping(modelName),
        tokens: { input: netInput, output, cacheRead, cacheWrite: 0, reasoning }
      });
    }
    if (events.length > 0) return events;
  }

  // Flat stats fallback
  const input     = pos(stats.input_tokens  ?? stats.prompt_tokens);
  const output    = pos(stats.output_tokens ?? stats.candidates_tokens);
  const cached    = pos(stats.cached_tokens);
  const reasoning = pos(stats.thoughts_tokens ?? stats.reasoning_tokens);

  if (input === 0 && output === 0 && cached === 0 && reasoning === 0) return [];

  const { netInput, cacheRead } = normaliseHeadlessInputAndCache(input, cached);
  events.push({
    sessionId,
    date,
    model: normalizeModelForGrouping(modelHint || 'unknown'),
    tokens: { input: netInput, output, cacheRead, cacheWrite: 0, reasoning }
  });

  return events;
}

// ---------------------------------------------------------------------------
// JSON file parser  (handles both full-session and headless formats)
// ---------------------------------------------------------------------------

async function parseJsonFile(filePath, fallbackDate, sessionId) {
  const text = await safeReadFile(filePath);
  if (!text) return [];

  let obj;
  try { obj = JSON.parse(text); } catch { return []; }

  // Full session format
  if (obj.sessionId || obj.session_id) {
    return parseSessionJson(obj, fallbackDate);
  }

  // Direct gemini event
  if (obj.type === 'gemini') {
    return parseSingleGeminiEvent(obj, sessionId, fallbackDate);
  }

  // Headless: stats object
  const stats = obj.stats ?? obj.result?.stats;
  if (stats) {
    const date = extractDateFromValue(obj) ?? fallbackDate;
    const modelHint = typeof obj.model === 'string' ? obj.model : null;
    return parseHeadlessStats(stats, modelHint, date, sessionId);
  }

  return [];
}

function parseSingleGeminiEvent(obj, sessionId, fallbackDate) {
  const model = typeof obj.model === 'string' ? obj.model : null;
  const tokens = obj.tokens;
  if (!model || !tokens) return [];

  const date = extractDateFromValue(obj) ?? fallbackDate;

  const input     = pos(tokens.input);
  const output    = pos(tokens.output);
  const cached    = pos(tokens.cached);
  const reasoning = pos(tokens.thoughts);
  const tool      = pos(tokens.tool);
  const total     = tokens.total != null ? pos(tokens.total) : null;

  const { netInput, cacheRead } = normaliseSessionInputAndCache(
    input, cached, output, reasoning, tool, total
  );

  return [{
    sessionId,
    date,
    model: normalizeModelForGrouping(model),
    tokens: { input: netInput + tool, output, cacheRead, cacheWrite: 0, reasoning }
  }];
}

// ---------------------------------------------------------------------------
// JSONL file parser  (streaming format)
// ---------------------------------------------------------------------------

async function parseJsonlFile(filePath, fallbackDate) {
  const text = await safeReadFile(filePath);
  if (!text) return [];

  let sessionId = basename(filePath, extname(filePath));
  let currentModel = null;
  const events = [];
  // Track direct message IDs for dedup (Gemini may emit the same ID twice with updated data)
  const directMsgIndex = new Map();  // id → index in events

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const type = obj.type;

    // ── init ──
    if (type === 'init') {
      if (typeof obj.model === 'string') currentModel = obj.model;
      const id = obj.session_id ?? obj.sessionId;
      if (typeof id === 'string') sessionId = id;
      continue;
    }

    // Update session ID from any line that carries it
    const lineSessionId = obj.session_id ?? obj.sessionId;
    if (typeof lineSessionId === 'string') sessionId = lineSessionId;

    // ── gemini turn (direct token object) ──
    if (type === 'gemini') {
      if (typeof obj.model === 'string') currentModel = obj.model;

      const parsed = parseSingleGeminiEvent(
        obj,
        sessionId,
        extractDateFromValue(obj) ?? fallbackDate
      );
      if (parsed.length > 0) {
        const msgId = typeof obj.id === 'string' ? obj.id : null;
        if (msgId) {
          if (directMsgIndex.has(msgId)) {
            // Replace with updated data
            events[directMsgIndex.get(msgId)] = parsed[0];
          } else {
            directMsgIndex.set(msgId, events.length);
            events.push(parsed[0]);
          }
        } else {
          events.push(parsed[0]);
        }
      }
      continue;
    }

    // ── result / any line with stats ──
    const stats = obj.stats ?? obj.result?.stats;
    if (stats) {
      const date      = extractDateFromValue(obj) ?? fallbackDate;
      const modelHint = currentModel;
      const parsed    = parseHeadlessStats(stats, modelHint, date, sessionId);
      events.push(...parsed);
    }
  }

  return events;
}

/**
 * Parse one Gemini session file (json or jsonl). The fallback date and session
 * id are derived from the path + mtime, so this is a pure function of the file
 * and safe to memoize by fingerprint.
 */
async function parseGeminiFile(filePath) {
  const fallbackDate = localDateFromTimestamp(await fileMtime(filePath));
  const sessionId = basename(filePath, extname(filePath));
  const ext = extname(filePath).toLowerCase();
  return ext === '.jsonl'
    ? parseJsonlFile(filePath, fallbackDate)
    : parseJsonFile(filePath, fallbackDate, sessionId);
}

// ---------------------------------------------------------------------------
// Date extractor
// ---------------------------------------------------------------------------

function extractDateFromValue(obj) {
  const raw = obj.timestamp ?? obj.created_at;
  if (!raw) return null;
  return localDateFromTimestamp(raw, null);
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

/**
 * Decide whether a given relative path under ~/.gemini/tmp/ is a valid
 * Gemini session file we should parse.
 *
 * Accepted patterns:
 *   session-<anything>.json[l]              (legacy, directly in tmp/)
 *   <hash>/chats/<filename>.json[l]         (modern layout)
 */
function isAcceptedFile(entry, parentName) {
  const name = entry.name;
  const ext  = extname(name).toLowerCase();
  if (ext !== '.json' && ext !== '.jsonl') return false;

  // Legacy: filename starts with "session-"
  if (name.startsWith('session-')) return true;

  // Modern: parent directory is "chats"
  if (parentName === 'chats') return true;

  return false;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  const tmpDir = getTmpDir();
  const topEntries = await safeReaddir(tmpDir);

  const dailyMap = new Map();
  const wmMap    = new Map();

  /**
   * Accumulate parsed events into the two aggregate maps.
   */
  function accumulate(events) {
    for (const { sessionId, date, model, tokens } of events) {
      // Daily
      const dk = `${date}::${model}`;
      if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model, ...zero(), cost: 0 });
      addInto(dailyMap.get(dk), tokens);

      // Workspace+model (use sessionId as workspace key for Gemini)
      const wmk = `${sessionId}::${model}`;
      if (!wmMap.has(wmk)) {
        wmMap.set(wmk, {
          workspace:      sessionId,
          workspaceLabel: sessionId,
          model,
          ...zero(),
          cost: 0
        });
      }
      addInto(wmMap.get(wmk), tokens);
    }
  }

  for (const entry of topEntries) {
    const entryPath = join(tmpDir, entry.name);

    if (entry.isFile() && isAcceptedFile(entry, /* parentName */ '')) {
      // Legacy root-level session file
      accumulate(await cachedParse(CLIENT_KEY, CACHE_VERSION, entryPath, parseGeminiFile));
      continue;
    }

    if (entry.isDirectory()) {
      // Modern layout: <hash>/chats/
      const chatsDir     = join(entryPath, 'chats');
      const chatsEntries = await safeReaddir(chatsDir);

      for (const chatEntry of chatsEntries) {
        if (!chatEntry.isFile() || !isAcceptedFile(chatEntry, 'chats')) continue;

        const filePath = join(chatsDir, chatEntry.name);
        accumulate(await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, parseGeminiFile));
      }
    }
  }

  await flushCache(CLIENT_KEY);
  return buildOutput(dailyMap, wmMap, pricingData);
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
