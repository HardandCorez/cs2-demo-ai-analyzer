import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEvent, parseHeader, parsePlayerInfo, parseTicks } from '@laihoe/demoparser2';
import { computeV5Metrics } from './v5-metrics.js';
import { computeV6Positioning } from './v6-positioning.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3001);
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxDemoMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => path.extname(file.originalname).toLowerCase() === '.dem'
    ? cb(null, true)
    : cb(new Error('Можно загружать только файлы .dem')),
});

const arr = (v) => Array.isArray(v) ? v : [];
const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const fixed = (v, digits = 2) => Number(n(v).toFixed(digits));
const perRound = (v, rounds, digits = 2) => rounds > 0 ? fixed(n(v) / rounds, digits) : 0;
const clean = (v) => String(v ?? '').trim();
const pick = (row, ...keys) => {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  return undefined;
};
const now = () => performance.now();
const ms = (start) => Math.round(performance.now() - start);

function normalizePlayerInfo(rows) {
  return arr(rows).map((row) => ({
    steamid: String(row.steamid ?? row.steam_id ?? ''),
    name: clean(row.name ?? row.player_name ?? 'Unknown'),
    teamNumber: n(row.team_number ?? row.team_num, 0),
  })).filter((p) => p.steamid || p.name !== 'Unknown');
}

function normalizeDeaths(rows) {
  return arr(rows).map((row) => {
    const gameTime = Number(pick(row, 'game_time'));
    const roundStartTime = Number(pick(row, 'round_start_time'));
    const secondsIntoRound = Number.isFinite(gameTime) && Number.isFinite(roundStartTime)
      ? fixed(gameTime - roundStartTime, 2)
      : null;
    return {
      tick: n(pick(row, 'tick')),
      round: n(pick(row, 'total_rounds_played', 'round', 'round_number')) + 1,
      attacker: clean(pick(row, 'attacker_name', 'attacker_player_name', 'attacker')),
      attackerSteamid: String(pick(row, 'attacker_steamid', 'attacker_steam_id') ?? ''),
      attackerTeam: clean(pick(row, 'attacker_team_name', 'attacker_team')),
      attackerTeamNumber: n(pick(row, 'attacker_team_num', 'attacker_team_number'), 0),
      victim: clean(pick(row, 'user_name', 'victim_name', 'player_name', 'victim')),
      victimSteamid: String(pick(row, 'user_steamid', 'victim_steamid', 'player_steamid') ?? ''),
      victimTeam: clean(pick(row, 'user_team_name', 'victim_team_name', 'player_team_name')),
      victimTeamNumber: n(pick(row, 'user_team_num', 'victim_team_num', 'player_team_num'), 0),
      assister: clean(pick(row, 'assister_name', 'assister')),
      weapon: clean(pick(row, 'weapon', 'weapon_name')).replace(/^weapon_/, ''),
      headshot: Boolean(pick(row, 'headshot', 'is_headshot')),
      penetrated: n(pick(row, 'penetrated', 'penetrated_objects')),
      gameTime: Number.isFinite(gameTime) ? gameTime : null,
      roundStartTime: Number.isFinite(roundStartTime) ? roundStartTime : null,
      secondsIntoRound,
      isWarmup: Boolean(pick(row, 'is_warmup_period')),
    };
  }).filter((e) => !e.isWarmup && (e.attacker || e.victim || e.weapon));
}

function isEnemyKill(e) {
  if (!e?.attacker || !e?.victim || e.attacker === e.victim) return false;
  if (e.attackerTeam && e.victimTeam && e.attackerTeam === e.victimTeam) return false;
  if (e.attackerTeamNumber > 0 && e.victimTeamNumber > 0 && e.attackerTeamNumber === e.victimTeamNumber) return false;
  return true;
}

function buildEntryStats(deaths) {
  const byPlayer = new Map();
  const byRound = new Map();
  for (const death of deaths) {
    if (!byRound.has(death.round)) byRound.set(death.round, []);
    byRound.get(death.round).push(death);
  }
  for (const events of byRound.values()) {
    events.sort((a, b) => a.tick - b.tick);
    const first = events.find(isEnemyKill);
    if (!first) continue;
    if (!byPlayer.has(first.attacker)) byPlayer.set(first.attacker, { entryKills: 0, openingDeaths: 0 });
    if (!byPlayer.has(first.victim)) byPlayer.set(first.victim, { entryKills: 0, openingDeaths: 0 });
    byPlayer.get(first.attacker).entryKills += 1;
    byPlayer.get(first.victim).openingDeaths += 1;
  }
  return byPlayer;
}

