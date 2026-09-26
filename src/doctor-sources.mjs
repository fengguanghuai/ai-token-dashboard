// Use the collectors' path resolvers, but never invoke collect/parse/cache code.
import { join, basename } from 'node:path';
import { configuredPaths, expandPath } from './collector-config.mjs';
import * as claude from './collectors/claude-code.mjs';
import * as codex from './collectors/codex.mjs';
import * as hermes from './collectors/hermes.mjs';
import * as opencode from './collectors/opencode.mjs';
import * as gemini from './collectors/gemini.mjs';
import * as openclaw from './collectors/openclaw.mjs';
import * as grok from './collectors/grok.mjs';
import * as dsh from './collectors/dsh.mjs';
import * as pi from './collectors/pi.mjs';

export const sourceKeys = new Map([claude, codex, hermes, opencode, gemini, openclaw, grok, dsh, pi]
  .map(source => [source.SOURCE_LABEL, source.CLIENT_KEY]));

export function sourceChecks() {
  const directory = (path, match, maxDepth) => ({ path, match, maxDepth, kind: 'directory' });
  const file = path => ({ path, kind: 'file' });
  const jsonl = name => name.endsWith('.jsonl');
  const source = (module, roots) => ({ key: module.CLIENT_KEY, label: module.SOURCE_LABEL, roots: roots.filter(root => root.path) });
  const extraOpenCode = [expandPath(process.env.OPENCODE_DB), ...configuredPaths('opencode', 'extraDbPaths')].filter(Boolean);
  return [
    source(claude, [
      ...claude.getClaudeRoots().flatMap(root => ['projects', 'transcripts'].map(sub => directory(join(root, sub), jsonl))),
      directory(claude.getDesktopBase(), jsonl)
    ]),
    source(codex, [...codex.getSessionRoots(), ...codex.getHeadlessRoots()].map(path => directory(path, jsonl))),
    source(hermes, [file(hermes.getDbPath())]),
    source(opencode, [directory(opencode.opencodeDataDir(), opencode.isOpenCodeDbFilename, 0),
      directory(opencode.legacyMessageDir(), name => name.endsWith('.json')),
      ...extraOpenCode.map(path => ({ ...file(path), invalid: !opencode.isOpenCodeDbFilename(basename(path)) }))]),
    source(gemini, [directory(gemini.getTmpDir(), name => /^session-.*\.jsonl?$/.test(name))]),
    source(openclaw, openclaw.getAgentRoots().map(path => directory(path, name => /\.(jsonl(?:\.gz|\.zstd)?|db)$/.test(name)))),
    source(grok, grok.getSessionRoots().map(path => directory(path, name => name === 'updates.jsonl'))),
    source(dsh, dsh.getSessionRoots().map(path => directory(path, name => /^session\.jsonl(?:\.zstd)?$/.test(name)))),
    source(pi, pi.sessionRoots().map(path => directory(path, jsonl)))
  ];
}
