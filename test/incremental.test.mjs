import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeEventKeys, filterDailyRows, filterTimeRows, watermarkCutoff
} from '../src/incremental.mjs';

test('dedupeEventKeys keeps unique keys and suffixes duplicates deterministically', () => {
  const rows = [{ eventKey: 'a' }, { eventKey: 'b' }, { eventKey: 'a' }, { eventKey: 'a' }];
  const out = dedupeEventKeys(rows);
  assert.deepEqual(out.map(r => r.eventKey), ['a', 'b', 'a#1', 'a#2']);
  // 同输入再跑一遍结果相同(幂等的前提)
  assert.deepEqual(dedupeEventKeys(rows).map(r => r.eventKey), ['a', 'b', 'a#1', 'a#2']);
  // 原数组对象未被修改
  assert.equal(rows[2].eventKey, 'a');
});

test('watermarkCutoff subtracts the overlap window', () => {
  assert.equal(watermarkCutoff('2026-07-19T12:00:00.000Z'), '2026-07-17T12:00:00.000Z');
  assert.equal(watermarkCutoff(null), null);
  assert.equal(watermarkCutoff('not-a-date'), null);
});

test('filterTimeRows keeps rows strictly newer than cutoff', () => {
  const rows = [
    { eventTime: '2026-07-17T11:59:59.000Z' },
    { eventTime: '2026-07-17T12:00:00.000Z' },
    { eventTime: '2026-07-17T12:00:01.000Z' }
  ];
  const out = filterTimeRows(rows, '2026-07-17T12:00:00.000Z');
  assert.deepEqual(out.map(r => r.eventTime), ['2026-07-17T12:00:01.000Z']);
  assert.equal(filterTimeRows(rows, null).length, 3);
});

test('filterDailyRows keeps dates on or after the cutoff date', () => {
  const rows = [{ usageDate: '2026-07-16' }, { usageDate: '2026-07-17' }, { usageDate: '2026-07-18' }];
  const out = filterDailyRows(rows, '2026-07-17T12:00:00.000Z');
  assert.deepEqual(out.map(r => r.usageDate), ['2026-07-17', '2026-07-18']);
  assert.equal(filterDailyRows(rows, null).length, 3);
});
