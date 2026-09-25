import './load-env.mjs';
import { openDb } from './db.mjs';
import { tokenFields } from './db-batch.mjs';
import { readSnapshot, writeSnapshot } from './usage-store.mjs';
import { backupSnapshot } from './usage-backup.mjs';

// Recover missing daily amounts from complete stored event costs only. Today's
// catalog cannot establish what a historical request actually cost.
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--apply') args.apply = true;
  else if (['--db', '--database-url'].includes(flag) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[flag.slice(2)] = process.argv[++i];
  else throw new Error(`Invalid argument: ${flag}`);
}
const db = await openDb(args['database-url'] ? { url: args['database-url'] } : args.db, { readOnly: !args.apply });
try {
  const previous = await readSnapshot(db);
  const key = row => JSON.stringify([row.device, row.source, row.usageDate, row.model]);
  const events = new Map();
  for (const row of previous.time) {
    if (!events.has(key(row))) events.set(key(row), []);
    events.get(key(row)).push(row);
  }
  const daily = [];
  for (const row of previous.daily) {
    if (row.costUSD !== 0 || row.totalTokens <= 0 || row.costBasis === 'recorded') continue;
    const detail = events.get(key(row)) || [];
    const cost = detail.reduce((n, r) => n + r.costUSD, 0);
    if (cost <= 0 || !tokenFields.every(field => detail.reduce((n, r) => n + (r[field] || 0), 0) === (row[field] || 0))) continue;
    daily.push({ ...row, costUSD: cost, costBasis: detail.some(r => ['legacy_unknown', 'unknown'].includes(r.costBasis)) ? 'legacy_unknown' : 'mixed' });
  }
  console.log(`[pricing:${args.apply ? 'apply' : 'preview'}] recoverable=${daily.length}, addedCostUSD=${daily.reduce((n, row) => n + row.costUSD, 0)}`);
  if (args.apply && daily.length) {
    const scopes = [...new Map(daily.map(row => [JSON.stringify([row.device, row.source]), { device: row.device, source: row.source }])).values()];
    const inScope = row => scopes.some(scope => scope.device === row.device && scope.source === row.source);
    console.log(`[backup] ${backupSnapshot(Object.fromEntries(Object.entries(previous).map(([kind, rows]) => [kind, rows.filter(inScope)])), scopes)}`);
    await writeSnapshot(db, { daily, time: [], sessions: [] });
  }
} finally { await db.close(); }
