/**
 * Live subscription-window quota (opt-in, network).
 *
 * Unlike the local-log collectors, this reaches out to the vendors' own
 * (undocumented) usage endpoints using the OAuth token the official CLIs
 * already stored locally, and returns the rolling-window utilization the
 * clients show — e.g. Claude's 5-hour / 7-day windows. It is point-in-time
 * state, not historical token data, so it is never written to SQLite.
 *
 * The stored access token is short-lived. When it is at/near expiry, or when a
 * usage call comes back 401/403, we exchange the long-lived refresh token for a
 * fresh access token (standard OAuth refresh_token grant) and persist it back
 * to the same credential store, so a stale access token never looks like a
 * logged-out session.
 *
 * Endpoints (same ones the official clients use):
 *   Claude:  GET  https://api.anthropic.com/api/oauth/usage   (anthropic-beta: oauth-2025-04-20)
 *            POST https://console.anthropic.com/v1/oauth/token (refresh)
 *   Codex:   GET  https://chatgpt.com/backend-api/wham/usage   (User-Agent: codex-cli)
 *            POST https://auth.openai.com/oauth/token           (refresh)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const KNOWN_TIERS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

// Public OAuth client identifiers the official CLIs ship with (needed for refresh).
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// Refresh once the access token is within this margin of its expiry.
const REFRESH_SKEW_MS = 60_000;

// ─── Account-identity helpers (used to label which login each card belongs to) ───
function decodeJwtPayload(jwt) {
  try {
    const seg = String(jwt).split('.');
    if (seg.length < 2) return null;
    return JSON.parse(Buffer.from(seg[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Mask locally so the raw address never leaves the box (e.g. someone@example.com → some***@example.com).
function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at <= 0) return null;
  const head = email.slice(0, Math.min(4, at));
  return `${head}***@${email.slice(at + 1)}`;
}

function titlePlan(plan) {
  if (typeof plan !== 'string' || !plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

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

// Standard OAuth refresh_token grant; returns the parsed token response or null.
async function postOAuthToken(url, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json && json.access_token ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Claude credentials: macOS Keychain → ~/.claude/.credentials.json ───
function readKeychainAccount() {
  try {
    const dump = execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = dump.match(/"acct"<blob>="([^"]*)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function readClaudeCreds() {
  if (platform() === 'darwin') {
    try {
      const json = execFileSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const creds = parseClaudeJson(json);
      if (creds) {
        creds.source = { kind: 'keychain', account: readKeychainAccount() };
        return creds;
      }
    } catch { /* not in keychain — fall through to file */ }
  }
  try {
    const path = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
    const creds = parseClaudeJson(readFileSync(path, 'utf8'));
    if (creds) creds.source = { kind: 'file', path };
    return creds;
  } catch {
    return null;
  }
}

function parseClaudeJson(text) {
  try {
    const o = JSON.parse(text);
    const oauth = o?.claudeAiOauth || o || {};
    const token = oauth.accessToken || o?.accessToken || null;
    if (!token) return null;
    const expiresAtMs = Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null;
    return {
      raw: o,
      token,
      refreshToken: oauth.refreshToken || o?.refreshToken || null,
      plan: titlePlan(oauth.subscriptionType),
      expiresAtMs,
      expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null
    };
  } catch {
    return null;
  }
}

// Persist a refreshed token back to whichever store it came from (best-effort).
function writeClaudeCreds(creds, fresh) {
  const prev = creds.raw || {};
  const nested = prev.claudeAiOauth && typeof prev.claudeAiOauth === 'object';
  const base = nested ? prev.claudeAiOauth : prev;
  const oauth = {
    ...base,
    accessToken: fresh.token,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAtMs
  };
  const out = nested ? { ...prev, claudeAiOauth: oauth } : oauth;
  const json = JSON.stringify(out);
  if (creds.source?.kind === 'keychain' && creds.source.account) {
    execFileSync('security',
      ['add-generic-password', '-U', '-a', creds.source.account, '-s', 'Claude Code-credentials', '-w', json],
      { stdio: 'ignore' });
  } else if (creds.source?.kind === 'file') {
    writeFileSync(creds.source.path, json, { mode: 0o600 });
  }
}

async function refreshClaude(creds) {
  if (!creds.refreshToken) return null;
  const res = await postOAuthToken(CLAUDE_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: CLAUDE_CLIENT_ID
  });
  if (!res) return null;
  const expiresAtMs = Number(res.expires_in) ? Date.now() + Number(res.expires_in) * 1000 : creds.expiresAtMs;
  const updated = {
    ...creds,
    token: res.access_token,
    refreshToken: res.refresh_token || creds.refreshToken,
    expiresAtMs,
    expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : creds.expiresAt
  };
  try { writeClaudeCreds(creds, updated); } catch { /* keep using the in-memory token */ }
  return updated;
}

