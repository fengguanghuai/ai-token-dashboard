import test from 'node:test';
import assert from 'node:assert/strict';
import { numberFlowParts } from '../src/client/shared/number-flow.js';
import { buildTrendData } from '../src/client/shared/trend-data.js';
import { U } from '../src/client/shared/utils.js';

test('CSV export preserves values and quotes embedded commas and newlines', async () => {
  let exportedBlob, clicked = false;
  const anchor = {click() { clicked = true; }};
  const oldDocument = globalThis.document;
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  try {
    globalThis.document = {createElement: () => anchor};
    URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:test-export'; };
    URL.revokeObjectURL = () => {};
    U.downloadCSV('usage.csv', [{model:'model,"long"\nname', total:123}], [{title:'model',field:'model'},{title:'total',field:'total'}]);
    assert.equal(clicked, true);
    assert.equal(anchor.download, 'usage.csv');
    assert.equal(await exportedBlob.text(), 'model,total\n"model,""long""\nname",123');
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  }
});

test('NumberFlow preserves grouping, currency decimals and Chinese display units', () => {
  for (const text of ['$1,234.00','29.56 亿','948 万','0','-123.4 万','9,999']) {
    const {value,prefix,suffix,format} = numberFlowParts(text);
    assert.equal(prefix + new Intl.NumberFormat('en-US',format).format(value) + suffix,text);
  }
  assert.equal(numberFlowParts('—'),null);
});
test('enhanced trend fills missing days and aligns previous period by date index', () => {
  const data = buildTrendData([
    {usageDate:'2026-09-14',source:'__proto__',totalTokens:10},
    {usageDate:'2026-09-14',source:'__proto__',totalTokens:7},
    {usageDate:'2026-09-14',source:'other',totalTokens:99},
  ], ['2026-09-13','2026-09-14'], ['__proto__'], [{usageDate:'2026-09-06',totalTokens:12}], ['2026-09-06','2026-09-07']);
  assert.equal(data[0].total,0);
  assert.equal(data[1].source0,17);
  assert.equal(data[1].total,17);
  assert.equal(data[0].previous,12);
  assert.equal(data[1].previous,0);
  assert.equal(data[0].previousDay,'2026-09-06');
  assert.equal(data[1].date.getDate(),14);
});
test('enhanced trend does not add a comparison when disabled', () => {
  assert.equal('previous' in buildTrendData([],['2026-09-14'],[],null)[0],false);
  assert.deepEqual(buildTrendData([],[],[],null),[]);
});
