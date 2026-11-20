// CS2 Demo AI Analyzer — unified server (5.0.0).
// Один процесс вместо бывшей цепочки server-v10fast → server-v10lite → server.js:
//   - /api/analyze: Fast Core in-process, при неудаче — автоматический stable fallback
//   - /api/episode-replay, /api/episode-coach: эпизоды + safe-default coach
//   - /api/ai: OpenAI direct или удалённый gateway
// Поведение ответов сохранено (parsePerformance, dataAvailability, replayEpisodes).

import 'dotenv/config';
import express from 'express';
import { requireLoopbackHost } from './security.js';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseDemoFast } from './demo/parse-fast.js';
import { parseDemoStable } from './demo/parse-stable.js';
import {
  buildReplayEpisodes, buildCriticalEpisodes,
  sampleTicks, parseEpisodeRows, normalizeFrames, buildEpisodeCoach, EPISODE_CONFIG,
} from './episodes.js';
import {
  aiRateLimit, compactMatchForAI, callOpenAIDirect, callAIGateway, getAIMode, isLocalGateway,
} from './ai.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const port = Number(process.env.PORT || 3000);
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));
const BUILD = '5.0.0-unified';

const app = express();
app.disable('x-powered-by');
app.use(requireLoopbackHost);
app.use(express.json({ limit: '4mb' }));
app.use(express.static(publicDir));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxDemoMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => path.extname(file.originalname).toLowerCase() === '.dem'
    ? cb(null, true)
    : cb(new Error('Можно загружать только файлы .dem')),
});

const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;

function enrichWithEpisodes(base, wrapperElapsedMs, fallbackUsed, fastCoreError) {
  const replayEpisodes = buildReplayEpisodes(base);
  const criticalEpisodes = buildCriticalEpisodes(replayEpisodes);
  return {
    ...base,
    replayEpisodes,
    criticalEpisodes,
    build: BUILD,
    dataAvailability: {
      ...(base?.dataAvailability || {}),
      replayEpisodes: replayEpisodes.length > 0,
      criticalEpisodes: criticalEpisodes.length > 0,
      episodeReplayLite: true,
      episodeCoachLite: true,
      fullMatchReplay: false,
    },
    parsePerformance: {
      ...(base?.parsePerformance || {}),
      wrapperElapsedMs,
      fallbackUsed,
      ...(fastCoreError ? { fastCoreError } : {}),
    },
  };
}

