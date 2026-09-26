import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('src/dev.mjs');
async function listener() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'token-dev-test-'));
  await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules/vite/bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const content = `import { createServer } from 'node:http';
    const port = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : Number(process.env.PORT);
    const server = createServer((req, res) => res.end('fixture'));
    server.listen(port, '127.0.0.1', () => console.log('READY:' + port));
    process.on('SIGTERM', () => server.close());`;
  await writeFile(join(root, 'src/server.mjs'), content);
  await writeFile(join(root, 'node_modules/vite/bin/vite.js'), content);
  return root;
}
function launch(root, env) {
  const child = spawn(process.execPath, [script], { cwd: root, env: { PATH: process.env.PATH, HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const done = once(child, 'close').then(([code]) => ({ code, output }));
  return { child, done, output: () => output };
}

test('dev refuses occupied API or client ports before starting either child', { timeout: 10_000 }, async () => {
  const root = await fixture(), busy = await listener(), free = await listener();
  await free.close();
  try {
    for (const env of [{ API_PORT: busy.port, CLIENT_PORT: free.port }, { API_PORT: free.port, CLIENT_PORT: busy.port }]) {
      const result = await launch(root, env).done;
      assert.equal(result.code, 1); assert.match(result.output, /端口已被占用/); assert.match(result.output, /Ctrl\+C/);
      assert.ok(result.output.includes(String(busy.port))); assert.doesNotMatch(result.output, /READY:|Unhandled|SQLite/);
      assert.ok(busy.server.listening, 'must not terminate the existing listener');
    }
    for (const env of [{ API_PORT: 'bad' }, { API_PORT: free.port, CLIENT_PORT: free.port }]) {
      assert.equal((await launch(root, env).done).code, 1);
    }
  } finally { await busy.close(); await rm(root, { recursive: true, force: true }); }
});

test('dev starts both services, rejects a duplicate, and releases ports on shutdown', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const root = await fixture(), api = await listener(), client = await listener();
  await api.close(); await client.close();
  const env = { API_PORT: api.port, CLIENT_PORT: client.port };
  const running = launch(root, env);
  try {
    const deadline = Date.now() + 5000;
    while (!running.output().includes(`READY:${api.port}`) || !running.output().includes(`READY:${client.port}`)) {
      if (Date.now() > deadline || running.child.exitCode !== null) throw new Error(running.output());
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal((await launch(root, env).done).code, 1);
    assert.equal(await (await fetch(`http://127.0.0.1:${client.port}`)).text(), 'fixture');
    running.child.kill('SIGTERM');
    assert.equal((await running.done).code, 143);
    for (const port of [api.port, client.port]) {
      const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
      await new Promise(resolve => probe.close(resolve));
    }
  } finally {
    if (running.child.exitCode === null) { running.child.kill('SIGTERM'); await running.done; }
    await rm(root, { recursive: true, force: true });
  }
});