function addDerivedMetrics(player, rounds) {
  const openingAttempts = n(player.entryKills) + n(player.openingDeaths);
  return {
    ...player,
    rounds,
    killsPerRound: perRound(player.kills, rounds),
    deathsPerRound: perRound(player.deaths, rounds),
    assistsPerRound: perRound(player.assists, rounds),
    utilityDamagePerRound: perRound(player.utilityDamage, rounds, 1),
    enemiesFlashedPerRound: perRound(player.enemiesFlashed, rounds, 2),
    openingAttempts,
    openingSuccessPct: openingAttempts > 0 ? Math.round((n(player.entryKills) / openingAttempts) * 100) : null,
    roundSurvivalPctEstimate: rounds > 0 ? Math.max(0, Math.min(100, Math.round(((rounds - n(player.deaths)) / rounds) * 100))) : null,
  };
}

function aggregateStats(tickRows, playerInfo, rounds, deaths) {
  const infoById = new Map(playerInfo.map((p) => [String(p.steamid), p]));
  const infoByName = new Map(playerInfo.map((p) => [p.name, p]));
  const entries = buildEntryStats(deaths);
  const seen = new Map();

  for (const row of arr(tickRows)) {
    const steamid = String(row.steamid ?? row.player_steamid ?? '');
    const name = clean(row.name ?? row.player_name ?? infoById.get(steamid)?.name ?? 'Unknown');
    const info = infoById.get(steamid) || infoByName.get(name);
    const key = steamid || name;
    if (!key || name === 'Unknown') continue;
    const kills = n(row.kills_total), deathsTotal = n(row.deaths_total), assists = n(row.assists_total);
    const damage = n(row.damage_total), hs = n(row.headshot_kills_total), util = n(row.utility_damage_total), flashed = n(row.enemies_flashed_total);
    const entry = entries.get(name) || { entryKills: 0, openingDeaths: 0 };
    seen.set(key, addDerivedMetrics({
      steamid, name,
      teamNumber: n(row.team_num ?? info?.teamNumber, 0),
      teamName: clean(row.team_name ?? ''),
      kills, deaths: deathsTotal, assists, headshots: hs, damage,
      adr: rounds > 0 ? Number((damage / rounds).toFixed(1)) : 0,
      kd: deathsTotal > 0 ? Number((kills / deathsTotal).toFixed(2)) : kills,
      hsPct: kills > 0 ? Math.round((hs / kills) * 100) : 0,
      utilityDamage: util, enemiesFlashed: flashed,
      entryKills: entry.entryKills, openingDeaths: entry.openingDeaths,
      impact: Number((kills + assists * 0.35 + entry.entryKills * 0.55 - deathsTotal * 0.52).toFixed(2)),
    }, rounds));
  }

  if (!seen.size) {
    for (const p of playerInfo) seen.set(String(p.steamid || p.name), {
      steamid: p.steamid, name: p.name, teamNumber: p.teamNumber, teamName: '',
      kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, adr: 0, kd: 0, hsPct: 0,
      utilityDamage: 0, enemiesFlashed: 0,
      entryKills: entries.get(p.name)?.entryKills || 0,
      openingDeaths: entries.get(p.name)?.openingDeaths || 0,
      impact: 0,
    });
    for (const death of deaths.filter(isEnemyKill)) {
      const values = [...seen.values()];
      const attacker = values.find((p) => p.name === death.attacker);
      const victim = values.find((p) => p.name === death.victim);
      const assister = values.find((p) => p.name === death.assister);
      if (attacker && attacker !== victim) { attacker.kills += 1; if (death.headshot) attacker.headshots += 1; }
      if (victim) victim.deaths += 1;
      if (assister && assister !== attacker) assister.assists += 1;
    }
    for (const [key, p] of seen) {
      p.kd = p.deaths > 0 ? Number((p.kills / p.deaths).toFixed(2)) : p.kills;
      p.hsPct = p.kills > 0 ? Math.round((p.headshots / p.kills) * 100) : 0;
      p.impact = Number((p.kills + p.assists * 0.35 + p.entryKills * 0.55 - p.deaths * 0.52).toFixed(2));
      seen.set(key, addDerivedMetrics(p, rounds));
    }
  }
  return [...seen.values()].sort((a, b) => b.impact - a.impact || b.kills - a.kills);
}

function summarizeRounds(rows) {
  const valid = arr(rows).filter((r) => !Boolean(pick(r, 'is_warmup_period')));
  const wins = {};
  for (const r of valid) {
    const winner = clean(r.winner ?? r.winner_name ?? r.team ?? 'Unknown');
    wins[winner] = (wins[winner] || 0) + 1;
  }
  return { rounds: valid.length, wins };
}

