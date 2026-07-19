import './load-env.mjs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { deleteTimeUsageForSource, openDb, recordRun } from './db.mjs';
import { batchUpsertDaily, batchUpsertSession, batchUpsertTimeUsage, getTimeWatermark } from './db-batch.mjs';
import { dedupeEventKeys, filterDailyRows, filterTimeRows, watermarkCutoff } from './incremental.mjs';
import { loadPricing } from './pricing.mjs';
import { tokenTotal } from './collectors/utils.mjs';

const COLLECTORS = [
  { module: './collectors/claude-code.mjs', label: 'Claude Code' },
  { module: './collectors/hermes.mjs', label: 'Hermes Agent' },
  { module: './collectors/codex.mjs', label: 'Codex CLI' },
  { module: './collectors/opencode.mjs', label: 'OpenCode' },
  { module: './collectors/gemini.mjs', label: 'Gemini CLI' },
  { module: './collectors/openclaw.mjs', label: 'OpenClaw' }
];

const args = parseArgs(process.argv.slice(2));
const device = args.device || hostname();
const db = await openDb(args.db);
const exportPayload = {
  device,
  mode: args.full ? 'full' : 'incremental',
  collectedAt: new Date().toISOString(),
  daily: [],
  time: [],
  sessions: [],
  runs: []
};

// Load LiteLLM pricing once — cached to disk, shared across all collectors
const pricingCachePath = resolve(process.cwd(), 'data', 'pricing-litellm.json');
const pricingData = await loadPricing(pricingCachePath);

await collectLocal();

if (args.push) {
  await pushPayload(args.push, exportPayload, args.token);
}

await db.close();

async function collectLocal() {
  let anyError = false;

  for (const { module, label } of COLLECTORS) {
    let graphJson;
    let modelsJson;
    let eventsJson;

    try {
      const { collect } = await import(module);
      ({ graphJson, modelsJson, eventsJson } = await collect(pricingData));
    } catch (error) {
      const run = {
        device,
        source: label,
        status: 'error',
        message: error.message,
        collectedAt: exportPayload.collectedAt,
        command: `js-collector:${module}`
      };
      await recordRun(db, run);
      exportPayload.runs.push(run);
      console.warn(`[${label}] ${error.message}`);
      anyError = true;
      continue;
    }

    const dailyRows = normalizeDailyRows(graphJson, device);
    const sessionRows = normalizeSessionRows(modelsJson, device);
    // 先在全量批次上生成稳定 key,再做水位线过滤,保证 #n 序号跨次运行一致
    const timeRows = dedupeEventKeys(normalizeTimeRows(eventsJson, device));

    const watermark = args.full ? null : await getTimeWatermark(db, device, label);
    const cutoff = watermarkCutoff(watermark);
    const dailyToWrite = filterDailyRows(dailyRows, cutoff);
    const timeToWrite = filterTimeRows(timeRows, cutoff);
    const fullRebuild = args.full || !watermark;

    await runInTransaction(db, async (tx) => {
      await batchUpsertDaily(tx, dailyToWrite);
      await batchUpsertSession(tx, sessionRows);
      // 全量重建才允许删表;增量路径老事件永不触碰(价格锁定语义)
      if (fullRebuild) await deleteTimeUsageForSource(tx, device, label);
      await batchUpsertTimeUsage(tx, timeToWrite);
    });
    exportPayload.daily.push(...dailyToWrite);
    exportPayload.sessions.push(...sessionRows);
    exportPayload.time.push(...timeToWrite);

    const message = `daily=${dailyToWrite.length}/${dailyRows.length}, time=${timeToWrite.length}/${timeRows.length}, workspace_model=${sessionRows.length}${fullRebuild ? ', full' : ''}`;
    const run = {
      device,
      source: label,
      status: dailyRows.length || sessionRows.length ? 'ok' : 'empty',
      message,
      collectedAt: exportPayload.collectedAt,
      command: `js-collector:${module}`
    };
    await recordRun(db, run);
    exportPayload.runs.push(run);
    console.log(`[${label}] ${message}`);
  }

  if (anyError) process.exitCode = 1;
}

