// Reject DNS rebinding and cross-site requests to the localhost-only analyzer.
const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);

export function requireLoopbackHost(req, res, next) {
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  if (!allowed.has(hostname)) {
    return res.status(403).json({ error: 'Недопустимый Host для локального API' });
  }

  const origin = String(req.headers.origin || '');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return res.status(403).json({ error: 'Недопустимый Origin' });
    }
    if (!allowed.has(originHost)) {
      return res.status(403).json({ error: 'Запросы с внешних сайтов запрещены' });
    }
  }
  next();
}
