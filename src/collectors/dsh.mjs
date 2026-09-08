/**
 * DeepSeek Harness (DSH) data collector (pure JS).
 *
 * Scans ~/.dsh/sessions/<encoded-cwd>/<session-uuid>/session.jsonl.zstd.
 * Each file is a multi-frame zstd container (every frame starts with the
 * magic bytes 28 B5 2F FD); frames are decompressed individually and the
 * concatenated output is parsed as JSONL.
 *
 * The event stream is a flat list of { type, seq, time, data } records:
 *   session         – once per file: session id, cwd, createdAt
 *   request/header  – data.header.config.{provider, model}, may repeat
 *                     mid-session (model switch)
 *   assistant/chunk – chunk.type === "usage" carries per-turn/step token
 *                     usage (no model attached); chunk.type === "finish"
 *                     carries the model that actually produced the step
 *
 * Model attribution: usage chunks are attributed to the "current" model,
 * updated by every request/header and every finish chunk
 * (replayState.response.model, with a flat replayState.model fallback).
 *
 * Token semantics: inputTokens and cacheReadTokens are disjoint counts
 * (unlike Codex, input does not include the cached part).
 *
 * Requires node >= 23.8 for zlib.zstdDecompressSync; on older runtimes the
 * collector warns once and returns empty results instead of crashing.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import zlib from 'node:zlib';
import { envPathList, configuredPaths } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { canonicalProvider, inferProviderFromModel, localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';

export const CLIENT_KEY = 'dsh';
export const SOURCE_LABEL = 'DeepSeek Harness';
const CACHE_VERSION = 1;   // bump when parseSessionFile behavior or output changes
const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || 90);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

let zstdUnavailableWarned = false;

function hasZstdSupport() {
  return typeof zlib.zstdDecompressSync === 'function';
}

function warnZstdUnavailable() {
  if (zstdUnavailableWarned) return;
  zstdUnavailableWarned = true;
  console.warn('[DeepSeek Harness] zlib.zstdDecompressSync unavailable (node >= 23.8 required) — skipping DSH sessions');
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getSessionRoots() {
  return envPathList(process.env.DSH_SESSIONS, configuredPaths('dsh', 'roots', [`${homedir()}/.dsh/sessions`]));
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

/** Recursively collect all .jsonl.zstd file paths under a directory. */
async function collectZstdFiles(dir) {
  const results = [];
  for (const entry of await safeReaddir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectZstdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) {
      results.push(full);
    }
  }
  return results;
}

/** Decompress a multi-frame zstd container into a single UTF-8 string. */
function decodeZstdContainer(buf) {
  const starts = [];
  for (let i = 0; i + ZSTD_MAGIC.length <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i);
    }
  }

  let text = '';
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      // a corrupt frame must not take down the whole file
    }
  }
  return text;
}

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

function workspaceLabel(raw) {
  if (!raw) return null;
  const normalized = String(raw).replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || raw;
}

// ---------------------------------------------------------------------------
// Session parser
// ---------------------------------------------------------------------------

/**
 * Parse a single DSH zstd session file.
 * Returns an array of { seq, time, sessionId, workspace, model, provider, tokens }.
 */
