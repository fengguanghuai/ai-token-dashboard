/**
 * OpenClaw data collector (pure JS).
 *
 * Scans agent directories in multiple roots for JSONL transcript files:
 *
 *   Primary:  ~/.openclaw/agents/<agentId>/sessions/*.jsonl[*]
 *   Legacy:   ~/.clawdbot/agents/...
 *             ~/.moltbot/agents/...
 *             ~/.moldbot/agents/...
 *
 * Supported file variants:
 *   <sessionId>.jsonl                       live transcript
 *   <sessionId>.jsonl.deleted.<timestamp>   archived
 *   <sessionId>.jsonl.reset.<timestamp>     reset
 *   sessions.json                           index file (legacy)
 *
 * JSONL event types:
 *   model_change  – { type, modelId, provider }
 *   custom        – { type, customType:"model-snapshot", data:{ modelId, provider } }
 *   message       – { type, message:{ role:"assistant", model, provider,
 *                     timestamp, usage:{ input, output, cacheRead, cacheWrite,
 *                     totalTokens, cost:{ total } } } }
 *
 * Only assistant messages with a resolved model are counted.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync }              from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { decodeZstdContainer } from './dsh.mjs';
import { parseSessionFile as parseCodexSession } from './codex.mjs';
import { configuredPaths } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { canonicalProvider, localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';

export const CLIENT_KEY  = 'openclaw';
export const SOURCE_LABEL = 'OpenClaw';
const CACHE_VERSION = 3;   // bump when parseSessionFile output shape changes

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** All roots that may contain OpenClaw agent data. */
export function getAgentRoots() {
  return configuredPaths('openclaw', 'agentRoots');
}

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dir) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function safeReadFile(filePath) {
  try {
    if ((await stat(filePath)).size > 64 * 1024 * 1024) throw new Error('transcript exceeds 64 MiB');
    return decodeTranscript(await readFile(filePath));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[OpenClaw] cannot read transcript: ${error.message}`);
    return null;
  }
}

function decodeTranscript(buffer) {
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8');
  }
  return decodeZstdContainer(buffer, SOURCE_LABEL);
}

async function fileMtimeMs(filePath) {
  try { return (await stat(filePath)).mtimeMs; } catch { return Date.now(); }
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
// Session ID extraction
// ---------------------------------------------------------------------------

/**
 * Derive a session ID from a filename that may be:
 *   abc-123.jsonl
 *   abc-123.jsonl.deleted.1700000000000
 *   abc-123.jsonl.reset.2026-03-20T06-34-44.520Z
 *
 * Strategy: split on the first occurrence of ".jsonl" and take the prefix.
 */
function sessionIdFromFilename(name) {
  const idx = name.indexOf('.jsonl');
  return idx > 0 ? name.slice(0, idx) : basename(name, extname(name));
}

// ---------------------------------------------------------------------------
// Determine whether a file should be parsed
// ---------------------------------------------------------------------------

function isTranscriptFile(name) {
  if (/checkpoint/i.test(name)) return false; // snapshots are not new API usage
  if (name === 'sessions.json') return false;          // handled separately
  if (name.endsWith('.json'))   return false;          // other json, not JSONL
  return /\.jsonl(?:\.(?:gz|zst|zstd))?$/.test(name)
      || name.includes('.jsonl.deleted.')
      || name.includes('.jsonl.reset.');
}

// ---------------------------------------------------------------------------
// Index file parser  (sessions.json)
// ---------------------------------------------------------------------------

/**
 * Parse a sessions.json index:
 *   { "agent:main:main": { sessionId: "...", sessionFile?: "..." }, ... }
 *
 * Returns an array of { sessionId, filePath } objects whose files exist.
 */
async function parseIndexFile(indexPath) {
  const text = await safeReadFile(indexPath);
  if (!text) return [];

  let obj;
  try { obj = JSON.parse(text); } catch { return []; }

  const indexDir = indexPath.slice(0, indexPath.lastIndexOf('/'));
  const results  = [];

  for (const entry of Object.values(obj)) {
    if (!entry || typeof entry.sessionId !== 'string') continue;
    const sessionId = entry.sessionId;

    // Resolve session file path
    let filePath;
    const sf = typeof entry.sessionFile === 'string' ? entry.sessionFile.trim() : '';
    if (sf) {
      filePath = sf.startsWith('/') ? sf : join(indexDir, sf);
    } else {
      filePath = join(indexDir, `${sessionId}.jsonl`);
    }

    if (existsSync(filePath)) {
      results.push({ sessionId, filePath });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// JSONL session parser
// ---------------------------------------------------------------------------

async function parseSessionFile(filePath, sessionId, agentPath) {
  const text = await safeReadFile(filePath);
  if (!text) return [];

  const fallbackTimestamp = await fileMtimeMs(filePath);
  return parseTranscript(text, sessionId, agentPath, fallbackTimestamp, filePath);
}

function parseTranscript(text, sessionId, agentPath, fallbackTimestamp, origin) {
  const fallbackDate = localDateFromTimestamp(fallbackTimestamp);

  let currentModel    = null;
  let currentProvider = null;
  const events        = [];

  for (const [lineNumber, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const type = entry.type;
    if (type === 'session' && typeof entry.id === 'string') sessionId = entry.id;

    // ── model_change ──────────────────────────────────────────────────────
    if (type === 'model_change') {
      if (typeof entry.modelId === 'string' && entry.modelId)
        currentModel = entry.modelId;
      if (typeof entry.provider === 'string' && entry.provider)
        currentProvider = entry.provider;
      continue;
    }

    // ── custom / model-snapshot ───────────────────────────────────────────
    if (type === 'custom' && entry.customType === 'model-snapshot') {
      const d = entry.data;
      if (d) {
        if (typeof d.modelId === 'string' && d.modelId)
          currentModel = d.modelId;
        if (typeof d.provider === 'string' && d.provider)
          currentProvider = d.provider;
      }
      continue;
    }

    // ── message ───────────────────────────────────────────────────────────
    if (type === 'message') {
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant' || msg.stopReason === 'pending') continue;

      const usage = msg.usage;
      if (!usage) continue;

      // Model resolution: message-embedded → current state
      const model =
        (typeof msg.model    === 'string' && msg.model    ? msg.model    : null) ||
        (typeof currentModel === 'string' && currentModel ? currentModel : null);

      if (!model) continue;

      const provider =
        (typeof msg.provider    === 'string' && msg.provider    ? msg.provider    : null) ||
        (typeof currentProvider === 'string' && currentProvider ? currentProvider : null) ||
        'unknown';

      currentModel    = model;
      currentProvider = provider;

      // Date from message timestamp (milliseconds since epoch)
      let date = fallbackDate;
      const timestamp = msg.timestamp ?? entry.timestamp ?? fallbackTimestamp;
      if (timestamp != null) {
        date = localDateFromTimestamp(timestamp, fallbackDate);
      }

      const costValue = usage.cost?.total;
      const cost = typeof costValue === 'number' && Number.isFinite(costValue) && costValue >= 0 ? costValue : null;
      const id = entry.id || msg.idempotencyKey || msg.responseId || `${origin}:${lineNumber}`;
      const eventKey = createHash('sha256').update(JSON.stringify([sessionId, id])).digest('hex');
      const mirror = /^codex-app-server:([^:]+):([^:]+):assistant$/.exec(msg.idempotencyKey || '');

      events.push({
        sessionId,
        agentPath,
        eventKey,
        timestamp,
        mirrorTurn: mirror ? `${mirror[1]}:${mirror[2]}` : null,
        date,
        model: normalizeModelForGrouping(model),
        provider: canonicalProvider(provider) || provider,
        tokens: {
          input:     pos(usage.input),
          output:    pos(usage.output),
          cacheRead:  pos(usage.cacheRead),
          cacheWrite: pos(usage.cacheWrite),
          reasoning:  0
        },
        cost
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Directory scanner — walks one agents root
// ---------------------------------------------------------------------------

/**
 * Scan one agents root (e.g. ~/.openclaw/agents).
 * Layout: <root>/<agentId>/sessions/<files>
 *
 * Only transcript roots are traversed; checkpoint directories are excluded.
 *
 * Also tolerates a flatter layout where transcripts sit directly under
 * <agentId>/ without a "sessions" subdir (for forward-compat).
 */
async function scanAgentsRoot(root) {
  const events = [];

  const agentEntries = await safeReaddir(root);
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;

    const agentDir  = join(root, agentEntry.name);
    const agentPath = agentDir;  // use as workspace key
    for (const name of ['openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite']) {
      const dbPath = join(agentDir, 'agent', name);
      if (existsSync(dbPath)) events.push(...await parseTranscriptDatabase(dbPath, agentPath));
    }

    // Prefer <agentId>/sessions/ if it exists, else fall back to <agentId>/
    const sessionsDir = join(agentDir, 'sessions');
    const targetDir   = existsSync(sessionsDir) ? sessionsDir : agentDir;
    const fileEntries = await transcriptFiles(targetDir);
    fileEntries.push(...await transcriptFiles(join(agentDir, 'session-sqlite-import-archive')));

    // --- index file first (to avoid double-counting files referenced by index)
    const indexRefs = new Set();
    const indexEntry = existsSync(join(targetDir, 'sessions.json'));
    if (indexEntry) {
      const indexPath = join(targetDir, 'sessions.json');
      const indexed   = await parseIndexFile(indexPath);
      for (const { sessionId, filePath } of indexed) {
        indexRefs.add(filePath);
        const ev = await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, () => parseSessionFile(filePath, sessionId, agentPath));
        events.push(...ev);
      }
    }

    // --- individual transcript files
    for (const filePath of fileEntries) {
      if (indexRefs.has(filePath)) continue;   // already handled via index

      const sessionId = sessionIdFromFilename(basename(filePath));
      const ev = await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, () => parseSessionFile(filePath, sessionId, agentPath));
      events.push(...ev);
    }
    const embedded = await collectEmbeddedCodex(agentDir);
    const ownedTurns = new Set(embedded.map(event => event.mirrorTurn).filter(Boolean));
    // Replace a mirrored terminal response only when the underlying turn was
    // actually read, retaining the transcript as fallback for missing rollouts.
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].agentPath === agentDir && ownedTurns.has(events[index].mirrorTurn)) events.splice(index, 1);
    }
    events.push(...embedded);
  }

  return events;
}

async function transcriptFiles(dir) {
  const paths = [];
  for (const entry of await safeReaddir(dir)) {
    if (/checkpoint/i.test(entry.name) || entry.name === 'codex-home') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await transcriptFiles(path));
    else if (entry.isFile() && isTranscriptFile(entry.name)) paths.push(path);
  }
  return paths.sort();
}

async function collectEmbeddedCodex(agentPath) {
  const result = [];
  const home = join(agentPath, 'agent', 'codex-home');
  for (const subdir of ['sessions', 'archived_sessions']) {
    for (const file of await transcriptFiles(join(home, subdir))) {
      if (!file.endsWith('.jsonl')) continue;
      const records = await cachedParse('openclaw-codex', 1, file, path => parseCodexSession(path, basename(path, '.jsonl')));
      for (const record of records) {
        const reasoning = Math.min(record.tokens.output, record.tokens.reasoning);
        const tokens = { ...record.tokens, output: record.tokens.output - reasoning, reasoning };
        result.push({ ...record, tokens, agentPath, provider: 'openai', cost: null,
          mirrorTurn: record.turnId ? `${record.sessionId}:${record.turnId}` : null,
          eventKey: createHash('sha256').update(JSON.stringify(['codex', record.sessionId, record.turnId, record.timestamp, tokens])).digest('hex') });
      }
    }
  }
  return result;
}

async function parseTranscriptDatabase(path, agentPath) {
  const events = [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (tables.has('transcript_events')) {
      let sessionId = null;
      let lines = [];
      let createdAt = 0;
      const emit = () => {
        if (lines.length) events.push(...parseTranscript(lines.join('\n'), sessionId, agentPath, createdAt, `${path}:${sessionId}`));
      };
      const statement = db.prepare('SELECT session_id, event_json, created_at FROM transcript_events ORDER BY session_id, seq');
      for (const row of sqliteRows(statement)) {
        if (row.session_id !== sessionId) { emit(); lines = []; sessionId = row.session_id; }
        lines.push(row.event_json);
        createdAt = row.created_at;
      }
      emit();
    }
    if (tables.has('session_transcript_archives')) {
      for (const row of sqliteRows(db.prepare('SELECT session_id, archive_blob, created_at, generation FROM session_transcript_archives'))) {
        try {
          const text = decodeTranscript(Buffer.from(row.archive_blob));
          events.push(...parseTranscript(text, row.session_id, agentPath, row.created_at, `${path}:${row.session_id}:${row.generation}`));
        } catch (error) { console.warn(`[OpenClaw] cannot decode archive: ${error.message}`); }
      }
    }
  } finally { db.close(); }
  return events;
}

function sqliteRows(statement) {
  return typeof statement.iterate === 'function' ? statement.iterate() : statement.all();
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  const roots  = getAgentRoots();
  const dailyMap = new Map();   // "date::model" → aggregated
  const wmMap    = new Map();   // "agentPath::model" → aggregated
  const seen = new Set();
  const timeEvents = [];

  function accumulate(events) {
    for (const { sessionId, agentPath, date, model, provider, tokens, cost, eventKey, timestamp } of events) {
      if (seen.has(eventKey)) continue;
      seen.add(eventKey);
      const calculatedCost = calculateCost(model, tokens, pricingData, provider);
      const effectiveCost = cost ?? calculatedCost;
      const ms = typeof timestamp === 'number' ? (timestamp < 1e12 ? timestamp * 1000 : timestamp) : Date.parse(timestamp);
      if (Number.isFinite(ms) && ms >= Date.now() - Number(process.env.TIME_USAGE_HISTORY_DAYS || Infinity) * 86400000) {
        timeEvents.push({ client: CLIENT_KEY, eventKey, eventTime: new Date(ms).toISOString(), usageDate: date,
          sessionId, workspaceKey: agentPath, workspaceLabel: agentPath, model, provider, tokens, cost: effectiveCost, costBasis: cost != null ? 'recorded' : undefined });
      }

      // Daily
      const dk = `${date}::${model}`;
      if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model, provider, ...zero(), cost: 0 });
      const d = dailyMap.get(dk);
      addInto(d, tokens);
      d.cost += effectiveCost;

      // Workspace+model  (agentPath is the natural workspace grouping for OpenClaw)
      const wmk = `${agentPath}::${model}`;
      if (!wmMap.has(wmk)) {
        wmMap.set(wmk, {
          workspace:      agentPath,
          workspaceLabel: agentPath,
          sessionId,
          model,
          provider,
          ...zero(),
          cost: 0
        });
      }
      const wm = wmMap.get(wmk);
      addInto(wm, tokens);
      wm.cost += effectiveCost;
    }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const events = await scanAgentsRoot(root);
    accumulate(events);
  }

  await flushCache(CLIENT_KEY);
  await flushCache('openclaw-codex');
  return { ...buildOutput(dailyMap, wmMap), eventsJson: { events: timeEvents } };
}

// ---------------------------------------------------------------------------
// Convert to common collector JSON
// ---------------------------------------------------------------------------

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