function normalizeRoundEnds(rows) {
  return arr(rows).filter((r) => !Boolean(pick(r, 'is_warmup_period'))).map((r, index) => ({
    round: n(pick(r, 'total_rounds_played'), index) + 1,
    tick: n(r.tick),
    winnerTeamNumber: n(pick(r, 'winner', 'winner_team_num', 'team'), 0),
    reason: clean(pick(r, 'reason', 'message')),
  }));
}

function normalizeRoundStarts(rows, rounds) {
  return arr(rows).filter((r) => !Boolean(pick(r, 'is_warmup_period'))).map((r, index) => ({
    round: n(pick(r, 'total_rounds_played'), index) + 1,
    tick: n(r.tick),
  })).filter((r) => r.tick > 0 && r.round >= 1 && r.round <= rounds);
}

function buildRoundRosters(roundStarts, rows) {
  const roundByTick = new Map(roundStarts.map((r) => [r.tick, r.round]));
  const rosters = {};
  for (const row of arr(rows)) {
    const round = roundByTick.get(n(row.tick));
    if (!round) continue;
    const name = clean(row.name ?? row.player_name);
    const teamNumber = n(row.team_num ?? row.team_number, 0);
    if (!name || teamNumber < 2) continue;
    if (!rosters[round]) rosters[round] = [];
    if (!rosters[round].some((p) => p.name === name)) rosters[round].push({
      name,
      steamid: String(row.steamid ?? row.player_steamid ?? ''),
      teamNumber,
      teamName: clean(row.team_name ?? ''),
    });
  }
  return rosters;
}

function uniqueTicks(list) {
  return [...new Set(arr(list).map((x) => n(x?.tick ?? x)).filter((tick) => tick > 0))];
}

function parseCombinedTicks(filePath, lastTick, roundStarts, deaths) {
  const statProps = ['kills_total', 'deaths_total', 'assists_total', 'headshot_kills_total', 'damage_total', 'utility_damage_total', 'enemies_flashed_total'];
  const posProps = ['X', 'Y', 'Z', 'velocity', 'velocity_X', 'velocity_Y', 'yaw', 'team_num', 'team_name', 'is_alive', 'is_walking', 'is_scoped', 'flash_duration', 'last_place_name'];
  const props = [...new Set([...statProps, ...posProps])];
  const rosterTicks = uniqueTicks(roundStarts);
  const deathTicks = uniqueTicks(deaths);
  const ticks = [...new Set([lastTick, ...rosterTicks, ...deathTicks].filter((t) => t > 0))].sort((a, b) => a - b);
  if (!ticks.length) return { mode: 'none', rows: [], tickRows: [], rosterRows: [], positionRows: [] };

  try {
    const rows = arr(parseTicks(filePath, props, ticks));
    const rosterSet = new Set(rosterTicks), deathSet = new Set(deathTicks);
    return {
      mode: 'single-pass',
      rows,
      tickRows: lastTick > 0 ? rows.filter((r) => n(r.tick) === lastTick) : [],
      rosterRows: rows.filter((r) => rosterSet.has(n(r.tick))),
      positionRows: rows.filter((r) => deathSet.has(n(r.tick))),
      requestedTicks: ticks.length,
    };
  } catch (error) {
    console.warn('[FAST CORE] combined parseTicks failed; compatibility fallback:', error?.message || error);
    let tickRows = [], rosterRows = [], positionRows = [];
    if (lastTick > 0) {
      try { tickRows = arr(parseTicks(filePath, [...statProps, 'team_name', 'team_num'], [lastTick])); } catch (e) { console.warn('[FAST CORE] stats fallback failed:', e?.message || e); }
    }
    if (rosterTicks.length) {
      try { rosterRows = arr(parseTicks(filePath, ['team_num', 'team_name'], rosterTicks)); } catch (e) { console.warn('[FAST CORE] roster fallback failed:', e?.message || e); }
    }
    if (deathTicks.length) {
      try { positionRows = arr(parseTicks(filePath, posProps, deathTicks)); }
      catch (e) {
        console.warn('[FAST CORE] position rich fallback failed:', e?.message || e);
        try { positionRows = arr(parseTicks(filePath, ['X', 'Y', 'Z', 'team_num', 'team_name', 'is_alive'], deathTicks)); } catch {}
      }
    }
    return { mode: 'compat-fallback', rows: [], tickRows, rosterRows, positionRows, requestedTicks: ticks.length };
  }
}

