import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const defaultDbPath = resolve(process.cwd(), 'data', 'usage.sqlite');
const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'db');

/**
 * Open the configured database and initialize its schema.
 *
 * Configuration priority: explicit input -> DATABASE_URL -> DB_DRIVER/DB_PATH -> SQLite.
 * A plain string is treated as a SQLite path unless it starts with a database URL scheme.
 */
export async function openDb(input) {
  const config = resolveDbConfig(input);
  let db;

  if (config.driver === 'sqlite') db = openSqlite(config.path);
  else if (config.driver === 'postgres') db = await openPostgres(config.url);
  else if (config.driver === 'mysql') db = await openMysql(config.url);
  else throw new Error(`Unsupported database driver: ${config.driver}`);

  await initSchema(db);
  return db;
}

export function resolveDbConfig(input) {
  const hasExplicitInput = input !== undefined && input !== null;
  const explicit = typeof input === 'string'
    ? (isDatabaseUrl(input) ? { url: input } : { path: input, driver: 'sqlite' })
    : (input || {});
  const url = explicit.url || explicit.databaseUrl
    || (!hasExplicitInput ? process.env.DATABASE_URL : '') || '';
  const requestedDriver = String(
    explicit.driver || (!hasExplicitInput ? process.env.DB_DRIVER : '') || ''
  ).toLowerCase();

  if (url) {
    const protocol = new URL(url).protocol.replace(':', '').toLowerCase();
    if (['postgres', 'postgresql'].includes(protocol)) return { driver: 'postgres', url };
    if (['mysql', 'mysql2'].includes(protocol)) return { driver: 'mysql', url };
    if (protocol === 'sqlite') return { driver: 'sqlite', path: fileURLToPath(url) };
    throw new Error(`Unsupported DATABASE_URL protocol: ${protocol}`);
  }

  if (requestedDriver && requestedDriver !== 'sqlite') {
    throw new Error(`DB_DRIVER=${requestedDriver} requires DATABASE_URL`);
  }

  return {
    driver: 'sqlite',
    path: resolve(explicit.path || (!hasExplicitInput ? process.env.DB_PATH : '') || defaultDbPath)
  };
}

function isDatabaseUrl(value) {
  return /^(?:postgres(?:ql)?|mysql2?|sqlite):/i.test(String(value || ''));
}

function openSqlite(path) {
  mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  client.exec('PRAGMA busy_timeout = 10000');
  client.exec('PRAGMA journal_mode = WAL');
  client.exec('PRAGMA foreign_keys = ON');

  const db = {
    driver: 'sqlite',
    config: { path },
    async exec(sql) { client.exec(sql); },
    async all(sql, params = []) { return client.prepare(sql).all(...params); },
    async get(sql, params = []) { return client.prepare(sql).get(...params); },
    async run(sql, params = []) { return client.prepare(sql).run(...params); },
    async transaction(work) {
      client.exec('BEGIN');
      try {
        const value = await work(db);
        client.exec('COMMIT');
        return value;
      } catch (error) {
        client.exec('ROLLBACK');
        throw error;
      }
    },
    async close() { client.close(); }
  };
  return db;
}

async function openPostgres(url) {
  const pg = await import('pg');
  pg.types.setTypeParser(20, Number);
  pg.types.setTypeParser(1700, Number);
  const connectionString = normalizePostgresUrl(url);
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE) || 10,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10_000,
    idleTimeoutMillis: 30_000
  });
  return postgresAdapter(pool, pool, url);
}

function normalizePostgresUrl(value) {
  const url = new URL(value);
  // pg 8 currently treats sslmode=require like verify-full, while libpq and
  // provider connection strings use "require" to mean encrypted without CA
  // verification. Make copied PostgreSQL/Supabase URLs retain libpq semantics.
  if (url.searchParams.get('sslmode') === 'require'
      && !url.searchParams.has('uselibpqcompat')
      && !url.searchParams.has('sslrootcert')) {
    url.searchParams.set('uselibpqcompat', 'true');
  }
  return url.toString();
}

