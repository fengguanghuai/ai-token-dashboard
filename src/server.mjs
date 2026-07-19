import './load-env.mjs';
import { createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { URL } from 'node:url';
import {
  apiRowIdExpression, deleteTimeUsageForSource, hourExpression, openDb,
  pruneCollectionRuns, recordRun, upsertDaily, upsertSession, upsertTimeUsage
} from './db.mjs';
import { loadCollectorConfig } from './collector-config.mjs';
import { calculateCacheSavings, loadPricing } from './pricing.mjs';
import { queryQuota } from './quota.mjs';

// Live subscription-window quota is the one feature that makes outbound calls
// (to the vendors' usage endpoints, using the OAuth token the CLIs stored
// locally). Opt-out with SUBSCRIPTION_QUOTA_ENABLED=false; cached briefly so a
// dashboard refresh doesn't hammer the upstream.
const quotaEnabled = String(process.env.SUBSCRIPTION_QUOTA_ENABLED ?? 'true').toLowerCase() !== 'false';
const QUOTA_TTL_MS = 60_000;       // cache a good result this long
const QUOTA_ERROR_TTL_MS = 10_000; // but recover quickly after a transient error
let quotaCache = { until: 0, data: null };

const port = Number(process.env.PORT || 4173);
const staticDir = existsSync(resolve(process.cwd(), 'dist'))
  ? resolve(process.cwd(), 'dist')
  : resolve(process.cwd(), 'public');
const db = await openDb();
const as = (name) => db.driver === 'mysql' ? `\`${name}\`` : `"${name}"`;
// Pricing data for serve-time cache-savings estimation. Same bundled cache
// file the collector uses; savings silently degrade to 0 if it is missing.
const pricingData = await loadPricing(resolve(process.cwd(), 'data', 'pricing-litellm.json'));
let activeCollection = null;
let collectionState = {
  status: 'idle',
  message: '尚未启动采集',
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  stdout: '',
  stderr: ''
};

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, { error: 'Internal server error' }, 500);
    else res.end();
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, url, res);
    return;
  }
  serveStatic(url.pathname, res);
}

server.listen(port, () => {
  console.log(`AI Token Dashboard: http://localhost:${port}`);
  startScheduledCollect();
});

