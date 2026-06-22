import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateFromTimestamp, normalizeModelForGrouping,
  canonicalProvider, inferProviderFromModel
} from '../src/collectors/utils.mjs';

test('localDateFromTimestamp falls back on bad input', () => {
  assert.equal(localDateFromTimestamp(''), 'unknown');
  assert.equal(localDateFromTimestamp(null), 'unknown');
  assert.equal(localDateFromTimestamp('not-a-date'), 'unknown');
  assert.equal(localDateFromTimestamp('bad', 'n/a'), 'n/a');
});

test('localDateFromTimestamp treats seconds and milliseconds as the same instant', () => {
  const seconds = 1_700_000_000;
  assert.match(localDateFromTimestamp(seconds), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localDateFromTimestamp(seconds), localDateFromTimestamp(seconds * 1000));
});

test('normalizeModelForGrouping strips reasoning tiers, date suffixes, and claude dots', () => {
  assert.equal(normalizeModelForGrouping('gpt-5-codex(high)'), 'gpt-5-codex');
  assert.equal(normalizeModelForGrouping('claude-sonnet-4-5-20250101'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelForGrouping('claude-3.5-sonnet'), 'claude-3-5-sonnet');
  assert.equal(normalizeModelForGrouping(''), 'unknown');
  assert.equal(normalizeModelForGrouping(null), 'unknown');
  // a parenthetical that is not a known tier is left intact
  assert.equal(normalizeModelForGrouping('model(beta)'), 'model(beta)');
});

test('canonicalProvider normalizes aliases', () => {
  assert.equal(canonicalProvider('openai'), 'openai');
  assert.equal(canonicalProvider('x-ai'), 'xai');
  assert.equal(canonicalProvider('anthropic/claude-sonnet'), 'anthropic');
  assert.equal(canonicalProvider('unknown'), null);
  assert.equal(canonicalProvider(null), null);
});

test('inferProviderFromModel maps model families', () => {
  assert.equal(inferProviderFromModel('claude-sonnet-4'), 'anthropic');
  assert.equal(inferProviderFromModel('gpt-4o'), 'openai');
  assert.equal(inferProviderFromModel('gemini-2.0-flash'), 'google');
  assert.equal(inferProviderFromModel('grok-2'), 'xai');
  assert.equal(inferProviderFromModel('deepseek-chat'), 'deepseek');
  assert.equal(inferProviderFromModel('totally-unknown'), null);
});
