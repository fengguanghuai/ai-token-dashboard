/**
 * OpenCode data collector (pure JS).
 *
 * Reads the local OpenCode usage stores:
 *   ~/.local/share/opencode/opencode*.db          — OpenCode 1.2+ SQLite
 *   ~/.local/share/opencode/storage/message/.../*.json — legacy JSON messages
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configuredPath, configuredPaths, expandPath } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { canonicalProvider, inferProviderFromModel, localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

export const CLIENT_KEY = 'opencode';
export const SOURCE_LABEL = 'OpenCode';

function opencodeDataDir() {
  return configuredPath(
    'opencode',
    'dataDir',
    `${homedir()}/.local/share/opencode`
  );
}

function legacyMessageDir() {
  const dataDir = opencodeDataDir();
  if (!dataDir) return null;
  return join(dataDir, 'storage', 'message');
}

function isOpenCodeDbFilename(name) {
  if (extname(name) !== '.db') return false;
  const stem = basename(name, '.db');
  if (stem === 'opencode') return true;
  const channel = stem.startsWith('opencode-') ? stem.slice('opencode-'.length) : '';
  return channel.length > 0 && /^[A-Za-z0-9._-]+$/.test(channel);
}

async function discoverDbPaths() {
  const dataDir = opencodeDataDir();
  const paths = [];
  for (const entry of await safeReaddir(dataDir)) {
    if (entry.isFile() && isOpenCodeDbFilename(entry.name)) {
      paths.push(join(dataDir, entry.name));
    }
  }

  const explicit = String(process.env.OPENCODE_DB || '').trim();
  const explicitPath = expandPath(explicit);
  if (explicitPath && existsSync(explicitPath) && isOpenCodeDbFilename(basename(explicitPath))) {
    paths.push(explicitPath);
  }

  for (const extraPath of configuredPaths('opencode', 'extraDbPaths')) {
    if (existsSync(extraPath) && isOpenCodeDbFilename(basename(extraPath))) {
      paths.push(extraPath);
    }
  }

  return [...new Set(paths)].sort();
}

async function collectJsonFiles(dir) {
  const results = [];
  for (const entry of await safeReaddir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReadJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pos(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function posFloat(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
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

function tokensFromMessage(msg) {
  const tokens = msg?.tokens;
  if (!tokens) return null;
  return {
    input: pos(tokens.input),
    output: pos(tokens.output),
    cacheRead: pos(tokens.cache?.read),
    cacheWrite: pos(tokens.cache?.write),
    reasoning: pos(tokens.reasoning)
  };
}

function parseMessageObject(msg, fallbackId, fallbackSessionId, fallbackWorkspace) {
  if (!msg || msg.role !== 'assistant') return null;

  const tokens = tokensFromMessage(msg);
  if (!tokens) return null;

  const model = typeof msg.modelID === 'string' && msg.modelID.trim()
    ? normalizeModelForGrouping(msg.modelID)
    : null;
  if (!model) return null;

  const provider = canonicalProvider(msg.providerID) || inferProviderFromModel(model) || 'unknown';
  const workspace = msg.path?.root || fallbackWorkspace || null;
  const timestamp = Number(msg.time?.created || 0);

  return {
    client: CLIENT_KEY,
    sessionId: msg.sessionID || fallbackSessionId || 'unknown',
    dedupKey: msg.id || fallbackId || null,
    fingerprint: fingerprintFor(msg, tokens, model, provider),
    date: localDateFromTimestamp(timestamp, 'unknown'),
    model,
    provider,
    workspace,
    workspaceLabel: workspaceLabel(workspace),
    tokens,
    cost: posFloat(msg.cost),
    agent: msg.mode || msg.agent || null
  };
}

function fingerprintFor(msg, tokens, model, provider) {
  return JSON.stringify({
    created: msg.time?.created ?? null,
    completed: msg.time?.completed ?? null,
    model,
    provider,
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    cost: posFloat(msg.cost),
    agent: msg.mode || msg.agent || null
  });
}

function parseDbRows(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    return [];
  }

  let rows;
  try {
    rows = db.prepare(`
      SELECT m.id, m.session_id, m.data, NULLIF(s.directory, '') AS workspace_root
      FROM message m
      LEFT JOIN session s ON s.id = m.session_id
      WHERE json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(m.data, '$.tokens') IS NOT NULL
      ORDER BY m.id, m.session_id
    `).all();
  } catch {
    try {
      rows = db.prepare(`
        SELECT m.id, m.session_id, m.data, NULL AS workspace_root
        FROM message m
        WHERE json_extract(m.data, '$.role') = 'assistant'
          AND json_extract(m.data, '$.tokens') IS NOT NULL
        ORDER BY m.id, m.session_id
      `).all();
    } catch {
      try { db.close(); } catch { /* ignore */ }
      return [];
    }
  }

  try { db.close(); } catch { /* ignore */ }

  const messages = [];
  const fingerprintIndices = new Map();

  for (const row of rows) {
    let msg;
    try {
      msg = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      continue;
    }

    const parsed = parseMessageObject(msg, row.id, row.session_id, row.workspace_root);
    if (!parsed) continue;

    const existingIndex = fingerprintIndices.get(parsed.fingerprint);
    if (existingIndex != null) {
      const existing = messages[existingIndex];
      if (!existing.dedupKey && parsed.dedupKey) existing.dedupKey = parsed.dedupKey;
      if (!existing.workspace && parsed.workspace) {
        existing.workspace = parsed.workspace;
        existing.workspaceLabel = parsed.workspaceLabel;
      } else if (existing.workspace && parsed.workspace && existing.workspace !== parsed.workspace) {
        existing.workspace = null;
        existing.workspaceLabel = null;
      }
      continue;
    }

    fingerprintIndices.set(parsed.fingerprint, messages.length);
    messages.push(parsed);
  }

  return messages;
}

