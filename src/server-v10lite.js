import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTicks } from '@laihoe/demoparser2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const publicPort = Number(process.env.PORT || 3000);
const internalPort = publicPort + 1;
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));
const replayHz = Math.max(2, Math.min(8, Number(process.env.EPISODE_REPLAY_HZ || 4)));
const tickRate = Math.max(32, Math.min(128, Number(process.env.DEMO_TICK_RATE || 64)));

// Keep the proven stable parser unchanged on a private port.
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
  fileFilter: (_req, file, cb) => path.extname(file.originalname).toLowerCase() === '.dem'
    ? cb(null, true)
    : cb(new Error('Можно загружать только файлы .dem')),
});

const arr = (v) => Array.isArray(v) ? v : [];
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const text = (v) => String(v ?? '').trim();

async function forwardDemo(file) {
  const form = new FormData();
  form.append('demo', await openAsBlob(file.path, { type: 'application/octet-stream' }), file.originalname);
  const response = await fetch(`${internalBase}/api/analyze`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `Stable parser HTTP ${response.status}`);
    error.status = response.status;
    error.details = data?.details;
    error.hint = data?.hint;
    throw error;
  }
  return data;
}

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

function buildReplayEpisodes(base) {
  return arr(base?.timeline)
    .map(episodeFromDeath)
    .filter(Boolean)
    .sort((a, b) => a.round - b.round || num(a.t, 999) - num(b.t, 999) || a.tick - b.tick);
}

function buildCriticalEpisodes(replayEpisodes) {
  return replayEpisodes
    .filter((e) => e.critical)
    .sort((a, b) => b.score - a.score || a.round - b.round)
    .slice(0, 24);
}

function sampleTicks(targetTick, beforeSec, afterSec) {
  const step = Math.max(1, Math.round(tickRate / replayHz));
  const start = Math.max(1, Math.round(targetTick - beforeSec * tickRate));
  const end = Math.max(start, Math.round(targetTick + afterSec * tickRate));
  const ticks = [];
  for (let t = start; t <= end; t += step) ticks.push(t);
  if (!ticks.includes(targetTick)) ticks.push(targetTick);
  return [...new Set(ticks)].sort((a, b) => a - b);
}

function parseEpisodeRows(filePath, ticks) {
  const props = ['X', 'Y', 'Z', 'yaw', 'team_num', 'team_name', 'is_alive', 'health'];
  try {
    return arr(parseTicks(filePath, props, ticks));
  } catch (error) {
    console.warn('V10 Lite replay state fallback:', error?.message || error);
    try {
      return arr(parseTicks(filePath, ['X', 'Y', 'Z', 'team_num', 'is_alive'], ticks));
    } catch (fallbackError) {
      console.warn('V10 Lite episode replay unavailable:', fallbackError?.message || fallbackError);
      return [];
    }
  }
}

function normalizeFrames(rows, targetTick) {
  const byTick = new Map();
  for (const row of rows) {
    const tick = num(row.tick);
    if (!tick) continue;
    if (!byTick.has(tick)) byTick.set(tick, []);
    const x = Number(row.X ?? row.x), y = Number(row.Y ?? row.y), z = Number(row.Z ?? row.z ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byTick.get(tick).push({
      steamid: String(row.steamid ?? row.player_steamid ?? ''),
      name: text(row.name ?? row.player_name) || 'Unknown',
      teamNumber: num(row.team_num ?? row.team_number),
      teamName: text(row.team_name),
      x, y, z: Number.isFinite(z) ? z : 0,
      yaw: Number.isFinite(Number(row.yaw)) ? Number(row.yaw) : null,
      alive: row.is_alive === undefined ? true : Boolean(row.is_alive),
      hp: Number.isFinite(Number(row.health)) ? Number(row.health) : null,
    });
  }
  return [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, players]) => ({
    tick,
    t: Number(((tick - targetTick) / tickRate).toFixed(3)),
    players,
  }));
}

