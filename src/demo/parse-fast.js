// Быстрый (single-pass combined parseTicks) парсер демок. Бывшее server-fastcore.js.
// Если combined-проход падает, сам делает совместимый fallback по частям.

import { parseEvent, parseHeader, parsePlayerInfo, parseTicks } from '@laihoe/demoparser2';
import { computeV5Metrics } from '../v5-metrics.js';
import { computeV6Positioning } from '../v6-positioning.js';
import {
  asArray, asNumber, cleanName, normalizePlayerInfo, pick, normalizeDeaths,
  summarizeRounds, normalizeRoundEnds, normalizeRoundStarts, buildRoundRosters,
  uniquePositiveTicks, aggregateStats,
} from './shared.js';

const now = () => performance.now();
const ms = (start) => Math.round(performance.now() - start);

function parseCombinedTicks(filePath, lastTick, roundStarts, deaths) {
  const statProps = ['kills_total', 'deaths_total', 'assists_total', 'headshot_kills_total', 'damage_total', 'utility_damage_total', 'enemies_flashed_total'];
  const posProps = ['X', 'Y', 'Z', 'velocity', 'velocity_X', 'velocity_Y', 'yaw', 'team_num', 'team_name', 'is_alive', 'is_walking', 'is_scoped', 'flash_duration', 'last_place_name'];
  const props = [...new Set([...statProps, ...posProps])];
  const rosterTicks = uniquePositiveTicks(roundStarts);
  const deathTicks = uniquePositiveTicks(deaths);
  const ticks = [...new Set([lastTick, ...rosterTicks, ...deathTicks].filter((t) => t > 0))].sort((a, b) => a - b);
  if (!ticks.length) return { mode: 'none', rows: [], tickRows: [], rosterRows: [], positionRows: [] };

  try {
    const rows = asArray(parseTicks(filePath, props, ticks));
    const rosterSet = new Set(rosterTicks), deathSet = new Set(deathTicks);
    return {
      mode: 'single-pass',
      rows,
      tickRows: lastTick > 0 ? rows.filter((r) => asNumber(r.tick) === lastTick) : [],
      rosterRows: rows.filter((r) => rosterSet.has(asNumber(r.tick))),
      positionRows: rows.filter((r) => deathSet.has(asNumber(r.tick))),
      requestedTicks: ticks.length,
    };
  } catch (error) {
    console.warn('[FAST CORE] combined parseTicks failed; compatibility fallback:', error?.message || error);
    let tickRows = [], rosterRows = [], positionRows = [];
    if (lastTick > 0) {
      try { tickRows = asArray(parseTicks(filePath, [...statProps, 'team_name', 'team_num'], [lastTick])); } catch (e) { console.warn('[FAST CORE] stats fallback failed:', e?.message || e); }
    }
    if (rosterTicks.length) {
      try { rosterRows = asArray(parseTicks(filePath, ['team_num', 'team_name'], rosterTicks)); } catch (e) { console.warn('[FAST CORE] roster fallback failed:', e?.message || e); }
    }
    if (deathTicks.length) {
      try { positionRows = asArray(parseTicks(filePath, posProps, deathTicks)); }
      catch (e) {
        console.warn('[FAST CORE] position rich fallback failed:', e?.message || e);
        try { positionRows = asArray(parseTicks(filePath, ['X', 'Y', 'Z', 'team_num', 'team_name', 'is_alive'], deathTicks)); } catch {}
      }
    }
    return { mode: 'compat-fallback', rows: [], tickRows, rosterRows, positionRows, requestedTicks: ticks.length };
  }
}

export async function parseDemoFast(filePath, originalName) {
  const totalStart = now();
  const timings = {};

  let t = now();
  const header = parseHeader(filePath) || {};
  const playerInfo = normalizePlayerInfo(parsePlayerInfo(filePath));
  timings.headerAndPlayers = ms(t);

  t = now();
  let roundEndRows = [];
  try { roundEndRows = asArray(parseEvent(filePath, 'round_end', [], ['total_rounds_played', 'is_warmup_period'])); }
  catch { roundEndRows = asArray(parseEvent(filePath, 'round_end')); }
  const roundSummary = summarizeRounds(roundEndRows);
  const normalizedRoundEnds = normalizeRoundEnds(roundEndRows);
  const lastTick = roundEndRows.reduce((max, r) => Math.max(max, asNumber(r.tick)), 0);

  let roundStartRows = [];
  try { roundStartRows = asArray(parseEvent(filePath, 'round_start', [], ['total_rounds_played', 'is_warmup_period'])); }
  catch { try { roundStartRows = asArray(parseEvent(filePath, 'round_start')); } catch {} }
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
      engine: 'fast-core',
      tickPassMode: combined.mode,
      requestedTicks: combined.requestedTicks || 0,
      timingsMs: timings,
    },
  };
}