function normalizeTimeRows(json, deviceName) {
  const events = Array.isArray(json?.events) ? json.events : [];
  return events.map((entry) => {
    const tokens = normalizeTokens(entry.tokens);
    const totalTokens = tokenTotal(tokens, entry.client);
    const eventTime = normalizeEventTime(entry.eventTime || entry.timestamp);
    const usageDate = entry.usageDate || entry.date || eventTime.slice(0, 10);
    const source = sourceLabel(entry.client);
    const model = entry.modelId || entry.model || entry.model_id || 'unknown';
    return {
      device: deviceName,
      source,
      eventKey: entry.eventKey || [
        entry.client || 'unknown',
        eventTime,
        entry.sessionId || entry.workspaceKey || '',
        model,
        totalTokens
      ].join(':'),
      eventTime,
      usageDate,
      model,
      projectPath: entry.workspaceLabel || entry.projectPath || entry.workspaceKey || null,
      sessionId: entry.sessionId || null,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationTokens: tokens.cacheWrite,
      cacheReadTokens: tokens.cacheRead,
      reasoningOutputTokens: tokens.reasoning,
      totalTokens,
      costUSD: entry.cost || 0
    };
  }).filter(row => row.eventTime && row.usageDate && row.totalTokens > 0);
}

function normalizeEventTime(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const text = String(value).trim();
  if (!text) return '';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function runInTransaction(database, work) {
  return database.transaction(work);
}

function normalizeDailyRows(json, deviceName) {
  const days = Array.isArray(json.contributions) ? json.contributions : [];
  return days.flatMap((day) => {
    const clients = Array.isArray(day.clients) ? day.clients : [];
    return clients.map((entry) => {
      const tokens = normalizeTokens(entry.tokens);
      return {
        device: deviceName,
        source: sourceLabel(entry.client),
        usageDate: day.date,
        model: entry.modelId || entry.model_id || 'unknown',
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheCreationTokens: tokens.cacheWrite,
        cacheReadTokens: tokens.cacheRead,
        reasoningOutputTokens: tokens.reasoning,
        totalTokens: tokenTotal(tokens, entry.client),
        costUSD: entry.cost || 0
      };
    });
  });
}

function normalizeSessionRows(json, deviceName) {
  const entries = Array.isArray(json.entries) ? json.entries : [];
  return entries.map((entry) => {
    const tokens = {
      input: positiveNumber(entry.input),
      output: positiveNumber(entry.output),
      cacheRead: positiveNumber(entry.cacheRead),
      cacheWrite: positiveNumber(entry.cacheWrite),
      reasoning: positiveNumber(entry.reasoning)
    };
    const source = sourceLabel(entry.client);
    const workspace = entry.workspaceLabel || entry.workspaceKey || '';
    const model = entry.model || 'unknown';
    return {
      device: deviceName,
      source,
      sessionId: ['local', entry.client || 'unknown', workspace || 'no-workspace', model].join(':'),
      lastActivity: exportPayload.collectedAt,
      projectPath: workspace || null,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationTokens: tokens.cacheWrite,
      cacheReadTokens: tokens.cacheRead,
      reasoningOutputTokens: tokens.reasoning,
      totalTokens: tokenTotal(tokens, entry.client),
      costUSD: entry.cost || 0
    };
  });
}

function normalizeTokens(tokens = {}) {
  return {
    input: positiveNumber(tokens.input),
    output: positiveNumber(tokens.output),
    cacheRead: positiveNumber(tokens.cacheRead ?? tokens.cache_read),
    cacheWrite: positiveNumber(tokens.cacheWrite ?? tokens.cache_write),
    reasoning: positiveNumber(tokens.reasoning)
  };
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sourceLabel(client) {
  const labels = {
    claude: 'Claude Code',
    codex: 'Codex CLI',
    opencode: 'OpenCode',
    gemini: 'Gemini CLI',
    openclaw: 'OpenClaw',
    hermes: 'Hermes Agent'
  };
  return labels[client] || client || 'unknown';
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--device') {
      parsed.device = argv[++i];
    } else if (arg === '--db') {
      parsed.db = argv[++i];
    } else if (arg === '--push') {
      parsed.push = argv[++i];
    } else if (arg === '--token') {
      parsed.token = argv[++i];
    } else if (arg === '--full') {
      parsed.full = true;
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Remote push helper
// ---------------------------------------------------------------------------

async function pushPayload(url, payload, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`上报失败：HTTP ${response.status} ${await response.text()}`);
  }
  console.log(`[push] ${url}`);
}
