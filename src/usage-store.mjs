import { batchUpsertDaily, batchUpsertSession, batchUpsertTimeUsage, fromStored, TABLES, tokenFields } from './db-batch.mjs';
import { calculateCost, hasModelPricing } from './pricing.mjs';

export const rowKey = (kind, row) => JSON.stringify(TABLES[kind].keys.map(column => row[TABLES[kind].fields.find(([c]) => c === column)[1]] ?? ''));
const bucketKey = row => JSON.stringify([row.device, row.source, row.usageDate, row.model || '']);
const sameUsage = (a, b) => tokenFields.every(key => (a[key] || 0) === (b[key] || 0));
const sum = (rows, key) => rows.reduce((n, row) => n + (row[key] || 0), 0);
const combinedBasis = rows => {
  const values = new Set(rows.map(row => row.costBasis || 'legacy_unknown'));
  if (values.has('legacy_unknown')) return 'legacy_unknown';
  if (values.has('unknown')) return 'unknown';
  return values.size === 1 ? [...values][0] : 'mixed';
};
const group = rows => {
  const map = new Map();
  for (const row of rows) { const key = bucketKey(row); if (!map.has(key)) map.set(key, []); map.get(key).push(row); }
  return map;
};

export async function readSnapshot(db, device, source) {
  const params = device ? [device, ...(source ? [source] : [])] : [];
  const where = device ? ` WHERE device = ?${source ? ' AND source = ?' : ''}` : '';
  const result = {};
  for (const [kind, { table }] of Object.entries(TABLES)) {
    result[kind] = (await db.all(`SELECT * FROM ${table}${where}`, params)).map(row => fromStored(kind, row));
  }
  return result;
}

function pricedTokens(row) {
  return {
    input: row.inputTokens || 0, output: row.outputTokens || 0,
    cacheRead: row.cacheReadTokens || 0, cacheWrite: row.cacheCreationTokens || 0,
    reasoning: /^Codex CLI(?: \(JS\))?$/.test(row.source) ? 0 : row.reasoningOutputTokens || 0
  };
}

/** Preserve stored amounts; estimate only changed usage, never reprice an
 * unchanged event just because the bundled catalog was refreshed. */
export function reconcileSnapshot(previous, incoming, { pricingData = null, full = false } = {}) {
  const oldEvents = new Map(previous.time.map(row => [rowKey('time', row), row]));
  const time = incoming.time.map(row => {
    const old = oldEvents.get(rowKey('time', row));
    if (!old) return row;
    if (old.model === row.model && sameUsage(old, row)) {
      return { ...row, costUSD: old.costUSD, costBasis: old.costBasis, pricingVersion: old.pricingVersion };
    }
    if (row.costBasis === 'recorded' && row.costUSD >= old.costUSD) return row;
    if (old.model === row.model && hasModelPricing(row.model, pricingData)) {
      const delta = calculateCost(row.model, pricedTokens(row), pricingData) - calculateCost(old.model, pricedTokens(old), pricingData);
      return { ...row, costUSD: old.costUSD + Math.max(0, delta), costBasis: delta < 0 || old.costBasis === 'legacy_unknown' ? 'legacy_unknown' : 'mixed' };
    }
    return { ...row, costUSD: old.costUSD, costBasis: 'legacy_unknown', pricingVersion: old.pricingVersion };
  });
  const merged = full ? new Map() : new Map(oldEvents);
  for (const row of time) merged.set(rowKey('time', row), row);
  const beforeBuckets = group(previous.time);
  const afterBuckets = group([...merged.values()]);
  const oldDays = new Map(previous.daily.map(row => [bucketKey(row), row]));
  const daily = incoming.daily.map(row => {
    const old = oldDays.get(bucketKey(row));
    const before = beforeBuckets.get(bucketKey(row)) || [];
    const after = afterBuckets.get(bucketKey(row)) || [];
    const complete = tokenFields.every(key => sum(after, key) === (row[key] || 0)) && after.length > 0;
    if (!old) return complete ? { ...row, costUSD: sum(after, 'costUSD'), costBasis: combinedBasis(after) } : row;
    if (sameUsage(old, row)) return { ...row, costUSD: old.costUSD, costBasis: old.costBasis, pricingVersion: old.pricingVersion, pricingLockedAt: old.pricingLockedAt };
    const accountedDelta = tokenFields.every(key => sum(after, key) - sum(before, key) === (row[key] || 0) - (old[key] || 0));
    // Log rotation is not proof that stored usage disappeared. Only an explicit
    // full rebuild may lower a summary without matching event corrections.
    if (!full && !accountedDelta && tokenFields.some(key => (row[key] || 0) < (old[key] || 0))) {
      return { ...old, costBasis: 'legacy_unknown' };
    }
    return {
      ...row, costUSD: accountedDelta ? old.costUSD + Math.max(0, sum(after, 'costUSD') - sum(before, 'costUSD')) : old.costUSD,
      costBasis: accountedDelta ? combinedBasis([old, ...after]) : 'legacy_unknown',
      pricingLockedAt: old.pricingLockedAt
    };
  });
  const activities = new Map();
  for (const event of merged.values()) {
    const key = JSON.stringify([event.projectPath, event.model]);
    if (event.eventTime > (activities.get(key) || '')) activities.set(key, event.eventTime);
  }
  const sessions = incoming.sessions.map(row => {
    const model = row.model || row.sessionId.slice(row.sessionId.lastIndexOf(':') + 1);
    return { ...row, lastActivity: row.projectPath ? activities.get(JSON.stringify([row.projectPath, model])) || null : null };
  });
  return { daily, time, sessions };
}

export function snapshotDiff(previous, next) {
  return Object.fromEntries(Object.keys(TABLES).map(kind => {
    const old = new Map(previous[kind].map(row => [rowKey(kind, row), row]));
    const keys = new Set(next[kind].map(row => rowKey(kind, row)));
    return [kind, {
      before: previous[kind].length, after: next[kind].length,
      added: next[kind].filter(row => !old.has(rowKey(kind, row))).length,
      removed: previous[kind].filter(row => !keys.has(rowKey(kind, row))).length,
      costBefore: sum(previous[kind], 'costUSD'), costAfter: sum(next[kind], 'costUSD')
    }];
  }));
}

export async function writeSnapshot(db, snapshot, { scopes = [], full = false, previous = null } = {}) {
  if (full && !scopes.length) throw new Error('Full replacement requires explicit scopes');
  await db.transaction(async tx => {
    if (full) for (const { device, source } of scopes) for (const { table } of Object.values(TABLES)) {
      await tx.run(`DELETE FROM ${table} WHERE device = ? AND source = ?`, [device, source]);
    }
    for (const [kind, write] of [['daily', batchUpsertDaily], ['time', batchUpsertTimeUsage], ['sessions', batchUpsertSession]]) {
      const old = new Map((previous?.[kind] || []).map(row => [rowKey(kind, row), row]));
      const fields = TABLES[kind].fields.filter(([, key]) => key !== 'pricingLockedAt');
      const changed = snapshot[kind].filter(row => full || !old.has(rowKey(kind, row)) || fields.some(([, key, fallback]) => (row[key] ?? fallback) !== (old.get(rowKey(kind, row))[key] ?? fallback)));
      await write(tx, changed);
    }
  });
}
