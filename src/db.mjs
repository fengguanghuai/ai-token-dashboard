import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveDisplayTz, zonedParts } from './timezone.mjs';
import { invalidateCollectionState } from './collection-state.mjs';
export { resolveDisplayTz } from './timezone.mjs';

export const defaultDbPath = resolve(process.cwd(), 'data', 'usage.sqlite');
const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'db');

/**
 * Open the configured database and initialize its schema.
 *
 * Configuration priority: explicit input -> DATABASE_URL -> DB_DRIVER/DB_PATH -> SQLite.
 * A plain string is treated as a SQLite path unless it starts with a database URL scheme.
 */
export async function openDb(input, { readOnly = false } = {}) {
  const config = resolveDbConfig(input);
  let db;

  if (config.driver === 'sqlite') db = openSqlite(config.path, readOnly);
  else if (config.driver === 'postgres') db = await openPostgres(config.url);
  else if (config.driver === 'mysql') db = await openMysql(config.url);
  else throw new Error(`Unsupported database driver: ${config.driver}`);

  if (!readOnly) await initSchema(db);
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

function openSqlite(path, readOnly = false) {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path, { readOnly });
  client.exec('PRAGMA busy_timeout = 10000');
  if (!readOnly) client.exec('PRAGMA journal_mode = WAL');
  client.exec('PRAGMA foreign_keys = ON');
  client.function('display_hour', { deterministic: true }, (value, tz) => zonedParts(value, tz)?.hour ?? null);
  client.function('display_date', { deterministic: true }, (value, tz) => zonedParts(value, tz)?.date ?? null);

  const db = {
    driver: 'sqlite',
    config: { path },
    async exec(sql) { client.exec(sql); },
    async all(sql, params = []) { return client.prepare(sql).all(...params); },
    async get(sql, params = []) { return client.prepare(sql).get(...params); },
    async run(sql, params = []) { return client.prepare(sql).run(...params); },
    async transaction(work) {
      client.exec('BEGIN IMMEDIATE');
      try {
        const tx = { ...db, transaction: nested => nested(tx) };
        const value = await work(tx);
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
    decimalNumbers: true,
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

  for (const table of ['daily_usage', 'time_usage']) {
    for (const [column, definition] of [['cost_basis', "VARCHAR(64) NOT NULL DEFAULT 'legacy_unknown'"], ['pricing_version', 'VARCHAR(64)']]) {
      if (db.driver === 'sqlite') await ensureSqliteColumn(db, table, column, definition);
      else if (db.driver === 'postgres') await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      else {
        const existing = await db.get('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
        if (!existing) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
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

/**
 * Display timezone for hour-of-day and "today" bucketing. Defaults to the host
 * machine's zone so every deployment auto-adapts to its user; override with the
 * DISPLAY_TZ env var (an IANA name like "Asia/Shanghai") for hosted/UTC servers.
 * Invalid values fall back to UTC — the value is interpolated into SQL, so it is
 * validated against IANA name characters to keep it injection-safe.
 */
export function todayExpression(driver, tz = resolveDisplayTz()) {
  // The price-lock "today" boundary follows the display timezone so it matches
  // each user's local day (and the day buckets the source tools report).
  if (driver === 'postgres') return `(CURRENT_TIMESTAMP AT TIME ZONE '${tz}')::date::text`;
  // CONVERT_TZ needs the MySQL timezone tables loaded; falls back to NULL without them.
  if (driver === 'mysql') return `DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '${tz}'), '%Y-%m-%d')`;
  return `display_date(datetime('now'), '${tz}')`;
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
  const { batchUpsertTimeUsage } = await import('./db-batch.mjs');
  return batchUpsertTimeUsage(db, [row]);
}

export async function deleteTimeUsageForSource(db, device, source) {
  await db.transaction(async tx => {
    await invalidateCollectionState(tx, [{ device, source }]);
    await tx.run('DELETE FROM time_usage WHERE device = ? AND source = ?', [device, source]);
  });
}

export async function upsertDaily(db, row) {
  const { batchUpsertDaily } = await import('./db-batch.mjs');
  return batchUpsertDaily(db, [row]);
}

export async function upsertSession(db, row) {
  const { batchUpsertSession } = await import('./db-batch.mjs');
  return batchUpsertSession(db, [row]);
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

export function hourExpression(driver, column = 'event_time', tz = resolveDisplayTz()) {
  if (driver === 'postgres') {
    return `CAST(EXTRACT(HOUR FROM CAST(${column} AS timestamptz) AT TIME ZONE '${tz}') AS INTEGER)`;
  }
  // CONVERT_TZ needs the MySQL timezone tables loaded; falls back to NULL without them.
  if (driver === 'mysql') {
    return `HOUR(CONVERT_TZ(STR_TO_DATE(LEFT(${column}, 19), '%Y-%m-%dT%H:%i:%s'), '+00:00', '${tz}'))`;
  }
  return `display_hour(${column}, '${tz}')`;
}

export function mysqlRowKey(...parts) {
  return createHash('sha256').update(parts.map(part => String(part ?? '')).join('\0')).digest('hex');
}

export function dateExpression(driver, column = 'event_time', tz = resolveDisplayTz()) {
  if (driver === 'postgres') return `to_char(CAST(${column} AS timestamptz) AT TIME ZONE '${tz}', 'YYYY-MM-DD')`;
  if (driver === 'mysql') return `DATE_FORMAT(CONVERT_TZ(STR_TO_DATE(LEFT(${column}, 19), '%Y-%m-%dT%H:%i:%s'), '+00:00', '${tz}'), '%Y-%m-%d')`;
  return `display_date(${column}, '${tz}')`;
}
