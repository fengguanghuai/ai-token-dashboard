import { createHash, timingSafeEqual } from 'node:crypto';

export function isLoopback(address = '') {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(address);
}

export function serverAccess(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const readToken = env.DASHBOARD_TOKEN || env.INGEST_TOKEN || '';
  const writeToken = env.INGEST_TOKEN || readToken;
  if (!isLoopback(host) && !readToken) {
    throw new Error('Remote access requires DASHBOARD_TOKEN or INGEST_TOKEN; use HOST=127.0.0.1 for local access.');
  }
  return { host, readToken, writeToken };
}

function matches(actual, expected) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

export function authorize(req, res, access, ingest = false) {
  const expected = ingest ? access.writeToken : access.readToken;
  if (!expected) return true;
  const authorization = req.headers.authorization || '';
  let actual = '';
  if (/^Bearer /i.test(authorization)) actual = authorization.slice(7).trim();
  if (/^Basic /i.test(authorization)) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) actual = decoded.slice(separator + 1);
  }
  if (matches(actual, expected)) return true;
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Basic realm="Token Studio", charset="UTF-8"',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify({ error: 'Authentication required' }));
  return false;
}

export function trustedRequest(req, access) {
  // Prevent a foreign website from reaching an unauthenticated local service
  // through DNS rebinding, form posts, or cross-origin fetches.
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, ''); }
  catch { return false; }
  if (isLoopback(access.host) && !access.readToken && !isLoopback(host)) return false;
  if (['GET', 'HEAD'].includes(req.method)) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return false; }
    catch { return false; }
  }
  return true;
}
