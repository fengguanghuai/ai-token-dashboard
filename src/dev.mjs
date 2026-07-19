import './load-env.mjs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const nodeCmd = process.execPath;
const viteBin = resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

const children = [
  spawn(nodeCmd, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: process.env.API_PORT || '4173' },
    stdio: 'inherit'
  }),
  spawn(nodeCmd, [viteBin, '--host', '127.0.0.1', '--port', '5173'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  })
];

let shuttingDown = false;

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children) {
      if (other !== child && !other.killed) other.kill();
    }
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
