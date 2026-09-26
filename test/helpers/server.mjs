import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

export async function startServer(options = {}, { staticDir } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'token-server-test-'));
  await mkdir(join(root, 'public', 'assets'), { recursive: true });
  await writeFile(join(root, 'public', 'index.html'), '<!doctype html><title>Test</title>');
  if (staticDir) await cp(staticDir, join(root, 'dist'), { recursive: true });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [resolve('src/server.mjs')], {
    cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DB_DRIVER: 'sqlite', DB_PATH: join(root, 'usage.sqlite'),
      DATABASE_URL: '', SUBSCRIPTION_QUOTA_ENABLED: 'false', SCHEDULED_COLLECT_ENABLED: 'false', TZ: 'UTC', DISPLAY_TZ: 'Asia/Shanghai', ...options },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; child.stderr.on('data', chunk => { log += chunk; });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  };
  try { await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${log}`)), 10_000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('AI Token Dashboard:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${log}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  }); } catch (error) { await close(); throw error; }
  const base = `http://127.0.0.1:${port}`;
  return { root, base, child,
    ingest: async (payload, token = options.INGEST_TOKEN || options.DASHBOARD_TOKEN) => {
      const response = await fetch(`${base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
      return { status: response.status, data: await response.json() };
    },
    close
  };
}

export const usage = (overrides = {}) => ({ device: 'laptop', source: 'Codex CLI', usageDate: '2026-09-01', model: 'test-model', inputTokens: 100, outputTokens: 10, totalTokens: 110, costUSD: 1, ...overrides });
export const event = (overrides = {}) => ({ ...usage(), eventKey: 'a', eventTime: '2026-09-01T00:00:00.000Z', projectPath: '/project/A', sessionId: 'session-a', ...overrides });
