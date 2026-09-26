/**
 * OpenCode data collector (pure JS).
 *
 * Reads the local OpenCode usage stores:
 *   ~/.local/share/opencode/opencode*.db          — OpenCode 1.2+ SQLite
 *   ~/.local/share/opencode/storage/message/.../*.json — legacy JSON messages
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configuredPath, configuredPaths, expandPath } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { canonicalProvider, inferProviderFromModel, localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';

export const CLIENT_KEY = 'opencode';
export const SOURCE_LABEL = 'OpenCode';
const CACHE_VERSION = 2;   // bump when parsed message shape changes
const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || Infinity);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

export function opencodeDataDir() {
  return configuredPath(
    'opencode',
    'dataDir',
    `${homedir()}/.local/share/opencode`
  );
}

export function legacyMessageDir() {
  const dataDir = opencodeDataDir();
  if (!dataDir) return null;
  return join(dataDir, 'storage', 'message');
}

export function isOpenCodeDbFilename(name) {
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

  const modelId = msg.modelID || msg.model?.id || msg.model?.modelID;
  const model = typeof modelId === 'string' && modelId.trim()
    ? normalizeModelForGrouping(modelId)
    : null;
  if (!model) return null;

  const provider = canonicalProvider(msg.providerID || msg.model?.providerID) || inferProviderFromModel(model) || 'unknown';
  const workspace = msg.path?.root || fallbackWorkspace || null;
  const timestamp = Number(msg.time?.created || 0);

  return {
    client: CLIENT_KEY,
    sessionId: msg.sessionID || fallbackSessionId || 'unknown',
    dedupKey: msg.id || fallbackId || null,
    fingerprint: fingerprintFor(msg, tokens, model, provider),
    eventTime: timestamp,
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
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  const rows = [];
  const workspaces = new Map();
  try {
    for (const table of ['session', 'session_v2']) {
      try {
        for (const row of db.prepare(`SELECT id, directory FROM ${table}`).all()) {
          if (row.directory) workspaces.set(row.id, row.directory);
        }
      } catch { /* older stores may not have project metadata */ }
    }
    for (const table of ['session_message', 'message']) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      if (!['id', 'session_id', 'data'].every(name => columns.has(name))) continue;
      const type = columns.has('type') ? 'type' : 'NULL AS type';
      const time = columns.has('time_created') ? 'time_created' : 'NULL AS time_created';
      rows.push(...db.prepare(`SELECT id, session_id, data, ${type}, ${time} FROM ${table} ORDER BY id`).all());
    }
  } finally { db.close(); }
  const messages = [];

  for (const row of rows) {
    let msg;
    try {
      msg = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      continue;
    }

    // New rows put the role outside the JSON payload and use a nested model.
    if (!msg || typeof msg !== 'object') continue;
    if (row.type != null && row.type !== 'assistant') continue;
    msg = { ...msg, role: msg.role || row.type,
      time: { ...msg.time, created: msg.time?.created ?? row.time_created } };
    const parsed = parseMessageObject(msg, row.id, row.session_id, workspaces.get(row.session_id));
    if (!parsed) continue;
    messages.push(parsed);
  }

  return messages;
}

async function parseLegacyJsonFile(filePath) {
  const msg = await safeReadJson(filePath);
  const fallbackId = `file:${await realpath(filePath).catch(() => filePath)}`;
  return parseMessageObject(msg, fallbackId, msg?.sessionID, msg?.path?.root);
}

export async function collect(pricingData = null) {
  const dailyMap = new Map();
  const wmMap = new Map();
  const events = [];
  const seen = new Set();

  const addMessage = (message) => {
    if (!message) return;
    const dedupKey = message.dedupKey || message.fingerprint;
    if (dedupKey && seen.has(dedupKey)) return;
    if (dedupKey) seen.add(dedupKey);

    const calculatedCost = calculateCost(message.model, message.tokens, pricingData, message.provider);
    const cost = message.cost > 0 ? message.cost : calculatedCost;
    if (keepTimeEvent(message.eventTime)) {
      events.push({
        client: CLIENT_KEY,
        eventKey: message.dedupKey || message.fingerprint,
        eventTime: message.eventTime,
        usageDate: message.date,
        sessionId: message.sessionId,
        workspaceKey: message.workspace || message.sessionId || 'unknown',
        workspaceLabel: message.workspaceLabel || message.workspace || message.sessionId || 'unknown',
        model: message.model,
        tokens: message.tokens,
        cost
      });
    }

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
    const messages = await cachedParse(CLIENT_KEY, CACHE_VERSION, dbPath, p => parseDbRows(p), [`${dbPath}-wal`]);
    for (const message of messages) addMessage(message);
  }

  for (const jsonPath of await collectJsonFiles(legacyMessageDir())) {
    addMessage(await cachedParse(CLIENT_KEY, CACHE_VERSION, jsonPath, parseLegacyJsonFile));
  }

  await flushCache(CLIENT_KEY);
  return { ...buildOutput(dailyMap, wmMap), eventsJson: { events } };
}

function keepTimeEvent(timestamp) {
  const n = Number(timestamp || 0);
  const ms = n < 10_000_000_000 ? n * 1000 : n;
  return Number.isFinite(ms) && ms >= EVENT_CUTOFF_MS;
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
