import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, dateExpression, hourExpression } from '../src/db.mjs';
import { queryDaily, queryTime, queryTimeSummary } from '../src/usage-query.mjs';
import { readSnapshot, writeSnapshot } from '../src/usage-store.mjs';
import { usage, event } from './helpers/server.mjs';
import { applyCollectionDelta } from '../src/collection-delta.mjs';
import { invalidateCollectionState } from '../src/collection-state.mjs';
import { checkDatabase } from '../src/doctor-checks.mjs';

for (const [name, variable] of [['PostgreSQL', 'TEST_POSTGRES_URL'], ['MySQL', 'TEST_MYSQL_URL']]) {
  test(`${name}: schema upgrades, exact upserts, project query, pagination and timezone`, { skip: !process.env[variable] }, async () => {
    const db = await openDb({ url: process.env[variable] });
    const device = `test-${randomUUID()}`;
    try {
      const snapshot = { daily: [usage({ device, costBasis: 'mixed', pricingVersion: '2026-09-25T00:00:00Z' })],
        time: [event({ device }), event({ device, eventKey: 'b', projectPath: '/project/a' })], sessions: [] };
      await writeSnapshot(db, snapshot);
      snapshot.daily[0].costUSD = 2;
      await writeSnapshot(db, snapshot);
      assert.equal((await readSnapshot(db, device)).daily[0].costUSD, 2);
      const beforeDoctor = await readSnapshot(db, device);
      const diagnosis = [];
      await checkDatabase((id, status) => diagnosis.push({ id, status }), { input: { url: process.env[variable] }, device });
      assert.ok(diagnosis.some(check => check.id === 'database.schema' && check.status === 'ok'));
      assert.ok(diagnosis.every(check => check.status !== 'error'));
      assert.deepEqual(await readSnapshot(db, device), beforeDoctor);
      const day = await queryDaily(db, new URLSearchParams(), null);
      assert.ok(day.projectDaily.filter(row => row.device === device).every(row => typeof row.totalTokens === 'number'));
      assert.equal(day.projectDaily.filter(row => row.device === device).length, 2);
      const bounds = new URLSearchParams({ start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z', limit: '1' });
      const first = await queryTime(db, bounds, null);
      assert.ok(first.nextCursor);
      bounds.set('cursor', first.nextCursor);
      const second = await queryTime(db, bounds, null);
      assert.notEqual(first.time[0].id, second.time[0].id);
      const summary = await queryTimeSummary(db, new URLSearchParams({ start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z', compareStart: '2026-08-30T00:00:00Z', compareEnd: '2026-08-31T00:00:00Z' }), null);
      const details = summary.current.projectDaily.filter(row => row.device === device);
      assert.deepEqual(details.map(row => row.projectPath).sort(), ['/project/A', '/project/a']);
      assert.equal(details.reduce((total, row) => total + row.totalTokens, 0), 220);
      assert.equal(summary.current.daily.find(row => row.device === device).eventCount, 2);
      assert.ok(summary.current.hourly.some(row => row.device === device && row.eventCount === 2));
      const projectPage = await queryTime(db, new URLSearchParams({ start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z', device, project: '/project/A' }), null);
      assert.deepEqual(projectPage.time.map(row => row.projectPath), ['/project/A']);
      const clock = await db.get(`SELECT ${hourExpression(db.driver, "'2026-09-01T17:00:00Z'", 'Asia/Shanghai')} AS hour, ${dateExpression(db.driver, "'2026-09-01T17:00:00Z'", 'Asia/Shanghai')} AS day`);
      assert.equal(Number(clock.hour), 1); assert.equal(clock.day, '2026-09-02');
      const root = mkdtempSync(join(tmpdir(), 'migration-test-'));
      try {
        const path = join(root, 'source.sqlite');
        const sqlite = await openDb(path);
        await writeSnapshot(sqlite, { ...snapshot, sessions: [{ ...usage({ device }), sessionId: 'workspace-model' }] });
        await sqlite.close();
        const migrated = spawnSync(process.execPath, [resolve('src/db-migrate.mjs'), '--from', path, '--to', process.env[variable], '--skip-runs'], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
        assert.equal(migrated.status, 0, migrated.stderr);
        const restored = await readSnapshot(db, device);
        assert.equal(restored.daily[0].costBasis, 'mixed');
        assert.equal(restored.daily[0].pricingVersion, '2026-09-25T00:00:00Z');
        assert.equal(restored.sessions.length, 1);
      } finally { rmSync(root, { recursive: true, force: true }); }
      const scope = { device, source: 'Codex CLI' };
      await applyCollectionDelta(db, scope, snapshot);
      assert.equal((await applyCollectionDelta(db, scope, snapshot)).unchanged, true);
      snapshot.time.push(event({ device, eventKey: 'old-late', usageDate: '2025-01-01', eventTime: '2025-01-01T12:00:00.000Z' }));
      snapshot.daily.push(usage({ device, usageDate: '2025-01-01' }));
      const delta = await applyCollectionDelta(db, scope, snapshot);
      assert.deepEqual(delta.dates, ['2025-01-01']);
      assert.equal((await readSnapshot(db, device)).time.length, 3);
      await writeSnapshot(db, { daily: [], time: [], sessions: [] }, { full: true, scopes: [{ device, source: 'Codex CLI' }] });
      assert.equal((await readSnapshot(db, device)).daily.length, 0);
    } finally {
      await invalidateCollectionState(db, [{ device, source: 'Codex CLI' }]);
      for (const table of ['daily_usage', 'time_usage', 'session_usage']) await db.run(`DELETE FROM ${table} WHERE device = ?`, [device]);
      await db.close();
    }
  });
}
