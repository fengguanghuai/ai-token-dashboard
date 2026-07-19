CREATE TABLE IF NOT EXISTS collection_runs (
  id BIGSERIAL PRIMARY KEY,
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  collected_at TEXT NOT NULL,
  command TEXT
);

CREATE TABLE IF NOT EXISTS daily_usage (
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  pricing_locked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device, source, usage_date, model)
);

CREATE TABLE IF NOT EXISTS session_usage (
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_activity TEXT,
  project_path TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
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
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device, source, event_key)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_source ON daily_usage(source);
CREATE INDEX IF NOT EXISTS idx_session_usage_total ON session_usage(total_tokens DESC);
CREATE INDEX IF NOT EXISTS idx_time_usage_time ON time_usage(event_time);
CREATE INDEX IF NOT EXISTS idx_time_usage_date_source ON time_usage(usage_date, source);
