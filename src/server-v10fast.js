import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import http from 'node:http';
import { openAsBlob } from 'node:fs';

const publicPort = Number(process.env.PORT || 3000);
const litePort = publicPort + 1;
const stablePort = publicPort + 2;
const fastPort = publicPort + 3;
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));

// Start the unchanged V10 Lite stack on a private port. It starts the proven
// stable server.js one port above itself, so we keep that as an automatic fallback.
const previousPort = process.env.PORT;
process.env.PORT = String(litePort);
await import('./server-v10lite.js');
process.env.PORT = String(fastPort);
await import('./server-fastcore.js');
if (previousPort === undefined) delete process.env.PORT;
else process.env.PORT = previousPort;

const liteBase = `http://127.0.0.1:${litePort}`;
const fastBase = `http://127.0.0.1:${fastPort}`;
const app = express();
app.disable('x-powered-by');

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxDemoMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => path.extname(file.originalname).toLowerCase() === '.dem'
    ? cb(null, true)
    : cb(new Error('Можно загружать только файлы .dem')),
});

const arr = (v) => Array.isArray(v) ? v : [];
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;

function episodeFromDeath(e) {
  if (!e?.victim || !num(e.tick)) return null;
  const reasons = [];
  let score = 0;
  if (e.repeekLike) { score += 4; reasons.push('REPEEK*'); }
  if (e.victimWidePeekLike) { score += 3; reasons.push('WIDE*'); }
  if (e.flashed === true) { score += 2; reasons.push('FLASH'); }
  if (Number.isFinite(Number(e.nearestTeammateDistance)) && Number(e.nearestTeammateDistance) > 900) {
    score += 2;
    reasons.push('FAR FROM TRADE*');
  }
  return {
    id: `${num(e.round)}-${num(e.tick)}-${e.victim}`,
    round: num(e.round),
    tick: num(e.tick),
    t: Number.isFinite(Number(e.secondsIntoRound)) ? Number(e.secondsIntoRound) : null,
    player: e.victim,
    attacker: e.attacker || '',
    weapon: e.weapon || '',
    reasons: reasons.length ? reasons : ['DEATH REVIEW'],
    score,
    critical: score >= 3,
    severity: score >= 7 ? 'critical' : score >= 5 ? 'high' : score >= 3 ? 'medium' : 'review',
    heuristic: score > 0,
  };
}

function enrichEpisodes(base) {
  const replayEpisodes = arr(base?.timeline)
    .map(episodeFromDeath)
    .filter(Boolean)
    .sort((a, b) => a.round - b.round || num(a.t, 999) - num(b.t, 999) || a.tick - b.tick);
  const criticalEpisodes = replayEpisodes
    .filter((e) => e.critical)
    .sort((a, b) => b.score - a.score || a.round - b.round)
    .slice(0, 24);
  return {
    ...base,
    replayEpisodes,
    criticalEpisodes,
    build: 'v10-lite-4.4.0-fast-core',
    dataAvailability: {
      ...(base?.dataAvailability || {}),
      replayEpisodes: replayEpisodes.length > 0,
      criticalEpisodes: criticalEpisodes.length > 0,
      episodeReplayLite: true,
      episodeCoachLite: true,
      fullMatchReplay: false,
    },
  };
}

async function sendDemo(baseUrl, file) {
  const form = new FormData();
  form.append('demo', await openAsBlob(file.path, { type: 'application/octet-stream' }), file.originalname);
  const response = await fetch(`${baseUrl}/api/analyze`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

app.get('/api/health', async (_req, res) => {
  try {
    const [fast, lite] = await Promise.allSettled([
      fetch(`${fastBase}/api/health`).then((r) => r.json()),
      fetch(`${liteBase}/api/health`).then((r) => r.json()),
    ]);
    const fastData = fast.status === 'fulfilled' ? fast.value : null;
    const liteData = lite.status === 'fulfilled' ? lite.value : null;
    res.json({
      ...(liteData || {}),
      ok: Boolean(fastData?.ok || liteData?.ok),
      build: 'v10-lite-4.4.0-fast-core',
      fastCore: Boolean(fastData?.ok),
      stableFallback: Boolean(liteData?.ok),
      ports: { public: publicPort, fastCore: fastPort, lite: litePort, stable: stablePort },
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  const totalStart = Date.now();
  try {
    let primaryError = null;
    try {
      const fast = await sendDemo(fastBase, req.file);
      if (fast.response.ok) {
        const result = enrichEpisodes(fast.data);
        result.parsePerformance = {
          ...(fast.data?.parsePerformance || {}),
          wrapperElapsedMs: Date.now() - totalStart,
          fallbackUsed: false,
        };
        return res.json(result);
      }
      primaryError = new Error(fast.data?.details || fast.data?.error || `Fast Core HTTP ${fast.response.status}`);
    } catch (error) {
      primaryError = error;
    }

    console.warn('[V10 4.4] Fast Core failed, retrying proven stable parser:', primaryError?.message || primaryError);
    const stable = await sendDemo(liteBase, req.file);
    if (!stable.response.ok) {
      return res.status(stable.response.status || 422).json({
        ...stable.data,
        fastCoreError: primaryError?.message || String(primaryError || ''),
      });
    }
    return res.json({
      ...stable.data,
      build: 'v10-lite-4.4.0-stable-fallback',
      parsePerformance: {
        ...(stable.data?.parsePerformance || {}),
        wrapperElapsedMs: Date.now() - totalStart,
        fallbackUsed: true,
        fastCoreError: primaryError?.message || String(primaryError || ''),
      },
    });
  } catch (error) {
    console.error('[V10 4.4 analyze]', error);
    res.status(422).json({ error: error?.message || 'Не удалось разобрать демку' });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

function proxyToLite(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${litePort}` };
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: litePort,
    method: req.method,
    path: req.originalUrl || req.url,
    headers,
  }, (upstreamRes) => {
    res.statusCode = upstreamRes.statusCode || 502;
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value !== undefined) res.setHeader(key, value);
    }
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) res.status(502).json({ error: `V10 Lite internal недоступен: ${error.message}` });
    else res.end();
  });
  req.pipe(upstream);
}

// Everything except the initial heavy /api/analyze request remains byte-for-byte
// on the already proven V10 Lite implementation (static UI, episode replay, coach, AI).
app.use(proxyToLite);

app.use((error, _req, res, _next) => {
  console.error('[V10 4.4]', error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Демка слишком большая. Лимит: ${maxDemoMb} MB.` });
  }
  res.status(400).json({ error: error?.message || 'Ошибка запроса' });
});

app.listen(publicPort, '127.0.0.1', () => {
  console.log(`CS2 Demo AI Analyzer V10 Lite 4.4 Fast Core: http://localhost:${publicPort}`);
  console.log(`Fast Core primary: ${fastBase}`);
  console.log(`V10 Lite internal: ${liteBase}`);
  console.log(`Stable parser fallback: http://127.0.0.1:${stablePort}`);
  console.log('Initial analysis: one combined parseTicks pass when supported; stable fallback is automatic.');
});
