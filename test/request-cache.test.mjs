import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestCache } from '../src/request-cache.mjs';

test('requests share pending work, TTL starts on completion, and failures are retryable', async () => {
  let clock = 0, calls = 0, complete;
  const cache = requestCache({ ttl: value => value.failed ? 10 : 60, now: () => clock });
  const load = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
  const a = cache.get('quota', load), b = cache.get('quota', load);
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(a, b);
  clock = 100; complete({ failed: false }); await a;
  clock = 159; await cache.get('quota', load); assert.equal(calls, 1);
  clock = 160; const c = cache.get('quota', async () => { calls++; return { failed: true }; }); await c;
  clock = 170; await assert.rejects(cache.get('quota', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.get('quota', async () => 42), 42);
});

test('bounded eviction and oversized results cannot retain or resurrect stale data', async () => {
  let calls = 0, resolveOld;
  const cache = requestCache({ ttl: 10000, maxEntries: 2, cacheable: value => value !== 'large' });
  const old = cache.get('range', () => new Promise(resolve => { resolveOld = resolve; }));
  await Promise.resolve();
  await cache.get('first', async () => 1); await cache.get('second', async () => 2);
  assert.equal(await cache.get('range', async () => 'new'), 'new');
  resolveOld('old'); await old;
  assert.equal(await cache.get('range', async () => assert.fail('new response should remain cached')), 'new');
  const load = async () => ++calls;
  await cache.get('other', load); await cache.get('last', load); await cache.get('range', load);
  assert.equal(calls, 3);
  await cache.get('huge', async () => 'large');
  assert.equal(await cache.get('huge', async () => 'small'), 'small');
});
