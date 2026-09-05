const asArray = (value) => (Array.isArray(value) ? value : []);
const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const fixed = (value, digits = 2) => Number(asNumber(value).toFixed(digits));
const avg = (values, digits = 1) => {
  const nums = asArray(values).map(Number).filter(Number.isFinite);
  return nums.length ? fixed(nums.reduce((s, n) => s + n, 0) / nums.length, digits) : null;
};

function sameTeam(e) {
  if (e?.attackerTeam && e?.victimTeam) return e.attackerTeam === e.victimTeam;
  const a = asNumber(e?.attackerTeamNumber, 0);
  const v = asNumber(e?.victimTeamNumber, 0);
  return a > 0 && v > 0 && a === v;
}

function validEnemyKill(e) {
  if (!e?.attacker || !e?.victim || e.attacker === e.victim) return false;
  if (sameTeam(e)) return false;
  return true;
}

function teammates(previous, current) {
  if (previous?.victimTeam && current?.attackerTeam) return previous.victimTeam === current.attackerTeam;
  const a = asNumber(previous?.victimTeamNumber, 0);
  const b = asNumber(current?.attackerTeamNumber, 0);
  return a > 0 && b > 0 && a === b;
}

export function annotateTrades(inputDeaths, tradeWindowSeconds = 5) {
  const deaths = asArray(inputDeaths)
    .map((e, index) => ({ ...e, eventIndex: index, tradeKill: false, tradedDeath: false, tradeOf: null }))
    .sort((a, b) => a.round - b.round || a.tick - b.tick);

  const byRound = new Map();
  for (const e of deaths) {
    if (!byRound.has(e.round)) byRound.set(e.round, []);
    byRound.get(e.round).push(e);
  }

  for (const events of byRound.values()) {
    for (let i = 0; i < events.length; i += 1) {
      const current = events[i];
      if (!validEnemyKill(current)) continue;
      const currentTime = Number(current.secondsIntoRound);
      if (!Number.isFinite(currentTime)) continue;

      for (let j = i - 1; j >= 0; j -= 1) {
        const previous = events[j];
        const previousTime = Number(previous.secondsIntoRound);
        if (!Number.isFinite(previousTime)) continue;
        const delta = currentTime - previousTime;
        if (delta > tradeWindowSeconds) break;
        if (delta < 0 || previous.tradedDeath || !validEnemyKill(previous)) continue;

        const revengeRelation = previous.attackerSteamid && current.victimSteamid
          ? previous.attackerSteamid === current.victimSteamid
          : previous.attacker === current.victim;

        if (teammates(previous, current) && revengeRelation) {
          current.tradeKill = true;
          current.tradeOf = previous.victim;
          previous.tradedDeath = true;
          break;
        }
      }
    }
  }

  return deaths.sort((a, b) => a.tick - b.tick);
}

function rosterTeams(rosterRaw) {
  const roster = asArray(rosterRaw).filter((p) => p?.name && asNumber(p.teamNumber) >= 2);
  const teams = new Map();
  for (const p of roster) {
    const team = asNumber(p.teamNumber);
    if (!teams.has(team)) teams.set(team, new Set());
    teams.get(team).add(p.name);
  }
  return teams;
}

function usableRoster(rosterRaw) {
  const teams = rosterTeams(rosterRaw);
  const total = [...teams.values()].reduce((sum, names) => sum + names.size, 0);
  return teams.size === 2 && total >= 8;
}

function computeClutches(deaths, rostersByRound, roundEnds) {
  const result = new Map();
  const endByRound = new Map(asArray(roundEnds).map((r) => [asNumber(r.round), r]));
  const byRound = new Map();
  for (const e of deaths) {
    if (!byRound.has(e.round)) byRound.set(e.round, []);
    byRound.get(e.round).push(e);
  }

  const rosterEntries = rostersByRound && typeof rostersByRound === 'object' ? Object.entries(rostersByRound) : [];
  for (const [roundKey, rosterRaw] of rosterEntries) {
    if (!usableRoster(rosterRaw)) continue;
    const round = asNumber(roundKey);
    const teams = rosterTeams(rosterRaw);
    const alive = new Map([...teams.entries()].map(([team, names]) => [team, new Set(names)]));
    const attempts = new Map();
    const events = asArray(byRound.get(round)).filter(validEnemyKill).slice().sort((a, b) => a.tick - b.tick);

    for (const e of events) {
      const victimTeamNumber = asNumber(e.victimTeamNumber);
      if (alive.has(victimTeamNumber)) alive.get(victimTeamNumber).delete(e.victim);

      for (const [team, members] of alive) {
        if (members.size !== 1) continue;
        const player = [...members][0];
        if (attempts.has(player)) continue;
        const opponentsAlive = [...alive.entries()]
          .filter(([otherTeam]) => otherTeam !== team)
          .reduce((sum, [, names]) => sum + names.size, 0);
        if (opponentsAlive < 1) continue;
        attempts.set(player, { team, opponents: opponentsAlive });
      }
    }

    const winnerTeamNumber = asNumber(endByRound.get(round)?.winnerTeamNumber);
    for (const [player, attempt] of attempts) {
      if (!result.has(player)) result.set(player, { clutchAttempts: 0, clutchWins: 0, clutch1v1: 0, clutch1v2: 0, clutch1v3Plus: 0 });
      const stats = result.get(player);
      stats.clutchAttempts += 1;
      if (attempt.opponents === 1) stats.clutch1v1 += 1;
      else if (attempt.opponents === 2) stats.clutch1v2 += 1;
      else stats.clutch1v3Plus += 1;
      if (winnerTeamNumber && winnerTeamNumber === attempt.team) stats.clutchWins += 1;
    }
  }
  return result;
}

