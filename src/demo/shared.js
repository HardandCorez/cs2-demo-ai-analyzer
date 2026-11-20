// Общие хелперы парсинга демок CS2. Используются обоими движками
// (fast single-pass и stable multi-pass), чтобы не дублировать код.
// Вынесено из бывших server.js / server-fastcore.js при унификации (5.0.0).

import { parseTicks } from '@laihoe/demoparser2';

export const asArray = (value) => (Array.isArray(value) ? value : []);
export const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
export const fixed = (value, digits = 2) => Number(asNumber(value).toFixed(digits));
export const perRound = (value, rounds, digits = 2) => (rounds > 0 ? fixed(asNumber(value) / rounds, digits) : 0);
export const cleanName = (value) => String(value ?? '').trim();

export function keyOfPlayer(row) {
  return String(row?.steamid ?? row?.steam_id ?? row?.player_steamid ?? row?.name ?? '');
}

export function normalizePlayerInfo(rows) {
  return asArray(rows).map((row) => ({
    steamid: String(row.steamid ?? row.steam_id ?? ''),
    name: cleanName(row.name ?? row.player_name ?? 'Unknown'),
    teamNumber: asNumber(row.team_number ?? row.team_num, 0),
  })).filter((p) => p.steamid || p.name !== 'Unknown');
}

export function pick(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  }
  return undefined;
}

export function normalizeDeaths(rows) {
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

export function isEnemyKill(e) {
  if (!e?.attacker || !e?.victim || e.attacker === e.victim) return false;
  if (e.attackerTeam && e.victimTeam && e.attackerTeam === e.victimTeam) return false;
  if (e.attackerTeamNumber > 0 && e.victimTeamNumber > 0 && e.attackerTeamNumber === e.victimTeamNumber) return false;
  return true;
}

export function buildEntryStats(deaths) {
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

export function addDerivedMetrics(player, rounds) {
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

export function aggregateStats(tickRows, playerInfo, rounds, deaths) {
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
        kills: 0,
        deaths: 0,
        assists: 0,
        headshots: 0,
        damage: 0,
        adr: 0,
        kd: 0,
        hsPct: 0,
        utilityDamage: 0,
        enemiesFlashed: 0,
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
        attacker.kills += 1;
        if (death.headshot) attacker.headshots += 1;
      }
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

export function summarizeRounds(roundEnds) {
  const rows = asArray(roundEnds).filter((r) => !Boolean(pick(r, 'is_warmup_period')));
  const rounds = rows.length;
  const wins = {};
  for (const r of rows) {
    const winner = cleanName(r.winner ?? r.winner_name ?? r.team ?? 'Unknown');
    wins[winner] = (wins[winner] || 0) + 1;
  }
  return { rounds, wins };
}

export function normalizeRoundEnds(rows) {
  return asArray(rows).filter((r) => !Boolean(pick(r, 'is_warmup_period'))).map((r, index) => ({
    round: asNumber(pick(r, 'total_rounds_played'), index) + 1,
    tick: asNumber(r.tick),
    winnerTeamNumber: asNumber(pick(r, 'winner', 'winner_team_num', 'team'), 0),
    reason: cleanName(pick(r, 'reason', 'message')),
  }));
}

export function normalizeRoundStarts(rows, rounds) {
  return asArray(rows).filter((r) => !Boolean(pick(r, 'is_warmup_period'))).map((r, index) => ({
    round: asNumber(pick(r, 'total_rounds_played'), index) + 1,
    tick: asNumber(r.tick),
  })).filter((r) => r.tick > 0 && r.round >= 1 && r.round <= rounds);
}

export function buildRoundRosters(roundStarts, rosterTicks) {
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

export function uniquePositiveTicks(events) {
  return [...new Set(asArray(events).map((event) => asNumber(event.tick)).filter((tick) => tick > 0))];
}

export function parsePositionSnapshots(filePath, deaths) {
  const ticks = uniquePositiveTicks(deaths);
  if (!ticks.length) return [];

  const fullProps = [
    'X', 'Y', 'Z',
    'velocity', 'velocity_X', 'velocity_Y',
    'yaw', 'team_num', 'team_name', 'is_alive',
    'is_walking', 'is_scoped', 'flash_duration', 'last_place_name',
  ];
  try {
    return parseTicks(filePath, fullProps, ticks);
  } catch (error) {
    console.warn('Full position snapshot unavailable, retrying minimal coordinates:', error?.message || error);
    try {
      return parseTicks(filePath, ['X', 'Y', 'Z', 'team_num', 'team_name', 'is_alive'], ticks);
    } catch (fallbackError) {
      console.warn('Coordinate snapshots unavailable:', fallbackError?.message || fallbackError);
      return [];
    }
  }
}
