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
import { homedir }                 from 'node:os';
import { join, basename, extname } from 'node:path';
import { calculateCost } from '../pricing.mjs';
import { canonicalProvider, localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

export const CLIENT_KEY  = 'openclaw';
export const SOURCE_LABEL = 'OpenClaw';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** All roots that may contain OpenClaw agent data. */
function getAgentRoots() {
  const home = homedir();
  return [
    join(home, '.openclaw', 'agents'),   // current name
    join(home, '.clawdbot', 'agents'),   // legacy rebrand history
    join(home, '.moltbot',  'agents'),
    join(home, '.moldbot',  'agents'),
  ];
}

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dir) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function safeReadFile(filePath) {
  try { return await readFile(filePath, 'utf8'); } catch { return null; }
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
  if (name === 'sessions.json') return false;          // handled separately
  if (name.endsWith('.json'))   return false;          // other json, not JSONL
  return name.endsWith('.jsonl')
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
  const fallbackDate = localDateFromTimestamp(fallbackTimestamp);

  let currentModel    = null;
  let currentProvider = null;
  const events        = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const type = entry.type;

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
      if (!msg || msg.role !== 'assistant') continue;

      const usage = msg.usage;
      if (!usage) continue;

      // Model resolution: message-embedded → current state
      const model =
        (typeof msg.model    === 'string' && msg.model    ? msg.model    : null) ||
        (typeof currentModel === 'string' && currentModel ? currentModel : null);

      if (!model) continue;   // no model resolved — skip (mirrors Rust)

      const provider =
        (typeof msg.provider    === 'string' && msg.provider    ? msg.provider    : null) ||
        (typeof currentProvider === 'string' && currentProvider ? currentProvider : null) ||
        'unknown';

      currentModel    = model;
      currentProvider = provider;

      // Date from message timestamp (milliseconds since epoch)
      let date = fallbackDate;
      if (msg.timestamp != null) {
        date = localDateFromTimestamp(msg.timestamp, fallbackDate);
      }

      const cost = (usage.cost && usage.cost.total != null)
        ? Math.max(0, Number(usage.cost.total) || 0)
        : 0;

      events.push({
        sessionId,
        agentPath,
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
 * We use a two-level walk: agentId dirs → sessions subdir → files.
 * This mirrors the real layout observed in tests and scanner.rs.
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

    // Prefer <agentId>/sessions/ if it exists, else fall back to <agentId>/
    const sessionsDir = join(agentDir, 'sessions');
    const targetDir   = existsSync(sessionsDir) ? sessionsDir : agentDir;
    const fileEntries = await safeReaddir(targetDir);

    // --- index file first (to avoid double-counting files referenced by index)
    const indexRefs = new Set();
    const indexEntry = fileEntries.find(e => e.isFile() && e.name === 'sessions.json');
    if (indexEntry) {
      const indexPath = join(targetDir, 'sessions.json');
      const indexed   = await parseIndexFile(indexPath);
      for (const { sessionId, filePath } of indexed) {
        indexRefs.add(filePath);
        const ev = await parseSessionFile(filePath, sessionId, agentPath);
        events.push(...ev);
      }
    }

    // --- individual transcript files
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile()) continue;
      if (!isTranscriptFile(fileEntry.name)) continue;

      const filePath = join(targetDir, fileEntry.name);
      if (indexRefs.has(filePath)) continue;   // already handled via index

      const sessionId = sessionIdFromFilename(fileEntry.name);
      const ev = await parseSessionFile(filePath, sessionId, agentPath);
      events.push(...ev);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  const roots  = getAgentRoots();
  const dailyMap = new Map();   // "date::model" → aggregated
  const wmMap    = new Map();   // "agentPath::model" → aggregated

  function accumulate(events) {
    for (const { sessionId, agentPath, date, model, provider, tokens, cost } of events) {
      const calculatedCost = calculateCost(model, tokens, pricingData, provider);
      const effectiveCost = calculatedCost > 0 ? calculatedCost : cost;

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

  return buildOutput(dailyMap, wmMap);
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
