import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, utimesSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the cache at a throwaway dir before the module reads the env at import.
process.env.AI_TOKEN_DASHBOARD_CACHE_DIR = mkdtempSync(join(tmpdir(), 'pc-cache-'));
const { cachedParse, flushCache } = await import('../src/collectors/parse-cache.mjs');

function tmpFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-src-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, contents);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('cachedParse re-parses only when the file fingerprint changes', async () => {
  const { file, cleanup } = tmpFile('one');
  try {
    let calls = 0;
    const parse = async () => { calls += 1; return [{ v: calls }]; };

    const r1 = await cachedParse('unit', 1, file, parse);
    assert.equal(calls, 1);
    await flushCache('unit');

    const r2 = await cachedParse('unit', 1, file, parse);   // unchanged → hit
    assert.equal(calls, 1, 'unchanged file must not re-parse');
    assert.deepEqual(r2, r1);

    writeFileSync(file, 'one-two-three');                    // size changes → miss
    const r3 = await cachedParse('unit', 1, file, parse);
    assert.equal(calls, 2, 'changed file must re-parse');
    assert.deepEqual(r3, [{ v: 2 }]);
  } finally {
    cleanup();
  }
});

test('a version bump invalidates cached entries', async () => {
  const { file, cleanup } = tmpFile('payload');
  try {
    let calls = 0;
    const parse = async () => { calls += 1; return [{ v: calls }]; };

    await cachedParse('ver', 1, file, parse);
    await flushCache('ver');
    assert.equal(calls, 1);

    await cachedParse('ver', 2, file, parse);   // different version → ignore old cache
    assert.equal(calls, 2, 'version bump must re-parse');
  } finally {
    cleanup();
  }
});

test('PARSE_CACHE disabled bypasses the cache entirely', async () => {
  process.env.PARSE_CACHE = '0';
  const fresh = await import('../src/collectors/parse-cache.mjs?disabled');
  const { file, cleanup } = tmpFile('x');
  try {
    let calls = 0;
    const parse = async () => { calls += 1; return [calls]; };
    await fresh.cachedParse('off', 1, file, parse);
    await fresh.cachedParse('off', 1, file, parse);
    assert.equal(calls, 2, 'every call must parse when disabled');
  } finally {
    delete process.env.PARSE_CACHE;
    cleanup();
  }
});

test('unchanged cache is not rewritten; disappeared files are dropped and failed writes retry', async () => {
  const first = tmpFile('first'), second = tmpFile('second');
  const cache = join(process.env.AI_TOKEN_DASHBOARD_CACHE_DIR, 'persist.json');
  const parse = async file => [readFileSync(file, 'utf8')];
  try {
    await cachedParse('persist', 1, first.file, parse);
    await cachedParse('persist', 1, second.file, parse);
    await flushCache('persist');
    utimesSync(cache, new Date('2001-01-01'), new Date('2001-01-01'));
    const timestamp = statSync(cache).mtimeMs;
    await cachedParse('persist', 1, first.file, parse);
    await cachedParse('persist', 1, second.file, parse);
    await flushCache('persist');
    assert.equal(statSync(cache).mtimeMs, timestamp);
    await cachedParse('persist', 1, first.file, parse);
    await flushCache('persist');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(cache, 'utf8')).files), [first.file]);
    rmSync(cache); mkdirSync(cache); // Rename onto a directory fails.
    writeFileSync(first.file, 'changed');
    await cachedParse('persist', 1, first.file, parse);
    await flushCache('persist');
    assert.equal(readdirSync(process.env.AI_TOKEN_DASHBOARD_CACHE_DIR).some(name => name.endsWith('.tmp')), false);
    rmSync(cache, { recursive: true });
    await cachedParse('persist', 1, first.file, parse);
    await flushCache('persist');
    assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')).files[first.file].records, ['changed']);
  } finally { first.cleanup(); second.cleanup(); }
});

test('resumable parsers receive the prior checkpoint only within the same version', async () => {
  const { file, cleanup } = tmpFile('first');
  try {
    const parse = async (_file, previous) => ({ count: (previous?.count || 0) + 1 });
    assert.deepEqual(await cachedParse('resume', 1, file, parse, [], { resume: true }), { count: 1 });
    await flushCache('resume');
    writeFileSync(file, 'second-longer');
    assert.deepEqual(await cachedParse('resume', 1, file, parse, [], { resume: true }), { count: 2 });
    await flushCache('resume');
    assert.deepEqual(await cachedParse('resume', 2, file, parse, [], { resume: true }), { count: 1 });
  } finally { cleanup(); }
});
