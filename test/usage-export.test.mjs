import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

test('backpressure cancellation stops database paging', async () => {
  let reads = 0;
  const db = {driver:'sqlite',all:async () => { reads++; return Array.from({length:1001},(_,i)=>({usage_date:'2026-09-01',device:'x',source:'s',model:String(i)})); }};
  const res = new EventEmitter();
  res.destroyed = false; res.writeHead = () => {}; res.write = () => { queueMicrotask(() => { res.destroyed=true;res.emit('close'); }); return false; };
  res.end = () => assert.fail('cancelled export must not end successfully');
  await streamUsageCsv(db, new URLSearchParams(), res);
  assert.equal(reads, 1); assert.equal(res.listenerCount('drain'),0);
});
