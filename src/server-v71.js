import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTicks } from '@laihoe/demoparser2';
import {
  TRAJECTORY_SECONDS,
  attachDeathTrajectories,
  estimateTickRate,
  trajectoryTicksForDeaths,
} from './v71-trajectories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const publicPort = Number(process.env.PORT || 3000);
const internalPort = publicPort + 1;
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));

// Reuse the stable V6/V6.1 parser + AI routes on a private loopback port.
// V7.1 only layers interactive-radar trajectory extraction on top.
const previousPort = process.env.PORT;
process.env.PORT = String(internalPort);
await import('./server.js');
if (previousPort === undefined) delete process.env.PORT;
else process.env.PORT = previousPort;

const internalBase = `http://127.0.0.1:${internalPort}`;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.static(publicDir));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxDemoMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.dem') {
      return cb(new Error('Можно загружать только файлы .dem'));
    }
    cb(null, true);
  },
});

async function forwardDemoToBase(file) {
  const form = new FormData();
  const blob = await openAsBlob(file.path, { type: 'application/octet-stream' });
  form.append('demo', blob, file.originalname);
  const response = await fetch(`${internalBase}/api/analyze`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `Base parser HTTP ${response.status}`);
    error.status = response.status;
    error.details = data?.details;
    error.hint = data?.hint;
    throw error;
  }
  return data;
}

function parseTrajectorySnapshots(filePath, deaths) {
  const tickRate = estimateTickRate(deaths);
  const ticks = trajectoryTicksForDeaths(deaths, tickRate);
  if (!ticks.length) return { tickRate, rows: [] };
  const props = [
    'X', 'Y', 'Z',
    'velocity', 'velocity_X', 'velocity_Y',
    'last_place_name', 'is_alive', 'team_num', 'team_name',
  ];
  try {
    return { tickRate, rows: parseTicks(filePath, props, ticks) };
  } catch (error) {
    console.warn('V7.1 trajectory full snapshots unavailable, retrying coordinates only:', error?.message || error);
    try {
      return { tickRate, rows: parseTicks(filePath, ['X', 'Y', 'Z', 'is_alive'], ticks) };
    } catch (fallbackError) {
      console.warn('V7.1 trajectories unavailable:', fallbackError?.message || fallbackError);
      return { tickRate, rows: [] };
    }
  }
}

function enrichWithTrajectories(base, filePath) {
  const deaths = Array.isArray(base?.timeline) ? base.timeline : [];
  if (!base?.positioning || !deaths.length) {
    return {
      ...base,
      dataAvailability: { ...(base?.dataAvailability || {}), deathTrajectories: false },
      advancedMetricsVersion: 'v7.1-interactive-radar',
    };
  }

  const { tickRate, rows } = parseTrajectorySnapshots(filePath, deaths);
  const positioning = attachDeathTrajectories({
    positioning: base.positioning,
    deaths,
    snapshotRows: rows,
    tickRate,
    seconds: TRAJECTORY_SECONDS,
  });
  const trajectoryCount = Number(positioning?.trajectory?.totalTrajectories || 0);
  return {
    ...base,
    positioning: {
      ...positioning,
      note: 'V7.1: настоящий radar + zoom/pan/click + round filters + sampled trajectory перед смертью. WIDE/REPEEK остаются эвристиками V6.1.',
    },
    dataAvailability: {
      ...(base.dataAvailability || {}),
      deathTrajectories: trajectoryCount > 0,
      interactiveRadar: true,
    },
    advancedMetricsVersion: 'v7.1-interactive-radar',
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    const response = await fetch(`${internalBase}/api/health`);
    const data = await response.json().catch(() => ({}));
    res.status(response.ok ? 200 : 502).json({
      ...data,
      ok: response.ok && data?.ok !== false,
      advancedMetricsVersion: 'v7.1-interactive-radar',
      interactiveRadar: true,
      deathTrajectorySeconds: TRAJECTORY_SECONDS,
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: `Base parser недоступен: ${error?.message || error}` });
  }
});

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  try {
    const base = await forwardDemoToBase(req.file);
    const result = enrichWithTrajectories(base, req.file.path);
    res.json(result);
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
  console.log(`CS2 Demo AI Analyzer V7.1: http://localhost:${publicPort}`);
  console.log(`Base parser/AI internal: ${internalBase}`);
  console.log(`Interactive radar: zoom/pan/click/round filter + ${TRAJECTORY_SECONDS}s death trajectories`);
});
