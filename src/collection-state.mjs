import { createHash } from 'node:crypto';

export const collectionScopeKey = ({ device, source }) => createHash('sha256')
  .update(JSON.stringify([device, source])).digest('hex');

export async function invalidateCollectionState(db, scopes) {
  const unique = new Map(scopes.map(scope => [JSON.stringify([scope.device, scope.source]), scope]));
  const keys = [...unique.values()].map(collectionScopeKey).sort();
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    // Keep a stable row to lock, including when this scope has never been
    // collected. Deleting a missing checkpoint would not serialize a first
    // collector with a concurrent importer on PostgreSQL/MySQL.
    await db.run(`INSERT INTO collection_checkpoints (scope_key, state_json) VALUES ${part.map(() => "(?, 'null')").join(',')}
      ${db.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE state_json = VALUES(state_json)' : 'ON CONFLICT(scope_key) DO UPDATE SET state_json = excluded.state_json'}`, part);
  }
}

export async function readCollectionState(db, scope) {
  const row = await db.get('SELECT state_json FROM collection_checkpoints WHERE scope_key = ?', [collectionScopeKey(scope)]);
  try { return JSON.parse(row?.state_json); } catch { return null; }
}

export async function lockCollectionState(db, scope) {
  const key = collectionScopeKey(scope);
  await db.run(`INSERT INTO collection_checkpoints (scope_key, state_json) VALUES (?, 'null')
    ${db.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE scope_key = VALUES(scope_key)' : 'ON CONFLICT(scope_key) DO NOTHING'}`, [key]);
  if (db.driver !== 'sqlite') await db.get('SELECT scope_key FROM collection_checkpoints WHERE scope_key = ? FOR UPDATE', [key]);
}

export async function saveCollectionState(db, scope, state) {
  // Called in the same transaction as usage writes. A failed collection must
  // never advance its checkpoint, even when its disposable parse cache did.
  await db.run(`INSERT INTO collection_checkpoints (scope_key, state_json) VALUES (?, ?)
    ${db.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE state_json = VALUES(state_json)' : 'ON CONFLICT(scope_key) DO UPDATE SET state_json = excluded.state_json'}`,
    [collectionScopeKey(scope), JSON.stringify(state)]);
}