function distance2d(a, b) {
  if (!a || !b) return null;
  const dx = Number(a.x) - Number(b.x), dy = Number(a.y) - Number(b.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return Math.hypot(dx, dy);
}

function nearestFrame(frames, targetT) {
  const list = arr(frames);
  if (!list.length) return null;
  let best = list[0], bestD = Math.abs(num(best.t) - targetT);
  for (const frame of list) {
    const d = Math.abs(num(frame.t) - targetT);
    if (d < bestD) { best = frame; bestD = d; }
  }
  return best;
}

function facingErrorDeg(victim, attacker) {
  if (!victim || !attacker || !Number.isFinite(Number(victim.yaw))) return null;
  const bearing = Math.atan2(Number(attacker.y) - Number(victim.y), Number(attacker.x) - Number(victim.x)) * 180 / Math.PI;
  let diff = bearing - Number(victim.yaw);
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return Math.abs(diff);
}

function buildEpisodeCoach(episode, replay) {
  const frames = arr(replay?.frames);
  const before = [...frames].filter((f) => num(f.t) <= -0.05).at(-1) || nearestFrame(frames, 0);
  const earlier = nearestFrame(frames, -1.5);
  const victimBefore = arr(before?.players).find((p) => p.name === episode.player);
  const attackerBefore = arr(before?.players).find((p) => p.name === episode.attacker);
  const victimEarlier = arr(earlier?.players).find((p) => p.name === episode.player);
  const teammateDistances = arr(before?.players)
    .filter((p) => victimBefore && p.name !== victimBefore.name && p.alive !== false && Number(p.teamNumber) === Number(victimBefore.teamNumber))
    .map((p) => distance2d(victimBefore, p))
    .filter(Number.isFinite);
  const nearestTeammateDistance = teammateDistances.length ? Math.min(...teammateDistances) : null;
  const duelDistance = distance2d(victimBefore, attackerBefore);
  const movementLast1_5s = distance2d(victimEarlier, victimBefore);
  const facingError = facingErrorDeg(victimBefore, attackerBefore);
  const hpBeforeDeath = Number.isFinite(Number(victimBefore?.hp)) ? Number(victimBefore.hp) : null;
  const reasons = arr(episode.reasons);

  const why = [];
  const risks = [];
  const plan = [];

  if (reasons.includes('REPEEK*')) {
    why.push('Эпизод отмечен как REPEEK*: повторный выход после предыдущего контакта выглядит предсказуемым по эвристике.');
    risks.push('Соперник может уже держать тот же угол и ожидать повторного появления.');
    plan.push('После первого контакта разорви линию: уйди за укрытие и сбрось тайминг.');
    plan.push('Повторно открывай угол только после новой информации, флешки или контакта тиммейта.');
  }
  if (reasons.includes('WIDE*')) {
    why.push('Эпизод отмечен как WIDE*: траектория похожа на широкий выход, но это эвристика, а не доказанная ошибка.');
    risks.push('Широкий выход может открыть сразу несколько потенциальных углов и ухудшить возможность быстро уйти назад.');
    plan.push('Открывай пространство поэтапно: один сектор за раз, сохраняя путь назад к укрытию.');
    plan.push('Перед точным выстрелом стабилизируй движение вместо продолжения широкого свинга.');
  }
  if (reasons.includes('FLASH')) {
    why.push('На смерти был активен эффект флешки.');
    risks.push('Контакт во время ослепления резко снижает качество первого выстрела и чтение второго противника.');
    plan.push('Если есть укрытие, пережди остаток флешки и только затем возвращай контакт.');
  }
  if (reasons.includes('FAR FROM TRADE*')) {
    why.push('Эпизод отмечен как FAR FROM TRADE*: расстояние до ближайшего живого тиммейта было большим по позиционной эвристике.');
    risks.push('В случае проигранной дуэли размен может быть слишком поздним или невозможным.');
    plan.push('До контакта сократи разрыв с ближайшим тиммейтом или выбери угол, который он реально сможет разменять.');
  }
  if (!why.length) {
    why.push('Это DEATH REVIEW: отдельная эвристика WIDE/REPEEK/FLASH/FAR FROM TRADE здесь не сработала.');
    risks.push('По одним координатам нельзя доказать конкретную ошибку, поэтому разбор ограничен безопасными принципами принятия дуэли.');
    plan.push('Перед контактом оставь себе понятный путь назад к укрытию и старайся изолировать одну дуэль.');
    plan.push('После обнаружения соперника не повторяй тот же тайминг автоматически — сначала обнови информацию или позицию.');
  }

  if (Number.isFinite(nearestTeammateDistance) && nearestTeammateDistance > 900 && !reasons.includes('FAR FROM TRADE*')) {
    risks.push(`В коротком replay ближайший живой тиммейт был примерно в ${Math.round(nearestTeammateDistance)}u — это дополнительный признак слабой разменной структуры.`);
  }
  if (Number.isFinite(facingError) && facingError > 75) {
    risks.push(`Примерная 2D разница между yaw игрока и направлением на соперника перед смертью: ${Math.round(facingError)}°. Это контекст, не полноценный LOS-анализ.`);
  }

  return {
    episodeOnly: true,
    provider: 'deterministic-safe-default-v10-lite-4.2',
    title: `R${episode.round} · ${episode.player} vs ${episode.attacker || 'opponent'}`,
    why,
    risks,
    plan: [...new Set(plan)].slice(0, 5),
    evidence: {
      hpBeforeDeath,
      duelDistance2d: Number.isFinite(duelDistance) ? Math.round(duelDistance) : null,
      nearestTeammateDistance2d: Number.isFinite(nearestTeammateDistance) ? Math.round(nearestTeammateDistance) : null,
      movementLast1_5s2d: Number.isFinite(movementLast1_5s) ? Math.round(movementLast1_5s) : null,
      facingErrorDeg2d: Number.isFinite(facingError) ? Math.round(facingError) : null,
    },
    limits: 'Safe-default coach: navmesh, стены и line-of-sight не моделируются. WIDE*/REPEEK*/trade-distance остаются эвристиками.',
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    const response = await fetch(`${internalBase}/api/health`);
    const data = await response.json().catch(() => ({}));
    res.status(response.ok ? 200 : 502).json({
      ...data,
      ok: response.ok && data?.ok !== false,
      build: 'v10-lite-4.2.0',
      episodeReplayLite: true,
      episodeCoachLite: true,
      fullMatchReplay: false,
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: `Stable parser недоступен: ${error?.message || error}` });
  }
});

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  try {
    const base = await forwardDemo(req.file);
    const replayEpisodes = buildReplayEpisodes(base);
    const criticalEpisodes = buildCriticalEpisodes(replayEpisodes);
    res.json({
      ...base,
      replayEpisodes,
      criticalEpisodes,
      build: 'v10-lite-4.2.0',
      dataAvailability: {
        ...(base.dataAvailability || {}),
        replayEpisodes: replayEpisodes.length > 0,
        criticalEpisodes: criticalEpisodes.length > 0,
        episodeReplayLite: true,
        episodeCoachLite: true,
        fullMatchReplay: false,
      },
    });
  } catch (error) {
    res.status(Number(error?.status) || 422).json({
      error: error?.message || 'Не удалось разобрать демку',
      details: error?.details,
      hint: error?.hint,
    });
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
      tickRate,
      sampleHz: replayHz,
      beforeSec,
      afterSec,
      frames,
      elapsedMs: Date.now() - started,
      note: 'V10 Lite: только короткое окно вокруг выбранного эпизода; WIDE/REPEEK остаются эвристиками.',
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
    res.status(502).json({ error: `AI route недоступен: ${error?.message || error}` });
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
  console.log(`CS2 Demo AI Analyzer V10 Lite 4.2.0: http://localhost:${publicPort}`);
  console.log(`Stable core internal: ${internalBase}`);
  console.log(`Episode replay: all deaths available on demand, ${replayHz} fps, ±4s default`);
  console.log('Episode coach: deterministic safe-default, selected episode only');
});
