import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEvent, parseTicks } from '@laihoe/demoparser2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const publicPort = Number(process.env.PORT || 3000);
const internalPort = publicPort + 1;
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));

const previousPort = process.env.PORT;
process.env.PORT = String(internalPort);
await import('./server-v8.js');
if (previousPort === undefined) delete process.env.PORT;
else process.env.PORT = previousPort;

const internalBase = `http://127.0.0.1:${internalPort}`;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
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
const pick = (row, ...keys) => {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  return undefined;
};

async function forwardDemo(file) {
  const form = new FormData();
  const blob = await openAsBlob(file.path, { type: 'application/octet-stream' });
  form.append('demo', blob, file.originalname);
  const response = await fetch(`${internalBase}/api/analyze`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `V8 parser HTTP ${response.status}`);
    error.status = response.status;
    error.details = data?.details;
    error.hint = data?.hint;
    throw error;
  }
  return data;
}

function eventRows(filePath, name, playerProps = [], otherProps = []) {
  try { return arr(parseEvent(filePath, name, playerProps, otherProps)); }
  catch { try { return arr(parseEvent(filePath, name)); } catch { return []; } }
}

function roundForTick(replay, tick) {
  return arr(replay?.rounds).find((r) => tick >= num(r.startTick) && tick <= num(r.endTick)) || null;
}

function normalizeUtility(filePath, replay) {
  const specs = [
    ['smokegrenade_detonate', 'smoke', 18], ['smokegrenade_expired', 'smoke_end', 0],
    ['flashbang_detonate', 'flash', 1.5], ['hegrenade_detonate', 'he', 0.6],
    ['inferno_startburn', 'molotov', 7], ['inferno_expire', 'molotov_end', 0],
    ['molotov_detonate', 'molotov', 7], ['decoy_started', 'decoy', 15],
  ];
  const out = [];
  for (const [eventName, type, duration] of specs) {
    for (const row of eventRows(filePath, eventName, ['team_name', 'team_num'], ['x', 'y', 'z'])) {
      const tick = num(row?.tick);
      const round = roundForTick(replay, tick);
      if (!round) continue;
      out.push({
        type, tick, round: round.round,
        t: Number(((tick - round.startTick) / Math.max(1, num(replay?.tickRate, 64))).toFixed(2)),
        duration,
        player: text(pick(row, 'user_name', 'player_name', 'name')),
        teamNumber: num(pick(row, 'user_team_num', 'player_team_num', 'team_num')),
        x: num(pick(row, 'x', 'X'), NaN), y: num(pick(row, 'y', 'Y'), NaN), z: num(pick(row, 'z', 'Z'), 0),
      });
    }
  }
  return out.filter((e) => Number.isFinite(e.x) && Number.isFinite(e.y));
}

function normalizeCombat(filePath) {
  const fires = eventRows(filePath, 'weapon_fire', ['team_name', 'team_num'], ['weapon']).map((row) => ({
    tick: num(row.tick), player: text(pick(row, 'user_name', 'player_name', 'name')), weapon: text(pick(row, 'weapon', 'weapon_name')).replace(/^weapon_/, ''),
  })).filter((e) => e.tick > 0 && e.player);
  const hurts = eventRows(filePath, 'player_hurt', ['team_name', 'team_num'], ['dmg_health', 'health', 'weapon', 'hitgroup']).map((row) => ({
    tick: num(row.tick), attacker: text(pick(row, 'attacker_name', 'attacker_player_name', 'attacker')), victim: text(pick(row, 'user_name', 'victim_name', 'player_name')), damage: num(pick(row, 'dmg_health', 'damage')), health: num(pick(row, 'health')), weapon: text(pick(row, 'weapon', 'weapon_name')).replace(/^weapon_/, ''), hitgroup: num(pick(row, 'hitgroup')),
  })).filter((e) => e.tick > 0 && e.attacker && e.victim);
  const blinds = eventRows(filePath, 'player_blind', ['team_name', 'team_num'], ['blind_duration']).map((row) => ({
    tick: num(row.tick), player: text(pick(row, 'user_name', 'player_name')), attacker: text(pick(row, 'attacker_name', 'attacker_player_name')), duration: num(pick(row, 'blind_duration')),
  })).filter((e) => e.tick > 0 && e.player);
  return { fires, hurts, blinds };
}

