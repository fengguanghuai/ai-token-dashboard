import { access, stat, opendir, readFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { serverAccess } from './http-security.mjs';

export function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 15);
}

// Codes are allowlisted. Raw errors, paths, DSNs, messages and env values must
// never become part of the shareable report (including its JSON form).
export function errorCode(error) {
  return new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EADDRINUSE', 'EADDRNOTAVAIL',
    'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ERR_SQLITE_ERROR',
    '28P01', '3D000', '42P01', '42703', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR',
    'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']).has(error?.code) ? error.code : 'CHECK_FAILED';
}

export async function inspectRoot(root, { limit = 2000, budgetMs = 250 } = {}) {
  if (root.invalid) return { state: 'invalid', candidates: 0 };
  const result = { state: 'readable', candidates: 0, entries: 0, incomplete: false };
  const deadline = performance.now() + budgetMs;
  try {
    const info = await stat(root.path);
    if (root.kind === 'file') {
      if (!info.isFile()) return { state: 'invalid', candidates: 0 };
      await access(root.path, constants.R_OK);
      return { state: info.size ? 'readable' : 'empty', candidates: info.size ? 1 : 0 };
    }
    if (!info.isDirectory()) return { state: 'invalid', candidates: 0 };
    const pending = [{ path: root.path, depth: 0 }];
    while (pending.length) {
      const dir = pending.pop();
      await access(dir.path, constants.R_OK | constants.X_OK);
      const handle = await opendir(dir.path);
      for await (const entry of handle) {
        if (result.entries >= limit || performance.now() >= deadline) {
          result.incomplete = true;
          return result;
        }
        result.entries++;
        const path = join(dir.path, entry.name);
        if (entry.isDirectory() && dir.depth < (root.maxDepth ?? 32)) pending.push({ path, depth: dir.depth + 1 });
        else if (entry.isDirectory() && root.maxDepth === undefined) result.incomplete = true;
        else if (entry.isFile() && root.match(entry.name)) {
          await access(path, constants.R_OK);
          result.candidates++;
        } else if (entry.isSymbolicLink()) result.incomplete = true;
      }
    }
    if (!result.entries) result.state = 'empty';
    return result;
  } catch (error) {
    return { ...result, state: error.code === 'ENOENT' ? 'missing' : 'unreadable', code: errorCode(error) };
  }
}

export async function checkConfig(add) {
  let config;
  try {
    config = JSON.parse(await readFile(process.env.AI_TOKEN_DASHBOARD_CONFIG || resolve('config/collectors.json'), 'utf8'));
  } catch (error) {
    const optional = error.code === 'ENOENT' && !process.env.AI_TOKEN_DASHBOARD_CONFIG;
    add('config', optional ? 'warn' : 'error', optional ? '采集配置缺失，部分来源不会启用。' : '采集配置无法读取或不是有效 JSON。',
      '检查 config/collectors.json 或 AI_TOKEN_DASHBOARD_CONFIG。');
    return false;
  }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const arrayKeys = new Set(['roots', 'homes', 'headlessRoots', 'agentRoots', 'extraDbPaths', 'sessionSubdirs']);
  const pathKeys = new Set(['dbPath', 'dataDir', 'tmpDir', 'desktopLocalAgentBase']);
  let valid = object(config) && object(config.collectors);
  for (const value of Object.values(valid ? config.collectors : {})) {
    if (!object(value)) { valid = false; break; }
    for (const [key, item] of Object.entries(value)) {
      if (arrayKeys.has(key) && (!Array.isArray(item) || !item.every(path => typeof path === 'string' && path.trim()))) valid = false;
      if (pathKeys.has(key) && (typeof item !== 'string' || !item.trim())) valid = false;
      if (key === 'includeDesktopLocalAgent' && typeof item !== 'boolean') valid = false;
    }
  }
  add('config', valid ? 'ok' : 'error', valid ? '采集配置格式有效。' : '采集配置字段类型不正确。',
    valid ? undefined : '路径列表必须是字符串数组，单一路径必须是非空字符串。');
  return valid;
}

