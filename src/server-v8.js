import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEvent, parseTicks } from '@laihoe/demoparser2';
import { estimateTickRate } from './v71-trajectories.js';
import { buildReplay, normalizeRoundBounds, sampleTicksForRounds } from './v8-replay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const publicPort = Number(process.env.PORT || 3000);
const internalPort = publicPort + 1;
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));
const requestedReplayHz = Math.max(1, Math.min(8, Number(process.env.REPLAY_HZ || 4)));

// Keep V7.4/V7.1 stable on a private port and layer full-round replay on top.
const previousPort = process.env.PORT;
process.env.PORT = String(internalPort);
await import('./server-v71.js');
if (previousPort === undefined) delete process.env.PORT;
else process.env.PORT = previousPort;

const internalBase = `http://127.0.0.1:${internalPort}`;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use(express.static(publicDir));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxDemoMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.dem') return cb(new Error('Можно загружать только файлы .dem'));
    cb(null, true);
  },
});

const arr = (v) => (Array.isArray(v) ? v : []);
const n = (v, fallback = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

async function forwardDemo(file) {
  const form = new FormData();
  const blob = await openAsBlob(file.path, { type: 'application/octet-stream' });
  form.append('demo', blob, file.originalname);
  const response = await fetch(`${internalBase}/api/analyze`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `V7 parser HTTP ${response.status}`);
    error.status = response.status;
    error.details = data?.details;
    error.hint = data?.hint;
    throw error;
  }
  return data;
}

function eventRows(filePath, name, extra = []) {
  try {
    return arr(parseEvent(filePath, name, [], ['total_rounds_played', 'is_warmup_period', ...extra]));
  } catch {
    try { return arr(parseEvent(filePath, name)); } catch { return []; }
  }
}

function normalizeBombEvents(filePath) {
  const specs = [
    ['bomb_planted', 'bomb_planted'],
    ['bomb_defused', 'bomb_defused'],
    ['bomb_exploded', 'bomb_exploded'],
    ['bomb_dropped', 'bomb_dropped'],
    ['bomb_pickup', 'bomb_pickup'],
  ];
  const out = [];
  for (const [eventName, type] of specs) {
    for (const row of eventRows(filePath, eventName)) {
      if (Boolean(row?.is_warmup_period)) continue;
      out.push({
        type,
        tick: n(row?.tick),
        round: n(row?.total_rounds_played) + 1,
        player: String(row?.user_name ?? row?.player_name ?? row?.name ?? ''),
      });
    }
  }
  return out.filter((e) => e.tick > 0 && e.round > 0);
}

function parseReplaySnapshots(filePath, ticks) {
  if (!ticks.length) return [];
  const richProps = [
    'X', 'Y', 'Z', 'yaw', 'team_num', 'team_name', 'is_alive',
    'health', 'last_place_name',
  ];
  try {
    return parseTicks(filePath, richProps, ticks);
  } catch (error) {
    console.warn('V8 rich replay snapshots unavailable, retrying minimal:', error?.message || error);
    try {
      return parseTicks(filePath, ['X', 'Y', 'Z', 'team_num', 'team_name', 'is_alive'], ticks);
    } catch (fallbackError) {
      console.warn('V8 replay snapshots unavailable:', fallbackError?.message || fallbackError);
      return [];
    }
  }
}

function buildReplayForDemo(filePath, base) {
  const starts = eventRows(filePath, 'round_start');
  const ends = eventRows(filePath, 'round_end');
  const bounds = normalizeRoundBounds(starts, ends);
  if (!bounds.length) return null;

  const tickRate = estimateTickRate(base?.timeline || []);
  const sampled = sampleTicksForRounds(bounds, tickRate, requestedReplayHz);
  const rows = parseReplaySnapshots(filePath, sampled.ticks);
  if (!rows.length) return null;

  return buildReplay({
    roundBounds: bounds,
    snapshotRows: rows,
    tickRate,
    sampleHz: sampled.hz,
    timeline: base?.timeline || [],
    bombEvents: normalizeBombEvents(filePath),
  });
}

app.get('/api/health', async (_req, res) => {
  try {
    const response = await fetch(`${internalBase}/api/health`);
    const data = await response.json().catch(() => ({}));
    res.status(response.ok ? 200 : 502).json({
      ...data,
      ok: response.ok && data?.ok !== false,
      advancedMetricsVersion: 'v8.0-round-replay',
      replay2D: true,
      replayHz: requestedReplayHz,
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: `V7 parser недоступен: ${error?.message || error}` });
  }
});

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  try {
    const base = await forwardDemo(req.file);
    const replay = buildReplayForDemo(req.file.path, base);
    res.json({
      ...base,
      replay,
      dataAvailability: { ...(base?.dataAvailability || {}), replay2D: Boolean(replay?.rounds?.length) },
      advancedMetricsVersion: 'v8.0-round-replay',
    });
  } catch (error) {
    console.error(error);
    res.status(Number(error?.status) || 422).json({
      error: error?.message || 'Не удалось разобрать демку',
      details: error?.details,
      hint: error?.hint || 'Проверь консоль сервера и повтори загрузку полноценного CS2 .dem.',
    });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/ai', async (req, res) => {
  try {
    const response = await fetch(`${internalBase}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ error: `Внутренний AI route недоступен: ${error?.message || error}` });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Демка слишком большая. Лимит: ${maxDemoMb} MB.` });
  }
  res.status(400).json({ error: error?.message || 'Ошибка запроса' });
});

app.listen(publicPort, '127.0.0.1', () => {
  console.log(`CS2 Demo AI Analyzer V8: http://localhost:${publicPort}`);
  console.log(`V7 parser internal: ${internalBase}`);
  console.log(`2D Replay: all-player round snapshots @ ~${requestedReplayHz} Hz`);
});
