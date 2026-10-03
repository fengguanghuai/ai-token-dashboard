import { createHash } from 'node:crypto';
import { collectionScopeKey, lockCollectionState } from './collection-state.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const exactColumn = (db, name) => db.driver === 'mysql' ? `${name} COLLATE utf8mb4_bin` : name;

export async function ensureSyncScope(db, scope) {
  const key = collectionScopeKey(scope);
  await db.run(`INSERT INTO sync_scopes (scope_key, device, source, revision, reset_revision) VALUES (?, ?, ?, 0, 0)
    ${db.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE scope_key = VALUES(scope_key)' : 'ON CONFLICT(scope_key) DO NOTHING'}`,
  [key, scope.device, scope.source]);
  return key;
}

// Upgrade only discovers identities, not usage payloads. The durable marker is
// committed with discovery, so an interrupted upgrade can safely restart.
export async function initSyncJournal(db) {
  if ((await db.get('SELECT version FROM sync_meta WHERE id = 1'))?.version === 1) return;
  await db.transaction(async tx => {
    await tx.run(`INSERT INTO sync_meta (id, version) VALUES (1, 0)
      ${tx.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE id = VALUES(id)' : 'ON CONFLICT(id) DO NOTHING'}`);
    const state = await tx.get(`SELECT version FROM sync_meta WHERE id = 1${tx.driver === 'sqlite' ? '' : ' FOR UPDATE'}`);
    if (Number(state.version) === 1) return;
    const scopes = await tx.all(['daily_usage', 'time_usage', 'session_usage'].map(table =>
      `SELECT ${exactColumn(tx, 'device')} AS device, ${exactColumn(tx, 'source')} AS source FROM ${table}`).join(' UNION '));
    for (const scope of scopes) await ensureSyncScope(tx, scope);
    await tx.run('UPDATE sync_meta SET version = 1 WHERE id = 1');
  });
}

async function advance(db, scope) {
  const key = await ensureSyncScope(db, scope);
  await db.run('UPDATE sync_scopes SET revision = revision + 1 WHERE scope_key = ?', [key]);
  const { revision } = await db.get('SELECT revision FROM sync_scopes WHERE scope_key = ?', [key]);
  if (!Number.isSafeInteger(Number(revision))) throw new Error('Sync revision exceeds the safe integer range');
  return { key, revision: Number(revision) };
}

// Called after the usage write, under the same source lock and transaction.
// Keep only the latest pending value per row; intermediate versions need not
// be transmitted because the existing ingest contract is an idempotent upsert.
export async function recordUsageChanges(db, kind, rows, definition) {
  const groups = new Map();
  for (const row of rows) {
    const key = collectionScopeKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [, records] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const { key, revision } = await advance(db, records[0]);
    const entries = new Map(records.map(row => {
      const payload = Object.fromEntries(definition.fields.map(([, name, fallback]) => [name, row[name] ?? fallback]));
      const identity = definition.keys.map(column => payload[definition.fields.find(([name]) => name === column)[1]]);
      return [digest([kind, ...identity]), JSON.stringify(payload)];
    }));
    for (let offset = 0, items = [...entries]; offset < items.length; offset += 200) {
      const part = items.slice(offset, offset + 200);
      await db.run(`INSERT INTO sync_changes (scope_key, row_key, revision, kind, payload_json)
        VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(',')}
        ${db.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE revision = VALUES(revision), payload_json = VALUES(payload_json)'
    : 'ON CONFLICT(scope_key, row_key) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json'}`,
      part.flatMap(([rowKey, payload]) => [key, rowKey, revision, kind, payload]));
    }
  }
}

// The persistent reset marker survives an empty replacement and journal
// cleanup, forcing lagging targets to receive one atomic scope replacement.
export async function resetUsageChanges(db, scopes) {
  const unique = new Map(scopes.map(scope => [collectionScopeKey(scope), scope]));
  for (const [, scope] of [...unique].sort(([a], [b]) => a.localeCompare(b))) {
    await lockCollectionState(db, scope);
    const { key, revision } = await advance(db, scope);
    await db.run('UPDATE sync_scopes SET reset_revision = ? WHERE scope_key = ?', [revision, key]);
    await db.run('DELETE FROM sync_changes WHERE scope_key = ?', [key]);
  }
}
