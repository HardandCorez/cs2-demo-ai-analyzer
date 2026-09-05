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

// V6.1 peek heuristics. These are intentionally conservative and are NOT
// line-of-sight/navmesh aware. They are filters for demo review, not proof.
const WIDE_PEEK_SPEED_UNITS = 150;
const WIDE_PEEK_LATERAL_RATIO = 0.72;
const WIDE_PEEK_MIN_DUEL_DISTANCE = 150;
const WIDE_PEEK_MAX_DUEL_DISTANCE = 3500;
const REPEEK_MIN_DELAY_SEC = 1.0;
const REPEEK_MAX_DELAY_SEC = 8.0;
const REPEEK_MAX_DISTANCE_UNITS = 450;

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

function velocityVectorOf(row) {
  const vx = finite(row?.velocity_X);
  const vy = finite(row?.velocity_Y);
  if (vx === null || vy === null) return null;
  return { x: vx, y: vy };
}

function speedOf(row) {
  const direct = finite(row?.velocity);
  if (direct !== null) return Math.abs(direct);
  const vector = velocityVectorOf(row);
  if (!vector) return null;
  return Math.hypot(vector.x, vector.y);
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
  const velocityVector = velocityVectorOf(row);
  return {
    tick: asNumber(row?.tick),
    name: cleanName(row?.name ?? row?.player_name),
    steamid: String(row?.steamid ?? row?.player_steamid ?? ''),
    teamNumber: asNumber(row?.team_num ?? row?.team_number, 0),
    teamName: cleanName(row?.team_name),
    pos,
    speed: speedOf(row),
    velocityVector,
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

function widePeekGeometry(subjectRow, opponentPos) {
  if (!subjectRow?.pos || !opponentPos || !subjectRow.velocityVector) {
    return { evaluable: false, like: false, lateralRatio: null, radialRatio: null };
  }

  const vx = subjectRow.velocityVector.x;
  const vy = subjectRow.velocityVector.y;
  const speed = Math.hypot(vx, vy);
  const dx = opponentPos.x - subjectRow.pos.x;
  const dy = opponentPos.y - subjectRow.pos.y;
  const distance = Math.hypot(dx, dy);
  if (speed < 1 || distance < 1) {
    return { evaluable: true, like: false, lateralRatio: 0, radialRatio: 0 };
  }

  const ux = dx / distance;
  const uy = dy / distance;
  const lateralSpeed = Math.abs(vx * uy - vy * ux);
  const radialSpeed = Math.abs(vx * ux + vy * uy);
  const lateralRatio = lateralSpeed / speed;
  const radialRatio = radialSpeed / speed;
  const duelDistanceOk = distance >= WIDE_PEEK_MIN_DUEL_DISTANCE && distance <= WIDE_PEEK_MAX_DUEL_DISTANCE;
  const like = duelDistanceOk
    && speed >= WIDE_PEEK_SPEED_UNITS
    && lateralRatio >= WIDE_PEEK_LATERAL_RATIO
    && subjectRow.isWalking !== true;

  return {
    evaluable: true,
    like,
    lateralRatio: fixed(lateralRatio, 2),
    radialRatio: fixed(radialRatio, 2),
    lateralSpeed: fixed(lateralSpeed, 1),
    radialSpeed: fixed(radialSpeed, 1),
  };
}

function estimateTickRate(events) {
  const rows = asArray(events)
    .filter((event) => Number.isFinite(Number(event.tick)) && Number.isFinite(Number(event.gameTime)))
    .sort((a, b) => Number(a.tick) - Number(b.tick));
  const rates = [];
  for (let i = 1; i < rows.length; i += 1) {
    const tickDelta = Number(rows[i].tick) - Number(rows[i - 1].tick);
    const timeDelta = Number(rows[i].gameTime) - Number(rows[i - 1].gameTime);
    if (tickDelta <= 0 || timeDelta <= 0.2 || timeDelta > 60) continue;
    const rate = tickDelta / timeDelta;
    if (rate >= 30 && rate <= 128) rates.push(rate);
  }
  if (!rates.length) return 64;
  rates.sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)];
}

function eventDeltaSeconds(current, previous, tickRate) {
  if (current?.round !== previous?.round) return null;
  const a = finite(current?.secondsIntoRound);
  const b = finite(previous?.secondsIntoRound);
  if (a !== null && b !== null) return a - b;
  const tickDelta = asNumber(current?.tick) - asNumber(previous?.tick);
  return tickDelta > 0 ? tickDelta / Math.max(1, tickRate) : null;
}

