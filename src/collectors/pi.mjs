/** Pi session collection. Only usage and routing metadata enter the parse cache. */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { configuredPaths, expandPath } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

export const CLIENT_KEY = 'pi';
export const SOURCE_LABEL = 'Pi Agent';
const CACHE_VERSION = 2;

export function sessionRoots() {
  const sessionDir = expandPath(process.env.PI_CODING_AGENT_SESSION_DIR);
  if (sessionDir) return [sessionDir];
  const agentDir = expandPath(process.env.PI_CODING_AGENT_DIR);
  if (agentDir) return [join(agentDir, 'sessions')];
  return configuredPaths('pi', 'roots', [join(homedir(), '.pi', 'agent', 'sessions')]);
}

async function findFiles(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const paths = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await findFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(path);
  }
  return paths;
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tokensFromUsage(usage) {
  const output = count(usage.output);
  const reasoning = Math.min(output, count(usage.reasoning));
  const tokens = {
    input: count(usage.input), output: output - reasoning,
    cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), reasoning
  };
  const missing = count(usage.totalTokens) - Object.values(tokens).reduce((sum, value) => sum + value, 0);
  // Keep an authoritative total without inventing input/output rates for it.
  if (missing > 0) tokens.unclassified = missing;
  return tokens;
}

function recordedCost(usage) {
  const value = usage.cost?.total;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Retains every billed branch, including entries no longer in active context. */
export async function parseSessionFile(filePath) {
  let source;
  try { source = await readFile(filePath, 'utf8'); } catch { return null; }
  let header = null;
  let linearState = {};
  const states = new Map();
  const events = [];
  for (const [lineIndex, line] of source.split('\n').entries()) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    if (row.type === 'session') {
      if (header) continue;
      header = {
        sessionId: text(row.id) || basename(filePath, '.jsonl'),
        workspace: text(row.cwd), parentSession: text(row.parentSession),
        createdAt: timestamp(row.timestamp), version: count(row.version) || 1
      };
      continue;
    }
    if (!header) continue;
    // A tree branch inherits routing from its parent, not the last physical line.
    const inherited = header.version >= 2
      ? (states.get(row.parentId) || {}) : linearState;
    const state = { ...inherited };
    if (row.type === 'model_change') {
      state.model = text(row.modelId);
      state.provider = text(row.provider);
    }
    const message = row.type === 'message' ? row.message : null;
    if (message?.role === 'assistant') {
      state.model = text(message.model) || state.model;
      state.provider = text(message.provider) || state.provider;
    }
    if (text(row.id)) states.set(row.id, state);
    linearState = state;

    const isMessage = message && ['assistant', 'toolResult'].includes(message.role);
    const isSummary = row.type === 'compaction' || row.type === 'branch_summary';
    const usage = isMessage ? message.usage : isSummary ? row.usage : null;
    if (!usage || typeof usage !== 'object' || message?.stopReason === 'pending') continue;
    const time = timestamp(row.timestamp) ?? timestamp(message?.timestamp);
    if (time === null) continue;
    const tokens = tokensFromUsage(usage);
    if (!Object.values(tokens).some(value => value > 0)) continue;
    // Tool usage can describe another model; never infer that model from the
    // caller. A missing tool model remains explicitly unknown.
    const routing = message?.role === 'toolResult' ? {} : state;
    const rawModel = text(message?.responseModel) || text(message?.model)
      || text(row.model) || routing.model || 'unknown';
    const provider = text(message?.provider) || text(row.provider) || routing.provider || null;
    const cost = recordedCost(usage);
    const entryId = text(row.id);
    events.push({
      eventKey: hash([header.sessionId, entryId || `line:${lineIndex}`]),
      // Forks preserve entry IDs, timestamps and usage. Compare all of them;
      // coincidentally equal token totals in unrelated sessions are not copies.
      fingerprint: entryId ? hash([entryId, row.type, time, rawModel, provider, tokens, cost]) : null,
      time, model: normalizeModelForGrouping(rawModel), provider, tokens, recordedCost: cost
    });
  }
  return header ? { ...header, events } : null;
}

function ancestors(filePath, sessions) {
  const result = [];
  const visited = new Set([filePath]);
  let current = sessions.get(filePath);
  while (current?.parentPath) {
    if (visited.has(current.parentPath)) return []; // broken/cyclic lineage: retain usage
    visited.add(current.parentPath);
    current = sessions.get(current.parentPath);
    if (!current) break; // do not read outside configured session roots
    result.push(current);
  }
  return result;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addTokens(target, tokens) {
  for (const key of Object.keys(tokens)) target[key] = (target[key] || 0) + tokens[key];
}

export async function collect(pricingData = null) {
  const discovered = (await Promise.all(sessionRoots().map(findFiles))).flat();
  const canonical = await Promise.all(discovered.map(path => realpath(path).catch(() => path)));
  const sessions = new Map();
  for (const filePath of [...new Set(canonical)].sort()) {
    const parsed = await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, parseSessionFile);
    if (!parsed) continue;
    const parent = parsed.parentSession && resolve(dirname(filePath), parsed.parentSession);
    const parentPath = parent ? await realpath(parent).catch(() => parent) : null;
    sessions.set(filePath, { ...parsed, parentPath });
  }

  const daily = new Map();
  const workspaces = new Map();
  const events = [];
  const seen = new Set();
  const cutoff = Date.now() - Number(process.env.TIME_USAGE_HISTORY_DAYS || Infinity) * 86400000;
  for (const [filePath, session] of sessions) {
    const inherited = new Set(ancestors(filePath, sessions).flatMap(parent =>
      parent.events.filter(event => session.createdAt !== null && event.time <= session.createdAt)
        .map(event => event.fingerprint).filter(Boolean)));
    for (const record of session.events) {
      if (record.fingerprint && inherited.has(record.fingerprint)) continue;
      if (seen.has(record.eventKey)) continue;
      seen.add(record.eventKey);
      const { time, model, provider, tokens, eventKey } = record;
      const date = localDateFromTimestamp(time);
      const workspace = session.workspace || session.sessionId;
      const cost = record.recordedCost ?? calculateCost(model, tokens, pricingData, provider);
      const dailyKey = JSON.stringify([date, model]);
      if (!daily.has(dailyKey)) daily.set(dailyKey, { date, model, tokens: emptyTokens(), cost: 0 });
      const day = daily.get(dailyKey);
      addTokens(day.tokens, tokens);
      day.cost += cost;
      const workspaceKey = JSON.stringify([workspace, model]);
      if (!workspaces.has(workspaceKey)) workspaces.set(workspaceKey,
        { client: CLIENT_KEY, workspaceKey: workspace, workspaceLabel: workspace, model, ...emptyTokens(), cost: 0 });
      const aggregate = workspaces.get(workspaceKey);
      addTokens(aggregate, tokens);
      aggregate.cost += cost;
      if (time >= cutoff) events.push({
        client: CLIENT_KEY, eventKey, eventTime: new Date(time).toISOString(), usageDate: date,
        sessionId: session.sessionId, workspaceKey: workspace, workspaceLabel: workspace,
        model, provider, tokens, cost, costBasis: record.recordedCost != null ? 'recorded' : undefined
      });
    }
  }
  await flushCache(CLIENT_KEY);
  const byDate = new Map();
  for (const row of daily.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push({ client: CLIENT_KEY, modelId: row.model, tokens: row.tokens, cost: row.cost });
  }
  return {
    graphJson: { contributions: [...byDate].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, clients]) => ({ date, clients })) },
    modelsJson: { entries: [...workspaces.values()] },
    eventsJson: { events }
  };
}
