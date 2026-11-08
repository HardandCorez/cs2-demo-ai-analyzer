// The analyzer is intended for localhost only. Disallow DNS rebinding and
// browser cross-origin requests, including requests from other local ports.
const HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/i;

export function requireLoopbackHost(req, res, next) {
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const matched = HOST_PATTERN.exec(hostHeader);
  if (!matched || (matched[2] && Number(matched[2]) > 65535)) {
    return res.status(403).json({ error: 'Недопустимый Host для локального API' });
  }

  const origin = String(req.headers.origin || '');
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return res.status(403).json({ error: 'Недопустимый Origin' });
    }
    const expectedOrigin = new URL(`http://${hostHeader}`).origin;
    if (parsed.protocol !== 'http:' || parsed.origin !== expectedOrigin ||
        parsed.username || parsed.password || parsed.pathname !== '/' ||
        parsed.search || parsed.hash) {
      return res.status(403).json({ error: 'Межсайтовые запросы к локальному API запрещены' });
    }
  }

  next();
}
