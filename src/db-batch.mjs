import { mysqlRowKey, nowExpression, todayExpression } from './db.mjs';

// SQLite 默认变量上限为 32766,但保守起见每批 400 行(400 × 16 参数 = 6400)。
const CHUNK_SIZE = 400;

function chunks(rows, size = CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function getTimeWatermark(db, device, source) {
  const row = await db.get(
    'SELECT MAX(event_time) AS watermark FROM time_usage WHERE device = ? AND source = ?',
    [device, source]
  );
  return row?.watermark || null;
}

const TIME_COLUMNS = `
  device, source, event_key, event_time, usage_date, model, project_path, session_id,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  reasoning_output_tokens, total_tokens, cost_usd, updated_at
`;

function timeValues(row) {
  return [
    row.device, row.source, row.eventKey, row.eventTime, row.usageDate, row.model || '',
    row.projectPath || null, row.sessionId || null, row.inputTokens || 0,
    row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0,
    row.reasoningOutputTokens || 0, row.totalTokens || 0, row.costUSD || 0
  ];
}

export async function batchUpsertTimeUsage(db, rows) {
  const now = nowExpression(db.driver);
  for (const part of chunks(rows)) {
    if (db.driver === 'mysql') {
      const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
      await db.run(`
        INSERT INTO time_usage (row_key, ${TIME_COLUMNS})
        VALUES ${part.map(() => group).join(', ')}
        ON DUPLICATE KEY UPDATE
          event_time = VALUES(event_time), usage_date = VALUES(usage_date), model = VALUES(model),
          project_path = VALUES(project_path), session_id = VALUES(session_id),
          input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
          cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
          reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
          cost_usd = VALUES(cost_usd), updated_at = ${now}
      `, part.flatMap(row => [mysqlRowKey(row.device, row.source, row.eventKey), ...timeValues(row)]));
      continue;
    }
    const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
    await db.run(`
      INSERT INTO time_usage (${TIME_COLUMNS})
      VALUES ${part.map(() => group).join(', ')}
      ON CONFLICT(device, source, event_key) DO UPDATE SET
        event_time = excluded.event_time, usage_date = excluded.usage_date, model = excluded.model,
        project_path = excluded.project_path, session_id = excluded.session_id,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd, updated_at = ${now}
    `, part.flatMap(timeValues));
  }
}

const DAILY_COLUMNS = `
  device, source, usage_date, model, input_tokens, output_tokens,
  cache_creation_tokens, cache_read_tokens, reasoning_output_tokens,
  total_tokens, cost_usd, pricing_locked_at, updated_at
`;

function dailyValues(row) {
  return [
    row.device, row.source, row.usageDate, row.model || '', row.inputTokens || 0,
    row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0,
    row.reasoningOutputTokens || 0, row.totalTokens || 0, row.costUSD || 0, row.usageDate
  ];
}

export async function batchUpsertDaily(db, rows) {
  const now = nowExpression(db.driver);
  const today = todayExpression(db.driver);
  for (const part of chunks(rows)) {
    if (db.driver === 'mysql') {
      const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? < ${today}, ${now}, NULL), ${now})`;
      await db.run(`
        INSERT INTO daily_usage (row_key, ${DAILY_COLUMNS})
        VALUES ${part.map(() => group).join(', ')}
        ON DUPLICATE KEY UPDATE
          input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
          cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
          reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
          cost_usd = IF(daily_usage.usage_date < ${today}, daily_usage.cost_usd, VALUES(cost_usd)),
          pricing_locked_at = IF(
            daily_usage.usage_date < ${today}, COALESCE(daily_usage.pricing_locked_at, ${now}), NULL
          ),
          updated_at = ${now}
      `, part.flatMap(row => [mysqlRowKey(row.device, row.source, row.usageDate, row.model || ''), ...dailyValues(row)]));
      continue;
    }
    const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? < ${today} THEN ${now} ELSE NULL END, ${now})`;
    await db.run(`
      INSERT INTO daily_usage (${DAILY_COLUMNS})
      VALUES ${part.map(() => group).join(', ')}
      ON CONFLICT(device, source, usage_date, model) DO UPDATE SET
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
        cost_usd = CASE WHEN daily_usage.usage_date < ${today} THEN daily_usage.cost_usd ELSE excluded.cost_usd END,
        pricing_locked_at = CASE
          WHEN daily_usage.usage_date < ${today} THEN COALESCE(daily_usage.pricing_locked_at, ${now})
          ELSE NULL
        END,
        updated_at = ${now}
    `, part.flatMap(dailyValues));
  }
}

const SESSION_COLUMNS = `
  device, source, session_id, last_activity, project_path, input_tokens,
  output_tokens, cache_creation_tokens, cache_read_tokens,
  reasoning_output_tokens, total_tokens, cost_usd, updated_at
`;

function sessionValues(row) {
  return [
    row.device, row.source, row.sessionId, row.lastActivity || null, row.projectPath || null,
    row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0,
    row.cacheReadTokens || 0, row.reasoningOutputTokens || 0, row.totalTokens || 0,
    row.costUSD || 0
  ];
}

export async function batchUpsertSession(db, rows) {
  const now = nowExpression(db.driver);
  for (const part of chunks(rows)) {
    if (db.driver === 'mysql') {
      const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
      await db.run(`
        INSERT INTO session_usage (row_key, ${SESSION_COLUMNS})
        VALUES ${part.map(() => group).join(', ')}
        ON DUPLICATE KEY UPDATE
          last_activity = VALUES(last_activity), project_path = VALUES(project_path),
          input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
          cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
          reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
          cost_usd = VALUES(cost_usd), updated_at = ${now}
      `, part.flatMap(row => [mysqlRowKey(row.device, row.source, row.sessionId), ...sessionValues(row)]));
      continue;
    }
    const group = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})`;
    await db.run(`
      INSERT INTO session_usage (${SESSION_COLUMNS})
      VALUES ${part.map(() => group).join(', ')}
      ON CONFLICT(device, source, session_id) DO UPDATE SET
        last_activity = excluded.last_activity, project_path = excluded.project_path,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd, updated_at = ${now}
    `, part.flatMap(sessionValues));
  }
}
