const asArray = (value) => (Array.isArray(value) ? value : []);
const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const fixed = (value, digits = 2) => Number(Number(value).toFixed(digits));

export const TRAJECTORY_SECONDS = 3;
export const TRAJECTORY_SAMPLES = 13;

function cleanName(value) {
  return String(value ?? '').trim();
}

export function estimateTickRate(events) {
  const rows = asArray(events)
    .filter((event) => Number.isFinite(Number(event?.tick)) && Number.isFinite(Number(event?.gameTime)))
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

export function trajectoryTicksForDeaths(deaths, tickRate, seconds = TRAJECTORY_SECONDS, samples = TRAJECTORY_SAMPLES) {
  const rate = Math.max(1, Number(tickRate) || 64);
  const count = Math.max(2, Math.round(samples));
  const backTicks = Math.max(1, Math.round(seconds * rate));
  const ticks = new Set();
  for (const death of asArray(deaths)) {
    const deathTick = asNumber(death?.tick);
    if (deathTick <= 0) continue;
    for (let i = 0; i < count; i += 1) {
      const fraction = i / (count - 1);
      const tick = Math.max(1, Math.round(deathTick - backTicks + backTicks * fraction));
      ticks.add(tick);
    }
  }
  return [...ticks].sort((a, b) => a - b);
}

function speedOf(row) {
  const direct = finite(row?.velocity);
  if (direct !== null) return Math.abs(direct);
  const vx = finite(row?.velocity_X);
  const vy = finite(row?.velocity_Y);
  if (vx === null || vy === null) return null;
  return Math.hypot(vx, vy);
}

function normalizeSnapshot(row) {
  const x = finite(row?.X ?? row?.x);
  const y = finite(row?.Y ?? row?.y);
  if (x === null || y === null) return null;
  return {
    tick: asNumber(row?.tick),
    name: cleanName(row?.name ?? row?.player_name),
    steamid: String(row?.steamid ?? row?.player_steamid ?? ''),
    x,
    y,
    z: finite(row?.Z ?? row?.z) ?? 0,
    velocity: (() => {
      const speed = speedOf(row);
      return speed === null ? null : fixed(speed, 1);
    })(),
    place: cleanName(row?.last_place_name),
    isAlive: row?.is_alive === undefined ? null : Boolean(row.is_alive),
  };
}

function samePlayer(row, death) {
  const steamid = String(death?.victimSteamid || '');
  if (steamid && row?.steamid) return String(row.steamid) === steamid;
  return row?.name === cleanName(death?.victim);
}

export function attachDeathTrajectories({
  positioning,
  deaths,
  snapshotRows,
  tickRate,
  seconds = TRAJECTORY_SECONDS,
}) {
  const rate = Math.max(1, Number(tickRate) || 64);
  const windowTicks = Math.round(seconds * rate);
  const snapshots = asArray(snapshotRows).map(normalizeSnapshot).filter(Boolean);
  const byTick = new Map();
  for (const row of snapshots) {
    if (!byTick.has(row.tick)) byTick.set(row.tick, []);
    byTick.get(row.tick).push(row);
  }
  const sortedTicks = [...byTick.keys()].sort((a, b) => a - b);
  const players = { ...(positioning?.players || {}) };
  let totalTrajectories = 0;
  let totalPoints = 0;

  for (const death of asArray(deaths)) {
    const deathTick = asNumber(death?.tick);
    const victim = cleanName(death?.victim);
    if (!victim || deathTick <= 0) continue;
    const startTick = Math.max(1, deathTick - windowTicks);
    const points = [];
    for (const tick of sortedTicks) {
      if (tick < startTick) continue;
      if (tick > deathTick) break;
      const rows = byTick.get(tick) || [];
      const row = rows.find((candidate) => samePlayer(candidate, death));
      if (!row) continue;
      points.push({
        x: row.x,
        y: row.y,
        z: row.z,
        tick: row.tick,
        tMinusSec: fixed((deathTick - row.tick) / rate, 2),
        velocity: row.velocity,
        place: row.place,
        isAlive: row.isAlive,
      });
    }
    if (points.length < 2) continue;
    const existing = players[victim] || { deaths: [], kills: [] };
    const deathTrajectories = asArray(existing.deathTrajectories).slice();
    deathTrajectories.push({
      deathTick,
      round: asNumber(death?.round),
      secondsIntoRound: death?.secondsIntoRound ?? null,
      victim,
      attacker: cleanName(death?.attacker),
      weapon: cleanName(death?.weapon),
      place: cleanName(death?.victimPlace),
      points,
    });
    players[victim] = { ...existing, deathTrajectories };
    totalTrajectories += 1;
    totalPoints += points.length;
  }

  return {
    ...(positioning || {}),
    players,
    trajectory: {
      version: 'v7.1',
      seconds,
      tickRate: fixed(rate, 2),
      totalTrajectories,
      totalPoints,
    },
  };
}
