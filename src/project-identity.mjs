// Collectors sometimes use a session ID as a workspace fallback. That identity
// remains useful for deduplication, but does not establish a project directory.
export function projectPath(value) {
  return typeof value === 'string' && /^(?:\/|[A-Za-z]:[\\/]|~\/)/.test(value) ? value : null;
}
