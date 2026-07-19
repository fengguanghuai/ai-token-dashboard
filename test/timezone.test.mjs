import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourExpression, resolveDisplayTz, todayExpression } from '../src/db.mjs';

function withEnv(key, value, fn) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test('resolveDisplayTz uses DISPLAY_TZ when set to a valid zone', () => {
  withEnv('DISPLAY_TZ', 'Asia/Shanghai', () => {
    assert.equal(resolveDisplayTz(), 'Asia/Shanghai');
  });
});

test('resolveDisplayTz falls back to the machine zone when DISPLAY_TZ is unset', () => {
  withEnv('DISPLAY_TZ', undefined, () => {
    const tz = resolveDisplayTz();
    assert.ok(typeof tz === 'string' && tz.length > 0);
    // Must match the process/host timezone that Intl reports.
    assert.equal(tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

test('resolveDisplayTz rejects an injection-shaped DISPLAY_TZ and falls back to UTC', () => {
  withEnv('DISPLAY_TZ', "Asia/Shanghai'; DROP TABLE daily_usage;--", () => {
    assert.equal(resolveDisplayTz(), 'UTC');
  });
});

test('hourExpression buckets by the given display timezone on postgres', () => {
  const sql = hourExpression('postgres', 'event_time', 'Asia/Shanghai');
  assert.match(sql, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.doesNotMatch(sql, /CURRENT_SETTING/);
});

test('hourExpression uses localtime on sqlite (machine zone)', () => {
  const sql = hourExpression('sqlite', 'event_time', 'Asia/Shanghai');
  assert.match(sql, /strftime\('%H', event_time, 'localtime'\)/);
});

test('todayExpression buckets the price-lock boundary by the display timezone on postgres', () => {
  const sql = todayExpression('postgres', 'Asia/Shanghai');
  assert.match(sql, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.match(sql, /::date/);
  assert.doesNotMatch(sql, /'UTC'/);
});
