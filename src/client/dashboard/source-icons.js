/* Brand icons per source, bundled as assets and keyed by the collector's label. */
import claude from './icons/claude.svg';
import gpt from './icons/gpt.svg';
import hermes from './icons/hermes.svg';
import gemini from './icons/gemini.svg';
import opencode from './icons/opencode.svg';
import openclaw from './icons/openclaw.svg';

const SOURCE_ICON = {
  'Claude Code': claude,
  'Codex CLI': gpt,
  'Hermes Agent': hermes,
  'Gemini CLI': gemini,
  'OpenCode': opencode,
  'OpenClaw': openclaw
};

/** Resolve a source label (tolerating a "(JS)" suffix) to its brand icon URL. */
export function sourceIcon(source) {
  if (!source) return null;
  return SOURCE_ICON[source] || SOURCE_ICON[String(source).replace(/\s*\(JS\)$/, '')] || null;
}
