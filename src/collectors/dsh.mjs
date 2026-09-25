/**
 * DeepSeek Harness (DSH) data collector (pure JS).
 *
 * Scans ~/.dsh/sessions/<encoded-cwd>/<session-uuid>/session.jsonl.zstd.
 * Plain session.jsonl is also supported. Compressed frame boundaries are
 * read from their headers and blocks, then decoded bytes are joined as JSONL.
 *
 * The event stream is a flat list of { type, seq, time, data } records:
 *   session         – once per file: session id, cwd, createdAt
 *   request/header  – data.header.config.{provider, model}, may repeat
 *                     mid-session (model switch)
 *   assistant/chunk – chunk.type === "usage" carries per-turn/step token
 *                     usage (no model attached); chunk.type === "finish"
 *                     carries the model that actually produced the step
 *
 * Final assistant/message usage replaces chunks for the same turn/step.
 * compaction/summary calls count separately. seedLength excludes fork history.
 * Final source metadata identifies the served model; older chunk-only logs
 * fall back to request headers and finish metadata.
 *
 * Token semantics: inputTokens and cacheReadTokens are disjoint counts
 * (unlike Codex, input does not include the cached part).
 *
 * Compressed logs require Node 22.15+ or 23.8+; plain logs work without zstd.
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
const CACHE_VERSION = 2;   // bump when parseSessionFile behavior or output changes
const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || Infinity);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

const zstdUnavailableWarned = new Set();

function hasZstdSupport() {
  return typeof zlib.zstdDecompressSync === 'function';
}

function warnZstdUnavailable(label) {
  if (zstdUnavailableWarned.has(label)) return;
  zstdUnavailableWarned.add(label);
  console.warn(`[${label}] zstd unavailable (Node 22.15+ or 23.8+ required) — skipping compressed sessions`);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getSessionRoots() {
  return envPathList(process.env.DSH_SESSIONS || (process.env.DSH_HOME && join(process.env.DSH_HOME, 'sessions')),
    configuredPaths('dsh', 'roots', [`${homedir()}/.dsh/sessions`]));
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
    } else if (entry.isFile() && (entry.name.endsWith('.jsonl.zstd') || entry.name === 'session.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

/** Decompress a multi-frame zstd container into a single UTF-8 string. */
export function decodeZstdContainer(buf, label = SOURCE_LABEL) {
  if (!buf.subarray(0, 4).equals(ZSTD_MAGIC)) return buf.toString('utf8');
  if (!hasZstdSupport()) {
    warnZstdUnavailable(label);
    return '';
  }
  // Node can stop after the first frame. Walk RFC 8878 frame/block lengths,
  // never search for magic bytes inside compressed payloads.
  const chunks = [];
  let offset = 0;
  let remaining = 64 * 1024 * 1024;
  while (offset < buf.length) {
    const end = zstdFrameEnd(buf, offset);
    if (end === null) break; // a writer may still be appending the last frame
    try {
      const decoded = zlib.zstdDecompressSync(buf.subarray(offset, end), { maxOutputLength: remaining });
      remaining -= decoded.length;
      chunks.push(decoded);
    } catch {
      // Preserve only the valid prefix; later records may lack routing state.
      break;
    }
    offset = end;
    if (remaining <= 0) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function zstdFrameEnd(buf, start) {
  if (start + 5 > buf.length || !buf.subarray(start, start + 4).equals(ZSTD_MAGIC)) return null;
  const descriptor = buf[start + 4];
  if (descriptor & 0x08) return null; // reserved bit
  const singleSegment = Boolean(descriptor & 0x20);
  const contentSizeFlag = descriptor >>> 6;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0)
    : [0, 2, 4, 8][contentSizeFlag];
  let offset = start + 5 + (singleSegment ? 0 : 1)
    + [0, 1, 2, 4][descriptor & 3] + contentSizeBytes;
  while (offset + 3 <= buf.length) {
    const block = buf.readUIntLE(offset, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) return null;
    offset += 3 + (type === 1 ? 1 : block >>> 3);
    if (offset > buf.length) return null;
    if (block & 1) {
      offset += descriptor & 4 ? 4 : 0;
      return offset <= buf.length ? offset : null;
    }
  }
  return null;
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
  let seedLength = 0;
  let pending = [];

  const records = [];

  for (const [lineIndex, raw] of (await decodeZstdContainer(buf)).split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;

    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'session') {
      sessionId = event.id || sessionId;
      workspace = event.cwd || workspace;
      seedLength = pos(event.seedLength);
      continue;
    }

    if (event.type === 'request/header') {
      pending = [];
      const config = event.data?.header?.config;
      if (config?.model) currentModel = config.model;
      if (config?.provider) currentProvider = config.provider;
      continue;
    }

    if (Number.isFinite(event.seq) && event.seq < seedLength) continue;
    const time = typeof event.time === 'number'
      ? (event.time < 1e12 ? event.time * 1000 : event.time)
      : Date.parse(event.time || '');
    const validTime = Number.isFinite(time) && time > 0 && time <= 8.64e15;
    const turn = event.data?.turn;
    const step = event.data?.step;
    const stepKey = Number.isInteger(turn) && Number.isInteger(step)
      ? `${sessionId || fallbackSessionId}:turn:${turn}:step:${step}` : null;

    if (event.type === 'assistant/message' || event.type === 'compaction/summary') {
      const data = event.data || {};
      if (!data.usage || !validTime) continue;
      const source = data.message?.source || {};
      if (event.type === 'assistant/message') {
        // Final usage replaces the streamed usage of the same call.
        for (const item of pending) {
          if (data.turn == null || data.step == null ||
              (item.turn === data.turn && item.step === data.step)) records[item.index] = null;
        }
        pending = pending.filter(item => records[item.index] !== null);
      }
      const u = data.usage;
      const identity = data.message?.id ? `message:${data.message.id}`
        : data.compactionId ? `compaction:${data.compactionId}` : null;
      records.push({
        seq: event.seq ?? `line:${lineIndex}`, time, sessionId, workspace, identity,
        stepKey: event.type === 'assistant/message' ? stepKey : null,
        model: source.replayState?.response?.responseModel || source.model || currentModel,
        provider: source.provider || currentProvider,
        tokens: { input: pos(u.inputTokens), output: pos(u.outputTokens),
          cacheRead: pos(u.cacheReadTokens), cacheWrite: pos(u.cacheWriteTokens), reasoning: 0 }
      });
      continue;
    }

    if (event.type !== 'assistant/chunk') continue;
    const chunk = event.data?.chunk;
    if (!chunk) continue;

    if (chunk.type === 'usage') {
      if (!validTime) continue;
      const u = chunk.usage || {};
      const tokens = {
        input: pos(u.inputTokens),
        output: pos(u.outputTokens),
        cacheRead: pos(u.cacheReadTokens),
        cacheWrite: pos(u.cacheWriteTokens),
        reasoning: 0
      };
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) continue;

      pending.push({ index: records.length, turn: event.data?.turn, step: event.data?.step });
      records.push({
        seq: event.seq ?? `line:${lineIndex}`,
        stepKey,
        time,
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
      const model = state.response?.responseModel || state.response?.model || state.model;
      for (const item of pending) {
        if (item.finished || (turn != null && step != null && (item.turn !== turn || item.step !== step))) continue;
        if (model) records[item.index].model = model;
        if (state.provider) records[item.index].provider = state.provider;
        item.finished = true;
      }
      if (model) currentModel = model;
      if (state.provider) currentProvider = state.provider;
    }
  }

  return records.filter(record => record && Object.values(record.tokens).some(value => value > 0));
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  const nestedPaths = await Promise.all(getSessionRoots().map((root) => collectZstdFiles(root)));
  const filePaths = [...new Set(nestedPaths.flat())];

  const dailyMap = new Map();   // "date::model" -> aggregated
  const wmMap = new Map();      // "workspace::model" -> aggregated
  const events = [];
  const seenEventKeys = new Set();
  const seenIdentities = new Set();

  for (const filePath of filePaths) {
    if (filePath.endsWith('.zstd') && !hasZstdSupport()) {
      warnZstdUnavailable();
      continue;
    }
    const fallbackSessionId = basename(dirname(filePath));
    const records = await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, p => parseSessionFile(p, fallbackSessionId));

    for (const { seq, time, sessionId, workspace, model, provider, tokens, identity, stepKey } of records) {
      const resolvedModel = normalizeModelForGrouping(model || 'unknown');
      const eventKey = stepKey || identity || `${sessionId || filePath}:${seq}`;
      if (identity && seenIdentities.has(identity)) continue;
      if (seenEventKeys.has(eventKey)) continue;
      seenEventKeys.add(eventKey);
      if (identity) seenIdentities.add(identity);

      const workspaceKey = workspace || sessionId || 'unknown';
      const date = localDateFromTimestamp(time, 'unknown');
      const cost = calculateCost(resolvedModel, tokens, pricingData, provider);

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
          cost
        });
      }

      const dk = `${date}::${resolvedModel}`;
      if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model: resolvedModel, ...zero(), cost: 0 });
      addInto(dailyMap.get(dk), tokens);
      dailyMap.get(dk).cost += cost;

      const wmk = `${workspaceKey}::${resolvedModel}`;
      if (!wmMap.has(wmk)) {
        wmMap.set(wmk, {
          workspace: workspaceKey,
          workspaceLabel: workspaceLabel(workspaceKey),
          model: resolvedModel,
          provider: canonicalProvider(provider) || inferProviderFromModel(resolvedModel) || 'unknown',
          ...zero(), cost: 0
        });
      }
      addInto(wmMap.get(wmk), tokens);
      wmMap.get(wmk).cost += cost;
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
          cost: row.cost
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
      cost: wm.cost
    };
  });

  return { graphJson: { contributions }, modelsJson: { entries } };
}
