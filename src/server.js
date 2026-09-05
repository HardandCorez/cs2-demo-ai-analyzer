import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseEvent,
  parseHeader,
  parsePlayerInfo,
  parseTicks,
} from '@laihoe/demoparser2';
import { computeV5Metrics } from './v5-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const port = Number(process.env.PORT || 3000);
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));
const aiGatewayUrl = String(process.env.AI_GATEWAY_URL || '').trim().replace(/\/+$/, '');
const aiGatewayToken = String(process.env.AI_GATEWAY_TOKEN || '').trim();
const aiTimeoutMs = Math.max(10_000, Number(process.env.AI_TIMEOUT_MS || 600_000));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
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

const asArray = (value) => (Array.isArray(value) ? value : []);
const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const fixed = (value, digits = 2) => Number(asNumber(value).toFixed(digits));
const perRound = (value, rounds, digits = 2) => rounds > 0 ? fixed(asNumber(value) / rounds, digits) : 0;

function cleanName(value) {
  return String(value ?? '').trim();
}

function keyOfPlayer(row) {
  return String(row?.steamid ?? row?.steam_id ?? row?.player_steamid ?? row?.name ?? '');
}

function normalizePlayerInfo(rows) {
  return asArray(rows).map((row) => ({
    steamid: String(row.steamid ?? row.steam_id ?? ''),
    name: cleanName(row.name ?? row.player_name ?? 'Unknown'),
    teamNumber: asNumber(row.team_number ?? row.team_num, 0),
  })).filter((p) => p.steamid || p.name !== 'Unknown');
}

function pick(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  }
  return undefined;
}

