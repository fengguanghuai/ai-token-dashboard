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
import { join } from 'node:path';
import { calculateCost } from '../pricing.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';

export const CLIENT_KEY = 'claude';
export const SOURCE_LABEL = 'Claude Code';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Return the Claude Code projects directory for the current OS.
 *
 * macOS/Linux : ~/.claude/projects/
 * Windows     : %APPDATA%\Claude\projects\
 */
export function getProjectsDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'Claude', 'projects');
  }
  return join(homedir(), '.claude', 'projects');
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
 */
async function parseSessionFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const records = [];
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

    records.push({
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
      model: obj.message.model || obj.model || 'unknown',
      usage: obj.message.usage,
      costUSD: typeof obj.costUSD === 'number' ? obj.costUSD : 0
    });
  }

  return records;
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
  const projectsDir = getProjectsDir();
  const projectEntries = await safeReaddir(projectsDir);

  // dailyKey ("YYYY-MM-DD::model") -> aggregated token counts
  const dailyMap = new Map();
  // workspaceModelKey ("workspaceDir::model") -> aggregated token counts
  const wmMap = new Map();

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;

    const projectPath = join(projectsDir, projectEntry.name);
    const workspaceKey = projectEntry.name;
    const workspaceLabel = decodeWorkspaceLabel(workspaceKey);

    const sessionEntries = await safeReaddir(projectPath);

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.jsonl')) continue;

      const records = await parseSessionFile(join(projectPath, sessionEntry.name));

      for (const record of records) {
        const date = localDateFromTimestamp(record.timestamp);
        const model = normalizeModelForGrouping(record.model);
        const tokens = extractTokens(record.usage);
        const calculatedCost = calculateCost(model, tokens, pricingData);
        const costUSD = calculatedCost > 0 ? calculatedCost : record.costUSD;

        // --- daily ---
        const dk = `${date}::${model}`;
        if (!dailyMap.has(dk)) {
          dailyMap.set(dk, { date, model, ...zeroTokens(), cost: 0 });
        }
        const dayAgg = dailyMap.get(dk);
        addInto(dayAgg, tokens);
        dayAgg.cost += costUSD;

        // --- workspace+model ---
        const wmk = `${workspaceKey}::${model}`;
        if (!wmMap.has(wmk)) {
          wmMap.set(wmk, {
            workspace: workspaceKey,
            workspaceLabel,
            model,
            ...zeroTokens(),
            cost: 0
          });
        }
        const wmAgg = wmMap.get(wmk);
        addInto(wmAgg, tokens);
        wmAgg.cost += costUSD;
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

  return { graphJson, modelsJson };
}