app.get('/api/health', (_req, res) => {
  const mode = getAIMode();
  res.json({
    ok: true,
    parser: '@laihoe/demoparser2',
    build: BUILD,
    aiConfigured: mode !== 'none',
    aiMode: mode,
    engines: { fastCore: true, stableFallback: true },
    episodeReplayLite: true,
    episodeCoachLite: true,
    fullMatchReplay: false,
  });
});

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  const totalStart = Date.now();
  try {
    let base = null;
    let fastCoreError = '';
    try {
      base = await parseDemoFast(req.file.path, req.file.originalname);
    } catch (error) {
      fastCoreError = String(error?.message || error);
      console.warn('[UNIFIED] Fast Core failed, retrying with stable parser:', fastCoreError);
      try {
        base = await parseDemoStable(req.file.path, req.file.originalname);
      } catch (stableError) {
        const message = String(stableError?.message || stableError || 'Unknown parser error');
        return res.status(422).json({
          error: 'Не удалось разобрать демку',
          details: message,
          fastCoreError,
          hint: message.includes('EntityNotFound')
            ? 'Эта версия демки может быть несовместима с текущей версией парсера. Обнови зависимости командой npm update и попробуй снова.'
            : 'Проверь, что это полноценная CS2 .dem, а не архив .dem.bz2/.zip.',
        });
      }
    }
    return res.json(enrichWithEpisodes(base, Date.now() - totalStart, Boolean(fastCoreError), fastCoreError));
  } catch (error) {
    console.error('[UNIFIED analyze]', error);
    return res.status(422).json({ error: error?.message || 'Не удалось разобрать демку' });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/episode-replay', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  const targetTick = Math.round(num(req.body?.tick));
  const round = Math.max(1, Math.round(num(req.body?.round, 1)));
  const beforeSec = Math.max(1, Math.min(6, num(req.body?.before, 4)));
  const afterSec = Math.max(1, Math.min(6, num(req.body?.after, 4)));
  if (!targetTick) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Не передан tick эпизода' });
  }

  const started = Date.now();
  try {
    const ticks = sampleTicks(targetTick, beforeSec, afterSec);
    const rows = parseEpisodeRows(req.file.path, ticks);
    const frames = normalizeFrames(rows, targetTick);
    if (!frames.length) return res.status(422).json({ error: 'Не удалось получить координаты для этого эпизода' });
    res.json({
      round,
      targetTick,
      tickRate: EPISODE_CONFIG.tickRate,
      sampleHz: EPISODE_CONFIG.replayHz,
      beforeSec,
      afterSec,
      frames,
      elapsedMs: Date.now() - started,
      note: 'Replay эпизода: только короткое окно вокруг выбранного события; WIDE/REPEEK остаются эвристиками.',
    });
  } catch (error) {
    console.error(error);
    res.status(422).json({ error: error?.message || 'Не удалось построить replay эпизода' });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/episode-coach', (req, res) => {
  const episode = req.body?.episode;
  const replay = req.body?.replay;
  if (!episode?.player || !Array.isArray(replay?.frames) || !replay.frames.length) {
    return res.status(400).json({ error: 'Нет данных выбранного эпизода/replay для coach-разбора' });
  }
  try {
    res.json(buildEpisodeCoach(episode, replay));
  } catch (error) {
    console.error(error);
    res.status(422).json({ error: error?.message || 'Не удалось построить разбор эпизода' });
  }
});

app.post('/api/ai', aiRateLimit, async (req, res) => {
  const match = req.body?.match;
  if (!match?.players?.length) return res.status(400).json({ error: 'Нет данных матча для AI-анализа' });

  const payload = compactMatchForAI(match, req.body?.selectedSteamid);
  const mode = getAIMode();

  if (mode === 'none') {
    return res.status(503).json({
      error: 'AI не настроен. Укажи AI_GATEWAY_URL в .env или OPENAI_API_KEY для прямого режима.',
    });
  }

  try {
    const result = mode === 'gateway'
      ? await callAIGateway(payload)
      : await callOpenAIDirect(payload);
    res.json(result);
  } catch (error) {
    console.error(error);
    const status = Number(error?.status) || 502;
    const message = String(error?.message || error);
    const hint = mode === 'direct' && /country|region|territory not supported/i.test(message)
      ? 'Прямой OpenAI-запрос отклонён по региону.'
      : mode === 'gateway' && isLocalGateway()
        ? 'Проверь, что локальный gateway запущен, а AI_TIMEOUT_MS одинаковый в обоих процессах.'
        : mode === 'gateway'
          ? 'Проверь AI_GATEWAY_URL, AI_GATEWAY_TOKEN и переменные окружения gateway.'
          : undefined;
    res.status(status).json({ error: message, hint });
  }
});

app.use((error, _req, res, _next) => {
  console.error('[UNIFIED]', error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Демка слишком большая. Лимит: ${maxDemoMb} MB.` });
  }
  res.status(400).json({ error: error?.message || 'Ошибка запроса' });
});

// This service is an internal backend: do not expose an unauthenticated AI endpoint to the LAN.
app.listen(port, '127.0.0.1', () => {
  console.log(`CS2 Demo AI Analyzer unified ${BUILD}: http://localhost:${port}`);
  console.log(`AI mode: ${getAIMode()}`);
  console.log('Analyze: Fast Core single-pass in-process, automatic stable fallback.');
  console.log(`Episode replay: ${EPISODE_CONFIG.replayHz} fps, tick rate ${EPISODE_CONFIG.tickRate}`);
});
