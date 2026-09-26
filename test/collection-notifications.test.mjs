import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectionNotifications } from '../src/collection-notifications.mjs';

test('completion wakes all waiting clients, idle responds immediately and disconnects unsubscribe', () => {
  let state = { status: 'running' };
  const updates = collectionNotifications(() => state, (res, value) => { res.value = value; });
  const first = new EventEmitter(), second = new EventEmitter(), disconnected = new EventEmitter();
  for (const client of [first, second, disconnected]) updates.wait(client);
  assert.equal(first.value, undefined);
  assert.equal(updates.pending, 3);
  disconnected.emit('close');
  assert.equal(updates.pending, 2);
  state = { status: 'ok' };
  updates.publish();
  assert.deepEqual(first.value, state);
  assert.deepEqual(second.value, state);
  assert.equal(disconnected.value, undefined);
  assert.equal(updates.pending, 0);
  const idle = new EventEmitter();
  updates.wait(idle);
  assert.deepEqual(idle.value, state);
});

test('long poll times out with current status and releases its listener', async () => {
  const res = new EventEmitter();
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const updates = collectionNotifications(() => ({ status: 'running' }), (_, state) => resolveResponse(state), { timeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    updates.wait(res);
    assert.deepEqual(await response, { status: 'running' });
    assert.equal(updates.pending, 0);
    assert.equal(res.listenerCount('close'), 0);
  } finally { clearTimeout(keepAlive); }
});