export async function parseSessionFile(filePath, fallbackSessionId) {
  if (!hasZstdSupport()) {
    warnZstdUnavailable();
    return [];
  }

  let buf;
  try {
    buf = await readFile(filePath);
  } catch {
    return [];
  }

  let currentModel = null;
  let currentProvider = null;
  let workspace = null;
  let sessionId = fallbackSessionId || null;

  const records = [];

  for (const raw of decodeZstdContainer(buf).split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === 'session') {
      sessionId = event.id || sessionId;
      workspace = event.cwd || workspace;
      continue;
    }

    if (event.type === 'request/header') {
      const config = event.data?.header?.config;
      if (config?.model) currentModel = config.model;
      if (config?.provider) currentProvider = config.provider;
      continue;
    }

    if (event.type !== 'assistant/chunk') continue;
    const chunk = event.data?.chunk;
    if (!chunk) continue;

    if (chunk.type === 'usage') {
      const u = chunk.usage || {};
      const tokens = {
        input: pos(u.inputTokens),
        output: pos(u.outputTokens),
        cacheRead: pos(u.cacheReadTokens),
        cacheWrite: pos(u.cacheWriteTokens),
        reasoning: 0
      };
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) continue;

      records.push({
        seq: event.seq,
        time: event.time,
        sessionId,
        workspace,
        model: currentModel,
        provider: currentProvider,
        tokens
      });
      continue;
    }

    if (chunk.type === 'finish') {
      const state = chunk.replayState || {};
      const model = state.response?.model || state.model;
      if (model) currentModel = model;
      if (state.provider) currentProvider = state.provider;
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  if (!hasZstdSupport()) {
    warnZstdUnavailable();
    return { graphJson: { contributions: [] }, modelsJson: { entries: [] }, eventsJson: { events: [] } };
  }

  const nestedPaths = await Promise.all(getSessionRoots().map((root) => collectZstdFiles(root)));
  const filePaths = [...new Set(nestedPaths.flat())];

  const dailyMap = new Map();   // "date::model" -> aggregated
  const wmMap = new Map();      // "workspace::model" -> aggregated
  const events = [];
  const seenEventKeys = new Set();

  for (const filePath of filePaths) {
    const fallbackSessionId = basename(dirname(filePath));
    const records = await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, p => parseSessionFile(p, fallbackSessionId));

    for (const { seq, time, sessionId, workspace, model, provider, tokens } of records) {
      const resolvedModel = normalizeModelForGrouping(model || 'unknown');
      const eventKey = `${sessionId || filePath}:${seq}`;
      if (seenEventKeys.has(eventKey)) continue;
      seenEventKeys.add(eventKey);

      const workspaceKey = workspace || sessionId || 'unknown';
      const date = localDateFromTimestamp(time, 'unknown');

      if (time >= EVENT_CUTOFF_MS) {
        events.push({
          client: CLIENT_KEY,
          eventKey,
          eventTime: new Date(time).toISOString(),
          usageDate: date,
          sessionId: sessionId || null,
          workspaceKey,
          workspaceLabel: workspaceLabel(workspaceKey),
          model: resolvedModel,
          tokens,
          cost: calculateCost(resolvedModel, tokens, pricingData, provider)
        });
      }

      const dk = `${date}::${resolvedModel}`;
      if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model: resolvedModel, ...zero() });
      addInto(dailyMap.get(dk), tokens);

      const wmk = `${workspaceKey}::${resolvedModel}`;
      if (!wmMap.has(wmk)) {
        wmMap.set(wmk, {
          workspace: workspaceKey,
          workspaceLabel: workspaceLabel(workspaceKey),
          model: resolvedModel,
          provider: canonicalProvider(provider) || inferProviderFromModel(resolvedModel) || 'unknown',
          ...zero()
        });
      }
      addInto(wmMap.get(wmk), tokens);
    }
  }

  await flushCache(CLIENT_KEY);
  return { ...buildOutput(dailyMap, wmMap, pricingData), eventsJson: { events } };
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
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning: row.reasoning
        };
        return {
          client: CLIENT_KEY,
          modelId: row.model,
          tokens,
          cost: calculateCost(row.model, tokens, pricingData, null, { tiered: false })
        };
      })
    }));

  const entries = [...wmMap.values()].map(wm => {
    const tokens = {
      input: wm.input,
      output: wm.output,
      cacheRead: wm.cacheRead,
      cacheWrite: wm.cacheWrite,
      reasoning: wm.reasoning
    };
    return {
      client: CLIENT_KEY,
      workspaceKey: wm.workspace,
      workspaceLabel: wm.workspaceLabel,
      model: wm.model,
      provider: wm.provider,
      ...tokens,
      cost: calculateCost(wm.model, tokens, pricingData, wm.provider, { tiered: false })
    };
  });

  return { graphJson: { contributions }, modelsJson: { entries } };
}