// The OAuth token carries no profile, but Claude Code stores the signed-in
// account (email / display name) in ~/.claude.json under `oauthAccount`.
function readClaudeProfile() {
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  candidates.push(join(homedir(), '.claude.json'));
  for (const path of candidates) {
    try {
      const a = JSON.parse(readFileSync(path, 'utf8'))?.oauthAccount;
      if (a && typeof a === 'object') {
        return {
          email: maskEmail(a.emailAddress),
          name: typeof a.displayName === 'string' ? a.displayName : null
        };
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

// ─── Codex credentials: ~/.codex/auth.json ───
function readCodexAuth() {
  try {
    const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    const o = JSON.parse(readFileSync(path, 'utf8'));
    const t = o?.tokens || {};
    const token = t.access_token || o?.access_token || null;
    if (!token) return null;
    return {
      raw: o,
      path,
      token,
      refreshToken: t.refresh_token || o?.refresh_token || null,
      accountId: t.account_id || o?.account_id || null,
      idToken: t.id_token || null
    };
  } catch {
    return null;
  }
}

function writeCodexAuth(auth, fresh) {
  const prev = auth.raw || {};
  const tokens = {
    ...(prev.tokens || {}),
    access_token: fresh.token,
    refresh_token: fresh.refreshToken,
    id_token: fresh.idToken,
    account_id: fresh.accountId
  };
  const out = { ...prev, tokens, last_refresh: new Date().toISOString() };
  writeFileSync(auth.path, JSON.stringify(out, null, 2), { mode: 0o600 });
}

async function refreshCodex(auth) {
  if (!auth.refreshToken) return null;
  const res = await postOAuthToken(CODEX_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: 'openid profile email'
  });
  if (!res) return null;
  const updated = {
    ...auth,
    token: res.access_token,
    refreshToken: res.refresh_token || auth.refreshToken,
    idToken: res.id_token || auth.idToken
  };
  try { writeCodexAuth(auth, updated); } catch { /* keep using the in-memory token */ }
  return updated;
}

// Pull the account profile out of Codex's id_token (a JWT) for the card + detail panel.
function codexAccount(idToken) {
  const p = decodeJwtPayload(idToken);
  if (!p) return null;
  const a = p['https://api.openai.com/auth'] || {};
  const account = {
    email: maskEmail(p.email),
    name: typeof p.name === 'string' ? p.name : null,
    plan: titlePlan(a.chatgpt_plan_type),
    planUntil: a.chatgpt_subscription_active_until || null
  };
  return Object.values(account).some(Boolean) ? account : null;
}

function windowSecondsToTier(secs) {
  if (secs === 18000) return 'five_hour';
  if (secs === 604800) return 'seven_day';
  const hours = Math.floor(secs / 3600);
  return hours >= 24 ? `${Math.floor(hours / 24)}_day` : `${hours}_hour`;
}

function claudeHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    accept: 'application/json'
  };
}

async function queryClaude() {
  let creds = readClaudeCreds();
  if (!creds) return { ok: false, status: 'no_credentials', message: '未找到 Claude 登录凭据' };
  const profile = readClaudeProfile() || {};

  // Proactive: refresh before calling when the access token is at/near expiry.
  if (creds.refreshToken && creds.expiresAtMs && creds.expiresAtMs - Date.now() < REFRESH_SKEW_MS) {
    creds = (await refreshClaude(creds)) || creds;
  }

  let { status, body } = await fetchJson('https://api.anthropic.com/api/oauth/usage', claudeHeaders(creds.token));

  // Reactive: a still-rejected token but a live refresh token → refresh once and retry.
  if ((status === 401 || status === 403) && creds.refreshToken) {
    const refreshed = await refreshClaude(creds);
    if (refreshed) {
      creds = refreshed;
      ({ status, body } = await fetchJson('https://api.anthropic.com/api/oauth/usage', claudeHeaders(creds.token)));
    }
  }

  const fields = { email: profile.email || null, name: profile.name || null, plan: creds.plan, expiresAt: creds.expiresAt };
  const account = Object.values(fields).some(Boolean) ? fields : null;

  if (status === 401 || status === 403) return { ok: false, status: 'expired', message: '登录已过期，请重新登录 Claude', account };
  if (status !== 200 || typeof body !== 'object') {
    return { ok: false, status: 'error', message: `HTTP ${status}`, account };
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

  return { ok: true, windows, extra, account };
}

function codexHeaders(auth) {
  const headers = { authorization: `Bearer ${auth.token}`, 'user-agent': 'codex-cli', accept: 'application/json' };
  if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
  return headers;
}

async function queryCodex() {
  let auth = readCodexAuth();
  if (!auth) return { ok: false, status: 'no_credentials', message: '未找到 Codex 登录凭据' };

  // Proactive: the access token is a JWT — refresh before calling if its exp is near.
  const exp = decodeJwtPayload(auth.token)?.exp;
  if (auth.refreshToken && exp && exp * 1000 - Date.now() < REFRESH_SKEW_MS) {
    auth = (await refreshCodex(auth)) || auth;
  }

  let { status, body } = await fetchJson('https://chatgpt.com/backend-api/wham/usage', codexHeaders(auth));

  // Reactive: refresh once and retry on rejection.
  if ((status === 401 || status === 403) && auth.refreshToken) {
    const refreshed = await refreshCodex(auth);
    if (refreshed) {
      auth = refreshed;
      ({ status, body } = await fetchJson('https://chatgpt.com/backend-api/wham/usage', codexHeaders(auth)));
    }
  }

  const account = codexAccount(auth.idToken);

  if (status === 401 || status === 403) return { ok: false, status: 'expired', message: '登录已过期，请重新登录 Codex', account };
  if (status !== 200 || typeof body !== 'object') {
    return { ok: false, status: 'error', message: `HTTP ${status}`, account };
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
  return { ok: true, windows, account };
}

export async function queryQuota() {
  const [claude, codex] = await Promise.all([
    queryClaude().catch(e => ({ ok: false, status: 'error', message: e.message })),
    queryCodex().catch(e => ({ ok: false, status: 'error', message: e.message }))
  ]);
  return { claude, codex, fetchedAt: new Date().toISOString() };
}
