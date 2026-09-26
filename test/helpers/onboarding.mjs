import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function onboardingFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-onboarding-'));
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  const missing = join(root, 'missing');
  const config = join(root, 'collectors.json');
  writeFileSync(config, JSON.stringify({ collectors: {
    claude: { roots: [missing], includeDesktopLocalAgent: false },
    codex: { homes: [missing], headlessRoots: [] }, hermes: { dbPath: join(missing, 'state.db') },
    opencode: { dataDir: missing, extraDbPaths: [] }, gemini: { tmpDir: missing },
    openclaw: { agentRoots: [missing] }, grok: { roots: [missing] }, dsh: { roots: [missing] }, pi: { roots: [sessions] }
  } }));
  const dbPath = join(root, 'usage.sqlite');
  const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    AI_TOKEN_DASHBOARD_CONFIG: config, AI_TOKEN_DASHBOARD_CACHE_DIR: join(root, 'cache'),
    DB_PATH: dbPath, DB_DRIVER: 'sqlite', DATABASE_URL: '', DISPLAY_TZ: 'UTC',
    HOST: '127.0.0.1', SUBSCRIPTION_QUOTA_ENABLED: 'false', SCHEDULED_COLLECT_ENABLED: 'false' };
  return { root, sessions, config, dbPath, env,
    run: (script, args = [], overrides = {}) => spawnSync(process.execPath, [resolve(script), ...args], {
      cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30_000
    }),
    seed: () => writeFileSync(join(sessions, 'synthetic.jsonl'), [
      { type: 'session', version: 3, id: 'onboarding-session', cwd: '/synthetic/project' },
      { type: 'message', id: 'synthetic-message', timestamp: '2026-09-01T12:00:00.000Z', message: {
        role: 'assistant', model: 'test-model', usage: { input: 100, output: 10, cost: { total: 0.25 } }
      } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n'),
    close: () => rmSync(root, { recursive: true, force: true })
  };
}
