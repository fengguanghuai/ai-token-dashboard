import assert from 'node:assert/strict';
import { syncDatabase } from '../../src/sync.mjs';
import { writeSnapshot, readSnapshot } from '../../src/usage-store.mjs';
import { batchUpsertTimeUsage } from '../../src/db-batch.mjs';
import { collectionScopeKey } from '../../src/collection-state.mjs';
import { initSyncJournal } from '../../src/sync-journal.mjs';
import { event, usage } from './server.mjs';

export async function exerciseSyncJournal(db, device) {
  const scope = { device, source: 'Codex CLI' }, key = collectionScopeKey(scope);
  const changed = overrides => event({ ...scope, ...overrides });
  const write = time => writeSnapshot(db, { daily: [], sessions: [], time });
  const sent = [];
  const fetcher = async (url, options) => { sent.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ ok: true }) }; };
  const options = { db, device, url: 'https://sync-test.invalid/a', fetcher };
  const queries = [];
  const track = handle => ({ ...handle,
    all: async (sql, params) => { const rows = await handle.all(sql, params); queries.push({ sql, rows: rows.length }); return rows; },
    transaction: work => handle.transaction(tx => work(track(tx)))
  });
  try {
    await write([changed({ eventKey: 'old', eventTime: '2025-01-01T00:00:00.000Z', usageDate: '2025-01-01' }), changed({ eventKey: 'new' })]);
    assert.equal((await syncDatabase(options)).rows.time, 2);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM sync_changes WHERE scope_key = ?', [key])).count, 0);
    queries.length = 0;
    assert.equal((await syncDatabase({ ...options, db: track(db) })).requests, 0);
    assert.ok(queries.every(({ sql }) => !/FROM (time_usage|daily_usage|session_usage|sync_changes)\b/.test(sql)), 'no-change sync must not read usage or change payloads');
    await syncDatabase({ ...options, url: 'https://sync-test.invalid/slow' });
    await write([changed({ eventKey: 'old', costUSD: 8 })]);
    await write([changed({ eventKey: 'old', costUSD: 9 })]);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM sync_changes WHERE scope_key = ?', [key])).count, 1, 'retain latest value, not every intermediate update');
    queries.length = 0;
    assert.equal((await syncDatabase({ ...options, db: track(db) })).rows.time, 1);
    assert.equal(sent.at(-1)[1].time[0].costUSD, 9);
    assert.ok(queries.every(({ sql }) => !/FROM (time_usage|daily_usage|session_usage)\b/.test(sql)), 'delta sync must not reread historical usage');
    assert.equal(queries.find(({ sql }) => /FROM sync_changes/.test(sql)).rows, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM sync_changes WHERE scope_key = ?', [key])).count, 1, 'slow target retains recovery records');
    assert.equal((await syncDatabase({ ...options, url: 'https://sync-test.invalid/slow' })).rows.time, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM sync_changes WHERE scope_key = ?', [key])).count, 0);
    assert.equal((await syncDatabase({ ...options, url: 'https://sync-test.invalid/brand-new' })).rows.time, 2, 'new target gets full baseline after pruning');
    assert.equal((await syncDatabase({ ...options, resync: true })).rows.time, 2, 'explicit resync repairs a hub reset behind the same URL');
    assert.equal(sent.at(-1)[1].mode, 'incremental', 'resync alone does not authorize remote deletion');

    await write([changed({ source: 'Other', eventKey: 'other' })]);
    assert.equal((await syncDatabase({ ...options, source: 'Other' })).rows.time, 1);
    assert.equal((await syncDatabase(options)).requests, 0, 'source-specific sync does not discard another source progress');
    const before = await db.get('SELECT revision FROM sync_scopes WHERE scope_key = ?', [key]);
    await write((await readSnapshot(db, device, scope.source)).time);
    assert.deepEqual(await db.get('SELECT revision FROM sync_scopes WHERE scope_key = ?', [key]), before, 'replayed upserts do not create new revisions or relay loops');
    await assert.rejects(db.transaction(async tx => {
      await batchUpsertTimeUsage(tx, [changed({ eventKey: 'rollback' })]);
      throw new Error('rollback');
    }), /rollback/);
    assert.deepEqual(await db.get('SELECT revision FROM sync_scopes WHERE scope_key = ?', [key]), before);
    assert.ok(!(await readSnapshot(db, device, scope.source)).time.some(row => row.eventKey === 'rollback'));

    await write([changed({ eventKey: 'during-sync', costUSD: 10 })]);
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const running = syncDatabase({ ...options, source: scope.source, fetcher: async (...args) => { started(); await gate; return fetcher(...args); } });
    await entered;
    try {
      await assert.rejects(syncDatabase({ ...options, source: scope.source }), /already running/);
      await write([changed({ eventKey: 'during-sync', costUSD: 11 })]);
    } finally { release(); }
    await running;
    assert.equal((await syncDatabase({ ...options, source: scope.source })).rows.time, 1, 'writes during upload remain pending');
    assert.equal(sent.at(-1)[1].time[0].costUSD, 11);

    await writeSnapshot(db, { daily: [usage({ ...scope, costUSD: 7 })], sessions: [], time: [] }, { full: true, scopes: [scope] });
    await syncDatabase({ ...options, source: scope.source });
    assert.equal(sent.at(-1)[1].mode, 'full'); assert.equal(sent.at(-1)[1].daily[0].costUSD, 7); assert.equal(sent.at(-1)[1].time.length, 0);
    await writeSnapshot(db, { daily: [], sessions: [], time: [] }, { full: true, scopes: [scope] });
    assert.equal((await syncDatabase({ ...options, source: scope.source })).requests, 1);
    assert.deepEqual(sent.at(-1)[1], { mode: 'full', scopes: [scope], daily: [], time: [], sessions: [] });
    await db.run('UPDATE sync_targets SET lease_owner = ?, lease_until = ? WHERE scope_key = ?', ['crashed', Date.now() + 120000, key]);
    await assert.rejects(syncDatabase({ ...options, source: scope.source }), /already running/);
    await db.run('UPDATE sync_targets SET lease_until = 0 WHERE scope_key = ?', [key]);
    assert.equal((await syncDatabase({ ...options, source: scope.source })).requests, 0, 'expired crash leases are recoverable');

    // Recreate pre-upgrade history without a journal entry, including a partial
    // interrupted migration. The first target must still see that old usage.
    const legacy = { device: device + '-legacy', source: 'Legacy' };
    await db.run(`INSERT INTO daily_usage (${db.driver === 'mysql' ? 'row_key,' : ''}device,source,usage_date,model,updated_at) VALUES (${db.driver === 'mysql' ? "'" + collectionScopeKey(legacy) + "'," : ''}?,?,?,?,?)`,
      [legacy.device, legacy.source, '2024-01-01', 'legacy-model', '2024-01-01T00:00:00.000Z']);
    await db.run('UPDATE sync_meta SET version = 0 WHERE id = 1');
    await initSyncJournal(db);
    assert.equal((await syncDatabase({ ...options, device: legacy.device })).rows.daily, 1);
  } finally {
    for (const identity of [device, device + '-legacy']) {
      const scopes = await db.all('SELECT scope_key FROM sync_scopes WHERE device = ?', [identity]);
      for (const { scope_key } of scopes) for (const table of ['sync_changes', 'sync_targets', 'sync_scopes', 'collection_checkpoints']) {
        await db.run(`DELETE FROM ${table} WHERE scope_key = ?`, [scope_key]);
      }
      for (const table of ['daily_usage', 'time_usage', 'session_usage']) await db.run(`DELETE FROM ${table} WHERE device = ?`, [identity]);
    }
  }
}
