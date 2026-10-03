CREATE TABLE IF NOT EXISTS collection_checkpoints (
  scope_key VARCHAR(64) PRIMARY KEY,
  state_json MEDIUMTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS sync_scopes (
  scope_key VARCHAR(64) PRIMARY KEY, device VARCHAR(255) NOT NULL, source VARCHAR(255) NOT NULL,
  revision BIGINT NOT NULL, reset_revision BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS sync_changes (
  scope_key VARCHAR(64) NOT NULL, row_key VARCHAR(64) NOT NULL,
  revision BIGINT NOT NULL, kind VARCHAR(16) NOT NULL, payload_json MEDIUMTEXT NOT NULL,
  PRIMARY KEY (scope_key, row_key), INDEX idx_sync_changes_revision (scope_key, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS sync_targets (
  target_key VARCHAR(64) PRIMARY KEY, scope_key VARCHAR(64) NOT NULL,
  acknowledged_revision BIGINT, lease_owner VARCHAR(64), lease_until BIGINT NOT NULL DEFAULT 0,
  INDEX idx_sync_targets_scope (scope_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

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
  cost_basis VARCHAR(64) NOT NULL DEFAULT 'legacy_unknown',
  pricing_version VARCHAR(64),
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
  cost_basis VARCHAR(64) NOT NULL DEFAULT 'legacy_unknown',
  pricing_version VARCHAR(64),
  updated_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (row_key),
  INDEX idx_time_usage_time (event_time),
  INDEX idx_time_usage_date_source (usage_date, source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
