/**
 * Incremental parse cache.
 *
 * Collectors re-scan every session file on each run. Most files never change
 * between runs (only the active session gets appended), yet they were fully
 * re-read and re-parsed every time. This caches each file's *parsed records*
 * keyed by a cheap fingerprint (mtime + size); unchanged files are served from
 * cache instead of being re-parsed.
 *
 * Important invariants:
 *   - Only raw parsed records are cached — never costs. Cost is recomputed
 *     downstream from the cached tokens, so pricing updates still take effect.
 *   - Records must be JSON-serializable (plain numbers/strings/null/objects).
 *   - Bump the `version` passed by a collector whenever its parser logic
 *     changes, so stale entries are discarded.
 *
 * Set PARSE_CACHE=0 to disable entirely (falls back to always parsing).
 */

import { mkdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { resolveDisplayTz } from '../timezone.mjs';

const CACHE_ROOT = process.env.AI_TOKEN_DASHBOARD_CACHE_DIR
  || resolve(process.cwd(), 'data', 'parse-cache');

const DISABLED = ['0', 'false', 'no', 'off']
  .includes(String(process.env.PARSE_CACHE ?? '').trim().toLowerCase());

// namespace -> { version, prev: Map<path,{fp,records}>, next: Map<...>, path }
const stores = new Map();

function cachePathFor(namespace) {
  return resolve(CACHE_ROOT, `${namespace}.json`);
}

async function getStore(namespace, version) {
  version = `${version}:${resolveDisplayTz()}`;
  let store = stores.get(namespace);
  if (store && store.version === version) return store;

  store = { version, prev: new Map(), next: new Map(), path: cachePathFor(namespace), persisted: false };
  try {
    const raw = JSON.parse(await readFile(store.path, 'utf8'));
    if (raw && raw.version === version && raw.files) {
      for (const [key, value] of Object.entries(raw.files)) {
        if (value && typeof value.fp === 'string') store.prev.set(key, value);
      }
      store.persisted = true;
    }
  } catch {
    // no usable cache — start cold
  }
  stores.set(namespace, store);
  return store;
}

async function fingerprint(filePath) {
  try {
    const st = await stat(filePath);
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Return parsed records for `filePath`, reusing the cache when the file's
 * fingerprint is unchanged. `parseFile(filePath)` is only invoked on a miss.
 * With resume enabled, the second argument is the previous result; the parser
 * must validate its content against the current file before reusing any state.
 */
export async function cachedParse(namespace, version, filePath, parseFile, dependencies = [], { resume = false } = {}) {
  if (DISABLED) return parseFile(filePath);

  const store = await getStore(namespace, version);
  const primary = await fingerprint(filePath);
  const fp = primary && (dependencies.length
    ? JSON.stringify([primary, ...await Promise.all(dependencies.map(fingerprint))])
    : primary);

  if (fp) {
    const hit = store.prev.get(filePath);
    if (hit && hit.fp === fp) {
      store.next.set(filePath, hit);
      return hit.records;
    }
  }

  const records = await parseFile(filePath, resume ? store.prev.get(filePath)?.records : undefined);
  // Only cache stat-able files; unstattable ones are parsed fresh every time.
  if (fp) store.next.set(filePath, { fp, records });
  return records;
}

/**
 * Persist the entries touched this run (dropping files no longer present) and
 * reset the in-memory state so a second pass in the same process stays correct.
 */
export async function flushCache(namespace) {
  if (DISABLED) return;
  const store = stores.get(namespace);
  if (!store) return;

  const changed = !store.persisted || store.prev.size !== store.next.size
    || [...store.next].some(([key, value]) => store.prev.get(key) !== value);
  if (changed) {
    const temporary = `${store.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(store.path), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: store.version, files: Object.fromEntries(store.next) }));
      await rename(temporary, store.path);
      store.persisted = true;
    } catch {
      // Retry on the next flush, even if the in-memory entries are unchanged.
      store.persisted = false;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  store.prev = store.next;
  store.next = new Map();
}
