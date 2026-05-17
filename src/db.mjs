import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const defaultDbPath = resolve(process.cwd(), 'data', 'usage.sqlite');

export function openDb(dbPath = defaultDbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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

    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_source ON daily_usage(source);
    CREATE INDEX IF NOT EXISTS idx_session_usage_total ON session_usage(total_tokens DESC);
  `);
}

export function upsertDaily(db, row) {
  db.prepare(`
    INSERT INTO daily_usage (
      device, source, usage_date, model, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, cached_input_tokens,
      reasoning_output_tokens, total_tokens, cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device, source, usage_date, model) DO UPDATE SET
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
    row.usageDate,
    row.model || '',
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
    INSERT INTO collection_runs(device, source, status, message, command)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.device, row.source, row.status, row.message || null, row.command || null);
}
