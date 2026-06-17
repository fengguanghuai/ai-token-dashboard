import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const defaultDbPath = resolve(process.cwd(), 'data', 'usage.sqlite');

export function openDb(dbPath = defaultDbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      command TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      pricing_locked_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device, source, usage_date, model)
    );

    CREATE TABLE IF NOT EXISTS session_usage (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_activity TEXT,
      project_path TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device, source, session_id)
    );

    CREATE TABLE IF NOT EXISTS time_usage (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      event_key TEXT NOT NULL,
      event_time TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      project_path TEXT,
      session_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device, source, event_key)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_source ON daily_usage(source);
    CREATE INDEX IF NOT EXISTS idx_session_usage_total ON session_usage(total_tokens DESC);
    CREATE INDEX IF NOT EXISTS idx_time_usage_time ON time_usage(event_time);
    CREATE INDEX IF NOT EXISTS idx_time_usage_date_source ON time_usage(usage_date, source);
  `);

  ensureColumn(db, 'daily_usage', 'pricing_locked_at', 'TEXT');
  db.exec(`
    UPDATE daily_usage
    SET pricing_locked_at = datetime('now')
    WHERE pricing_locked_at IS NULL
      AND usage_date < date('now', 'localtime')
  `);
}

export function upsertTimeUsage(db, row) {
  db.prepare(`
    INSERT INTO time_usage (
      device, source, event_key, event_time, usage_date, model, project_path, session_id,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cached_input_tokens, reasoning_output_tokens, total_tokens, cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device, source, event_key) DO UPDATE SET
      event_time = excluded.event_time,
      usage_date = excluded.usage_date,
      model = excluded.model,
      project_path = excluded.project_path,
      session_id = excluded.session_id,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      updated_at = datetime('now')
  `).run(
    row.device,
    row.source,
    row.eventKey,
    row.eventTime,
    row.usageDate,
    row.model || '',
    row.projectPath || null,
    row.sessionId || null,
    row.inputTokens || 0,
    row.outputTokens || 0,
    row.cacheCreationTokens || 0,
    row.cacheReadTokens || 0,
    row.cachedInputTokens || 0,
    row.reasoningOutputTokens || 0,
    row.totalTokens || 0,
    row.costUSD || 0
  );
}

export function deleteTimeUsageForSource(db, device, source) {
  db.prepare(`
    DELETE FROM time_usage
    WHERE device = ? AND source = ?
  `).run(device, source);
}

export function upsertDaily(db, row) {
  db.prepare(`
    INSERT INTO daily_usage (
      device, source, usage_date, model, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, cached_input_tokens,
      reasoning_output_tokens, total_tokens, cost_usd, pricing_locked_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? < date('now', 'localtime') THEN datetime('now') ELSE NULL END,
      datetime('now')
    )
    ON CONFLICT(device, source, usage_date, model) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = CASE
        WHEN daily_usage.usage_date < date('now', 'localtime') THEN daily_usage.cost_usd
        ELSE excluded.cost_usd
      END,
      pricing_locked_at = CASE
        WHEN daily_usage.usage_date < date('now', 'localtime') THEN COALESCE(daily_usage.pricing_locked_at, datetime('now'))
        ELSE NULL
      END,
      updated_at = datetime('now')
  `).run(
    row.device,
    row.source,
    row.usageDate,
    row.model || '',
    row.inputTokens || 0,
    row.outputTokens || 0,
    row.cacheCreationTokens || 0,
    row.cacheReadTokens || 0,
    row.cachedInputTokens || 0,
    row.reasoningOutputTokens || 0,
    row.totalTokens || 0,
    row.costUSD || 0,
    row.usageDate
  );
}

function ensureColumn(db, tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some(column => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

export function upsertSession(db, row) {
  db.prepare(`
    INSERT INTO session_usage (
      device, source, session_id, last_activity, project_path, input_tokens,
      output_tokens, cache_creation_tokens, cache_read_tokens,
      cached_input_tokens, reasoning_output_tokens, total_tokens, cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device, source, session_id) DO UPDATE SET
      last_activity = excluded.last_activity,
      project_path = excluded.project_path,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      updated_at = datetime('now')
  `).run(
    row.device,
    row.source,
    row.sessionId,
    row.lastActivity || null,
    row.projectPath || null,
    row.inputTokens || 0,
    row.outputTokens || 0,
    row.cacheCreationTokens || 0,
    row.cacheReadTokens || 0,
    row.cachedInputTokens || 0,
    row.reasoningOutputTokens || 0,
    row.totalTokens || 0,
    row.costUSD || 0
  );
}

export function recordRun(db, row) {
  db.prepare(`
    INSERT INTO collection_runs(device, source, status, message, collected_at, command)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    row.device,
    row.source,
    row.status,
    row.message || null,
    row.collectedAt || new Date().toISOString(),
    row.command || null
  );
}
