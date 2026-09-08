import { test } from 'node:test';
import assert from 'node:assert/strict';
import { U } from '../src/client/shared/utils.js';

const sourceFilters = (extra = {}) => ({
  startDate: '2026-08-10', endDate: '2026-09-08',
  sources: new Set(), devices: new Set(), models: new Set(), ...extra
});

test('source options exclude historical and zero-token rows, independently of source selection', () => {
  const rows = [
    { source: 'Codex CLI', usageDate: '2026-09-08', totalTokens: 100 },
    { source: 'Pi Agent', usageDate: '2026-09-08', totalTokens: 1 },
    { source: 'OpenCode', usageDate: '2026-08-06', totalTokens: 10 },
    { source: 'DeepSeek Harness', usageDate: '2026-09-08', totalTokens: 0 }
  ];
  assert.deepEqual(U.sourceOptions(rows, sourceFilters({ sources: new Set(['Codex CLI', 'OpenCode']) })), [
    { source: 'Codex CLI', hasUsage: true },
    { source: 'OpenCode', hasUsage: false },
    { source: 'Pi Agent', hasUsage: true }
  ]);
  assert.equal(U.sourceOptions(rows, sourceFilters({ startDate: '2026-01-01' }))
    .find(o => o.source === 'OpenCode').hasUsage, true);
  assert.deepEqual(U.sourceOptions([], sourceFilters()), []);
});

test('source options follow device and model filters and retain selected empty choices', () => {
  const rows = [
    { source: 'Codex CLI', usageDate: '2026-09-08', device: 'a', model: 'm1', totalTokens: 10 },
    { source: 'Pi Agent', usageDate: '2026-09-08', device: 'a', model: 'm2', totalTokens: 10 },
    { source: 'DeepSeek Harness', usageDate: '2026-09-08', device: 'b', model: 'm1', totalTokens: 10 }
  ];
  assert.deepEqual(U.sourceOptions(rows, sourceFilters({
    devices: new Set(['a']), models: new Set(['m1']), sources: new Set(['Pi Agent'])
  })), [{ source: 'Codex CLI', hasUsage: true }, { source: 'Pi Agent', hasUsage: false }]);
  assert.deepEqual(U.sourceOptions(rows, sourceFilters({ devices: new Set(['b']) })),
    [{ source: 'DeepSeek Harness', hasUsage: true }]);
});

test('source options respect precise time boundaries', () => {
  const rows = [
    { source: 'Codex CLI', eventTime: '2026-09-08T10:00:00Z', totalTokens: 10 },
    { source: 'Pi Agent', eventTime: '2026-09-08T10:30:00Z', totalTokens: 1 },
    { source: 'OpenCode', eventTime: '2026-09-08T10:30:01Z', totalTokens: 10 }
  ];
  assert.deepEqual(U.sourceOptions(rows, sourceFilters({
    startDateTime: '2026-09-08T10:00:00Z', endDateTime: '2026-09-08T10:30:00Z'
  }), true), [{ source: 'Codex CLI', hasUsage: true }, { source: 'Pi Agent', hasUsage: true }]);
});

test('usage shares distinguish tiny positive usage from zero', () => {
  assert.equal(U.usageShare(92187, 2958494728), '<0.1%');
  assert.equal(U.usageShare(1, 1000), '0.1%');
  assert.equal(U.usageShare(1, 4), '25.0%');
  assert.equal(U.usageShare(0, 100), '0%');
  assert.equal(U.usageShare(0, 0), '0%');
});

test('aggregateTotals sums cacheSavedUSD, defaulting missing values to 0', () => {
  const rows = [
    { totalTokens: 100, inputTokens: 10, outputTokens: 20, cacheReadTokens: 60,
      cacheCreationTokens: 10, reasoningOutputTokens: 0, costUSD: 1, cacheSavedUSD: 2.5 },
    { totalTokens: 50, inputTokens: 50, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningOutputTokens: 0, costUSD: 0.5 } // no cacheSavedUSD
  ];
  const t = U.aggregateTotals(rows);
  assert.equal(t.cacheSavedUSD, 2.5);
  assert.equal(t.totalTokens, 150);
});