export async function checkDatabase(add, { device = hostname(), input } = {}) {
  const { resolveDbConfig, openDb } = await import('./db.mjs');
  let config, db;
  try { config = resolveDbConfig(input); }
  catch { add('database', 'error', '数据库配置无效。', '检查 DATABASE_URL 协议、转义和 DB_DRIVER；不要把连接串贴到 Issue。'); return; }
  if (config.driver === 'sqlite') {
    try {
      const info = await stat(config.path);
      if (!info.isFile()) throw new Error('not a file');
      await access(config.path, constants.R_OK);
    } catch (error) {
      add('database', error.code === 'ENOENT' ? 'warn' : 'error',
        error.code === 'ENOENT' ? 'SQLite 数据库尚未创建。' : 'SQLite 数据库不可读取。',
        error.code === 'ENOENT' ? '首次使用运行 npm run db:init。' : '检查 DB_PATH 及文件读取权限。');
      return;
    }
  }
  try {
    db = await openDb(config, { readOnly: true });
    await db.get('SELECT 1 AS ok');
    add('database.connection', 'ok', `${config.driver} 只读连接成功。`);
    // Probe required columns without schema initialization or full-table scans.
    const columns = {
      daily_usage: 'device, source, usage_date, model, total_tokens, cost_usd, cost_basis, pricing_version',
      time_usage: 'device, source, event_key, event_time, project_path, session_id, cost_basis, pricing_version',
      session_usage: 'device, source, session_id, total_tokens, cost_usd',
      collection_runs: 'id, device, source, status, collected_at',
      collection_checkpoints: 'scope_key, state_json'
    };
    for (const [table, fields] of Object.entries(columns)) await db.all(`SELECT ${fields} FROM ${table} LIMIT 0`);
    add('database.schema', 'ok', '用量表及关键字段存在。');
    const runs = await db.all(`SELECT r.source, r.status, r.collected_at FROM collection_runs r
      JOIN (SELECT source, MAX(id) AS id FROM collection_runs WHERE device = ? GROUP BY source) latest ON r.id = latest.id`, [device]);
    const { sourceKeys: known } = await import('./doctor-sources.mjs');
    let count = 0;
    for (const run of runs) {
      if (!known.has(run.source)) continue;
      count++;
      const status = ['ok', 'empty', 'error'].includes(run.status) ? run.status : 'unknown';
      const date = new Date(run.collected_at);
      const time = Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
      add(`collection.${known.get(run.source)}`, status === 'ok' ? 'ok' : 'warn',
        `${run.source} 上次记录：${status}（${time}）。`,
        status === 'error' ? '检查对应来源路径后，重新运行 npm run collect。' : undefined);
    }
    if (!count) add('collection', 'warn', '此设备还没有已知来源的采集记录。', '运行 npm run collect；自定义设备名可用 doctor --device <名称> 检查。');
  } catch (error) {
    const schema = ['42P01', '42703', 'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ERR_SQLITE_ERROR'].includes(error.code);
    add('database', 'error', `数据库检查失败（${errorCode(error)}）。`, schema
      ? '检查数据库文件或表结构；已有数据先备份，再运行 npm run db:init。'
      : '检查数据库地址、网络、凭据和连接权限。');
  } finally { if (db) await db.close(); }
}

export async function checkPort(host, port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', error => resolve(error.code === 'EADDRINUSE' ? 'busy' : errorCode(error)));
    server.listen(port, host, () => server.close(() => resolve('free')));
  });
}

