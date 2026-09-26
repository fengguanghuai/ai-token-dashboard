import { supportedNode, runChecks } from './doctor-checks.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const checks = [];
const add = (id, status, message, action, details) => checks.push({ id, status, message, ...(action ? { action } : {}), ...(details ? { details } : {}) });
let device;
let usageError = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') continue;
  if (args[i] === '--device' && args[i + 1] && !args[i + 1].startsWith('--')) { device = args[++i]; continue; }
  if (args[i] === '--help') {
    console.log('Usage: npm run doctor -- [--json] [--device <name>]\nRead-only diagnostics; does not collect, initialize schemas, or stop processes.');
    process.exit(0);
  }
  usageError = true;
}
if (usageError) add('arguments', 'error', '不支持的参数或缺少设备名称。', '使用 --help 查看参数。');
else if (!supportedNode(process.versions.node)) add('runtime', 'error', `Node ${process.versions.node} 不受支持。`, '安装 Node >=22.15.0，推荐使用 Node 22 LTS 最新补丁版本。');
else {
  add('runtime', 'ok', `Node ${process.versions.node} 满足版本要求。`);
  try {
    await import('./load-env.mjs');
    await runChecks(add, { device });
  } catch {
    add('doctor', 'error', '诊断未完成。', '检查 .env 读取权限、Node 内置 SQLite 支持及项目文件完整性；运行 npm ci 后重试。');
  }
}
const summary = Object.fromEntries(['ok', 'warn', 'error'].map(status => [status, checks.filter(check => check.status === status).length]));
const report = { version: 1, summary, checks };
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log('AI Token Dashboard · Doctor\n只检查环境、文件元数据及已有数据库；候选文件不代表有效用量，上次采集记录不代表本次采集成功。\n');
  for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}${check.action ? `\n  → ${check.action}` : ''}`);
  console.log(`\n${summary.ok} 通过 / ${summary.warn} 提示 / ${summary.error} 错误。`);
}
process.exitCode = usageError ? 2 : summary.error ? 1 : 0;