function buildDuels(base, combat) {
  const tickRate = Math.max(1, num(base?.replay?.tickRate, 64));
  const duels = [];
  for (const kill of arr(base?.timeline)) {
    const kt = num(kill.tick);
    const attacker = text(kill.attacker), victim = text(kill.victim);
    if (!kt || !attacker || !victim || attacker === victim) continue;
    const windowTicks = Math.round(tickRate * 4);
    const shots = combat.fires.filter((e) => e.player === attacker && e.tick <= kt && e.tick >= kt - windowTicks);
    const hits = combat.hurts.filter((e) => e.attacker === attacker && e.victim === victim && e.tick <= kt && e.tick >= kt - windowTicks);
    const firstShot = shots[0]?.tick || null;
    const firstHit = hits[0]?.tick || null;
    duels.push({
      round: num(kill.round), tick: kt, t: kill.secondsIntoRound ?? null, attacker, victim, weapon: kill.weapon || shots.at(-1)?.weapon || '', result: 'kill',
      shots: shots.length, hits: hits.length, damage: hits.reduce((s, h) => s + h.damage, 0),
      ttkSec: firstShot ? Number(((kt - firstShot) / tickRate).toFixed(3)) : null,
      firstBulletHitHeuristic: firstShot && firstHit ? Math.abs(firstHit - firstShot) <= Math.round(tickRate * 0.18) : null,
      widePeekLike: Boolean(kill.victimWidePeekLike), repeekLike: Boolean(kill.repeekLike), traded: Boolean(kill.tradeKill || kill.tradedDeath), nearestTeammateDistance: kill.nearestTeammateDistance ?? null,
    });
  }
  return duels;
}

function aggregateAim(base, combat, duels) {
  const out = {};
  for (const p of arr(base?.players)) {
    const name = p.name;
    const shots = combat.fires.filter((e) => e.player === name).length;
    const hits = combat.hurts.filter((e) => e.attacker === name).length;
    const ds = duels.filter((d) => d.attacker === name);
    const ttks = ds.map((d) => d.ttkSec).filter(Number.isFinite);
    const first = ds.map((d) => d.firstBulletHitHeuristic).filter((v) => v !== null);
    out[name] = {
      shots, hits,
      accuracyPct: shots ? Number(((hits / shots) * 100).toFixed(1)) : null,
      avgTtkSec: ttks.length ? Number((ttks.reduce((a,b)=>a+b,0) / ttks.length).toFixed(3)) : null,
      firstBulletHitPctHeuristic: first.length ? Number((first.filter(Boolean).length / first.length * 100).toFixed(1)) : null,
      note: 'Accuracy = player_hurt / weapon_fire; first-bullet metric is heuristic.',
    };
  }
  return out;
}

function enrichReplayStates(filePath, replay) {
  const ticks = [...new Set(arr(replay?.rounds).flatMap((r) => arr(r.frames).map((f) => num(f.tick))).filter(Boolean))];
  if (!ticks.length) return replay;
  let rows = [];
  try { rows = parseTicks(filePath, ['health','armor_value','has_helmet','has_defuser','money','active_weapon_name','team_num','team_name','is_alive'], ticks); }
  catch { try { rows = parseTicks(filePath, ['health','armor_value','team_num','team_name','is_alive'], ticks); } catch { rows = []; } }
  const byKey = new Map();
  for (const row of rows) byKey.set(`${num(row.tick)}|${text(row.name ?? row.player_name)}`, row);
  for (const round of arr(replay?.rounds)) for (const frame of arr(round.frames)) for (const p of arr(frame.players)) {
    const row = byKey.get(`${num(frame.tick)}|${text(p.name)}`);
    if (!row) continue;
    p.hp = Number.isFinite(Number(row.health)) ? Number(row.health) : p.hp;
    p.armor = Number.isFinite(Number(row.armor_value)) ? Number(row.armor_value) : null;
    p.helmet = row.has_helmet === undefined ? null : Boolean(row.has_helmet);
    p.defuser = row.has_defuser === undefined ? null : Boolean(row.has_defuser);
    p.money = Number.isFinite(Number(row.money)) ? Number(row.money) : null;
    p.weapon = text(row.active_weapon_name).replace(/^weapon_/, '');
  }
  return replay;
}

function buildCriticalEpisodes(base, duels) {
  const result = [];
  for (const e of arr(base?.timeline)) {
    const reasons = [];
    let score = 0;
    if (e.repeekLike) { score += 4; reasons.push('повторный пик'); }
    if (e.victimWidePeekLike) { score += 3; reasons.push('широкий выход'); }
    if (e.flashed === true) { score += 2; reasons.push('смерть во флешке'); }
    if (Number.isFinite(Number(e.nearestTeammateDistance)) && Number(e.nearestTeammateDistance) > 900) { score += 2; reasons.push('далеко от размена'); }
    if (score < 3 || !e.victim) continue;
    const duel = duels.find((d) => d.tick === num(e.tick) && d.victim === e.victim);
    result.push({
      id: `${e.round}-${e.tick}-${e.victim}`, round: num(e.round), tick: num(e.tick), t: e.secondsIntoRound ?? null,
      player: e.victim, attacker: e.attacker, weapon: e.weapon, severity: score >= 6 ? 'high' : 'medium', score, reasons, duel,
      recommendation: e.repeekLike ? 'После контакта разорвать линию и не отдавать ожидаемый второй пик без нового преимущества.' : e.victimWidePeekLike ? 'Открывать сектор поэтапно и остановиться перед первым точным выстрелом.' : 'Снизить риск: играть ближе к укрытию и сохранять trade-path.',
    });
  }
  return result.sort((a,b)=>b.score-a.score || a.round-b.round).slice(0, 12);
}