export async function runChecks(add, options) {
  const require = createRequire(import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const missing = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(name => {
    try { require.resolve(name); return false; } catch { return true; }
  });
  add('dependencies', missing.length ? 'error' : 'ok', missing.length ? `缺少依赖：${missing.join(', ')}。` : '项目依赖可解析。', missing.length ? '在项目目录运行 npm ci。' : undefined);
  const validConfig = await checkConfig(add);
  try {
    const zone = process.env.DISPLAY_TZ?.trim();
    if (zone && !/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(zone)) throw new Error('invalid');
    new Intl.DateTimeFormat('en', zone ? { timeZone: zone } : {});
    add('timezone', 'ok', '展示时区有效。');
  } catch { add('timezone', 'error', 'DISPLAY_TZ 无效，应用会退回 UTC。', '使用有效 IANA 时区，例如 Asia/Shanghai 或 UTC。'); }
  try { serverAccess(); add('access', 'ok', '监听地址与认证配置有效。'); }
  catch { add('access', 'error', '远程监听缺少访问令牌。', '本机使用 HOST=127.0.0.1；远程访问设置 DASHBOARD_TOKEN 或 INGEST_TOKEN。'); }
  const ports = [['API_PORT', 4173, process.env.HOST || '127.0.0.1'], ['CLIENT_PORT', 5173, '127.0.0.1']];
  if (process.env.PORT) ports.push(['PORT', 4173, process.env.HOST || '127.0.0.1']);
  if (Number(process.env.API_PORT || 4173) === Number(process.env.CLIENT_PORT || 5173)) add('ports', 'error', 'API_PORT 和 CLIENT_PORT 不能相同。', '为开发 API 和前端设置不同端口。');
  for (const [key, fallback, host] of ports) {
    const port = Number(process.env[key] || fallback);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { add(`port.${key}`, 'error', `${key} 无效。`, '端口必须是 1–65535 的整数。'); continue; }
    const state = await checkPort(host, port);
    add(`port.${key}`, state === 'free' ? 'ok' : state === 'busy' ? 'warn' : 'error',
      `${key}=${port}：${state === 'free' ? '可监听' : state === 'busy' ? '已被占用' : state}。`,
      state === 'busy' ? '若已有项目实例可直接使用；否则检查占用进程或更换端口。doctor 不会停止任何进程。' : undefined);
  }
  if (validConfig) {
    const { sourceChecks } = await import('./doctor-sources.mjs');
    for (const source of sourceChecks()) {
      const roots = [];
      for (const root of source.roots) roots.push(await inspectRoot(root));
      const bad = roots.some(root => ['invalid', 'unreadable'].includes(root.state));
      const found = roots.reduce((sum, root) => sum + root.candidates, 0);
      const incomplete = roots.some(root => root.incomplete);
      const counts = Object.fromEntries(['missing', 'empty', 'unreadable', 'invalid'].map(state => [state, roots.filter(root => root.state === state).length]));
      add(`source.${source.key}`, bad ? 'error' : !found || incomplete ? 'warn' : 'ok',
        `${source.label}：${roots.length} 个路径，${found} 个候选文件；不存在 ${counts.missing}，空 ${counts.empty}，不可读取 ${counts.unreadable}，无效 ${counts.invalid}${incomplete ? '（扫描未完成）' : ''}。`,
        bad || !found ? '检查 config/collectors.json 中该来源路径及环境变量覆盖；未使用的工具可忽略缺失提示。' : undefined,
        { roots });
    }
  }
  const zlib = await import('node:zlib');
  add('compression', typeof zlib.zstdDecompressSync === 'function' ? 'ok' : 'warn',
    typeof zlib.zstdDecompressSync === 'function' ? '支持 zstd 压缩日志。' : '运行时不支持 zstd，压缩日志会被跳过。',
    typeof zlib.zstdDecompressSync === 'function' ? undefined : '升级到当前 Node 22 LTS 补丁版本或更新的 LTS。');
  await checkDatabase(add, options);
  const staticDir = existsSync(resolve('dist')) ? 'dist' : 'public';
  try { await access(resolve(staticDir, 'index.html'), constants.R_OK); add('frontend', 'ok', '前端页面存在（未校验是否最新）。'); }
  catch { add('frontend', 'warn', '前端尚未构建，npm run serve 无法展示页面。', '运行 npm run build；开发模式可使用 npm run dev。'); }
}