function normalizeDeaths(rows) {
  return asArray(rows).map((row) => {
    const gameTime = Number(pick(row, 'game_time'));
    const roundStartTime = Number(pick(row, 'round_start_time'));
    const secondsIntoRound = Number.isFinite(gameTime) && Number.isFinite(roundStartTime)
      ? fixed(gameTime - roundStartTime, 2)
      : null;
    return {
      tick: asNumber(pick(row, 'tick')),
      round: asNumber(pick(row, 'total_rounds_played', 'round', 'round_number')) + 1,
      attacker: cleanName(pick(row, 'attacker_name', 'attacker_player_name', 'attacker')),
      attackerSteamid: String(pick(row, 'attacker_steamid', 'attacker_steam_id') ?? ''),
      attackerTeam: cleanName(pick(row, 'attacker_team_name', 'attacker_team')),
      attackerTeamNumber: asNumber(pick(row, 'attacker_team_num', 'attacker_team_number'), 0),
      victim: cleanName(pick(row, 'user_name', 'victim_name', 'player_name', 'victim')),
      victimSteamid: String(pick(row, 'user_steamid', 'victim_steamid', 'player_steamid') ?? ''),
      victimTeam: cleanName(pick(row, 'user_team_name', 'victim_team_name', 'player_team_name')),
      victimTeamNumber: asNumber(pick(row, 'user_team_num', 'victim_team_num', 'player_team_num'), 0),
      assister: cleanName(pick(row, 'assister_name', 'assister')),
      weapon: cleanName(pick(row, 'weapon', 'weapon_name')).replace(/^weapon_/, ''),
      headshot: Boolean(pick(row, 'headshot', 'is_headshot')),
      penetrated: asNumber(pick(row, 'penetrated', 'penetrated_objects')),
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
  return true;
}

function buildEntryStats(deaths) {
  const byPlayer = new Map();
  const byRound = new Map();
  for (const death of deaths) {
    if (!byRound.has(death.round)) byRound.set(death.round, []);
    byRound.get(death.round).push(death);
  }
  for (const roundEvents of byRound.values()) {
    roundEvents.sort((a, b) => a.tick - b.tick);
    const first = roundEvents.find(isEnemyKill);
    if (!first) continue;
    if (!byPlayer.has(first.attacker)) byPlayer.set(first.attacker, { entryKills: 0, openingDeaths: 0 });
    if (!byPlayer.has(first.victim)) byPlayer.set(first.victim, { entryKills: 0, openingDeaths: 0 });
    byPlayer.get(first.attacker).entryKills += 1;
    byPlayer.get(first.victim).openingDeaths += 1;
  }
  return byPlayer;
}

function addDerivedMetrics(player, rounds) {
  const openingAttempts = asNumber(player.entryKills) + asNumber(player.openingDeaths);
  return {
    ...player,
    rounds,
    killsPerRound: perRound(player.kills, rounds),
    deathsPerRound: perRound(player.deaths, rounds),
    assistsPerRound: perRound(player.assists, rounds),
    utilityDamagePerRound: perRound(player.utilityDamage, rounds, 1),
    enemiesFlashedPerRound: perRound(player.enemiesFlashed, rounds, 2),
    openingAttempts,
    openingSuccessPct: openingAttempts > 0 ? Math.round((asNumber(player.entryKills) / openingAttempts) * 100) : null,
    roundSurvivalPctEstimate: rounds > 0
      ? Math.max(0, Math.min(100, Math.round(((rounds - asNumber(player.deaths)) / rounds) * 100)))
      : null,
  };
}

function aggregateStats(tickRows, playerInfo, rounds, deaths) {
  const infoById = new Map(playerInfo.map((p) => [String(p.steamid), p]));
  const infoByName = new Map(playerInfo.map((p) => [p.name, p]));
  const entries = buildEntryStats(deaths);
  const seen = new Map();

  for (const row of asArray(tickRows)) {
    const steamid = String(row.steamid ?? row.player_steamid ?? '');
    const name = cleanName(row.name ?? row.player_name ?? infoById.get(steamid)?.name ?? 'Unknown');
    const info = infoById.get(steamid) || infoByName.get(name);
    const k = steamid || name;
    if (!k || name === 'Unknown') continue;

    const kills = asNumber(row.kills_total);
    const deathsTotal = asNumber(row.deaths_total);
    const assists = asNumber(row.assists_total);
    const damage = asNumber(row.damage_total);
    const hs = asNumber(row.headshot_kills_total);
    const util = asNumber(row.utility_damage_total);
    const flashed = asNumber(row.enemies_flashed_total);
    const entry = entries.get(name) || { entryKills: 0, openingDeaths: 0 };

    seen.set(k, addDerivedMetrics({
      steamid,
      name,
      teamNumber: asNumber(row.team_num ?? info?.teamNumber, 0),
      teamName: cleanName(row.team_name ?? ''),
      kills,
      deaths: deathsTotal,
      assists,
      headshots: hs,
      damage,
      adr: rounds > 0 ? Number((damage / rounds).toFixed(1)) : 0,
      kd: deathsTotal > 0 ? Number((kills / deathsTotal).toFixed(2)) : kills,
      hsPct: kills > 0 ? Math.round((hs / kills) * 100) : 0,
      utilityDamage: util,
      enemiesFlashed: flashed,
      entryKills: entry.entryKills,
      openingDeaths: entry.openingDeaths,
      impact: Number((kills * 1.0 + assists * 0.35 + entry.entryKills * 0.55 - deathsTotal * 0.52).toFixed(2)),
    }, rounds));
  }

  if (seen.size === 0) {
    for (const p of playerInfo) {
      seen.set(keyOfPlayer(p), {
        steamid: p.steamid,
        name: p.name,
        teamNumber: p.teamNumber,
        teamName: '',
        kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0,
        adr: 0, kd: 0, hsPct: 0, utilityDamage: 0, enemiesFlashed: 0,
        entryKills: entries.get(p.name)?.entryKills || 0,
        openingDeaths: entries.get(p.name)?.openingDeaths || 0,
        impact: 0,
      });
    }
    for (const death of deaths.filter(isEnemyKill)) {
      const attacker = [...seen.values()].find((p) => p.name === death.attacker);
      const victim = [...seen.values()].find((p) => p.name === death.victim);
      const assister = [...seen.values()].find((p) => p.name === death.assister);
      if (attacker && attacker !== victim) {
        attacker.kills++;
        if (death.headshot) attacker.headshots++;
      }
      if (victim) victim.deaths++;
      if (assister && assister !== attacker) assister.assists++;
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

function summarizeRounds(roundEnds) {
  const rows = asArray(roundEnds).filter((r) => !Boolean(pick(r, 'is_warmup_period')));
  const rounds = rows.length;
  const wins = {};
  rows.forEach((r, index) => {
    const winner = cleanName(r.winner ?? r.winner_name ?? r.team ?? 'Unknown');
    wins[winner] = (wins[winner] || 0) + 1;
  });
  return { rounds, wins };
}

function normalizeRoundEnds(rows) {
  return asArray(rows).filter((r) => !Boolean(pick(r, 'is_warmup_period'))).map((r, index) => ({
    round: asNumber(pick(r, 'total_rounds_played'), index) + 1,
    tick: asNumber(r.tick),
    winnerTeamNumber: asNumber(pick(r, 'winner', 'winner_team_num', 'team'), 0),
    reason: cleanName(pick(r, 'reason', 'message')),
  }));
}

function normalizeRoundStarts(rows, rounds) {
  return asArray(rows).filter((r) => !Boolean(pick(r, 'is_warmup_period'))).map((r, index) => ({
    round: asNumber(pick(r, 'total_rounds_played'), index) + 1,
    tick: asNumber(r.tick),
  })).filter((r) => r.tick > 0 && r.round >= 1 && r.round <= rounds);
}

function buildRoundRosters(roundStarts, rosterTicks) {
  const roundByTick = new Map(roundStarts.map((r) => [r.tick, r.round]));
  const rosters = {};
  for (const row of asArray(rosterTicks)) {
    const round = roundByTick.get(asNumber(row.tick));
    if (!round) continue;
    const name = cleanName(row.name ?? row.player_name);
    const teamNumber = asNumber(row.team_num ?? row.team_number, 0);
    if (!name || teamNumber < 2) continue;
    if (!rosters[round]) rosters[round] = [];
    if (!rosters[round].some((p) => p.name === name)) {
      rosters[round].push({
        name,
        steamid: String(row.steamid ?? row.player_steamid ?? ''),
        teamNumber,
        teamName: cleanName(row.team_name ?? ''),
      });
    }
  }
  return rosters;
}

async function parseDemo(filePath, originalName) {
  const header = parseHeader(filePath) || {};
  const playerInfo = normalizePlayerInfo(parsePlayerInfo(filePath));

  let roundEndRows = [];
  try {
    roundEndRows = asArray(parseEvent(filePath, 'round_end', [], ['total_rounds_played', 'is_warmup_period']));
  } catch {
    roundEndRows = asArray(parseEvent(filePath, 'round_end'));
  }
  const roundSummary = summarizeRounds(roundEndRows);
  const normalizedRoundEnds = normalizeRoundEnds(roundEndRows);
  const lastTick = roundEndRows.reduce((max, r) => Math.max(max, asNumber(r.tick)), 0);

  let deathRows = [];
  try {
    deathRows = parseEvent(
      filePath,
      'player_death',
      ['team_name', 'team_num'],
      ['total_rounds_played', 'game_time', 'round_start_time', 'is_warmup_period'],
    );
  } catch {
    try {
      deathRows = parseEvent(filePath, 'player_death', ['team_name'], ['total_rounds_played', 'game_time', 'round_start_time']);
    } catch {
      deathRows = parseEvent(filePath, 'player_death');
    }
  }
  const deaths = normalizeDeaths(deathRows);

  let tickRows = [];
  if (lastTick > 0) {
    const props = [
      'kills_total', 'deaths_total', 'assists_total', 'headshot_kills_total',
      'damage_total', 'utility_damage_total', 'enemies_flashed_total',
      'team_name', 'team_num',
    ];
    try {
      tickRows = parseTicks(filePath, props, [lastTick]);
    } catch (error) {
      console.warn('Aggregate tick stats unavailable:', error?.message || error);
    }
  }

  let rostersByRound = {};
  try {
    const roundStartRows = parseEvent(filePath, 'round_start', [], ['total_rounds_played', 'is_warmup_period']);
    const roundStarts = normalizeRoundStarts(roundStartRows, roundSummary.rounds);
    if (roundStarts.length) {
      const rosterTicks = parseTicks(filePath, ['team_num', 'team_name'], roundStarts.map((r) => r.tick));
      rostersByRound = buildRoundRosters(roundStarts, rosterTicks);
    }
  } catch (error) {
    console.warn('Round rosters unavailable; clutch detection will stay limited:', error?.message || error);
  }

  const basePlayers = aggregateStats(tickRows, playerInfo, roundSummary.rounds, deaths);
  const advanced = computeV5Metrics({
    deaths,
    players: basePlayers,
    rounds: roundSummary.rounds,
    rostersByRound,
    roundEnds: normalizedRoundEnds,
  });
  const players = advanced.players.sort((a, b) => b.impact - a.impact || b.kills - a.kills);
  const best = players[0] || null;

  return {
    fileName: originalName,
    map: header.map_name || 'unknown',
    server: header.server_name || '',
    demoVersion: header.demo_version_name || '',
    networkProtocol: header.network_protocol || '',
    rounds: roundSummary.rounds,
    roundWinsBySide: roundSummary.wins,
    players,
    topPlayer: best,
    timeline: advanced.deaths.slice(0, 500),
    timelineTruncated: advanced.deaths.length > 500,
    dataAvailability: advanced.dataAvailability,
    advancedMetricsVersion: 'v5-trades-kast-clutch-timing',
    parser: '@laihoe/demoparser2',
  };
}

app.get('/api/health', (_req, res) => {
  const aiMode = aiGatewayUrl ? 'gateway' : process.env.OPENAI_API_KEY ? 'direct' : 'none';
  res.json({
    ok: true,
    parser: '@laihoe/demoparser2',
    advancedMetricsVersion: 'v5-trades-kast-clutch-timing',
    aiConfigured: aiMode !== 'none',
    aiMode,
  });
});

app.post('/api/analyze', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл .dem не получен' });
  try {
    const result = await parseDemo(req.file.path, req.file.originalname);
    res.json(result);
  } catch (error) {
    console.error(error);
    const message = String(error?.message || error || 'Unknown parser error');
    res.status(422).json({
      error: 'Не удалось разобрать демку',
      details: message,
      hint: message.includes('EntityNotFound')
        ? 'Эта версия демки может быть несовместима с текущей версией парсера. Обнови зависимости командой npm update и попробуй снова.'
        : 'Проверь, что это полноценная CS2 .dem, а не архив .dem.bz2/.zip.',
    });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

function buildVerifiedMetrics(selected, rounds) {
  if (!selected) return null;
  const openingAttempts = asNumber(selected.entryKills) + asNumber(selected.openingDeaths);
  return {
    kills: asNumber(selected.kills),
    deaths: asNumber(selected.deaths),
    assists: asNumber(selected.assists),
    kd: fixed(selected.kd, 2),
    adr: fixed(selected.adr, 1),
    headshots: asNumber(selected.headshots),
    hsPct: asNumber(selected.hsPct),
    damage: asNumber(selected.damage),
    utilityDamage: asNumber(selected.utilityDamage),
    enemiesFlashed: asNumber(selected.enemiesFlashed),
    entryKills: asNumber(selected.entryKills),
    openingDeaths: asNumber(selected.openingDeaths),
    openingAttempts,
    openingSuccessPct: openingAttempts > 0 ? Math.round((asNumber(selected.entryKills) / openingAttempts) * 100) : null,
    killsPerRound: perRound(selected.kills, rounds),
    deathsPerRound: perRound(selected.deaths, rounds),
    assistsPerRound: perRound(selected.assists, rounds),
    utilityDamagePerRound: perRound(selected.utilityDamage, rounds, 1),
    enemiesFlashedPerRound: perRound(selected.enemiesFlashed, rounds, 2),
    roundSurvivalPctEstimate: rounds > 0
      ? Math.max(0, Math.min(100, Math.round(((rounds - asNumber(selected.deaths)) / rounds) * 100)))
      : null,
    tradeKills: asNumber(selected.tradeKills),
    tradedDeaths: asNumber(selected.tradedDeaths),
    tradedDeathPct: selected.tradedDeathPct ?? null,
    kastRounds: asNumber(selected.kastRounds),
    kastPct: selected.kastPct ?? null,
    twoK: asNumber(selected.twoK),
    threeK: asNumber(selected.threeK),
    fourK: asNumber(selected.fourK),
    fiveK: asNumber(selected.fiveK),
    multiKillRounds: asNumber(selected.multiKillRounds),
    clutchAttempts: asNumber(selected.clutchAttempts),
    clutchWins: asNumber(selected.clutchWins),
    clutchWinPct: selected.clutchWinPct ?? null,
    clutch1v1: asNumber(selected.clutch1v1),
    clutch1v2: asNumber(selected.clutch1v2),
    clutch1v3Plus: asNumber(selected.clutch1v3Plus),
    avgFirstKillTimeSec: selected.avgFirstKillTimeSec ?? null,
    avgDeathTimeSec: selected.avgDeathTimeSec ?? null,
    avgOpeningKillTimeSec: selected.avgOpeningKillTimeSec ?? null,
    avgOpeningDeathTimeSec: selected.avgOpeningDeathTimeSec ?? null,
    avgOpeningDuelTimeSec: selected.avgOpeningDuelTimeSec ?? null,
    customImpact: fixed(selected.impact, 2),
  };
}

function compactMatchForAI(match, selectedSteamid) {
  const selected = match.players?.find((p) => String(p.steamid) === String(selectedSteamid))
    || match.players?.find((p) => p.name === selectedSteamid)
    || match.players?.[0];

  const allRelated = asArray(match.timeline)
    .filter((e) => !selected || e.attacker === selected.name || e.victim === selected.name || e.assister === selected.name || e.tradeOf === selected.name);
  const related = allRelated.slice(0, 80);
  const availability = match.dataAvailability || {};

  return {
    map: match.map,
    rounds: match.rounds,
    selectedPlayer: selected,
    verifiedMetrics: buildVerifiedMetrics(selected, match.rounds),
    metricDefinitions: {
      kd: 'kills / deaths',
      adr: 'total damage / match rounds',
      hsPct: 'headshot kills / kills * 100',
      enemiesFlashed: 'number of enemy flash effects registered by the parser; this is NOT the number of flashbangs thrown',
      openingSuccessPct: 'entryKills / (entryKills + openingDeaths) * 100',
      tradeKills: 'kills within 5 seconds that directly revenge a teammate killed by the victim',
      tradedDeaths: 'deaths revenged by a teammate within 5 seconds',
      kastPct: 'percentage of rounds with Kill, Assist, Survival or Traded death',
      multiKillRounds: 'rounds with at least two kills',
      clutchAttempts: 'rounds where roster tracking shows the player became the sole survivor against at least one opponent',
      clutchWins: 'clutch attempts where the player team won the round',
      avgOpeningDuelTimeSec: 'average seconds from round_start_time to opening duel when selected player was involved',
      customImpact: 'project-specific heuristic, NOT HLTV Rating',
    },
    dataAvailability: {
      killEvents: true,
      exactRoundStartTiming: Boolean(availability.firstContactTiming),
      firstContactTiming: Boolean(availability.firstContactTiming),
      reactionTime: false,
      playerPositions: false,
      tradeDetection: Boolean(availability.tradeDetection),
      clutchDetection: Boolean(availability.clutchDetection),
      economy: false,
      kast: Boolean(availability.kast),
      multikills: Boolean(availability.multikills),
      flashbangsThrown: false,
      utilityCoordinates: false,
      sideSplitMetrics: false,
      timelineTruncated: Boolean(match.timelineTruncated),
      relatedKillEventsTruncated: allRelated.length > related.length,
    },
    scoreboard: asArray(match.players).slice(0, 10),
    relatedKillEvents: related,
  };
}

function strictCoachInstructions() {
  return [
    'Ты CS2-аналитик. Работай как проверяющий статистику, а не как рассказчик.',
    'Используй только verifiedMetrics, scoreboard, relatedKillEvents, metricDefinitions и dataAvailability.',
    'Каждый конкретный вывод должен опираться на числовую метрику или конкретное событие раунда из входных данных.',
    'Никогда не выдумывай время реакции, позиционирование, экономику, сторону T/CT или качество гранат, если dataAvailability говорит false.',
    'Трейды, KAST, multikills, clutch и timing разрешено обсуждать только когда соответствующий dataAvailability=true.',
    'enemiesFlashed означает зарегистрированные эффекты ослепления врагов, а не количество брошенных флешек.',
    'customImpact — внутренний коэффициент проекта, не называй его HLTV Rating.',
    'Не называй K/D 1.0+ низким без явного сравнительного контекста.',
    'Высокий HS% сам по себе не доказывает хорошее принятие решений.',
    'Если метрика недоступна, прямо напиши: данных недостаточно для этого вывода.',
    'Формат ответа: Оценка 0-100; Подтвержденные сильные стороны; Подтвержденные проблемы; Что нельзя заключить из этих данных; 5 действий на тренировку; Короткий вывод.',
  ].join(' ');
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of asArray(data?.output)) {
    for (const content of asArray(item?.content)) {
      if (content?.type === 'output_text' && typeof content.text === 'string') chunks.push(content.text);
      else if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

async function callOpenAIDirect(payload) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY не настроен');
    error.status = 503;
    throw error;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: strictCoachInstructions(),
      input: `Разбери матч только по подтвержденным данным:\n${JSON.stringify(payload)}`,
      max_output_tokens: 1600,
    }),
    signal: AbortSignal.timeout(aiTimeoutMs),
  });

  const data = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const message = data?.error?.message || `OpenAI API HTTP ${apiResponse.status}`;
    const error = new Error(message);
    error.status = apiResponse.status;
    throw error;
  }

  const text = extractOutputText(data);
  if (!text) {
    const error = new Error('OpenAI API вернул ответ без текста');
    error.status = 502;
    throw error;
  }

  return { analysis: text, model, provider: 'openai-direct' };
}

async function callAIGateway(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (aiGatewayToken) headers.Authorization = `Bearer ${aiGatewayToken}`;

  const response = await fetch(`${aiGatewayUrl}/v1/analyze`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ match: payload }),
    signal: AbortSignal.timeout(aiTimeoutMs),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `AI Gateway HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!data?.analysis) {
    const error = new Error('AI Gateway вернул ответ без анализа');
    error.status = 502;
    throw error;
  }
  return data;
}

app.post('/api/ai', async (req, res) => {
  const match = req.body?.match;
  if (!match?.players?.length) return res.status(400).json({ error: 'Нет данных матча для AI-анализа' });

  const payload = compactMatchForAI(match, req.body?.selectedSteamid);
  const mode = aiGatewayUrl ? 'gateway' : process.env.OPENAI_API_KEY ? 'direct' : 'none';

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
    const localGateway = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(aiGatewayUrl);
    const hint = mode === 'direct' && /country|region|territory not supported/i.test(message)
      ? 'Прямой OpenAI-запрос отклонён по региону.'
      : mode === 'gateway' && localGateway
        ? 'Проверь, что локальные Ollama и npm run start:ollama-gateway запущены, а AI_TIMEOUT_MS одинаковый в обоих процессах.'
        : mode === 'gateway'
          ? 'Проверь AI_GATEWAY_URL, AI_GATEWAY_TOKEN и переменные окружения gateway.'
          : undefined;
    res.status(status).json({ error: message, hint });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Демка слишком большая. Лимит: ${maxDemoMb} MB.` });
  }
  res.status(400).json({ error: error?.message || 'Ошибка запроса' });
});

app.listen(port, () => {
  console.log(`CS2 Demo AI Analyzer: http://localhost:${port}`);
  console.log('Advanced metrics: v5-trades-kast-clutch-timing');
  console.log(`AI mode: ${aiGatewayUrl ? `gateway -> ${aiGatewayUrl}` : process.env.OPENAI_API_KEY ? 'direct OpenAI' : 'not configured'}`);
});