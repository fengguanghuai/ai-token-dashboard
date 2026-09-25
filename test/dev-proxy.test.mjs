import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { startServer } from './helpers/server.mjs';

test('Vite forwards a same-origin collect request, while foreign browser origins remain rejected', async () => {
  const app = await startServer();
  const previousPort = process.env.API_PORT;
  let vite;
  try {
    // Exercise the HTTP -> child-process -> status path without scanning any
    // personal logs or credentials in the test runner's home directory.
    await mkdir(join(app.root, 'src'));
    await writeFile(join(app.root, 'src', 'collect.mjs'), "console.log('fixture collection completed');\n");
    process.env.API_PORT = new URL(app.base).port;
    vite = await createServer({ configFile: resolve('vite.config.js'), root: app.root,
      logLevel: 'silent', server: { host: '127.0.0.1', port: 0, watch: null } });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const response = await fetch(`${origin}/api/collect`, { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' } });
    assert.equal(response.status, 202, await response.text());
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(`${origin}/api/collect/status`)).json();
      if (state.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state.status, 'ok', JSON.stringify(state));
    assert.match(state.stdout, /fixture collection completed/);
    const blocked = await fetch(`${origin}/api/collect`, { method: 'POST', headers: { origin: 'https://foreign.example' } });
    assert.equal(blocked.status, 403);
  } finally {
    if (previousPort === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = previousPort;
    await vite?.close();
    await app.close();
  }
});
