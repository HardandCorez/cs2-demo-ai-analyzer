const asArray = (value) => (Array.isArray(value) ? value : []);
const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const fixed = (value, digits = 1) => Number(Number(value).toFixed(digits));

const ISOLATED_DISTANCE_UNITS = 900;
const HIGH_SPEED_UNITS = 140;
const OUTSIDE_FRONT_DEGREES = 75;

function cleanName(value) {
  return String(value ?? '').trim();
}

function positionOf(row) {
  const x = finite(row?.X ?? row?.x);
  const y = finite(row?.Y ?? row?.y);
  const z = finite(row?.Z ?? row?.z);
  if (x === null || y === null) return null;
  return { x, y, z: z ?? 0 };
}

function speedOf(row) {
  const direct = finite(row?.velocity);
  if (direct !== null) return Math.abs(direct);
  const vx = finite(row?.velocity_X);
  const vy = finite(row?.velocity_Y);
  if (vx === null || vy === null) return null;
  return Math.hypot(vx, vy);
}

function distance2d(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDelta(a, b) {
  let delta = Math.abs(a - b) % 360;
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function facingError(victimRow, victimPos, attackerPos) {
  const yaw = finite(victimRow?.yaw);
  if (yaw === null || !victimPos || !attackerPos) return null;
  const bearing = Math.atan2(attackerPos.y - victimPos.y, attackerPos.x - victimPos.x) * 180 / Math.PI;
  return angleDelta(yaw, bearing);
}

function normalizeSnapshot(row) {
  const pos = positionOf(row);
  return {
    tick: asNumber(row?.tick),
    name: cleanName(row?.name ?? row?.player_name),
    steamid: String(row?.steamid ?? row?.player_steamid ?? ''),
    teamNumber: asNumber(row?.team_num ?? row?.team_number, 0),
    teamName: cleanName(row?.team_name),
    pos,
    speed: speedOf(row),
    yaw: finite(row?.yaw),
    flashDuration: finite(row?.flash_duration),
    isWalking: row?.is_walking === undefined ? null : Boolean(row.is_walking),
    isScoped: row?.is_scoped === undefined ? null : Boolean(row.is_scoped),
    isAlive: row?.is_alive === undefined ? null : Boolean(row.is_alive),
    lastPlaceName: cleanName(row?.last_place_name),
  };
}

function samePlayer(snapshot, name, steamid) {
  if (!snapshot) return false;
  if (steamid && snapshot.steamid) return String(snapshot.steamid) === String(steamid);
  return snapshot.name === name;
}

function findPlayer(rows, name, steamid) {
  return rows.find((row) => samePlayer(row, name, steamid)) || rows.find((row) => row.name === name) || null;
}

function teammateRows(rows, subject) {
  if (!subject) return [];
  return rows.filter((row) => {
    if (!row.pos || row.name === subject.name) return false;
    if (row.isAlive === false) return false;
    if (subject.teamNumber > 0 && row.teamNumber > 0) return row.teamNumber === subject.teamNumber;
    if (subject.teamName && row.teamName) return row.teamName === subject.teamName;
    return false;
  });
}

function nearestDistance(subject, candidates) {
  if (!subject?.pos) return null;
  let best = null;
  for (const row of candidates) {
    const d = distance2d(subject.pos, row.pos);
    if (d === null) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

function boundsFromSnapshots(rows) {
  const points = rows.map((row) => row.pos).filter(Boolean);
  if (!points.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const padX = spanX * 0.06;
  const padY = spanY * 0.06;
  return {
    minX: fixed(minX - padX, 1),
    maxX: fixed(maxX + padX, 1),
    minY: fixed(minY - padY, 1),
    maxY: fixed(maxY + padY, 1),
  };
}

function percentage(count, total) {
  return total > 0 ? Math.round((count / total) * 100) : null;
}

function average(values, digits = 1) {
  const nums = asArray(values).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return fixed(nums.reduce((sum, n) => sum + n, 0) / nums.length, digits);
}

function placeSummary(points) {
  const counts = new Map();
  for (const point of points) {
    const place = cleanName(point.place);
    if (!place) continue;
    counts.set(place, (counts.get(place) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([place, count]) => ({ place, count }))
    .sort((a, b) => b.count - a.count || a.place.localeCompare(b.place))
    .slice(0, 5);
}

export function computeV6Positioning({ deaths: rawDeaths, players: rawPlayers, snapshotRows: rawSnapshotRows }) {
  const snapshots = asArray(rawSnapshotRows).map(normalizeSnapshot).filter((row) => row.tick > 0 && row.name);
  const byTick = new Map();
  for (const row of snapshots) {
    if (!byTick.has(row.tick)) byTick.set(row.tick, []);
    byTick.get(row.tick).push(row);
  }

  const deaths = asArray(rawDeaths).map((event) => {
    const rows = byTick.get(asNumber(event.tick)) || [];
    const victimRow = findPlayer(rows, event.victim, event.victimSteamid);
    const attackerRow = findPlayer(rows, event.attacker, event.attackerSteamid);
    const victimPos = victimRow?.pos || null;
    const attackerPos = attackerRow?.pos || null;
    const nearestTeammateDistance = nearestDistance(victimRow, teammateRows(rows, victimRow));
    const duelDistance = distance2d(victimPos, attackerPos);
    const viewError = facingError(victimRow, victimPos, attackerPos);

    return {
      ...event,
      victimPosition: victimPos,
      attackerPosition: attackerPos,
      victimPlace: victimRow?.lastPlaceName || '',
      attackerPlace: attackerRow?.lastPlaceName || '',
      nearestTeammateDistance: nearestTeammateDistance === null ? null : fixed(nearestTeammateDistance, 1),
      duelDistance: duelDistance === null ? null : fixed(duelDistance, 1),
      victimVelocity: victimRow?.speed === null || victimRow?.speed === undefined ? null : fixed(victimRow.speed, 1),
      victimFlashed: victimRow?.flashDuration === null || victimRow?.flashDuration === undefined ? null : victimRow.flashDuration > 0.05,
      victimFlashDuration: victimRow?.flashDuration === null || victimRow?.flashDuration === undefined ? null : fixed(victimRow.flashDuration, 2),
      victimFacingErrorDeg: viewError === null ? null : fixed(viewError, 1),
      victimWalking: victimRow?.isWalking ?? null,
      victimScoped: victimRow?.isScoped ?? null,
    };
  });

  const players = asArray(rawPlayers).map((player) => {
    const playerDeaths = deaths.filter((event) => event.victim === player.name && event.victimPosition);
    const playerKills = deaths.filter((event) => event.attacker === player.name && event.attackerPosition);
    const spacingSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.nearestTeammateDistance)));
    const movementSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.victimVelocity)));
    const flashSamples = playerDeaths.filter((event) => event.victimFlashed !== null);
    const facingSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.victimFacingErrorDeg)));
    const duelSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.duelDistance)));

    const isolatedDeathsHeuristic = spacingSamples.filter((event) => event.nearestTeammateDistance > ISOLATED_DISTANCE_UNITS).length;
    const highSpeedDeaths = movementSamples.filter((event) => event.victimVelocity > HIGH_SPEED_UNITS).length;
    const flashedDeaths = flashSamples.filter((event) => event.victimFlashed).length;
    const attackerOutsideFrontDeaths = facingSamples.filter((event) => event.victimFacingErrorDeg > OUTSIDE_FRONT_DEGREES).length;
    const places = placeSummary(playerDeaths.map((event) => ({ place: event.victimPlace })));
    const topPlace = places[0] || null;

    return {
      ...player,
      positionSamples: playerDeaths.length,
      spacingSamples: spacingSamples.length,
      avgNearestTeammateDistanceAtDeath: average(spacingSamples.map((event) => event.nearestTeammateDistance), 1),
      isolatedDeathsHeuristic,
      isolatedDeathPct: percentage(isolatedDeathsHeuristic, spacingSamples.length),
      movementDeathSamples: movementSamples.length,
      avgVelocityAtDeath: average(movementSamples.map((event) => event.victimVelocity), 1),
      highSpeedDeaths,
      highSpeedDeathPct: percentage(highSpeedDeaths, movementSamples.length),
      flashedDeathSamples: flashSamples.length,
      flashedDeaths,
      flashedDeathPct: percentage(flashedDeaths, flashSamples.length),
      facingDeathSamples: facingSamples.length,
      attackerOutsideFrontDeaths,
      attackerOutsideFrontPct: percentage(attackerOutsideFrontDeaths, facingSamples.length),
      avgFacingErrorAtDeathDeg: average(facingSamples.map((event) => event.victimFacingErrorDeg), 1),
      duelDistanceSamples: duelSamples.length,
      avgDuelDistanceAtDeath: average(duelSamples.map((event) => event.duelDistance), 1),
      topDeathPlace: topPlace?.place || '',
      topDeathPlaceDeaths: topPlace?.count || 0,
      topDeathPlacePct: percentage(topPlace?.count || 0, playerDeaths.length),
      deathPlaces: places,
    };
  });

  const positioningPlayers = {};
  for (const player of players) {
    const playerDeaths = deaths.filter((event) => event.victim === player.name && event.victimPosition).map((event) => ({
      x: event.victimPosition.x,
      y: event.victimPosition.y,
      z: event.victimPosition.z,
      round: event.round,
      tick: event.tick,
      secondsIntoRound: event.secondsIntoRound,
      place: event.victimPlace || '',
      nearestTeammateDistance: event.nearestTeammateDistance,
      velocity: event.victimVelocity,
      flashed: event.victimFlashed,
      facingErrorDeg: event.victimFacingErrorDeg,
      duelDistance: event.duelDistance,
      weapon: event.weapon,
    }));
    const playerKills = deaths.filter((event) => event.attacker === player.name && event.attackerPosition).map((event) => ({
      x: event.attackerPosition.x,
      y: event.attackerPosition.y,
      z: event.attackerPosition.z,
      round: event.round,
      tick: event.tick,
      secondsIntoRound: event.secondsIntoRound,
      place: event.attackerPlace || '',
      weapon: event.weapon,
      headshot: event.headshot,
    }));
    positioningPlayers[player.name] = { deaths: playerDeaths, kills: playerKills };
  }

  const hasPositions = deaths.some((event) => event.victimPosition || event.attackerPosition);
  const spacingSamples = players.reduce((sum, player) => sum + asNumber(player.spacingSamples), 0);
  const movementSamples = players.reduce((sum, player) => sum + asNumber(player.movementDeathSamples), 0);
  const flashSamples = players.reduce((sum, player) => sum + asNumber(player.flashedDeathSamples), 0);
  const facingSamples = players.reduce((sum, player) => sum + asNumber(player.facingDeathSamples), 0);
  const placeSamples = players.reduce((sum, player) => sum + asNumber(player.topDeathPlaceDeaths), 0);

  return {
    players,
    deaths,
    positioning: {
      bounds: boundsFromSnapshots(snapshots),
      thresholds: {
        isolatedDistanceUnits: ISOLATED_DISTANCE_UNITS,
        highSpeedUnitsPerSec: HIGH_SPEED_UNITS,
        outsideFrontDegrees: OUTSIDE_FRONT_DEGREES,
      },
      players: positioningPlayers,
      note: 'Координатная проекция нормализована по событиям матча и не содержит геометрию карты, стены или этажи.',
    },
    dataAvailability: {
      playerPositions: hasPositions,
      positionalHeatmap: hasPositions,
      teammateSpacing: spacingSamples > 0,
      movementAtDeath: movementSamples > 0,
      flashedAtDeath: flashSamples > 0,
      facingAtDeath: facingSamples > 0,
      placeNames: placeSamples > 0,
      widePeekDetection: false,
      repeekDetection: false,
      lineOfSight: false,
      navMesh: false,
    },
  };
}
