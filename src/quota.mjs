/**
 * Live subscription-window quota (opt-in, network).
 *
 * Unlike the local-log collectors, this reaches out to the vendors' own
 * (undocumented) usage endpoints using the OAuth token the official CLIs
 * already stored locally, and returns the rolling-window utilization the
 * clients show — e.g. Claude's 5-hour / 7-day windows. It is point-in-time
 * state, not historical token data, so it is never written to SQLite.
 *
 * Endpoints (same ones the official clients use):
 *   Claude:  GET https://api.anthropic.com/api/oauth/usage   (anthropic-beta: oauth-2025-04-20)
 *   Codex:   GET https://chatgpt.com/backend-api/wham/usage   (User-Agent: codex-cli)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const KNOWN_TIERS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

async function fetchJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    return { status: res.status, body: res.ok ? await res.json() : await res.text().catch(() => '') };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Claude credentials: macOS Keychain → ~/.claude/.credentials.json ───
function readClaudeToken() {
  if (platform() === 'darwin') {
    try {
      const json = execFileSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const tok = parseClaudeJson(json);
      if (tok) return tok;
    } catch { /* not in keychain — fall through to file */ }
  }
  try {
    const path = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
    return parseClaudeJson(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function parseClaudeJson(text) {
  try {
    const o = JSON.parse(text);
    return o?.claudeAiOauth?.accessToken || o?.accessToken || null;
  } catch {
    return null;
  }
}

// ─── Codex credentials: ~/.codex/auth.json ───
function readCodexAuth() {
  try {
    const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    const o = JSON.parse(readFileSync(path, 'utf8'));
    const token = o?.tokens?.access_token || o?.access_token || null;
    const accountId = o?.tokens?.account_id || o?.account_id || null;
    return token ? { token, accountId } : null;
  } catch {
    return null;
  }
}

function windowSecondsToTier(secs) {
  if (secs === 18000) return 'five_hour';
  if (secs === 604800) return 'seven_day';
  const hours = Math.floor(secs / 3600);
  return hours >= 24 ? `${Math.floor(hours / 24)}_day` : `${hours}_hour`;
}

async function queryClaude() {
  const token = readClaudeToken();
  if (!token) return { ok: false, status: 'no_credentials', message: '未找到 Claude 登录凭据' };

  const { status, body } = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    accept: 'application/json'
  });
  if (status === 401 || status === 403) return { ok: false, status: 'expired', message: '登录已过期，请重新登录 Claude' };
  if (status !== 200 || typeof body !== 'object') {
    return { ok: false, status: 'error', message: `HTTP ${status}` };
  }

  const windows = [];
  for (const [key, w] of Object.entries(body)) {
    if (key === 'extra_usage' || !w || typeof w !== 'object') continue;
    if (typeof w.utilization !== 'number') continue;
    // Claude reports utilization as a 0–100 percentage; normalize to a 0–1 fraction.
    windows.push({ name: key, utilization: w.utilization / 100, resetsAt: w.resets_at || null });
  }
  windows.sort((a, b) => KNOWN_TIERS.indexOf(a.name) - KNOWN_TIERS.indexOf(b.name));

  const e = body.extra_usage;
  const extra = e && typeof e === 'object'
    ? { enabled: !!e.is_enabled, utilization: e.utilization ?? null, usedCredits: e.used_credits ?? null, monthlyLimit: e.monthly_limit ?? null, currency: e.currency ?? null }
    : null;

  return { ok: true, windows, extra };
}

async function queryCodex() {
  const auth = readCodexAuth();
  if (!auth) return { ok: false, status: 'no_credentials', message: '未找到 Codex 登录凭据' };

  const headers = { authorization: `Bearer ${auth.token}`, 'user-agent': 'codex-cli', accept: 'application/json' };
  if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;

  const { status, body } = await fetchJson('https://chatgpt.com/backend-api/wham/usage', headers);
  if (status === 401 || status === 403) return { ok: false, status: 'expired', message: '登录已过期，请重新登录 Codex' };
  if (status !== 200 || typeof body !== 'object') {
    return { ok: false, status: 'error', message: `HTTP ${status}` };
  }

  const windows = [];
  const rl = body.rate_limit || {};
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w || typeof w.used_percent !== 'number') continue;
    windows.push({
      name: w.limit_window_seconds ? windowSecondsToTier(w.limit_window_seconds) : 'unknown',
      utilization: w.used_percent / 100,
      resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null
    });
  }
  return { ok: true, windows };
}

export async function queryQuota() {
  const [claude, codex] = await Promise.all([
    queryClaude().catch(e => ({ ok: false, status: 'error', message: e.message })),
    queryCodex().catch(e => ({ ok: false, status: 'error', message: e.message }))
  ]);
  return { claude, codex, fetchedAt: new Date().toISOString() };
}
