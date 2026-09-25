import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export function backupSnapshot(snapshot, scopes) {
  const directory = resolve(process.cwd(), 'data', 'backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `usage-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), scopes, ...snapshot }), { mode: 0o600, flag: 'wx' });
  return path;
}