function sameArea(currentPos, previousPos, currentPlace, previousPlace) {
  const distance = distance2d(currentPos, previousPos);
  if (distance !== null && distance <= REPEEK_MAX_DISTANCE_UNITS) return { same: true, distance };
  const a = cleanName(currentPlace);
  const b = cleanName(previousPlace);
  if (a && b && a === b) return { same: true, distance };
  return { same: false, distance };
}

function annotatePostKillRepeeks(events) {
  const tickRate = estimateTickRate(events);
  const byRound = new Map();
  for (const event of events) {
    if (!byRound.has(event.round)) byRound.set(event.round, []);
    byRound.get(event.round).push(event);
  }

  return events.map((event) => {
    const prior = asArray(byRound.get(event.round))
      .filter((candidate) => candidate.tick < event.tick && candidate.attacker === event.victim && candidate.attackerPosition)
      .map((candidate) => ({ candidate, deltaSec: eventDeltaSeconds(event, candidate, tickRate) }))
      .filter(({ deltaSec }) => deltaSec !== null && deltaSec >= REPEEK_MIN_DELAY_SEC && deltaSec <= REPEEK_MAX_DELAY_SEC)
      .sort((a, b) => b.candidate.tick - a.candidate.tick)[0];

    if (!prior) {
      return {
        ...event,
        repeekEligible: false,
        repeekLike: false,
        repeekDeltaSec: null,
        repeekDistanceUnits: null,
        repeekPriorVictim: '',
      };
    }

    const area = sameArea(
      event.victimPosition,
      prior.candidate.attackerPosition,
      event.victimPlace,
      prior.candidate.attackerPlace,
    );

    return {
      ...event,
      repeekEligible: true,
      repeekLike: area.same,
      repeekDeltaSec: fixed(prior.deltaSec, 2),
      repeekDistanceUnits: area.distance === null ? null : fixed(area.distance, 1),
      repeekPriorVictim: prior.candidate.victim || '',
    };
  });
}

