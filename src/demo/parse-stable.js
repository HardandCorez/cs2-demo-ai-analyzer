// Стабильный (multi-pass) парсер демок. Бывшее тело server.js.
// Fallback: используется только если быстрый движок не справился с демкой.

import { parseEvent, parseHeader, parsePlayerInfo, parseTicks } from '@laihoe/demoparser2';
import { computeV5Metrics } from '../v5-metrics.js';
import { computeV6Positioning } from '../v6-positioning.js';
import {
  asArray, asNumber, cleanName, normalizePlayerInfo, pick, normalizeDeaths,
  summarizeRounds, normalizeRoundEnds, normalizeRoundStarts, buildRoundRosters,
  parsePositionSnapshots, aggregateStats,
} from './shared.js';

export async function parseDemoStable(filePath, originalName) {
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

  const positionSnapshotRows = parsePositionSnapshots(filePath, advanced.deaths);
  const positional = computeV6Positioning({
    deaths: advanced.deaths,
    players: advanced.players,
    snapshotRows: positionSnapshotRows,
  });

  const players = positional.players.sort((a, b) => b.impact - a.impact || b.kills - a.kills);
  const best = players[0] || null;
  const dataAvailability = {
    ...advanced.dataAvailability,
    ...positional.dataAvailability,
  };

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
    timeline: positional.deaths.slice(0, 500),
    timelineTruncated: positional.deaths.length > 500,
    dataAvailability,
    positioning: positional.positioning,
    advancedMetricsVersion: 'v6-positioning-context',
    parser: '@laihoe/demoparser2',
  };
}
