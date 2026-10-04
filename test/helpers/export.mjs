import assert from 'node:assert/strict';
import { withReadSnapshot } from '../../src/db.mjs';
import { usageCsvPages } from '../../src/usage-export.mjs';
import { writeSnapshot } from '../../src/usage-store.mjs';
import { usage, event } from './server.mjs';

// Exercise the same contract against SQLite and the real remote CI databases.
export async function exerciseSnapshotExport(db, device) {
  const scope = { device, source: 'Codex CLI' };
  try {
    for (const mode of ['daily', 'time']) {
      const snapshot = { daily: [], time: [], sessions: [] };
      const rows = Array.from({ length: 1105 }, (_, i) => {
        const key = String(i).padStart(5, '0');
        return mode === 'time' ? event({ ...scope, eventKey: key, costUSD: 0.25 }) : usage({ ...scope, model: key, costUSD: 0.25 });
      });
      snapshot[mode] = rows;
      await writeSnapshot(db, snapshot, { full: true, scopes: [scope] });
      const params = new URLSearchParams({ mode, device, start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' });
      await withReadSnapshot(db, async reader => {
        const pages = usageCsvPages(reader, params, null);
        try {
          let csv = (await pages.next()).value;
          // Replace the source between pages, including old row deletions and
          // a new row with different cost. Neither must affect this snapshot.
          await writeSnapshot(db, { ...snapshot, [mode]: [{ ...rows.at(-1), costUSD: 999 }] }, { full: true, scopes: [scope] });
          for await (const page of pages) csv += page;
          const lines = csv.trim().split('\r\n');
          assert.equal(lines.length, 1106, mode);
          assert.equal(lines.slice(1).reduce((sum, row) => sum + Number(row.split(',').at(-1)), 0), 276.25, mode);
        } finally { await pages.return(); }
      });
      let after = '';
      await withReadSnapshot(db, async reader => { for await (const page of usageCsvPages(reader, params, null)) after += page; });
      assert.equal(after.trim().split('\r\n').length, 2);
      assert.match(after, /,999\r\n$/);
    }
  } finally { await writeSnapshot(db, { daily: [], time: [], sessions: [] }, { full: true, scopes: [scope] }); }
}
