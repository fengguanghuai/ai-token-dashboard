/**
 * Pure-JavaScript Claude Code data collector.
 *
 * Reads JSONL session files from the Claude Code projects directory and
 * returns data in the common collector shape consumed by collect.mjs.
 *
 * Supported platforms: macOS, Linux, Windows — no native binaries required.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { configuredBool, configuredPath, configuredPaths, envPathList } from '../collector-config.mjs';
import { calculateCost } from '../pricing.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

export const CLIENT_KEY = 'claude';
export const SOURCE_LABEL = 'Claude Code';
const EVENT_HISTORY_DAYS = Number(process.env.TIME_USAGE_HISTORY_DAYS || 90);
const EVENT_CUTOFF_MS = Date.now() - EVENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Return Claude Code data roots. Claude Code has used both ~/.claude and
 * ~/.config/claude layouts; CLAUDE_CONFIG_DIR may contain comma-separated
 * custom roots. Each root is expected to contain a projects/ directory.
 */
export function getClaudeRoots() {
  const envRoots = envPathList(process.env.CLAUDE_CONFIG_DIR);
  if (envRoots.length) return envRoots;

  return configuredPaths('claude', 'roots');
}

export async function getScanRoots() {
  const envRoots = envPathList(process.env.CLAUDE_CONFIG_DIR);
  const includeDesktopLocalAgent = configuredBool('claude', 'includeDesktopLocalAgent', true);
  const roots = envRoots.length
    ? envRoots
    : [
        ...getClaudeRoots(),
        ...(includeDesktopLocalAgent ? await getClaudeDesktopLocalAgentRoots() : [])
      ];

  return unique(roots).flatMap((root) => [
    { type: 'projects', path: join(root, 'projects') },
    { type: 'transcripts', path: join(root, 'transcripts') }
  ]);
}

async function collectJsonlFiles(dir) {
  const results = [];
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function getClaudeDesktopLocalAgentRoots() {
  if (process.platform !== 'darwin') return [];

  const base = configuredPath(
    'claude',
    'desktopLocalAgentBase',
    `${homedir()}/Library/Application Support/Claude/local-agent-mode-sessions`
  );
  if (!base) return [];
  const sessionDirs = await collectClaudeDirs(base);
  return sessionDirs.filter((dir) => /[/\\]local_[^/\\]+[/\\]\.claude$/.test(dir));
}

async function collectClaudeDirs(dir) {
  const results = [];
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (!entry.isDirectory()) continue;

    if (entry.name === '.claude') {
      results.push(fullPath);
      continue;
    }

    results.push(...await collectClaudeDirs(fullPath));
  }
  return results;
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * Attempt to decode a project directory name into a human-readable path.
 * Claude Code URL-encodes the absolute project path as the directory name,
 * e.g. "%2FUsers%2Fjohn%2Fmy-project".  Fall back to the raw name when
 * decoding fails (older or unknown formats).
 */
function decodeWorkspaceLabel(dirName) {
  try {
    const decoded = decodeURIComponent(dirName);
    // Only use decoded form when it looks like an absolute path
    if (decoded.startsWith('/') || /^[A-Za-z]:\\/.test(decoded)) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return dirName;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Read one session JSONL file and return an array of assistant-turn records.
 * Each record carries { timestamp, model, usage, costUSD }.
 *
 * Claude Code can write multiple assistant usage snapshots for the same
 * streamed response. Collapse message.id+requestId duplicates, fall back to
 * message.id when requestId is absent, and keep the largest token value seen
 * for each field.
 */
async function parseSessionFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const records = [];
  const dedupIndex = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Only assistant turns carry usage information
    if (obj.type !== 'assistant' || !obj.message?.usage) continue;

    const record = {
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
      model: obj.message.model || obj.model || 'unknown',
      usage: obj.message.usage,
      costUSD: typeof obj.costUSD === 'number' ? obj.costUSD : 0,
    };

    const dedupKey = dedupKeyForAssistant(obj);

    if (dedupKey && dedupIndex.has(dedupKey)) {
      const existing = records[dedupIndex.get(dedupKey)];
      mergeUsageMax(existing.usage, record.usage);
      existing.costUSD = Math.max(existing.costUSD || 0, record.costUSD || 0);
      if (!existing.timestamp && record.timestamp) existing.timestamp = record.timestamp;
      if (existing.model === 'unknown' && record.model !== 'unknown') existing.model = record.model;
      continue;
    }

    if (dedupKey) dedupIndex.set(dedupKey, records.length);
    records.push(record);
  }

  return records;
}

function dedupKeyForAssistant(obj) {
  const messageId = obj.message?.id;
  if (!messageId) return null;
  return obj.requestId ? `${messageId}:${obj.requestId}` : `message:${messageId}`;
}

function mergeUsageMax(target, source) {
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'thinking_tokens'
  ]) {
    target[key] = Math.max(Number(target[key] || 0), Number(source[key] || 0));
  }
}

