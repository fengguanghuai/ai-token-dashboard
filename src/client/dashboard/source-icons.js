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

// Some icons have a lot of internal padding / a non-square viewBox and read
// visually smaller; nudge them up so all the logos look the same weight.
const SOURCE_ICON_SCALE = { OpenClaw: 1.4 };

// Monochrome dark logos need inverting on dark surfaces.
const SOURCE_ICON_DARK_INVERT = new Set(['Codex CLI', 'Hermes Agent', 'OpenCode']);

function normalizeSource(source) {
  return String(source || '').replace(/\s*\(JS\)$/, '');
}

/** Resolve a source label (tolerating a "(JS)" suffix) to its brand icon URL. */
export function sourceIcon(source) {
  if (!source) return null;
  return SOURCE_ICON[source] || SOURCE_ICON[normalizeSource(source)] || null;
}

/** Per-source visual scale so logos read at a consistent size. */
export function sourceIconScale(source) {
  return SOURCE_ICON_SCALE[source] || SOURCE_ICON_SCALE[normalizeSource(source)] || 1;
}

/** Extra class for logos that must invert on the dark theme. */
export function sourceIconClass(source) {
  return SOURCE_ICON_DARK_INVERT.has(normalizeSource(source)) ? 'logo-invert-dark' : '';
}
