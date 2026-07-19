CREATE TABLE IF NOT EXISTS collection_runs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  device VARCHAR(255) NOT NULL,
  source VARCHAR(255) NOT NULL,
  status VARCHAR(64) NOT NULL,
  message TEXT,
  collected_at VARCHAR(40) NOT NULL,
  command TEXT,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_usage (
  row_key CHAR(64) NOT NULL,
  device VARCHAR(255) NOT NULL,
  source VARCHAR(255) NOT NULL,
  usage_date VARCHAR(10) NOT NULL,
  model VARCHAR(255) NOT NULL DEFAULT '',
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE NOT NULL DEFAULT 0,
  pricing_locked_at VARCHAR(40),
  updated_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (row_key),
  INDEX idx_daily_usage_date (usage_date),
  INDEX idx_daily_usage_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_usage (
  row_key CHAR(64) NOT NULL,
  device VARCHAR(255) NOT NULL,
  source VARCHAR(255) NOT NULL,
  session_id TEXT NOT NULL,
  last_activity VARCHAR(40),
  project_path TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE NOT NULL DEFAULT 0,
  updated_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (row_key),
  INDEX idx_session_usage_total (total_tokens DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS time_usage (
  row_key CHAR(64) NOT NULL,
  device VARCHAR(255) NOT NULL,
  source VARCHAR(255) NOT NULL,
  event_key TEXT NOT NULL,
  event_time VARCHAR(40) NOT NULL,
  usage_date VARCHAR(10) NOT NULL,
  model VARCHAR(255) NOT NULL DEFAULT '',
  project_path TEXT,
  session_id TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE NOT NULL DEFAULT 0,
  updated_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (row_key),
  INDEX idx_time_usage_time (event_time),
  INDEX idx_time_usage_date_source (usage_date, source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