// ---------------------------------------------------------------------------
// Safe directory helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function extractTokens(usage) {
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    // Newer models expose reasoning/thinking tokens
    reasoning: usage.reasoning_tokens || usage.thinking_tokens || 0
  };
}

function addInto(target, tokens) {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  target.reasoning += tokens.reasoning;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * Scan the Claude Code projects directory and return the common daily and
 * workspace/model objects consumed by collect.mjs.
 *
 * @returns {{ graphJson: object, modelsJson: object }}
 */
export async function collect(pricingData = null) {
  // dailyKey ("YYYY-MM-DD::model") -> aggregated token counts
  const dailyMap = new Map();
  // workspaceModelKey ("workspaceDir::model") -> aggregated token counts
  const wmMap = new Map();
  const events = [];

  for (const root of await getScanRoots()) {
    const filePaths = await collectJsonlFiles(root.path);
    for (const filePath of filePaths) {
      const workspaceKey = workspaceKeyFromPath(root, filePath);
      const workspaceLabel = decodeWorkspaceLabel(workspaceKey);
      const records = await parseSessionFile(filePath);

      for (const record of records) {
        const tokens = extractTokens(record.usage);
        aggregateRecord({ ...record, tokens, workspaceKey, workspaceLabel, filePath }, dailyMap, wmMap, pricingData, events);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Convert to common daily JSON
  // -----------------------------------------------------------------------
  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map((row) => ({
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

  const graphJson = { contributions };

  // -----------------------------------------------------------------------
  // Convert to common workspace/model JSON
  // -----------------------------------------------------------------------
  const entries = [...wmMap.values()].map((wm) => ({
    client: CLIENT_KEY,
    workspaceKey: wm.workspace,
    workspaceLabel: wm.workspaceLabel,
    model: wm.model,
    input: wm.input,
    output: wm.output,
    cacheRead: wm.cacheRead,
    cacheWrite: wm.cacheWrite,
    reasoning: wm.reasoning,
    cost: wm.cost
  }));

  const modelsJson = { entries };

  return { graphJson, modelsJson, eventsJson: { events } };
}

function workspaceKeyFromPath(root, filePath) {
  const rel = relative(root.path, filePath);
  const firstSegment = rel.split(/[\\/]/).find(Boolean);
  if (root.type === 'projects' && firstSegment) return firstSegment;
  return `transcripts:${firstSegment || filePath}`;
}

function aggregateRecord(record, dailyMap, wmMap, pricingData, events) {
  const date = localDateFromTimestamp(record.timestamp);
  const model = normalizeModelForGrouping(record.model);
  const tokens = record.tokens || extractTokens(record.usage);
  const calculatedCost = calculateCost(model, tokens, pricingData);
  const costUSD = calculatedCost > 0 ? calculatedCost : record.costUSD;

  if (keepTimeEvent(record.timestamp)) {
    events.push({
      client: CLIENT_KEY,
      eventKey: `${record.filePath || record.workspaceKey}:${record.timestamp || ''}:${model}:${JSON.stringify(tokens)}`,
      eventTime: record.timestamp,
      usageDate: date,
      sessionId: record.filePath,
      workspaceKey: record.workspaceKey,
      workspaceLabel: record.workspaceLabel,
      model,
      tokens,
      cost: costUSD
    });
  }

  // --- daily ---
  const dk = `${date}::${model}`;
  if (!dailyMap.has(dk)) {
    dailyMap.set(dk, { date, model, ...zeroTokens(), cost: 0 });
  }
  const dayAgg = dailyMap.get(dk);
  addInto(dayAgg, tokens);
  dayAgg.cost += costUSD;

  // --- workspace+model ---
  const wmk = `${record.workspaceKey}::${model}`;
  if (!wmMap.has(wmk)) {
    wmMap.set(wmk, {
      workspace: record.workspaceKey,
      workspaceLabel: record.workspaceLabel,
      model,
      ...zeroTokens(),
      cost: 0
    });
  }
  const wmAgg = wmMap.get(wmk);
  addInto(wmAgg, tokens);
  wmAgg.cost += costUSD;
}

function keepTimeEvent(timestamp) {
  const ms = Date.parse(timestamp || '');
  return Number.isFinite(ms) && ms >= EVENT_CUTOFF_MS;
}
