import { mysqlRowKey, nowExpression } from './db.mjs';
import { zonedParts } from './timezone.mjs';
import { invalidateCollectionState } from './collection-state.mjs';

export const tokenFields = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'reasoningOutputTokens', 'totalTokens'];
const tokenColumns = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'reasoning_output_tokens', 'total_tokens'];
const usage = tokenFields.map((key, i) => [tokenColumns[i], key, 0]);
const cost = [['cost_usd', 'costUSD', 0], ['cost_basis', 'costBasis', 'legacy_unknown'], ['pricing_version', 'pricingVersion', null]];
export const TABLES = {
  daily: { table: 'daily_usage', keys: ['device', 'source', 'usage_date', 'model'], fields: [
    ['device', 'device'], ['source', 'source'], ['usage_date', 'usageDate'], ['model', 'model', ''],
    ...usage, ...cost, ['pricing_locked_at', 'pricingLockedAt', null]
  ] },
  time: { table: 'time_usage', keys: ['device', 'source', 'event_key'], fields: [
    ['device', 'device'], ['source', 'source'], ['event_key', 'eventKey'], ['event_time', 'eventTime'],
    ['usage_date', 'usageDate'], ['model', 'model', ''], ['project_path', 'projectPath', null], ['session_id', 'sessionId', null], ...usage, ...cost
  ] },
  sessions: { table: 'session_usage', keys: ['device', 'source', 'session_id'], fields: [
    ['device', 'device'], ['source', 'source'], ['session_id', 'sessionId'], ['last_activity', 'lastActivity', null],
    ['project_path', 'projectPath', null], ...usage, ['cost_usd', 'costUSD', 0]
  ] }
};

export function fromStored(kind, row) {
  return Object.fromEntries(TABLES[kind].fields.map(([column, key, fallback]) => [key, row[column] ?? fallback]));
}

async function batchUpsert(db, kind, rows) {
  if (!rows.length) return;
  const work = tx => writeRows(tx, kind, rows);
  return db.transaction ? db.transaction(work) : work(db);
}

async function writeRows(db, kind, rows) {
  await invalidateCollectionState(db, rows);
  const { table, keys, fields } = TABLES[kind];
  const columns = fields.map(([column]) => column);
  const mutable = columns.filter(column => !keys.includes(column));
  const mysql = db.driver === 'mysql';
  for (let start = 0; start < rows.length; start += 400) {
    const part = rows.slice(start, start + 400);
    const names = [...(mysql ? ['row_key'] : []), ...columns, 'updated_at'];
    const group = `(${Array(names.length - 1).fill('?').join(', ')}, ${nowExpression(db.driver)})`;
    const update = mutable.map(column => `${column} = ${mysql ? `VALUES(${column})` : `excluded.${column}`}`);
    update.push(`updated_at = ${nowExpression(db.driver)}`);
    await db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES ${part.map(() => group).join(', ')}
      ${mysql ? 'ON DUPLICATE KEY UPDATE' : `ON CONFLICT(${keys.join(', ')}) DO UPDATE SET`} ${update.join(', ')}`,
    part.flatMap(row => {
      const values = fields.map(([, key, fallback]) => row[key] ?? fallback);
      if (!mysql) return values;
      return [mysqlRowKey(...keys.map(key => values[columns.indexOf(key)])), ...values];
    }));
  }
}

export async function getTimeWatermark(db, device, source) {
  return (await db.get('SELECT MAX(event_time) AS watermark FROM time_usage WHERE device = ? AND source = ?', [device, source]))?.watermark || null;
}

// These are storage primitives. Cost preservation and late-usage reconciliation
// happen before the write, rather than freezing an entire historical day here.
export const batchUpsertTimeUsage = (db, rows) => batchUpsert(db, 'time', rows);
export const batchUpsertSession = (db, rows) => batchUpsert(db, 'sessions', rows);
export const batchUpsertDaily = (db, rows) => batchUpsert(db, 'daily', rows.map(row => ({
  ...row, pricingLockedAt: row.pricingLockedAt ?? (row.usageDate < zonedParts(Date.now()).date ? new Date().toISOString() : null)
})));
