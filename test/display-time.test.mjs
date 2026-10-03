import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayDateTime, displayTimeMs, displayTimeZone, setDisplayTimeZone } from '../src/client/shared/display-time.js';
import { U } from '../src/client/shared/utils.js';
import { RU } from '../src/client/review/utils.js';
import { summaryRangeForFilters, usageExportUrl } from '../src/client/shared/usage-data.js';

test('display dates, review periods, precise filters and exports use the server zone', () => {
  const previous = displayTimeZone();
  try {
    setDisplayTimeZone('Asia/Shanghai');
    const instant = new Date('2026-09-30T17:15:00Z');
    assert.equal(U.formatTs(instant.toISOString()), '2026-10-01 01:15');
    assert.equal(U.localDateStr(instant), '2026-10-01');
    assert.equal(U.toDateTimeLocalValue(instant), '2026-10-01T01:15');
    assert.equal(RU.getPeriod('month', instant).start, '2026-10-01');
    assert.equal(RU.getPeriod('month', instant).prev.end, '2026-09-30');
    assert.deepEqual(U.rangeDates('2026-09-30', '2026-10-02'), ['2026-09-30', '2026-10-01', '2026-10-02']);
    assert.equal(U.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(U.calendarDateStr(new Date(2026, 9, 1)), '2026-10-01');
    const filters = { precise: true, compare: true, startDateTime: '2026-10-01T01:00', endDateTime: '2026-10-01T01:30',
      sources: new Set(), models: new Set(), devices: new Set() };
    const query = summaryRangeForFilters(filters);
    assert.deepEqual(query, { start: '2026-09-30T17:00:00.000Z', end: '2026-09-30T17:30:00.000Z',
      compareStart: '2026-09-30T16:29:00.000Z', compareEnd: '2026-09-30T16:59:00.000Z' });
    const exported = new URL(usageExportUrl(filters), 'http://localhost');
    assert.equal(exported.searchParams.get('start'), query.start);
    assert.equal(exported.searchParams.get('end'), query.end);
    assert.equal(displayTimeMs('2026-10-01T01:15:00.123'), Date.parse('2026-09-30T17:15:00.123Z'));
    assert.ok(Number.isNaN(displayTimeMs('2026-02-30T01:00')));
    assert.throws(() => setDisplayTimeZone(undefined));
    assert.throws(() => setDisplayTimeZone('invalid'));
    assert.equal(displayTimeZone(), 'Asia/Shanghai');
  } finally { setDisplayTimeZone(previous); }
});

test('DST gaps are rejected and repeated wall hours select the earlier instant', () => {
  const previous = displayTimeZone();
  try {
    setDisplayTimeZone('America/New_York');
    assert.ok(Number.isNaN(displayTimeMs('2026-03-08T02:30')));
    assert.equal(displayTimeMs('2026-11-01T01:30'), Date.parse('2026-11-01T05:30:00Z'));
    assert.equal(displayDateTime('2026-11-01T06:30:00Z'), '2026-11-01T01:30:00');
    assert.equal(displayTimeMs('2026-11-01T01:30:00-05:00'), Date.parse('2026-11-01T06:30:00Z'));
    setDisplayTimeZone('Asia/Kathmandu');
    assert.equal(displayTimeMs('2026-10-01T01:00'), Date.parse('2026-09-30T19:15:00Z'));
  } finally { setDisplayTimeZone(previous); }
});
