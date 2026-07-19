const DEFAULT_OVERLAP_MS = 48 * 60 * 60 * 1000;

/**
 * Make event keys unique within one normalized batch by suffixing repeats
 * with #1, #2, … in source order. Must run on the FULL per-source batch
 * (before any watermark filtering) so numbering is stable across runs.
 */
export function dedupeEventKeys(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const count = seen.get(row.eventKey) || 0;
    seen.set(row.eventKey, count + 1);
    return count === 0 ? row : { ...row, eventKey: `${row.eventKey}#${count}` };
  });
}

/** Watermark minus the overlap window; null when there is no usable watermark. */
export function watermarkCutoff(watermark, overlapMs = DEFAULT_OVERLAP_MS) {
  if (!watermark) return null;
  const ms = Date.parse(watermark);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - overlapMs).toISOString();
}

export function filterTimeRows(rows, cutoff) {
  if (!cutoff) return rows;
  return rows.filter(row => row.eventTime > cutoff);
}

export function filterDailyRows(rows, cutoff) {
  if (!cutoff) return rows;
  const cutoffDate = cutoff.slice(0, 10);
  return rows.filter(row => row.usageDate >= cutoffDate);
}