function postgresAdapter(pool, queryable, url) {
  const db = {
    driver: 'postgres',
    config: { url },
    async exec(sql) { await queryable.query(sql); },
    async all(sql, params = []) {
      const result = await queryable.query(postgresPlaceholders(sql), params);
      return result.rows;
    },
    async get(sql, params = []) {
      const rows = await db.all(sql, params);
      return rows[0];
    },
    async run(sql, params = []) {
      return queryable.query(postgresPlaceholders(sql), params);
    },
    async transaction(work) {
      if (queryable !== pool) return work(db);
      const client = await pool.connect();
      const tx = postgresAdapter(pool, client, url);
      try {
        await client.query('BEGIN');
        const value = await work(tx);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async close() { if (queryable === pool) await pool.end(); }
  };
  return db;
}

async function openMysql(url) {
  const mysql = await import('mysql2/promise');
  const parsed = new URL(url);
  const sslMode = parsed.searchParams.get('ssl') || parsed.searchParams.get('ssl-mode');
  const pool = mysql.createPool({
    host: parsed.hostname,
    port: Number(parsed.port) || 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10_000,
    ssl: sslMode && !['false', 'disabled', '0'].includes(sslMode.toLowerCase())
      ? { rejectUnauthorized: sslMode.toLowerCase() !== 'skip-verify' }
      : undefined
  });
  return mysqlAdapter(pool, pool, url);
}

function mysqlAdapter(pool, queryable, url) {
  const db = {
    driver: 'mysql',
    config: { url },
    async exec(sql) { await queryable.query(sql); },
    async all(sql, params = []) {
      const [rows] = await queryable.query(sql, params);
      return rows;
    },
    async get(sql, params = []) {
      const rows = await db.all(sql, params);
      return rows[0];
    },
    async run(sql, params = []) { return queryable.query(sql, params); },
    async transaction(work) {
      if (queryable !== pool) return work(db);
      const connection = await pool.getConnection();
      const tx = mysqlAdapter(pool, connection, url);
      try {
        await connection.beginTransaction();
        const value = await work(tx);
        await connection.commit();
        return value;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() { if (queryable === pool) await pool.end(); }
  };
  return db;
}

function postgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function initSchema(db) {
  const schema = readFileSync(resolve(schemaDir, `schema.${db.driver}.sql`), 'utf8');
  for (const statement of splitStatements(schema)) await db.exec(statement);

  if (db.driver === 'sqlite') {
    await ensureSqliteColumn(db, 'daily_usage', 'pricing_locked_at', 'TEXT');
    for (const table of ['daily_usage', 'session_usage', 'time_usage']) {
      await dropSqliteColumn(db, table, 'cached_input_tokens');
    }
  }

  const now = nowExpression(db.driver);
  const today = todayExpression(db.driver);
  await db.run(`
    UPDATE daily_usage
    SET pricing_locked_at = ${now}
    WHERE pricing_locked_at IS NULL AND usage_date < ${today}
  `);
  await pruneCollectionRuns(db);
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean);
}

async function ensureSqliteColumn(db, tableName, columnName, columnDefinition) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  if (columns.some(column => column.name === columnName)) return;
  await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

async function dropSqliteColumn(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  if (!columns.some(column => column.name === columnName)) return;
  await db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
}

export function nowExpression(driver) {
  if (driver === 'postgres') {
    return `to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  }
  if (driver === 'mysql') return `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
  return `datetime('now')`;
}

export function todayExpression(driver) {
  if (driver === 'postgres') return 'CURRENT_DATE::text';
  if (driver === 'mysql') return `DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d')`;
  return `date('now', 'localtime')`;
}

/** Keep only the most recent collection run rows. */
export async function pruneCollectionRuns(db, keep = Number(process.env.COLLECTION_RUNS_KEEP) || 500) {
  const limit = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 500;
  if (db.driver === 'mysql') {
    await db.run(`
      DELETE FROM collection_runs
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id FROM collection_runs ORDER BY id DESC LIMIT ?
        ) AS recent_runs
      )
    `, [limit]);
    return;
  }
  await db.run(`
    DELETE FROM collection_runs
    WHERE id NOT IN (
      SELECT id FROM collection_runs ORDER BY id DESC LIMIT ?
    )
  `, [limit]);
}

export async function upsertTimeUsage(db, row) {
  const values = [
    row.device, row.source, row.eventKey, row.eventTime, row.usageDate, row.model || '',
    row.projectPath || null, row.sessionId || null, row.inputTokens || 0,
    row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0,
    row.reasoningOutputTokens || 0, row.totalTokens || 0, row.costUSD || 0
  ];
  const now = nowExpression(db.driver);
  const columns = `
    device, source, event_key, event_time, usage_date, model, project_path, session_id,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    reasoning_output_tokens, total_tokens, cost_usd, updated_at
  `;

  if (db.driver === 'mysql') {
    await db.run(`
      INSERT INTO time_usage (row_key, ${columns})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})
      ON DUPLICATE KEY UPDATE
        event_time = VALUES(event_time), usage_date = VALUES(usage_date), model = VALUES(model),
        project_path = VALUES(project_path), session_id = VALUES(session_id),
        input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
        cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
        reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
        cost_usd = VALUES(cost_usd), updated_at = ${now}
    `, [mysqlRowKey(row.device, row.source, row.eventKey), ...values]);
    return;
  }

  await db.run(`
    INSERT INTO time_usage (${columns})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})
    ON CONFLICT(device, source, event_key) DO UPDATE SET
      event_time = excluded.event_time, usage_date = excluded.usage_date, model = excluded.model,
      project_path = excluded.project_path, session_id = excluded.session_id,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd, updated_at = ${now}
  `, values);
}

export async function deleteTimeUsageForSource(db, device, source) {
  await db.run('DELETE FROM time_usage WHERE device = ? AND source = ?', [device, source]);
}

export async function upsertDaily(db, row) {
  const values = [
    row.device, row.source, row.usageDate, row.model || '', row.inputTokens || 0,
    row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0,
    row.reasoningOutputTokens || 0, row.totalTokens || 0, row.costUSD || 0, row.usageDate
  ];
  const now = nowExpression(db.driver);
  const today = todayExpression(db.driver);

  if (db.driver === 'mysql') {
    await db.run(`
      INSERT INTO daily_usage (
        row_key, device, source, usage_date, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, reasoning_output_tokens,
        total_tokens, cost_usd, pricing_locked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? < ${today}, ${now}, NULL), ${now})
      ON DUPLICATE KEY UPDATE
        input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
        cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
        reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
        cost_usd = IF(daily_usage.usage_date < ${today}, daily_usage.cost_usd, VALUES(cost_usd)),
        pricing_locked_at = IF(
          daily_usage.usage_date < ${today}, COALESCE(daily_usage.pricing_locked_at, ${now}), NULL
        ),
        updated_at = ${now}
    `, [mysqlRowKey(row.device, row.source, row.usageDate, row.model || ''), ...values]);
    return;
  }

  await db.run(`
    INSERT INTO daily_usage (
      device, source, usage_date, model, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, reasoning_output_tokens,
      total_tokens, cost_usd, pricing_locked_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? < ${today} THEN ${now} ELSE NULL END, ${now})
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
  `, values);
}

export async function upsertSession(db, row) {
  const values = [
    row.device, row.source, row.sessionId, row.lastActivity || null, row.projectPath || null,
    row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0,
    row.cacheReadTokens || 0, row.reasoningOutputTokens || 0, row.totalTokens || 0,
    row.costUSD || 0
  ];
  const now = nowExpression(db.driver);

  if (db.driver === 'mysql') {
    await db.run(`
      INSERT INTO session_usage (
        row_key, device, source, session_id, last_activity, project_path, input_tokens,
        output_tokens, cache_creation_tokens, cache_read_tokens,
        reasoning_output_tokens, total_tokens, cost_usd, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})
      ON DUPLICATE KEY UPDATE
        last_activity = VALUES(last_activity), project_path = VALUES(project_path),
        input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
        cache_creation_tokens = VALUES(cache_creation_tokens), cache_read_tokens = VALUES(cache_read_tokens),
        reasoning_output_tokens = VALUES(reasoning_output_tokens), total_tokens = VALUES(total_tokens),
        cost_usd = VALUES(cost_usd), updated_at = ${now}
    `, [mysqlRowKey(row.device, row.source, row.sessionId), ...values]);
    return;
  }

  await db.run(`
    INSERT INTO session_usage (
      device, source, session_id, last_activity, project_path, input_tokens,
      output_tokens, cache_creation_tokens, cache_read_tokens,
      reasoning_output_tokens, total_tokens, cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now})
    ON CONFLICT(device, source, session_id) DO UPDATE SET
      last_activity = excluded.last_activity, project_path = excluded.project_path,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens, cache_read_tokens = excluded.cache_read_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens, total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd, updated_at = ${now}
  `, values);
}

export async function recordRun(db, row) {
  await db.run(`
    INSERT INTO collection_runs(device, source, status, message, collected_at, command)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    row.device, row.source, row.status, row.message || null,
    row.collectedAt || new Date().toISOString(), row.command || null
  ]);
}

export function apiRowIdExpression(driver, columns) {
  if (driver === 'mysql') {
    return `CONCAT_WS(':', ${columns.map(column => `COALESCE(${column}, '')`).join(', ')})`;
  }
  return columns.map(column => `COALESCE(${column}, '')`).join(` || ':' || `);
}

export function hourExpression(driver, column = 'event_time') {
  if (driver === 'postgres') {
    return `CAST(EXTRACT(HOUR FROM CAST(${column} AS timestamptz) AT TIME ZONE CURRENT_SETTING('TIMEZONE')) AS INTEGER)`;
  }
  if (driver === 'mysql') {
    return `HOUR(DATE_ADD(STR_TO_DATE(LEFT(${column}, 19), '%Y-%m-%dT%H:%i:%s'), INTERVAL TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) MINUTE))`;
  }
  return `CAST(strftime('%H', ${column}, 'localtime') AS INTEGER)`;
}

export function mysqlRowKey(...parts) {
  return createHash('sha256').update(parts.map(part => String(part ?? '')).join('\0')).digest('hex');
}
