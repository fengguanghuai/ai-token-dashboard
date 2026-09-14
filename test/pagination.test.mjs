import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginateRows } from '../src/client/shared/pagination.js';

test('pagination bounds DOM rows without mutating the complete dataset', () => {
  const rows = Array.from({ length: 1147 }, (_, id) => ({ id }));
  const first = paginateRows(rows, 1);
  assert.equal(first.rows.length, 50);
  assert.equal(first.pageCount, 23);
  assert.equal(first.total, 1147);
  assert.equal(paginateRows(rows, 2).rows[0].id, 50);
  const last = paginateRows(rows, 23);
  assert.equal(last.rows.length, 47);
  assert.equal(last.start, 1101);
  assert.equal(last.end, 1147);
  assert.equal(rows.length, 1147);
});

test('pagination clamps after filtering and handles empty and invalid input', () => {
  assert.deepEqual(paginateRows([], 8), { page: 1, pageCount: 1, total: 0, start: 0, end: 0, rows: [] });
  assert.equal(paginateRows([1, 2], 99).page, 1);
  assert.equal(paginateRows([1, 2], -1).page, 1);
  assert.equal(paginateRows([1, 2], NaN, 0).rows.length, 2);
  assert.deepEqual(paginateRows([4, 3, 2, 1], 2, 2).rows, [2, 1]);
});
