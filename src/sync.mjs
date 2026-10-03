import { randomUUID } from 'node:crypto';
import { readSnapshot } from './usage-store.mjs';
import { collectionScopeKey, lockCollectionState } from './collection-state.mjs';
import { digest, exactColumn } from './sync-journal.mjs';

const LEASE_MS = 120_000; // Each HTTP request times out after 60 seconds.
const emptySnapshot = () => ({ daily: [], time: [], sessions: [] });

async function claim(db, targetKey, scopeKey, owner) {
  await db.run(`INSERT INTO sync_targets (target_key, scope_key) VALUES (?, ?)
    ${db.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE target_key = VALUES(target_key)' : 'ON CONFLICT(target_key) DO NOTHING'}`,
  [targetKey, scopeKey]);
  await db.run('UPDATE sync_targets SET lease_owner = ?, lease_until = ? WHERE target_key = ? AND lease_until <= ?',
    [owner, Date.now() + LEASE_MS, targetKey, Date.now()]);
  const target = await db.get('SELECT acknowledged_revision, lease_owner FROM sync_targets WHERE target_key = ?', [targetKey]);
  if (target.lease_owner !== owner) throw new Error('Sync already running for this target, device and source; retry after it finishes (or after two minutes following a crash)');
  return target.acknowledged_revision == null ? null : Number(target.acknowledged_revision);
}

async function renew(db, targetKey, owner) {
  await db.run('UPDATE sync_targets SET lease_until = ? WHERE target_key = ? AND lease_owner = ? AND lease_until > ?',
    [Date.now() + LEASE_MS, targetKey, owner, Date.now()]);
  const lease = await db.get('SELECT lease_owner, lease_until FROM sync_targets WHERE target_key = ?', [targetKey]);
  if (lease.lease_owner !== owner || Number(lease.lease_until) <= Date.now()) throw new Error('Sync lease expired; retry without advancing progress');
}

async function capture(db, scope, after, full, resync) {
  return db.transaction(async tx => {
    await lockCollectionState(tx, scope);
    const key = collectionScopeKey(scope);
    const state = await tx.get('SELECT revision, reset_revision FROM sync_scopes WHERE scope_key = ?', [key]);
    const revision = Number(state.revision);
    const replacement = full || Number(state.reset_revision) > (after ?? 0);
    if (after != null && after > revision && !full) throw new Error('Sync progress is ahead of source history; restore the complete database or use --full --apply');
    if (!replacement && !resync && after === revision) return { revision, snapshot: emptySnapshot(), mode: 'incremental' };
    if (after == null || replacement || resync) return { revision, mode: replacement ? 'full' : 'incremental',
      snapshot: await readSnapshot(tx, scope.device, scope.source) };
    const snapshot = emptySnapshot();
    const changes = await tx.all('SELECT kind, payload_json FROM sync_changes WHERE scope_key = ? AND revision > ? AND revision <= ? ORDER BY revision, row_key',
      [key, after, revision]);
    for (const row of changes) snapshot[row.kind].push(JSON.parse(row.payload_json));
    return { revision, snapshot, mode: 'incremental' };
  });
}

async function acknowledge(db, targetKey, scopeKey, owner, revision) {
  await db.transaction(async tx => {
    await renew(tx, targetKey, owner);
    await tx.run('UPDATE sync_targets SET acknowledged_revision = ? WHERE target_key = ? AND lease_owner = ?', [revision, targetKey, owner]);
    // Offline targets retain their progress. New targets always get a baseline,
    // so pruning acknowledged records cannot strand either kind of receiver.
    const { floor } = await tx.get('SELECT MIN(COALESCE(acknowledged_revision, 0)) AS floor FROM sync_targets WHERE scope_key = ?', [scopeKey]);
    await tx.run('DELETE FROM sync_changes WHERE scope_key = ? AND revision <= ?', [scopeKey, Number(floor)]);
  });
}

/** First connection captures a baseline. Later runs read only transactional
 * changes; old event timestamps, repeated payloads and lost responses are safe.
 * No database transaction is held open across a network request. */
export async function syncDatabase({ db, url, token, device, source, full = false, resync = false, scopes, fetcher = fetch }) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP(S) ingest URL and --token');
  target.hash = '';
  const selected = full && scopes ? scopes : await db.all(`SELECT device, source FROM sync_scopes WHERE ${exactColumn(db, 'device')} = ?${source ? ` AND ${exactColumn(db, 'source')} = ?` : ''} ORDER BY scope_key`,
    [device, ...(source ? [source] : [])]);
  const result = { requests: 0, rows: { daily: 0, time: 0, sessions: 0 } };
  for (const scope of selected) {
    const scopeKey = collectionScopeKey(scope), targetKey = digest([target.href, scope.device, scope.source]);
    const owner = randomUUID();
    const after = await claim(db, targetKey, scopeKey, owner);
    try {
      const plan = await capture(db, scope, after, full, resync);
      const send = async payload => {
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > 48 * 1024 * 1024) throw new Error('Replacement exceeds 48 MiB; rebuild one source at a time with --source');
        await renew(db, targetKey, owner);
        const response = await fetcher(target.href, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body, signal: AbortSignal.timeout(60_000)
        });
        if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}`);
        if ((await response.json()).ok !== true) throw new Error('Hub did not acknowledge upload');
        result.requests++;
      };
      if (plan.mode === 'full') await send({ mode: 'full', scopes: [scope], ...plan.snapshot });
      else {
        const count = Math.max(...Object.values(plan.snapshot).map(rows => rows.length));
        for (let i = 0; i < count; i += 1000) await send({ mode: 'incremental',
          ...Object.fromEntries(Object.entries(plan.snapshot).map(([kind, rows]) => [kind, rows.slice(i, i + 1000)])) });
      }
      if (after !== plan.revision || plan.mode === 'full') await acknowledge(db, targetKey, scopeKey, owner, plan.revision);
      for (const kind of Object.keys(result.rows)) result.rows[kind] += plan.snapshot[kind].length;
    } finally {
      await db.run('UPDATE sync_targets SET lease_owner = NULL, lease_until = 0 WHERE target_key = ? AND lease_owner = ?', [targetKey, owner]);
    }
  }
  return result;
}