async function parseDemoFast(filePath, originalName) {
  const totalStart = now();
  const timings = {};

  let t = now();
  const header = parseHeader(filePath) || {};
  const playerInfo = normalizePlayerInfo(parsePlayerInfo(filePath));
  timings.headerAndPlayers = ms(t);

  t = now();
  let roundEndRows = [];
  try { roundEndRows = arr(parseEvent(filePath, 'round_end', [], ['total_rounds_played', 'is_warmup_period'])); }
  catch { roundEndRows = arr(parseEvent(filePath, 'round_end')); }
  const roundSummary = summarizeRounds(roundEndRows);
  const normalizedRoundEnds = normalizeRoundEnds(roundEndRows);
  const lastTick = roundEndRows.reduce((max, r) => Math.max(max, n(r.tick)), 0);

  let roundStartRows = [];
  try { roundStartRows = arr(parseEvent(filePath, 'round_start', [], ['total_rounds_played', 'is_warmup_period'])); }
  catch { try { roundStartRows = arr(parseEvent(filePath, 'round_start')); } catch {} }
  const roundStarts = normalizeRoundStarts(roundStartRows, roundSummary.rounds);
  timings.roundEvents = ms(t);

  t = now();
  let deathRows = [];
  try {
    deathRows = parseEvent(filePath, 'player_death', ['team_name', 'team_num'], ['total_rounds_played', 'game_time', 'round_start_time', 'is_warmup_period']);
  } catch {
    try { deathRows = parseEvent(filePath, 'player_death', ['team_name'], ['total_rounds_played', 'game_time', 'round_start_time']); }
    catch { deathRows = parseEvent(filePath, 'player_death'); }
  }
  const deaths = normalizeDeaths(deathRows);
  timings.deathEvents = ms(t);

  t = now();
  const combined = parseCombinedTicks(filePath, lastTick, roundStarts, deaths);
  timings.tickData = ms(t);

  t = now();
  const rostersByRound = buildRoundRosters(roundStarts, combined.rosterRows);
  const basePlayers = aggregateStats(combined.tickRows, playerInfo, roundSummary.rounds, deaths);
  const advanced = computeV5Metrics({ deaths, players: basePlayers, rounds: roundSummary.rounds, rostersByRound, roundEnds: normalizedRoundEnds });
  timings.v5Metrics = ms(t);

  t = now();
  const positional = computeV6Positioning({ deaths: advanced.deaths, players: advanced.players, snapshotRows: combined.positionRows });
  timings.v6Positioning = ms(t);
  timings.total = ms(totalStart);

  const players = positional.players.sort((a, b) => b.impact - a.impact || b.kills - a.kills);
  const dataAvailability = { ...advanced.dataAvailability, ...positional.dataAvailability };
  const map = header.map_name || 'unknown';
  console.log(`[FAST CORE] ${map} · ${roundSummary.rounds} rounds · ${deaths.length} deaths · ${combined.mode} · ticks ${timings.tickData}ms · total ${timings.total}ms`);

  return {
    fileName: originalName,
    map,
    server: header.server_name || '',
    demoVersion: header.demo_version_name || '',
    networkProtocol: header.network_protocol || '',
    rounds: roundSummary.rounds,
    roundWinsBySide: roundSummary.wins,
    players,
    topPlayer: players[0] || null,
    timeline: positional.deaths.slice(0, 500),
    timelineTruncated: positional.deaths.length > 500,
    dataAvailability,
    positioning: positional.positioning,
    advancedMetricsVersion: 'v6-positioning-context-fastcore',
    parser: '@laihoe/demoparser2',
    parsePerformance: {
      engine: 'fast-core-4.4',
      tickPassMode: combined.mode,
      requestedTicks: combined.requestedTicks || 0,
      timingsMs: timings,
    },
  };
}

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  parser: '@laihoe/demoparser2',
  build: 'fast-core-4.4.0',
  fastCore: true,
  singleTickPass: true,
}));

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  try {
    res.json(await parseDemoFast(req.file.path, req.file.originalname));
  } catch (error) {
    console.error('[FAST CORE]', error);
    res.status(422).json({
      error: 'Fast Core не смог разобрать демку',
      details: String(error?.message || error),
      fallbackRecommended: true,
    });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

app.use((error, _req, res, _next) => {
  console.error('[FAST CORE]', error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Демка слишком большая. Лимит: ${maxDemoMb} MB.` });
  res.status(400).json({ error: error?.message || 'Ошибка Fast Core' });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`CS2 Fast Core 4.4: http://127.0.0.1:${port}`);
  console.log('Fast Core: one combined parseTicks pass + automatic compatibility fallback');
});
