import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { expandPath, envPathList } from '../src/collector-config.mjs';

test('expandPath expands ~ and environment variables', () => {
  assert.equal(expandPath('~'), homedir());
  assert.equal(expandPath('~/logs'), `${homedir()}/logs`);

  process.env.EXPAND_TEST_DIR = '/tmp/example';
  assert.equal(expandPath('${EXPAND_TEST_DIR}/sub'), '/tmp/example/sub');
  assert.equal(expandPath('$EXPAND_TEST_DIR/sub'), '/tmp/example/sub');
  delete process.env.EXPAND_TEST_DIR;
});

test('expandPath returns null for empty/invalid input', () => {
  assert.equal(expandPath(''), null);
  assert.equal(expandPath('   '), null);
  assert.equal(expandPath(null), null);
  assert.equal(expandPath(42), null);
});

test('envPathList splits, trims, and drops empties', () => {
  assert.deepEqual(envPathList('/a, /b ,, /c'), ['/a', '/b', '/c']);
  assert.deepEqual(envPathList(''), []);
  assert.deepEqual(envPathList('', ['/fallback']), ['/fallback']);
});
