#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const command = args.shift();
const projectFlag = args.indexOf('--project');
const explicitProject = projectFlag >= 0 ? args.splice(projectFlag, 2)[1] : null;
const start = explicitProject
  ? resolve(explicitProject)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const project = findProjectRoot(start);
const env = { ...process.env, ...readEnv(resolve(project, '.env')) };

const commands = {
  preflight: ['src/db-migrate.mjs', '--dry-run', ...args],
  init: ['src/db-init.mjs', ...args],
  migrate: ['src/db-migrate.mjs', ...args],
  check: ['src/db-check.mjs', ...args]
};

if (!commands[command]) {
  console.error('Usage: database.mjs <preflight|init|migrate|check> [--project PATH] [options]');
  process.exit(2);
}

const result = spawnSync(process.execPath, commands[command], {
  cwd: project,
  env,
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function findProjectRoot(startPath) {
  let current = startPath;
  while (true) {
    const packagePath = resolve(current, 'package.json');
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (pkg.name === 'ai-token-dashboard') return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`ai-token-dashboard project root not found from ${startPath}`);
}

function readEnv(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}
