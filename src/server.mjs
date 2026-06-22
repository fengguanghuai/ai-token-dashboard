import { createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { URL } from 'node:url';
import { deleteTimeUsageForSource, openDb, pruneCollectionRuns, recordRun, upsertDaily, upsertSession, upsertTimeUsage } from './db.mjs';
import { loadCollectorConfig } from './collector-config.mjs';

const port = Number(process.env.PORT || 4173);
const staticDir = existsSync(resolve(process.cwd(), 'dist'))
  ? resolve(process.cwd(), 'dist')
  : resolve(process.cwd(), 'public');
const db = openDb(process.env.DB_PATH);
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, url, res);
    return;
  }
  serveStatic(url.pathname, res);
});

server.listen(port, () => {
  console.log(`AI Token Dashboard: http://localhost:${port}`);
  startScheduledCollect();
});

function handleApi(req, url, res) {
  if (url.pathname === '/api/summary') {
    sendJson(res, {
      totals: one(`
        SELECT
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(cache_creation_tokens + cache_read_tokens), 0) AS cacheTokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningTokens,
          COALESCE(SUM(cost_usd), 0) AS costUSD
        FROM daily_usage
      `),
      bySource: all(`
        SELECT source, device,
          SUM(total_tokens) AS totalTokens,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(cost_usd) AS costUSD
        FROM daily_usage
        GROUP BY source, device
        ORDER BY totalTokens DESC
      `),
      byDay: all(`
        SELECT usage_date AS date, source, SUM(total_tokens) AS totalTokens, SUM(cost_usd) AS costUSD
        FROM daily_usage
        GROUP BY usage_date, source
        ORDER BY usage_date
      `),
      byModel: all(`
        SELECT source, model, SUM(total_tokens) AS totalTokens, SUM(cost_usd) AS costUSD
        FROM daily_usage
        WHERE model != ''
        GROUP BY source, model
        ORDER BY totalTokens DESC
        LIMIT 20
      `),
      topSessions: all(`
        SELECT device, source, session_id AS sessionId, last_activity AS lastActivity,
          project_path AS projectPath, total_tokens AS totalTokens, cost_usd AS costUSD
        FROM session_usage
        ORDER BY total_tokens DESC
        LIMIT 30
      `),
      runs: all(`
        SELECT device, source, status, message, collected_at AS collectedAt
        FROM collection_runs
        ORDER BY id DESC
        LIMIT 20
      `)
    });
    return;
  }
  if (url.pathname === '/api/data') {
    const rawSessions = all(`
      SELECT device, source,
        session_id AS sessionId,
        last_activity AS lastActivity,
        project_path AS projectPath,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_creation_tokens AS cacheCreationTokens,
        cache_read_tokens AS cacheReadTokens,
        reasoning_output_tokens AS reasoningOutputTokens,
        total_tokens AS totalTokens,
        cost_usd AS costUSD
      FROM session_usage
      ORDER BY total_tokens DESC
    `);
    const rawRuns = all(`
      SELECT id, device, source, status, message,
        collected_at AS collectedAt
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

    const rawDaily = all(`
      SELECT rowid AS id, device, source,
        usage_date AS usageDate, model,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_creation_tokens AS cacheCreationTokens,
        cache_read_tokens AS cacheReadTokens,
        reasoning_output_tokens AS reasoningOutputTokens,
        total_tokens AS totalTokens,
        cost_usd AS costUSD
      FROM daily_usage
      ORDER BY usage_date DESC
    `);

    sendJson(res, {
      // Enrich daily rows with projectPath from session data
      daily: rawDaily.map(d => ({
        ...d,
        projectPath: projMap.get(`${d.device}::${d.source}`)?.project || null
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
    sendJson(res, {
      time: all(`
        SELECT rowid AS id, device, source,
          event_time AS eventTime,
          usage_date AS usageDate,
          model,
          project_path AS projectPath,
          session_id AS sessionId,
          input_tokens AS inputTokens,
          output_tokens AS outputTokens,
          cache_creation_tokens AS cacheCreationTokens,
          cache_read_tokens AS cacheReadTokens,
          reasoning_output_tokens AS reasoningOutputTokens,
          total_tokens AS totalTokens,
          cost_usd AS costUSD
        FROM time_usage
        ORDER BY event_time DESC
      `)
    });
    return;
  }
  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    handleIngest(req, res);
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
  if (process.env.DB_PATH) args.push('--db', process.env.DB_PATH);

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

    db.exec('BEGIN');
    try {
      dailyRows.forEach((row) => upsertDaily(db, row));
      for (const row of timePairs.values()) deleteTimeUsageForSource(db, row.device, row.source);
      timeRows.forEach((row) => upsertTimeUsage(db, row));
      sessionRows.forEach((row) => upsertSession(db, row));
      runRows.forEach((row) => recordRun(db, row));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // The hub stays up across many ingests; keep collection_runs bounded.
    if (runRows.length) pruneCollectionRuns(db);

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

function one(sql) {
  return db.prepare(sql).get();
}

function all(sql) {
  return db.prepare(sql).all();
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
    '.jsx': 'application/javascript; charset=utf-8'
  };
  return types[extname(filePath)] || 'application/octet-stream';
}
