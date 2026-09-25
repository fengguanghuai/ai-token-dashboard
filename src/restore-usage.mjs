import './load-env.mjs';
import { readFileSync } from 'node:fs';
import { openDb } from './db.mjs';
import { validateIngest } from './ingest-validation.mjs';
import { readSnapshot, snapshotDiff, writeSnapshot } from './usage-store.mjs';
import { backupSnapshot } from './usage-backup.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--apply') args.apply = true;
  else if (['--file', '--db'].includes(flag) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[flag.slice(2)] = process.argv[++i];
  else throw new Error(`Invalid argument: ${flag}`);
}
if (!args.file) throw new Error('Usage: npm run db:restore -- --file data/backups/usage-....json [--db path] [--apply]');
const backup = JSON.parse(readFileSync(args.file, 'utf8'));
if (backup.version !== 1) throw new Error('Unsupported backup version');
const next = validateIngest({ ...backup, mode: 'full' });
const db = await openDb(args.db, { readOnly: !args.apply });
try {
  const previous = { daily: [], time: [], sessions: [] };
  for (const scope of next.scopes) {
    const rows = await readSnapshot(db, scope.device, scope.source);
    for (const kind of Object.keys(previous)) previous[kind].push(...rows[kind]);
  }
  console.log(`[${args.apply ? 'restore' : 'preview'}] ${JSON.stringify(snapshotDiff(previous, next))}`);
  if (args.apply) {
    console.log(`[backup] ${backupSnapshot(previous, next.scopes)}`);
    await writeSnapshot(db, next, { full: true, scopes: next.scopes });
  }
} finally { await db.close(); }
