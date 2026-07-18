const STORAGE_KEY = 'ts-theme';

export function resolveTheme(stored) {
  return stored === 'dark' ? 'dark' : 'light';
}

export function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  const theme = resolveTheme(stored);
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
}

export function chartVars() {
  const styles = getComputedStyle(document.documentElement);
  const v = name => styles.getPropertyValue(name).trim();
  return {
    text: v('--text'),
    muted: v('--muted'),
    border: v('--border'),
    surface: v('--surface'),
    accent: v('--accent'),
    grid: v('--chart-grid'),
    tooltipBg: v('--tooltip-bg')
  };
}