function attachUtilityToReplay(replay, utility) {
  for (const round of arr(replay?.rounds)) round.events = [...arr(round.events), ...utility.filter((e) => e.round === round.round)].sort((a,b)=>num(a.t)-num(b.t));
  if (replay) replay.utility = utility;
  return replay;
}

function buildTelemetry(filePath, base) {
  const replay = enrichReplayStates(filePath, base.replay);
  const utility = normalizeUtility(filePath, replay);
  attachUtilityToReplay(replay, utility);
  const combat = normalizeCombat(filePath);
  const duels = buildDuels({ ...base, replay }, combat);
  const aim = aggregateAim(base, combat, duels);
  return { replay, utility, duels, aim, criticalEpisodes: buildCriticalEpisodes(base, duels) };
}

function compactForAI(match) {
  const copy = { ...match };
  delete copy.replay; delete copy.utility; delete copy.duels; delete copy.aim; delete copy.criticalEpisodes;
  return copy;
}

async function proxyJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

app.get('/api/health', async (_req, res) => {
  try {
    const response = await fetch(`${internalBase}/api/health`);
    const data = await response.json().catch(() => ({}));
    res.status(response.ok ? 200 : 502).json({ ...data, ok: response.ok && data?.ok !== false, advancedMetricsVersion: 'v9-unified-coach', replay2D: true, episodeCoach: true, aimTelemetry: true, utilityReplay: true });
  } catch (error) { res.status(503).json({ ok: false, error: `V8 parser недоступен: ${error?.message || error}` }); }
});

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  try {
    const base = await forwardDemo(req.file);
    const telemetry = buildTelemetry(req.file.path, base);
    res.json({ ...base, ...telemetry, dataAvailability: { ...(base.dataAvailability || {}), utilityReplay: telemetry.utility.length > 0, duelTelemetry: telemetry.duels.length > 0, aimTelemetry: Object.keys(telemetry.aim).length > 0, criticalEpisodes: telemetry.criticalEpisodes.length > 0 }, advancedMetricsVersion: 'v9-unified-coach' });
  } catch (error) {
    console.error(error);
    res.status(Number(error?.status) || 422).json({ error: error?.message || 'Не удалось разобрать демку', details: error?.details, hint: error?.hint });
  } finally { await fs.unlink(req.file.path).catch(() => {}); }
});

app.post('/api/ai', async (req, res) => {
  try {
    const { response, data } = await proxyJson(`${internalBase}/api/ai`, { ...req.body, match: compactForAI(req.body?.match || {}) });
    res.status(response.status).json(data);
  } catch (error) { res.status(502).json({ error: `AI route недоступен: ${error?.message || error}` }); }
});

app.post('/api/episode-ai', async (req, res) => {
  const episode = req.body?.episode || {};
  const match = req.body?.match || {};
  const selectedSteamid = req.body?.selectedSteamid || episode.player;
  const rate = Math.max(1, num(match?.replay?.tickRate, 64));
  const relatedTimeline = arr(match.timeline).filter((e) => Number(e.round) === Number(episode.round) && Math.abs(num(e.tick) - num(episode.tick)) <= rate * 6);
  const compact = { ...compactForAI(match), timeline: relatedTimeline };
  try {
    const { response, data } = await proxyJson(`${internalBase}/api/ai`, { match: compact, selectedSteamid });
    if (!response.ok) return res.status(response.status).json(data);
    const facts = [`R${episode.round}${Number.isFinite(Number(episode.t)) ? ` · ${Number(episode.t).toFixed(1)}с` : ''}`, episode.player ? `${episode.player} погиб от ${episode.attacker || 'соперника'}` : '', arr(episode.reasons).length ? `Флаги: ${episode.reasons.join(', ')}` : ''].filter(Boolean).join(' · ');
    res.json({ ...data, episodeAnalysis: `${facts}\n\nКак лучше было сыграть:\n${episode.recommendation || 'Снизить риск, изолировать один угол и сохранить возможность размена.'}\n\nAI-разбор:\n${data.analysis || ''}` });
  } catch (error) { res.status(502).json({ error: `Episode AI недоступен: ${error?.message || error}` }); }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Демка слишком большая. Лимит: ${maxDemoMb} MB.` });
  res.status(400).json({ error: error?.message || 'Ошибка запроса' });
});

app.listen(publicPort, '127.0.0.1', () => {
  console.log(`CS2 Demo AI Analyzer V9: http://localhost:${publicPort}`);
  console.log(`V8 parser internal: ${internalBase}`);
  console.log('V9: smooth replay + utility + duel/aim telemetry + critical episodes + episode AI');
});
