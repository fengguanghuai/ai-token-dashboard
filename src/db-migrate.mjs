import './load-env.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, openDb, pruneCollectionRuns } from './db.mjs';

const args = parseArgs(process.argv.slice(2));
const sourcePath = resolve(args.from || process.env.DB_PATH || defaultDbPath);
const targetUrl = args.to || process.env.DATABASE_URL;

if (!existsSync(sourcePath)) throw new Error(`SQLite source does not exist: ${sourcePath}`);
if (!targetUrl) throw new Error('Target is required: pass --to or set DATABASE_URL');
if (!/^(?:postgres(?:ql)?|mysql2?):/i.test(targetUrl)) {
  throw new Error('Target must be a PostgreSQL or MySQL connection URL');
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const tableConfigs = [
  {
    table: 'daily_usage',
    key: ['device', 'source', 'usage_date', 'model'],
    columns: [
      'device', 'source', 'usage_date', 'model', 'input_tokens', 'output_tokens',
      'cache_creation_tokens', 'cache_read_tokens', 'reasoning_output_tokens',
      'total_tokens', 'cost_usd', 'pricing_locked_at', 'updated_at'
    ]
  },
  {
    table: 'session_usage',
    key: ['device', 'source', 'session_id'],
    columns: [
      'device', 'source', 'session_id', 'last_activity', 'project_path',
      'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens',
      'reasoning_output_tokens', 'total_tokens', 'cost_usd', 'updated_at'
    ]
  },
  {
    table: 'time_usage',
    key: ['device', 'source', 'event_key'],
    columns: [
      'device', 'source', 'event_key', 'event_time', 'usage_date', 'model',
      'project_path', 'session_id', 'input_tokens', 'output_tokens',
      'cache_creation_tokens', 'cache_read_tokens', 'reasoning_output_tokens',
      'total_tokens', 'cost_usd', 'updated_at'
    ]
  }
];

const sourceRows = Object.fromEntries(tableConfigs.map(config => [
  config.table,
  readSourceRows(source, config)
]));
const runRows = source.prepare(`
  SELECT device, source, status, message, collected_at, command
  FROM collection_runs ORDER BY id
`).all();

console.log(`[db:migrate] source=${sourcePath}`);
for (const config of tableConfigs) console.log(`${config.table}=${sourceRows[config.table].length}`);
console.log(`collection_runs=${runRows.length}`);

if (args.dryRun) {
  source.close();
  console.log(`[db:migrate] dry-run target=${redactUrl(targetUrl)}`);
  process.exit(0);
}

const target = await openDb({ url: targetUrl });
try {
  console.log(`[db:migrate] target=${target.driver} ${redactUrl(targetUrl)}`);
  for (const config of tableConfigs) {
    await bulkUpsert(target, config, sourceRows[config.table]);
    console.log(`[db:migrate] migrated ${config.table}=${sourceRows[config.table].length}`);
  }

  const existingRuns = Number((await target.get('SELECT COUNT(*) AS count FROM collection_runs')).count);
  if (existingRuns === 0 && !args.skipRuns) {
    await bulkInsertRuns(target, runRows);
    await pruneCollectionRuns(target);
    console.log(`[db:migrate] migrated collection_runs=${runRows.length}`);
  } else {
    console.log(`[db:migrate] collection_runs skipped (target already has ${existingRuns} rows or --skip-runs)`);
  }

  let verified = true;
  for (const config of tableConfigs) {
    const targetCount = Number((await target.get(`SELECT COUNT(*) AS count FROM ${config.table}`)).count);
    const expected = sourceRows[config.table].length;
    const ok = targetCount >= expected;
    verified &&= ok;
    console.log(`[db:migrate] verify ${config.table}: source=${expected} target=${targetCount} ${ok ? 'OK' : 'FAILED'}`);
  }
  if (!verified) throw new Error('Migration verification failed');
  console.log('[db:migrate] migration verified');
} finally {
  source.close();
  await target.close();
}

async function bulkUpsert(db, config, rows, batchSize = 250) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await db.transaction(async (tx) => {
      const mysql = tx.driver === 'mysql';
      const columns = mysql ? ['row_key', ...config.columns] : config.columns;
      const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
      const values = batch.flatMap((row) => {
        const rowValues = config.columns.map(column => row[column]);
        return mysql ? [hashKey(config.key.map(column => row[column])), ...rowValues] : rowValues;
      });
      const mutable = config.columns.filter(column => !config.key.includes(column));
      const conflict = mysql
        ? `ON DUPLICATE KEY UPDATE ${mutable.map(column => `${column} = VALUES(${column})`).join(', ')}`
        : `ON CONFLICT (${config.key.join(', ')}) DO UPDATE SET ${mutable.map(column => `${column} = excluded.${column}`).join(', ')}`;
      await tx.run(`INSERT INTO ${config.table} (${columns.join(', ')}) VALUES ${placeholders} ${conflict}`, values);
    });
  }
}

async function bulkInsertRuns(db, rows, batchSize = 250) {
  const columns = ['device', 'source', 'status', 'message', 'collected_at', 'command'];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    const values = batch.flatMap(row => columns.map(column => row[column]));
    await db.run(`INSERT INTO collection_runs (${columns.join(', ')}) VALUES ${placeholders}`, values);
  }
}

function hashKey(parts) {
  return createHash('sha256').update(parts.map(part => String(part ?? '')).join('\0')).digest('hex');
}

function readSourceRows(db, config) {
  const available = new Set(db.prepare(`PRAGMA table_info(${config.table})`).all().map(column => column.name));
  const selections = config.columns.map((column) => {
    if (available.has(column)) return column;
    if (column === 'pricing_locked_at') return 'NULL AS pricing_locked_at';
    if (column === 'updated_at') return `datetime('now') AS updated_at`;
    throw new Error(`SQLite source is missing required column ${config.table}.${column}`);
  });
  return db.prepare(`SELECT ${selections.join(', ')} FROM ${config.table}`).all();
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from' && argv[index + 1]) result.from = argv[++index];
    else if (arg === '--to' && argv[index + 1]) result.to = argv[++index];
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--skip-runs') result.skipRuns = true;
  }
  return result;
}
