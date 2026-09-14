// Import the selected, locally tested MIT chart source and its dependency closure.
// No registry code is executed here. Existing destination files are not overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const source = path.resolve('examples/ui-showcase/src');
const target = path.resolve('src/client/vendor/bklit');
const seen = new Set();
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
    const spec = match[1];
    if (!spec.startsWith('.') && spec !== '@/lib/utils') continue;
    const base = spec === '@/lib/utils' ? path.join(source, 'lib/utils') : path.resolve(path.dirname(file), spec);
    const dependency = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map(ext => base + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!dependency || !dependency.startsWith(source + path.sep)) throw new Error(`Unresolved import ${spec}`);
    visit(dependency);
  }
}
for (const file of ['line-chart.tsx','line.tsx','grid.tsx','x-axis.tsx','tooltip/chart-tooltip.tsx']) visit(path.join(source, 'components/charts', file));
let patch = '*** Begin Patch\n';
for (const file of seen) {
  const rel = path.relative(source, file);
  const dest = path.join(target, rel);
  if (fs.existsSync(dest)) throw new Error(`Refusing to overwrite ${dest}`);
  let content = fs.readFileSync(file, 'utf8');
  let util = path.relative(path.dirname(file), path.join(source, 'lib/utils')).split(path.sep).join('/');
  if (!util.startsWith('.')) util = './' + util;
  content = content.replaceAll('@/lib/utils', util);
  patch += `*** Add File: ${dest}\n` + content.split('\n').map(line => '+' + line).join('\n') + '\n';
}
patch += '*** End Patch\n';
execFileSync('apply_patch', [], { input: patch, maxBuffer: 4 * 1024 * 1024 });
console.log(`Imported ${seen.size} Bklit source files.`);
