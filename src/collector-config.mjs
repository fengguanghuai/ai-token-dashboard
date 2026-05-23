import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

let cachedConfig;

export function loadCollectorConfig() {
  if (cachedConfig) return cachedConfig;

  const configPath = process.env.AI_TOKEN_DASHBOARD_CONFIG ||
    resolve(process.cwd(), 'config', 'collectors.json');

  try {
    cachedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    cachedConfig = { collectors: {} };
  }

  return cachedConfig;
}

export function collectorConfig(name) {
  return loadCollectorConfig().collectors?.[name] || {};
}

export function configuredPaths(name, key, fallback = []) {
  const value = collectorConfig(name)[key];
  const paths = Array.isArray(value) ? value : fallback;
  return paths
    .map((item) => expandPath(item))
    .filter(Boolean);
}

export function configuredPath(name, key, fallback = null) {
  const value = collectorConfig(name)[key] ?? fallback;
  return expandPath(value);
}

export function configuredBool(name, key, fallback = false) {
  const value = collectorConfig(name)[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function configuredStrings(name, key, fallback = []) {
  const value = collectorConfig(name)[key];
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : fallback;
}

export function envPathList(value, fallback = []) {
  const paths = String(value || '')
    .split(',')
    .map((item) => expandPath(item.trim()))
    .filter(Boolean);
  return paths.length ? paths : fallback;
}

export function existingPaths(paths) {
  return paths.filter((path) => existsSync(path));
}

export function expandPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  let expanded = value.trim();
  if (expanded === '~') {
    expanded = homedir();
  } else if (expanded.startsWith('~/')) {
    expanded = `${homedir()}${expanded.slice(1)}`;
  }

  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    return process.env[name] || '';
  });
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    return process.env[name] || '';
  });

  return expanded;
}