async function handleApi(req, url, res) {
  if (url.pathname === '/api/data') {
    const rawSessions = await all(`
      SELECT device, source,
        session_id AS ${as('sessionId')},
        last_activity AS ${as('lastActivity')},
        project_path AS ${as('projectPath')},
        input_tokens AS ${as('inputTokens')},
        output_tokens AS ${as('outputTokens')},
        cache_creation_tokens AS ${as('cacheCreationTokens')},
        cache_read_tokens AS ${as('cacheReadTokens')},
        reasoning_output_tokens AS ${as('reasoningOutputTokens')},
        total_tokens AS ${as('totalTokens')},
        cost_usd AS ${as('costUSD')}
      FROM session_usage
      ORDER BY total_tokens DESC
    `);
    const rawRuns = await all(`
      SELECT id, device, source, status, message,
        collected_at AS ${as('collectedAt')}
      FROM collection_runs
      ORDER BY id DESC
      LIMIT 500
    `);
    // Normalize sessions
    const sessions = rawSessions.map(s => ({
      ...s,
      lastActivity: s.lastActivity ? s.lastActivity.slice(0, 10) : null,
      projectPath: (s.projectPath && s.projectPath !== 'Unknown Project')
        ? s.projectPath
        : (s.sessionId ? s.sessionId.split('/').slice(-1)[0] || s.sessionId : null)
    }));

    // Build (device, source) -> projectPath map for enriching daily rows
    // Use the project with the most tokens for each (device, source) pair
    const projMap = new Map();
    for (const s of rawSessions) {
      const proj = (s.projectPath && s.projectPath !== 'Unknown Project')
        ? s.projectPath
        : (s.sessionId ? s.sessionId.split('/').slice(-1)[0] || s.sessionId : null);
      if (!proj) continue;
      const key = `${s.device}::${s.source}`;
      const cur = projMap.get(key);
      if (!cur || s.totalTokens > cur.tokens) {
        projMap.set(key, { project: proj, tokens: s.totalTokens });
      }
    }

    const dailyId = apiRowIdExpression(db.driver, ['device', 'source', 'usage_date', 'model']);
    const rawDaily = await all(`
      SELECT ${dailyId} AS id, device, source,
        usage_date AS ${as('usageDate')}, model,
        input_tokens AS ${as('inputTokens')},
        output_tokens AS ${as('outputTokens')},
        cache_creation_tokens AS ${as('cacheCreationTokens')},
        cache_read_tokens AS ${as('cacheReadTokens')},
        reasoning_output_tokens AS ${as('reasoningOutputTokens')},
        total_tokens AS ${as('totalTokens')},
        cost_usd AS ${as('costUSD')}
      FROM daily_usage
      ORDER BY usage_date DESC
    `);

    sendJson(res, {
      // Enrich daily rows with projectPath from session data
      daily: rawDaily.map(d => ({
        ...d,
        projectPath: projMap.get(`${d.device}::${d.source}`)?.project || null,
        cacheSavedUSD: calculateCacheSavings(d.model, {
          input: d.inputTokens,
          output: d.outputTokens,
          cacheRead: d.cacheReadTokens,
          cacheWrite: d.cacheCreationTokens,
          reasoning: d.reasoningOutputTokens
        }, pricingData)
      })),
      sessions,
      // Normalize runs: strip newlines from messages, shorten device names
      runs: rawRuns.map(r => ({
        ...r,
        message: r.message ? r.message.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : '',
        device: r.device ? r.device.replace(/\.local$/, '').replace(/^(.{30}).+$/, '$1…') : r.device
      }))
    });
    return;
  }
  if (url.pathname === '/api/time') {
    // Per-event rows are only needed for the precise (datetime) view, so the
    // client loads them lazily instead of shipping the whole table on first paint.
    const timeId = apiRowIdExpression(db.driver, ['device', 'source', 'event_key']);
    sendJson(res, {
      time: await all(`
        SELECT ${timeId} AS id, device, source,
          event_time AS ${as('eventTime')},
          usage_date AS ${as('usageDate')},
          model,
          project_path AS ${as('projectPath')},
          session_id AS ${as('sessionId')},
          input_tokens AS ${as('inputTokens')},
          output_tokens AS ${as('outputTokens')},
          cache_creation_tokens AS ${as('cacheCreationTokens')},
          cache_read_tokens AS ${as('cacheReadTokens')},
          reasoning_output_tokens AS ${as('reasoningOutputTokens')},
          total_tokens AS ${as('totalTokens')},
          cost_usd AS ${as('costUSD')}
        FROM time_usage
        ORDER BY event_time DESC
      `)
    });
    return;
  }
  if (url.pathname === '/api/hourly') {
    // Pre-aggregate events for the dashboard heatmap. Keeping the filter
    // dimensions in the result lets the client apply the same source/device/
    // model filters without downloading the much larger per-event dataset.
    const localHour = hourExpression(db.driver);
    sendJson(res, {
      hourly: await all(`
        SELECT device, source,
          usage_date AS ${as('usageDate')},
          ${localHour} AS hour,
          model,
          COUNT(*) AS ${as('eventCount')},
          SUM(total_tokens) AS ${as('totalTokens')},
          SUM(cost_usd) AS ${as('costUSD')}
        FROM time_usage
        GROUP BY device, source, usage_date, hour, model
        ORDER BY usage_date DESC, hour DESC
      `)
    });
    return;
  }
  if (url.pathname === '/api/quota') {
    await handleQuota(res);
    return;
  }
  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    await handleIngest(req, res);
    return;
  }
  if (url.pathname === '/api/collect' && req.method === 'POST') {
    handleCollect(req, res);
    return;
  }
  if (url.pathname === '/api/collect/status') {
    sendJson(res, collectionState);
    return;
  }
  sendJson(res, { error: 'Not found' }, 404);
}

function handleCollect(req, res) {
  // The socket must be loopback AND the request must not have transited a proxy.
  // Behind a reverse proxy every request's socket is loopback, so the proxy
  // headers are what actually reveal a remote origin — reject if any are present.
  const proxied = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']
    .some(header => req.headers[header]);
  if (!isLoopback(req.socket.remoteAddress) || proxied) {
    sendJson(res, { error: '采集接口仅允许本机访问' }, 403);
    return;
  }

  startCollection({ reason: 'manual' });
  sendJson(res, collectionState, 202);
}

function startCollection({ reason = 'manual' } = {}) {
  if (activeCollection) {
    return false;
  }

  const args = ['src/collect.mjs'];
  const device = collectionDevice();
  if (device) args.push('--device', device);
  if (process.env.DB_PATH && !process.env.DATABASE_URL) args.push('--db', process.env.DB_PATH);

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true
  });

  activeCollection = child;
  let stdout = '';
  let stderr = '';
  const startedAt = new Date().toISOString();
  collectionState = {
    status: 'running',
    message: reason === 'scheduled' ? '正在定时采集本机用量' : '正在采集本机用量',
    startedAt,
    finishedAt: null,
    exitCode: null,
    stdout: '',
    stderr: ''
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  child.on('error', error => {
    activeCollection = null;
    collectionState = {
      ...collectionState,
      status: 'error',
      message: error.message,
      finishedAt: new Date().toISOString(),
      stderr: error.message
    };
  });

  child.on('close', code => {
    activeCollection = null;
    collectionState = {
      status: code === 0 ? 'ok' : 'error',
      message: code === 0 ? '采集完成' : '采集失败',
      exitCode: code,
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr)
    };
  });

  return true;
}