async function parseLegacyJsonFile(filePath) {
  const msg = await safeReadJson(filePath);
  const fallbackId = basename(filePath, '.json');
  return parseMessageObject(msg, fallbackId, msg?.sessionID, msg?.path?.root);
}

export async function collect(pricingData = null) {
  const dailyMap = new Map();
  const wmMap = new Map();
  const seen = new Set();

  const addMessage = (message) => {
    if (!message) return;
    const dedupKey = message.dedupKey || message.fingerprint;
    if (dedupKey && seen.has(dedupKey)) return;
    if (dedupKey) seen.add(dedupKey);

    const calculatedCost = calculateCost(message.model, message.tokens, pricingData, message.provider);
    const cost = message.cost > 0 ? message.cost : calculatedCost;

    const dk = `${message.date}::${message.model}`;
    if (!dailyMap.has(dk)) {
      dailyMap.set(dk, { date: message.date, model: message.model, provider: message.provider, ...zero(), cost: 0 });
    }
    const day = dailyMap.get(dk);
    addInto(day, message.tokens);
    day.cost += cost;

    const workspaceKey = message.workspace || message.sessionId || 'unknown';
    const wmk = `${workspaceKey}::${message.model}`;
    if (!wmMap.has(wmk)) {
      wmMap.set(wmk, {
        workspace: workspaceKey,
        workspaceLabel: message.workspaceLabel || workspaceKey,
        model: message.model,
        provider: message.provider,
        ...zero(),
        cost: 0
      });
    }
    const wm = wmMap.get(wmk);
    addInto(wm, message.tokens);
    wm.cost += cost;
  };

  for (const dbPath of await discoverDbPaths()) {
    for (const message of parseDbRows(dbPath)) addMessage(message);
  }

  for (const jsonPath of await collectJsonFiles(legacyMessageDir())) {
    addMessage(await parseLegacyJsonFile(jsonPath));
  }

  return buildOutput(dailyMap, wmMap);
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
    workspaceLabel: wm.workspaceLabel,
    model: wm.model,
    provider: wm.provider,
    input: wm.input,
    output: wm.output,
    cacheRead: wm.cacheRead,
    cacheWrite: wm.cacheWrite,
    reasoning: wm.reasoning,
    cost: wm.cost
  }));

  return { graphJson: { contributions }, modelsJson: { entries } };
}
