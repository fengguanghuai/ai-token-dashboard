import { createHash } from 'node:crypto';
import { readCollectionState, lockCollectionState } from './collection-state.mjs';
import { fromStored } from './db-batch.mjs';
import { readSnapshot, reconcileSnapshot, writeSnapshot } from './usage-store.mjs';

const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

export function collectionSignature(snapshot) {
  const days = new Map();
  for (const kind of ['daily', 'time']) for (const row of snapshot[kind]) {
    if (!days.has(row.usageDate)) days.set(row.usageDate, []);
    days.get(row.usageDate).push([kind, row]);
  }
  // Use complete normalized input, including event identity and project
  // metadata, not just token totals or an event-time watermark. A moved event,
  // correction, or late historical record must invalidate its date bucket.
  return { version: 1, days: Object.fromEntries([...days].map(([date, rows]) => [date, digest(rows)])),
    sessions: digest(snapshot.sessions) };
}

export async function prepareCollectionDelta(db, scope, incoming) {
  const signature = collectionSignature(incoming);
  const stored = await readCollectionState(db, scope);
  if (stored?.version !== signature.version || !stored.days || typeof stored.days !== 'object') {
    return { previous: await readSnapshot(db, scope.device, scope.source), incoming, signature, unchanged: false, dates: null };
  }
  const dates = [...new Set([...Object.keys(stored.days), ...Object.keys(signature.days)])]
    .filter(date => stored.days[date] !== signature.days[date]);
  if (!dates.length && stored.sessions === signature.sessions) return { signature, unchanged: true, dates };
  // Large rebuilds are cheaper as a single scan; normal runs only read the
  // changed dates. Keep a bounded parameter count on all three SQL drivers.
  if (dates.length > 180) return { previous: await readSnapshot(db, scope.device, scope.source), incoming, signature, unchanged: false, dates: null };

  const values = [scope.device, scope.source, ...dates];
  const placeholders = dates.map(() => '?').join(',');
  const selected = new Set(dates);
  const previous = { daily: [], time: [], sessions: [], activities: [] };
  if (dates.length) for (const [kind, table] of [['daily', 'daily_usage'], ['time', 'time_usage']]) {
    previous[kind] = (await db.all(`SELECT * FROM ${table} WHERE device = ? AND source = ? AND usage_date IN (${placeholders})`, values))
      .map(row => fromStored(kind, row));
  }
  previous.sessions = (await db.all('SELECT * FROM session_usage WHERE device = ? AND source = ?', values.slice(0, 2)))
    .map(row => fromStored('sessions', row));
  // Preserve activity from retained history outside the changed dates, without
  // loading those events into JS. Inside the dates, reconciliation computes the
  // maxima again, including corrections that move activity backwards.
  const project = db.driver === 'mysql' ? 'project_path COLLATE utf8mb4_bin' : 'project_path';
  const model = db.driver === 'mysql' ? 'model COLLATE utf8mb4_bin' : 'model';
  previous.activities = await db.all(`SELECT ${project} AS project_path, ${model} AS model, MAX(event_time) AS last_activity
    FROM time_usage WHERE device = ? AND source = ?${dates.length ? ` AND usage_date NOT IN (${placeholders})` : ''}
    GROUP BY ${project}, ${model}`, values);
  return { previous, signature, dates, unchanged: false, incoming: {
    daily: incoming.daily.filter(row => selected.has(row.usageDate)),
    time: incoming.time.filter(row => selected.has(row.usageDate)), sessions: incoming.sessions
  } };
}

export async function applyCollectionDelta(db, scope, incoming, { pricingData = null } = {}) {
  return db.transaction(async tx => {
    // Serialize readers/writers for this scope. Other storage primitives
    // invalidate the same row before writing, so a concurrent import cannot
    // leave a checkpoint describing an outdated database snapshot.
    await lockCollectionState(tx, scope);
    const delta = await prepareCollectionDelta(tx, scope, incoming);
    if (!delta.unchanged) {
      delta.next = reconcileSnapshot(delta.previous, delta.incoming, { pricingData });
      await writeSnapshot(tx, delta.next, { previous: delta.previous, checkpoint: { scope, signature: delta.signature } });
    }
    return delta;
  });
}