function startScheduledCollect() {
  const schedule = scheduledCollectConfig();
  if (!schedule.enabled) return;

  console.log(`[collect:schedule] enabled interval=${schedule.intervalSeconds}s runOnStart=${schedule.runOnStart}`);

  const run = () => {
    const started = startCollection({ reason: 'scheduled' });
    if (!started) console.log('[collect:schedule] skipped because a collection is already running');
  };

  if (schedule.runOnStart) {
    setTimeout(run, 1000);
  }

  setInterval(run, schedule.intervalSeconds * 1000);
}

function scheduledCollectConfig() {
  const config = loadCollectorConfig().scheduledCollect || {};
  const enabled = envBool('SCHEDULED_COLLECT_ENABLED', config.enabled ?? false);
  const intervalSeconds = Math.max(
    10,
    envNumber('SCHEDULED_COLLECT_INTERVAL_SECONDS',
      envNumber('COLLECT_INTERVAL_SECONDS', config.intervalSeconds ?? 300))
  );
  const runOnStart = envBool('SCHEDULED_COLLECT_RUN_ON_START', config.runOnStart ?? false);
  return { enabled, intervalSeconds, runOnStart };
}

function collectionDevice() {
  const config = loadCollectorConfig().scheduledCollect || {};
  return process.env.COLLECT_DEVICE || process.env.SCHEDULED_COLLECT_DEVICE || config.device || null;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return Boolean(fallback);
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : Number(fallback);
}

async function handleQuota(res) {
  if (!quotaEnabled) {
    sendJson(res, { disabled: true });
    return;
  }
  const now = Date.now();
  if (quotaCache.data && now < quotaCache.until) {
    sendJson(res, quotaCache.data);
    return;
  }
  try {
    const data = await queryQuota();
    const failed = ['claude', 'codex'].some(k => {
      const q = data[k];
      return q && !q.ok && q.status !== 'no_credentials';
    });
    quotaCache = { until: now + (failed ? QUOTA_ERROR_TTL_MS : QUOTA_TTL_MS), data };
    sendJson(res, data);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
}

async function handleIngest(req, res) {
  const expectedToken = process.env.INGEST_TOKEN;
  if (expectedToken) {
    const actualToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (actualToken !== expectedToken) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }
  }

  try {
    const payload = await readJson(req);
    const dailyRows = Array.isArray(payload.daily) ? payload.daily : [];
    const timeRows = Array.isArray(payload.time) ? payload.time : [];
    const sessionRows = Array.isArray(payload.sessions) ? payload.sessions : [];
    const runRows = Array.isArray(payload.runs) ? payload.runs : [];

    // A push carries the device's full current time-usage window per source, so
    // replace each (device, source) wholesale — mirroring local collect — instead
    // of only upserting, which would leave events that have since disappeared.
    const timePairs = new Map();
    for (const row of timeRows) {
      if (row.device && row.source) timePairs.set(`${row.device}::${row.source}`, row);
    }

    await db.transaction(async (tx) => {
      for (const row of dailyRows) await upsertDaily(tx, row);
      for (const row of timePairs.values()) await deleteTimeUsageForSource(tx, row.device, row.source);
      for (const row of timeRows) await upsertTimeUsage(tx, row);
      for (const row of sessionRows) await upsertSession(tx, row);
      for (const row of runRows) await recordRun(tx, row);
    });

    // The hub stays up across many ingests; keep collection_runs bounded.
    if (runRows.length) await pruneCollectionRuns(db);

    sendJson(res, { ok: true, daily: dailyRows.length, time: timeRows.length, sessions: sessionRows.length, runs: runRows.length });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

function serveStatic(pathname, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const filePath = decoded === '/' || decoded === '/review'
    ? join(staticDir, 'index.html')
    : join(staticDir, decoded);
  // Require the resolved path to live under staticDir. The trailing separator
  // stops sibling dirs like `dist-foo` from matching the `dist` prefix.
  const inRoot = filePath === staticDir || filePath.startsWith(staticDir + sep);
  if (decoded.includes('\0') || !inRoot || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

function all(sql, params) {
  return db.all(sql, params);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function trimOutput(value) {
  const text = String(value || '').trim();
  return text.length > 12000 ? `${text.slice(-12000)}` : text;
}

function isLoopback(address = '') {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === 'localhost';
}

function readJson(req) {
  return new Promise((resolveRequest, rejectRequest) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        rejectRequest(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolveRequest(JSON.parse(body || '{}'));
      } catch (error) {
        rejectRequest(error);
      }
    });
    req.on('error', rejectRequest);
  });
}

function contentType(filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.jsx': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };
  return types[extname(filePath)] || 'application/octet-stream';
}
