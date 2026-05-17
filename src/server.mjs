import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { URL } from 'node:url';
import { openDb, recordRun, upsertDaily, upsertSession } from './db.mjs';

const port = Number(process.env.PORT || 4173);
const staticDir = existsSync(resolve(process.cwd(), 'dist'))
  ? resolve(process.cwd(), 'dist')
  : resolve(process.cwd(), 'public');
const db = openDb(process.env.DB_PATH);

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
});

function handleApi(req, url, res) {
  if (url.pathname === '/api/summary') {
    sendJson(res, {
      totals: one(`
        SELECT
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(cache_creation_tokens + cache_read_tokens + cached_input_tokens), 0) AS cacheTokens,
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
        cached_input_tokens AS cachedInputTokens,
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
      LIMIT 200
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
        cached_input_tokens AS cachedInputTokens,
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
  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    handleIngest(req, res);
    return;
  }
  sendJson(res, { error: 'Not found' }, 404);
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
    const sessionRows = Array.isArray(payload.sessions) ? payload.sessions : [];
    const runRows = Array.isArray(payload.runs) ? payload.runs : [];

    db.exec('BEGIN');
    try {
      dailyRows.forEach((row) => upsertDaily(db, row));
      sessionRows.forEach((row) => upsertSession(db, row));
      runRows.forEach((row) => recordRun(db, row));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    sendJson(res, { ok: true, daily: dailyRows.length, sessions: sessionRows.length, runs: runRows.length });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

function serveStatic(pathname, res) {
  const filePath = pathname === '/' ? join(staticDir, 'index.html')
    : pathname === '/review' ? join(staticDir, 'index.html')
    : join(staticDir, pathname);
  if (!filePath.startsWith(staticDir) || !existsSync(filePath)) {
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