export function computeV6Positioning({ deaths: rawDeaths, players: rawPlayers, snapshotRows: rawSnapshotRows }) {
  const snapshots = asArray(rawSnapshotRows).map(normalizeSnapshot).filter((row) => row.tick > 0 && row.name);
  const byTick = new Map();
  for (const row of snapshots) {
    if (!byTick.has(row.tick)) byTick.set(row.tick, []);
    byTick.get(row.tick).push(row);
  }

  const enrichedDeaths = asArray(rawDeaths).map((event) => {
    const rows = byTick.get(asNumber(event.tick)) || [];
    const victimRow = findPlayer(rows, event.victim, event.victimSteamid);
    const attackerRow = findPlayer(rows, event.attacker, event.attackerSteamid);
    const victimPos = victimRow?.pos || null;
    const attackerPos = attackerRow?.pos || null;
    const nearestTeammateDistance = nearestDistance(victimRow, teammateRows(rows, victimRow));
    const duelDistance = distance2d(victimPos, attackerPos);
    const viewError = facingError(victimRow, victimPos, attackerPos);
    const victimPeek = widePeekGeometry(victimRow, attackerPos);
    const attackerPeek = widePeekGeometry(attackerRow, victimPos);

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
      victimWidePeekEvaluable: victimPeek.evaluable,
      victimWidePeekLike: victimPeek.like,
      victimWidePeekLateralRatio: victimPeek.lateralRatio,
      victimWidePeekLateralSpeed: victimPeek.lateralSpeed ?? null,
      attackerWidePeekEvaluable: attackerPeek.evaluable,
      attackerWidePeekLike: attackerPeek.like,
      attackerWidePeekLateralRatio: attackerPeek.lateralRatio,
    };
  });

  const deaths = annotatePostKillRepeeks(enrichedDeaths);

  const players = asArray(rawPlayers).map((player) => {
    const playerDeaths = deaths.filter((event) => event.victim === player.name && event.victimPosition);
    const playerKills = deaths.filter((event) => event.attacker === player.name && event.attackerPosition);
    const spacingSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.nearestTeammateDistance)));
    const movementSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.victimVelocity)));
    const flashSamples = playerDeaths.filter((event) => event.victimFlashed !== null);
    const facingSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.victimFacingErrorDeg)));
    const duelSamples = playerDeaths.filter((event) => Number.isFinite(Number(event.duelDistance)));
    const widePeekSamples = playerDeaths.filter((event) => event.victimWidePeekEvaluable);
    const widePeekLikeDeaths = widePeekSamples.filter((event) => event.victimWidePeekLike);
    const widePeekKillSamples = playerKills.filter((event) => event.attackerWidePeekEvaluable);
    const widePeekLikeKills = widePeekKillSamples.filter((event) => event.attackerWidePeekLike);
    const repeekEligible = playerDeaths.filter((event) => event.repeekEligible);
    const repeekLikeDeaths = repeekEligible.filter((event) => event.repeekLike);

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

      // V6.1 peek heuristics.
      widePeekSamples: widePeekSamples.length,
      widePeekLikeDeaths: widePeekLikeDeaths.length,
      widePeekLikeDeathPct: percentage(widePeekLikeDeaths.length, widePeekSamples.length),
      avgWidePeekLateralRatio: average(widePeekSamples.map((event) => event.victimWidePeekLateralRatio), 2),
      widePeekLikeDeathRounds: widePeekLikeDeaths.map((event) => event.round).slice(0, 12),
      widePeekKillSamples: widePeekKillSamples.length,
      widePeekLikeKills: widePeekLikeKills.length,
      widePeekLikeKillPct: percentage(widePeekLikeKills.length, widePeekKillSamples.length),
      repeekEligibleSamples: repeekEligible.length,
      repeekLikeDeaths: repeekLikeDeaths.length,
      repeekLikePct: percentage(repeekLikeDeaths.length, repeekEligible.length),
      avgRepeekDelaySec: average(repeekLikeDeaths.map((event) => event.repeekDeltaSec), 2),
      repeekLikeDeathRounds: repeekLikeDeaths.map((event) => event.round).slice(0, 12),
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
      widePeekLike: Boolean(event.victimWidePeekLike),
      widePeekLateralRatio: event.victimWidePeekLateralRatio,
      repeekEligible: Boolean(event.repeekEligible),
      repeekLike: Boolean(event.repeekLike),
      repeekDeltaSec: event.repeekDeltaSec,
      repeekDistanceUnits: event.repeekDistanceUnits,
      repeekPriorVictim: event.repeekPriorVictim,
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
      widePeekLike: Boolean(event.attackerWidePeekLike),
      widePeekLateralRatio: event.attackerWidePeekLateralRatio,
    }));
    positioningPlayers[player.name] = { deaths: playerDeaths, kills: playerKills };
  }

  const hasPositions = deaths.some((event) => event.victimPosition || event.attackerPosition);
  const spacingSamples = players.reduce((sum, player) => sum + asNumber(player.spacingSamples), 0);
  const movementSamples = players.reduce((sum, player) => sum + asNumber(player.movementDeathSamples), 0);
  const flashSamples = players.reduce((sum, player) => sum + asNumber(player.flashedDeathSamples), 0);
  const facingSamples = players.reduce((sum, player) => sum + asNumber(player.facingDeathSamples), 0);
  const placeSamples = players.reduce((sum, player) => sum + asNumber(player.topDeathPlaceDeaths), 0);
  const widePeekSamples = players.reduce((sum, player) => sum + asNumber(player.widePeekSamples), 0);
  const repeekEligibleSamples = players.reduce((sum, player) => sum + asNumber(player.repeekEligibleSamples), 0);

  return {
    players,
    deaths,
    positioning: {
      bounds: boundsFromSnapshots(snapshots),
      thresholds: {
        isolatedDistanceUnits: ISOLATED_DISTANCE_UNITS,
        highSpeedUnitsPerSec: HIGH_SPEED_UNITS,
        outsideFrontDegrees: OUTSIDE_FRONT_DEGREES,
        widePeekSpeedUnitsPerSec: WIDE_PEEK_SPEED_UNITS,
        widePeekLateralRatio: WIDE_PEEK_LATERAL_RATIO,
        widePeekMinDuelDistanceUnits: WIDE_PEEK_MIN_DUEL_DISTANCE,
        widePeekMaxDuelDistanceUnits: WIDE_PEEK_MAX_DUEL_DISTANCE,
        repeekMinDelaySec: REPEEK_MIN_DELAY_SEC,
        repeekMaxDelaySec: REPEEK_MAX_DELAY_SEC,
        repeekMaxDistanceUnits: REPEEK_MAX_DISTANCE_UNITS,
      },
      players: positioningPlayers,
      note: 'V6.1: heatmap + spacing + wide-peek-like и post-kill repeek-like эвристики. Координатная проекция не содержит геометрию карты, стены, этажи, navmesh или line-of-sight.',
    },
    dataAvailability: {
      playerPositions: hasPositions,
      positionalHeatmap: hasPositions,
      teammateSpacing: spacingSamples > 0,
      movementAtDeath: movementSamples > 0,
      flashedAtDeath: flashSamples > 0,
      facingAtDeath: facingSamples > 0,
      placeNames: placeSamples > 0,
      widePeekHeuristic: widePeekSamples > 0,
      repeekHeuristic: repeekEligibleSamples > 0,
      // Confirmed detection remains false until we add map geometry/LOS and richer combat state.
      widePeekDetection: false,
      repeekDetection: false,
      lineOfSight: false,
      navMesh: false,
    },
  };
}
