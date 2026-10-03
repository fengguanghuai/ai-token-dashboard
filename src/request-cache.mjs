// Process-local results only. Authentication stays ahead of every cache lookup.
// Pending requests share one promise; evicted requests cannot refill
// the cache after a newer request completes.
export function requestCache({ ttl, maxEntries = 4, cacheable = () => true, now = Date.now }) {
  const entries = new Map();
  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && (hit.pending || hit.until > now())) {
        entries.delete(key); entries.set(key, hit);
        return hit.promise;
      }
      const entry = { pending: true };
      entries.delete(key); entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      entry.promise = Promise.resolve().then(load).then(value => {
        entry.pending = false;
        entry.until = now() + (typeof ttl === 'function' ? ttl(value) : ttl);
        if (!cacheable(value) && entries.get(key) === entry) entries.delete(key);
        return value;
      }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      return entry.promise;
    }
  };
}
