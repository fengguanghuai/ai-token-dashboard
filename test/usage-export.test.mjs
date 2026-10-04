import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { exerciseSnapshotExport } from './helpers/export.mjs';
import { startServer, usage, event } from './helpers/server.mjs';
import { csvCell, streamUsageCsv } from '../src/usage-export.mjs';
import { usageExportUrl } from '../src/client/shared/usage-data.js';

test('CSV export applies filters and exports all pages with stored fees', async () => {
  const app = await startServer();
  try {
    const time = Array.from({ length: 2105 }, (_, i) => event({ eventKey: String(i).padStart(5, '0'), costUSD: 0.25 }));
    assert.equal((await app.ingest({ daily: [usage({ model: 'a,"b', costUSD: 9 }), ...Array.from({length:2105},(_,i)=>usage({model:String(i).padStart(5,'0'),costUSD:0.25}))], time })).status, 200);
    const res = await fetch(app.base + '/api/export.csv?mode=time&start=2026-09-01T00:00:00Z&end=2026-09-02T00:00:00Z&device=laptop');
    assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition'), /attachment/);
    const rows = (await res.text()).trim().split('\r\n');
    assert.equal(rows.length, 2106);
    assert.equal(rows.slice(1).reduce((s, r) => s + Number(r.split(',').at(-1)), 0), 526.25);
    const daily = await (await fetch(app.base + '/api/export.csv?startDate=2026-09-01&endDate=2026-09-01&model=a%2C%22b')).text();
    assert.match(daily, /"a,""b"/); assert.match(daily, /,9\r\n$/);
    const allDaily = (await (await fetch(app.base + '/api/export.csv')).text()).trim().split('\r\n');
    assert.equal(allDaily.length, 2107);
    assert.equal(new Set(allDaily.slice(1)).size, 2106);
    const empty = await (await fetch(app.base + '/api/export.csv?device=absent')).text();
    assert.equal(empty.trim().split('\r\n').length, 1);
    for (const q of ['mode=wrong', 'startDate=bad', 'mode=time', 'mode=time&start=bad&end=bad', 'limit=1', 'project=x'])
      assert.equal((await fetch(app.base + '/api/export.csv?' + q)).status, 400);
    assert.equal((await fetch(app.base + '/api/export.csv', {method:'POST'})).status, 405);
  } finally { await app.close(); }
});

test('CSV endpoint requires existing dashboard authentication', async () => {
  const app = await startServer({ DASHBOARD_TOKEN: 'export-test-token' });
  try {
    assert.equal((await fetch(app.base + '/api/export.csv')).status, 401);
    assert.equal((await fetch(app.base + '/api/export.csv', { headers: {authorization:'Basic '+Buffer.from(':export-test-token').toString('base64')} })).status, 200);
  } finally { await app.close(); }
});

test('CSV quoting neutralizes formula strings and preserves numeric values', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('a\rb'), '"a\rb"');
  assert.equal(csvCell(-2), '-2');
  assert.equal(csvCell(' a,"b\n'), '" a,""b\n"');
});

test('download query excludes comparison periods and preserves selected dimensions', () => {
  const filters = {startDate:'2026-09-01',endDate:'2026-09-02',compare:true,sources:new Set(['A','B']),devices:new Set(['device']),models:new Set(['模型'])};
  const url = new URL(usageExportUrl(filters, 'B'), 'http://localhost');
  assert.equal(url.searchParams.get('startDate'), '2026-09-01');
  assert.deepEqual(url.searchParams.getAll('source'), ['B']);
  assert.equal(url.searchParams.get('model'), '模型');
});

test('SQLite CSV snapshot survives concurrent replacement and permits writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csv-snapshot-'));
  const db = await openDb(join(root, 'usage.sqlite'));
  try { await exerciseSnapshotExport(db, 'csv-sqlite'); }
  finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('CSV releases its snapshot before downloading and cleans private spool files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csv-spool-'));
  try {
    for (const scenario of ['success', 'cancel-preparation', 'query-error', 'cancel-download']) {
      let reads = 0, active = false, headers = false;
      const res = new Writable({ write(chunk, _encoding, done) {
        assert.equal(active, false, 'slow clients must not keep the database transaction');
        if (scenario === 'cancel-download') this.destroy();
        setTimeout(done, 5);
      } });
      res.writeHead = () => { headers = true; assert.equal(active, false); };
      const db = { driver: 'postgres', transaction: async work => {
        active = true;
        try { return await work({ driver: 'postgres', all: async () => {
          reads++;
          const [directory] = await readdir(root);
          const spool = join(root, directory, 'usage.csv');
          if (process.platform !== 'win32') assert.equal((await stat(spool)).mode & 0o777, 0o600);
          if (scenario === 'cancel-preparation') res.destroy();
          if (scenario === 'query-error' && reads === 2) throw new Error('query failed');
          return reads === 1 ? Array.from({length:1001},(_,i)=>({usage_date:'2026-09-01',device:'x',source:'s',model:String(i)})) : [];
        } }); } finally { active = false; }
      } };
      const run = streamUsageCsv(db, new URLSearchParams(), res, null, { temporaryRoot: root });
      if (scenario === 'query-error') await assert.rejects(run, /query failed/);
      else await run;
      assert.equal(headers, !['cancel-preparation', 'query-error'].includes(scenario));
      assert.equal(reads, scenario === 'cancel-preparation' ? 1 : 2);
      assert.deepEqual(await readdir(root), [], scenario);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