export function computeV5Metrics({ deaths: rawDeaths, players: rawPlayers, rounds, rostersByRound = {}, roundEnds = [] }) {
  const deaths = annotateTrades(rawDeaths, 5);
  const players = asArray(rawPlayers);
  const names = new Set(players.map((p) => p.name).filter(Boolean));
  for (const e of deaths) {
    if (e.attacker) names.add(e.attacker);
    if (e.victim) names.add(e.victim);
    if (e.assister) names.add(e.assister);
  }

  const clutchByPlayer = computeClutches(deaths, rostersByRound, roundEnds);
  const advanced = new Map();
  const byRound = new Map();
  for (const e of deaths) {
    if (!byRound.has(e.round)) byRound.set(e.round, []);
    byRound.get(e.round).push(e);
  }

  for (const name of names) {
    const killRounds = new Set();
    const assistRounds = new Set();
    const deathRounds = new Set();
    const tradedDeathRounds = new Set();
    const killsPerRound = new Map();
    const firstKillTimes = [];
    const deathTimes = [];
    const openingKillTimes = [];
    const openingDeathTimes = [];
    let tradeKills = 0;
    let tradedDeaths = 0;

    for (const [round, eventsRaw] of byRound) {
      const events = eventsRaw.slice().sort((a, b) => a.tick - b.tick);
      const validEvents = events.filter(validEnemyKill);
      const firstEvent = validEvents[0];
      const playerKills = validEvents.filter((e) => e.attacker === name);
      const playerDeaths = validEvents.filter((e) => e.victim === name);
      const playerAssists = validEvents.filter((e) => e.assister === name);

      if (playerKills.length) {
        killRounds.add(round);
        killsPerRound.set(round, playerKills.length);
        const t = Number(playerKills[0].secondsIntoRound);
        if (Number.isFinite(t)) firstKillTimes.push(t);
      }
      if (playerDeaths.length) {
        deathRounds.add(round);
        const t = Number(playerDeaths[0].secondsIntoRound);
        if (Number.isFinite(t)) deathTimes.push(t);
      }
      if (playerAssists.length) assistRounds.add(round);

      for (const e of playerKills) if (e.tradeKill) tradeKills += 1;
      for (const e of playerDeaths) {
        if (e.tradedDeath) {
          tradedDeaths += 1;
          tradedDeathRounds.add(round);
        }
      }

      if (firstEvent?.attacker === name) {
        const t = Number(firstEvent.secondsIntoRound);
        if (Number.isFinite(t)) openingKillTimes.push(t);
      }
      if (firstEvent?.victim === name) {
        const t = Number(firstEvent.secondsIntoRound);
        if (Number.isFinite(t)) openingDeathTimes.push(t);
      }
    }

    let kastRounds = 0;
    const totalRounds = Math.max(0, asNumber(rounds));
    for (let round = 1; round <= totalRounds; round += 1) {
      const survived = !deathRounds.has(round);
      if (killRounds.has(round) || assistRounds.has(round) || survived || tradedDeathRounds.has(round)) kastRounds += 1;
    }

    const multi = { twoK: 0, threeK: 0, fourK: 0, fiveK: 0, multiKillRounds: 0 };
    for (const count of killsPerRound.values()) {
      if (count >= 2) multi.multiKillRounds += 1;
      if (count === 2) multi.twoK += 1;
      else if (count === 3) multi.threeK += 1;
      else if (count === 4) multi.fourK += 1;
      else if (count >= 5) multi.fiveK += 1;
    }

    const clutch = clutchByPlayer.get(name) || { clutchAttempts: 0, clutchWins: 0, clutch1v1: 0, clutch1v2: 0, clutch1v3Plus: 0 };
    advanced.set(name, {
      tradeKills,
      tradedDeaths,
      tradedDeathPct: deathRounds.size ? Math.round((tradedDeaths / deathRounds.size) * 100) : null,
      kastRounds,
      kastPct: totalRounds ? fixed((kastRounds / totalRounds) * 100, 1) : null,
      ...multi,
      ...clutch,
      clutchWinPct: clutch.clutchAttempts ? Math.round((clutch.clutchWins / clutch.clutchAttempts) * 100) : null,
      avgFirstKillTimeSec: avg(firstKillTimes, 1),
      avgDeathTimeSec: avg(deathTimes, 1),
      avgOpeningKillTimeSec: avg(openingKillTimes, 1),
      avgOpeningDeathTimeSec: avg(openingDeathTimes, 1),
      avgOpeningDuelTimeSec: avg([...openingKillTimes, ...openingDeathTimes], 1),
    });
  }

  const mergedPlayers = players.map((p) => ({ ...p, ...(advanced.get(p.name) || {}) }));
  const rosterRoundCount = Object.values(rostersByRound || {}).filter(usableRoster).length;
  const timedTeamEvents = deaths.filter((e) => Number.isFinite(Number(e.secondsIntoRound)) && ((e.attackerTeam && e.victimTeam) || (asNumber(e.attackerTeamNumber) > 0 && asNumber(e.victimTeamNumber) > 0)));

  return {
    players: mergedPlayers,
    deaths,
    dataAvailability: {
      tradeDetection: timedTeamEvents.length > 0,
      kast: asNumber(rounds) > 0,
      multikills: true,
      firstContactTiming: deaths.some((e) => Number.isFinite(Number(e.secondsIntoRound))),
      clutchDetection: rosterRoundCount >= Math.max(1, Math.floor(asNumber(rounds) * 0.8)),
      clutchRosterRounds: rosterRoundCount,
    },
  };
}
