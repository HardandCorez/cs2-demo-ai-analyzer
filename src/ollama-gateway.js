import 'dotenv/config';
import express from 'express';

const app = express();
const host = '127.0.0.1';
const port = Number(process.env.OLLAMA_GATEWAY_PORT || 11435);
const ollamaUrl = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
const model = String(process.env.OLLAMA_MODEL || 'qwen3:4b').trim();
const gatewayToken = String(process.env.AI_GATEWAY_TOKEN || '').trim();
const timeoutMs = Math.max(60_000, Number(process.env.AI_TIMEOUT_MS || 600_000));

app.disable('x-powered-by');
app.use(express.json({ limit: '768kb' }));

const asArray = (value) => (Array.isArray(value) ? value : []);
const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const fixed = (value, digits = 2) => Number(asNumber(value).toFixed(digits));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function authorize(req, res, next) {
  if (!gatewayToken) return next();
  if (String(req.headers.authorization || '') !== `Bearer ${gatewayToken}`) {
    return res.status(401).json({ error: 'Неверный локальный AI gateway token' });
  }
  next();
}

function validateMatch(match) {
  if (!match || typeof match !== 'object') return 'Нет данных матча';
  if (!match.selectedPlayer || typeof match.selectedPlayer !== 'object') return 'Не выбран игрок';
  if (!Array.isArray(match.scoreboard) || match.scoreboard.length === 0) return 'Нет scoreboard';
  if (match.scoreboard.length > 20) return 'Слишком много игроков в payload';
  return null;
}

function deriveVerifiedMetrics(match) {
  if (match?.verifiedMetrics && typeof match.verifiedMetrics === 'object') return match.verifiedMetrics;
  const p = match?.selectedPlayer || {};
  const rounds = Math.max(0, asNumber(match?.rounds));
  const kills = asNumber(p.kills);
  const deaths = asNumber(p.deaths);
  const entryKills = asNumber(p.entryKills);
  const openingDeaths = asNumber(p.openingDeaths);
  const openingAttempts = entryKills + openingDeaths;
  return {
    kills,
    deaths,
    assists: asNumber(p.assists),
    kd: deaths > 0 ? fixed(kills / deaths, 2) : kills,
    adr: fixed(p.adr, 1),
    headshots: asNumber(p.headshots),
    hsPct: asNumber(p.hsPct),
    entryKills,
    openingDeaths,
    openingAttempts,
    openingSuccessPct: openingAttempts > 0 ? Math.round((entryKills / openingAttempts) * 100) : null,
    killsPerRound: rounds > 0 ? fixed(kills / rounds, 2) : 0,
    tradeKills: asNumber(p.tradeKills),
    tradedDeaths: asNumber(p.tradedDeaths),
    tradedDeathPct: p.tradedDeathPct ?? null,
    kastPct: p.kastPct ?? null,
    multiKillRounds: asNumber(p.multiKillRounds),
    twoK: asNumber(p.twoK),
    threeK: asNumber(p.threeK),
    fourK: asNumber(p.fourK),
    fiveK: asNumber(p.fiveK),
    clutchAttempts: asNumber(p.clutchAttempts),
    clutchWins: asNumber(p.clutchWins),
    clutchWinPct: p.clutchWinPct ?? null,
    avgOpeningDuelTimeSec: p.avgOpeningDuelTimeSec ?? null,
    positionSamples: asNumber(p.positionSamples),
    spacingSamples: asNumber(p.spacingSamples),
    avgNearestTeammateDistanceAtDeath: p.avgNearestTeammateDistanceAtDeath ?? null,
    isolatedDeathsHeuristic: asNumber(p.isolatedDeathsHeuristic),
    isolatedDeathPct: p.isolatedDeathPct ?? null,
    movementDeathSamples: asNumber(p.movementDeathSamples),
    avgVelocityAtDeath: p.avgVelocityAtDeath ?? null,
    highSpeedDeaths: asNumber(p.highSpeedDeaths),
    highSpeedDeathPct: p.highSpeedDeathPct ?? null,
    flashedDeathSamples: asNumber(p.flashedDeathSamples),
    flashedDeaths: asNumber(p.flashedDeaths),
    flashedDeathPct: p.flashedDeathPct ?? null,
    facingDeathSamples: asNumber(p.facingDeathSamples),
    attackerOutsideFrontDeaths: asNumber(p.attackerOutsideFrontDeaths),
    attackerOutsideFrontPct: p.attackerOutsideFrontPct ?? null,
    avgFacingErrorAtDeathDeg: p.avgFacingErrorAtDeathDeg ?? null,
    duelDistanceSamples: asNumber(p.duelDistanceSamples),
    avgDuelDistanceAtDeath: p.avgDuelDistanceAtDeath ?? null,
    topDeathPlace: String(p.topDeathPlace || ''),
    topDeathPlaceDeaths: asNumber(p.topDeathPlaceDeaths),
    topDeathPlacePct: p.topDeathPlacePct ?? null,
  };
}

function deterministicScore(m, availability) {
  let score = 50;
  if (m.kd >= 1) score += clamp((m.kd - 1) * 30, 0, 18);
  else score -= clamp((1 - m.kd) * 35, 0, 20);
  score += clamp((asNumber(m.adr) - 70) * 0.35, -15, 15);
  score += clamp((asNumber(m.killsPerRound) - 0.65) * 25, -10, 10);
  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null) {
    score += clamp((m.openingSuccessPct - 50) * 0.2, -10, 10);
  }
  if (availability.kast && m.kastPct !== null) score += clamp((m.kastPct - 70) * 0.3, -6, 6);
  return Math.round(clamp(score, 0, 100));
}

function buildFacts(m, availability) {
  const strengths = [];
  const problems = [];

  if (m.kd >= 1.2) strengths.push({ id: 'strong_kd', text: 'Сильный K/D', evidence: `${m.kills}/${m.deaths} = ${m.kd}` });
  else if (m.kd < 0.9) problems.push({ id: 'weak_kd', text: 'Низкий K/D', evidence: `${m.kills}/${m.deaths} = ${m.kd}` });

  if (m.adr >= 85) strengths.push({ id: 'strong_adr', text: 'Высокий урон за раунд', evidence: `ADR ${m.adr}` });
  else if (m.adr < 65) problems.push({ id: 'weak_adr', text: 'Низкий урон за раунд', evidence: `ADR ${m.adr}` });

  if (m.killsPerRound >= 0.8) strengths.push({ id: 'strong_kpr', text: 'Высокая результативность по убийствам', evidence: `KPR ${m.killsPerRound}` });
  else if (m.killsPerRound < 0.55) problems.push({ id: 'weak_kpr', text: 'Низкая результативность по убийствам', evidence: `KPR ${m.killsPerRound}` });

  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null) {
    const timing = availability.firstContactTiming && m.avgOpeningDuelTimeSec !== null ? `; средний opening-контакт ${m.avgOpeningDuelTimeSec}с` : '';
    const sample = m.openingAttempts < 10 ? '; выборка небольшая' : '';
    if (m.openingSuccessPct >= 55) strengths.push({ id: 'strong_opening', text: 'Положительный результат opening-дуэлей', evidence: `${m.entryKills}/${m.openingAttempts} = ${m.openingSuccessPct}%${sample}${timing}` });
    else if (m.openingSuccessPct < 45) problems.push({ id: 'weak_opening', text: 'Слабый результат opening-дуэлей', evidence: `${m.entryKills}/${m.openingAttempts} = ${m.openingSuccessPct}%${sample}${timing}` });
  }

  if (availability.kast && m.kastPct !== null) {
    if (m.kastPct >= 75) strengths.push({ id: 'strong_kast', text: 'Высокая вовлечённость по KAST', evidence: `KAST ${m.kastPct}%` });
    else if (m.kastPct < 65) problems.push({ id: 'weak_kast', text: 'Низкая вовлечённость по KAST', evidence: `KAST ${m.kastPct}%` });
  }

  if (availability.tradeDetection && m.tradedDeaths + m.tradeKills >= 3) {
    if (m.tradeKills >= 3) strengths.push({ id: 'trade_impact', text: 'Есть заметный refrag-вклад', evidence: `trade kills ${m.tradeKills}` });
    if (m.deaths >= 8 && m.tradedDeathPct !== null && m.tradedDeathPct < 30) {
      problems.push({ id: 'low_traded_deaths', text: 'Малая доля смертей была разменяна', evidence: `${m.tradedDeaths}/${m.deaths} = ${m.tradedDeathPct}% в окне 5с` });
    }
  }

  if (availability.multikills && m.multiKillRounds >= 3) {
    strengths.push({ id: 'multikill_impact', text: 'Регулярные multikill-раунды', evidence: `${m.multiKillRounds} раундов 2K+; 2K ${m.twoK}, 3K ${m.threeK}, 4K ${m.fourK}, 5K ${m.fiveK}` });
  }

  if (availability.clutchDetection && m.clutchWins > 0) strengths.push({ id: 'clutch_wins', text: 'Есть выигранные клатчи', evidence: `${m.clutchWins}/${m.clutchAttempts} выиграно` });
  else if (availability.clutchDetection && m.clutchAttempts >= 3 && m.clutchWins === 0) problems.push({ id: 'clutch_misses', text: 'Клатч-попытки пока без побед', evidence: `0/${m.clutchAttempts}` });

  if (m.hsPct >= 60 && m.kills >= 10) {
    strengths.push({ id: 'high_hs', text: 'Высокая доля убийств в голову', evidence: `HS ${m.hsPct}% (${m.headshots}/${m.kills})`, note: 'Это характеристика стрельбы, а не доказательство хорошего позиционирования.' });
  }

  if (availability.teammateSpacing && m.spacingSamples >= 6 && m.isolatedDeathPct !== null && m.isolatedDeathPct >= 45) {
    problems.push({ id: 'isolated_deaths', text: 'Много смертей происходило далеко от ближайшего тиммейта', evidence: `${m.isolatedDeathsHeuristic}/${m.spacingSamples} = ${m.isolatedDeathPct}% выше порога spacing; стены и этажи не учитываются` });
  }

  if (availability.flashedAtDeath && m.flashedDeathSamples >= 6 && m.flashedDeathPct !== null && m.flashedDeathPct >= 25) {
    problems.push({ id: 'flashed_deaths', text: 'Заметная доля смертей пришлась на активное ослепление', evidence: `${m.flashedDeaths}/${m.flashedDeathSamples} = ${m.flashedDeathPct}%` });
  }

  if (availability.facingAtDeath && m.facingDeathSamples >= 6 && m.attackerOutsideFrontPct !== null && m.attackerOutsideFrontPct >= 45) {
    problems.push({ id: 'outside_front', text: 'Атакующий часто находился вне фронтального сектора в момент смерти', evidence: `${m.attackerOutsideFrontDeaths}/${m.facingDeathSamples} = ${m.attackerOutsideFrontPct}%; это геометрическая эвристика без line-of-sight` });
  }

  if (availability.movementAtDeath && m.movementDeathSamples >= 8 && m.highSpeedDeathPct !== null && m.highSpeedDeathPct >= 50) {
    problems.push({ id: 'high_speed_deaths', text: 'Высокая доля смертей произошла на заметной скорости', evidence: `${m.highSpeedDeaths}/${m.movementDeathSamples} = ${m.highSpeedDeathPct}%; это не детектор wide-peek` });
  }

  if (availability.placeNames && m.positionSamples >= 6 && m.topDeathPlace && m.topDeathPlaceDeaths >= 3 && m.topDeathPlacePct >= 30) {
    problems.push({ id: 'repeat_death_place', text: 'Смерти заметно концентрируются в одной named-zone', evidence: `${m.topDeathPlace}: ${m.topDeathPlaceDeaths}/${m.positionSamples} = ${m.topDeathPlacePct}%` });
  }

  return { strengths: strengths.slice(0, 8), problems: problems.slice(0, 10) };
}

function buildUnknowns(match) {
  const a = {
    reactionTime: false,
    playerPositions: false,
    positionalHeatmap: false,
    teammateSpacing: false,
    movementAtDeath: false,
    flashedAtDeath: false,
    facingAtDeath: false,
    placeNames: false,
    widePeekDetection: false,
    repeekDetection: false,
    lineOfSight: false,
    navMesh: false,
    tradeDetection: false,
    clutchDetection: false,
    economy: false,
    kast: false,
    multikills: false,
    firstContactTiming: false,
    flashbangsThrown: false,
    utilityCoordinates: false,
    sideSplitMetrics: false,
    ...(match?.dataAvailability || {}),
  };
  const map = [
    ['reactionTime', 'время реакции'],
    ['playerPositions', 'координаты игрока в моменты событий'],
    ['teammateSpacing', 'дистанция до ближайшего тиммейта при смерти'],
    ['movementAtDeath', 'скорость движения в момент смерти'],
    ['flashedAtDeath', 'состояние ослепления в момент смерти'],
    ['facingAtDeath', 'направление взгляда относительно атакующего'],
    ['placeNames', 'named-zone места смертей'],
    ['widePeekDetection', 'надёжное определение wide-peek'],
    ['repeekDetection', 'надёжное определение repeek'],
    ['lineOfSight', 'line-of-sight и видимость через геометрию карты'],
    ['navMesh', 'navmesh, стены и этажи карты'],
    ['tradeDetection', 'трейды и refrag-эффективность'],
    ['clutchDetection', 'клатчи 1vX'],
    ['economy', 'экономические решения'],
    ['kast', 'KAST'],
    ['multikills', 'multikill-раунды'],
    ['firstContactTiming', 'точный timing первого контакта'],
    ['flashbangsThrown', 'количество именно брошенных флешек'],
    ['utilityCoordinates', 'качество конкретных гранат по позициям'],
    ['sideSplitMetrics', 'T/CT-сплит'],
  ];
  return map.filter(([key]) => !a[key]).map(([, text]) => text);
}

function actionLibrary(m, problems, availability) {
  const actions = [];
  const ids = new Set(problems.map((p) => p.id));

  if (ids.has('weak_opening')) {
    actions.push({ id: 'review_openings', text: `Пересмотри все ${m.openingAttempts} opening-дуэлей: ${m.entryKills} побед и ${m.openingDeaths} смертей. Для каждого вручную пометь причину: лишний peek, отсутствие поддержки, crosshair placement или проигранная стрельба.` });
    actions.push({ id: 'opening_sample', text: 'Собери минимум 10 opening-дуэлей в следующих матчах и сравни процент успеха с текущим, чтобы убрать влияние маленькой выборки.' });
  }
  if (ids.has('weak_kd')) actions.push({ id: 'review_deaths', text: 'Разбери смерти и отдели обязательные размены от лишних повторных пиков и проигранных чистых дуэлей.' });
  if (ids.has('weak_adr')) actions.push({ id: 'damage_focus', text: 'Отслеживай раунды с низким уроном и проверяй, успеваешь ли нанести полезный damage до смерти.' });
  if (ids.has('weak_kpr')) actions.push({ id: 'duel_volume', text: 'Разбери раунды без убийств и отметь, где ты рано выпал из розыгрыша или не участвовал в ключевых дуэлях.' });
  if (ids.has('weak_kast')) actions.push({ id: 'kast_review', text: 'Разбери раунды без K/A/S/T и вручную пометь, почему раунд не дал ни убийства, ни ассиста, ни выживания, ни размена.' });
  if (ids.has('low_traded_deaths')) actions.push({ id: 'trade_review', text: 'Пересмотри смерти без размена в течение 5 секунд и проверь, мог ли тиммейт физически сделать refrag.' });
  if (ids.has('clutch_misses')) actions.push({ id: 'clutch_review', text: `Разбери ${m.clutchAttempts} clutch-попытки по отдельности: win condition, время, bomb state и порядок дуэлей.` });

  if (ids.has('isolated_deaths')) actions.push({ id: 'spacing_review', text: `Отфильтруй смерти с дистанцией до ближайшего тиммейта выше порога V6. Проверь по демке, разделяла ли вас стена/этаж и был ли реальный trade path; не считай одну дистанцию доказательством плохого spacing.` });
  if (ids.has('flashed_deaths')) actions.push({ id: 'antiflash_review', text: `Разбери ${m.flashedDeaths} смертей под активной flash_duration: была ли возможность отвернуться, спрятаться или дождаться поддержки.` });
  if (ids.has('outside_front')) actions.push({ id: 'angle_review', text: 'Пересмотри смерти, где атакующий был вне фронтального сектора. Отдели нормальные crossfire/спину от ситуаций, где ты потерял опасный угол.' });
  if (ids.has('high_speed_deaths')) actions.push({ id: 'movement_review', text: 'Пересмотри high-speed deaths и вручную отметь: ротация, выход на контакт, прыжок или peek. Только после просмотра решай, была ли проблема остановки/контр-стрейфа.' });
  if (ids.has('repeat_death_place')) actions.push({ id: 'zone_review', text: `Собери все смерти в зоне «${m.topDeathPlace}» и сравни сценарии входа/удержания. Повторение зоны важно только если причины смертей тоже повторяются.` });

  if (availability.tradeDetection) actions.push({ id: 'track_trades', text: `Следи за trade kills (${m.tradeKills}) и traded deaths (${m.tradedDeaths}); сравнивай их между матчами, а не по одному эпизоду.` });
  actions.push({ id: 'track_core', text: 'После каждого матча фиксируй K/D, ADR, KPR, opening %, KAST, trades и V6 positioning-context — одинаковый набор позволяет сравнивать форму.' });
  return actions.slice(0, 10);
}

function pickOrderFallback(items, max = 3) {
  return items.slice(0, max).map((item) => item.id);
}

function selectionSchema(factIds, actionIds) {
  return {
    type: 'object',
    properties: {
      strengthIds: { type: 'array', maxItems: 3, items: { type: 'string', enum: factIds.strengths.length ? factIds.strengths : ['none'] } },
      problemIds: { type: 'array', maxItems: 3, items: { type: 'string', enum: factIds.problems.length ? factIds.problems : ['none'] } },
      actionIds: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string', enum: actionIds.length ? actionIds : ['none'] } },
    },
    required: ['strengthIds', 'problemIds', 'actionIds'],
  };
}

async function ollamaRequest(path, options = {}) {
  return fetch(`${ollamaUrl}${path}`, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function choosePriorities(strengths, problems, actions, metrics) {
  const fallback = {
    strengthIds: pickOrderFallback(strengths, 3),
    problemIds: pickOrderFallback(problems, 3),
    actionIds: pickOrderFallback(actions, 5),
  };
  if (!strengths.length && !problems.length) return fallback;

  const schema = selectionSchema(
    { strengths: strengths.map((x) => x.id), problems: problems.map((x) => x.id) },
    actions.map((x) => x.id),
  );

  try {
    const response = await ollamaRequest('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: schema,
        keep_alive: '15m',
        messages: [
          { role: 'system', content: '/no_think Выбери только приоритетные ID из разрешённых списков. Никакого свободного текста и новых фактов. V6 positional heuristics не превращай в доказательство wide-peek/repeek.' },
          { role: 'user', content: JSON.stringify({ metrics, strengths, problems, actions }) },
        ],
        options: { temperature: 0, num_ctx: 3072, num_predict: 220 },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return fallback;
    const parsed = JSON.parse(String(data?.message?.content || '{}'));
    const allowedStrengths = new Set(strengths.map((x) => x.id));
    const allowedProblems = new Set(problems.map((x) => x.id));
    const allowedActions = new Set(actions.map((x) => x.id));
    return {
      strengthIds: asArray(parsed.strengthIds).filter((id) => allowedStrengths.has(id)).slice(0, 3),
      problemIds: asArray(parsed.problemIds).filter((id) => allowedProblems.has(id)).slice(0, 3),
      actionIds: asArray(parsed.actionIds).filter((id) => allowedActions.has(id)).slice(0, 5),
    };
  } catch {
    return fallback;
  }
}

function orderedByIds(items, ids, fallbackMax) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chosen = ids.map((id) => byId.get(id)).filter(Boolean);
  return chosen.length ? chosen : items.slice(0, fallbackMax);
}

function formatReport({ score, metrics, strengths, problems, unknowns, actions, availability }) {
  const lines = [];
  lines.push(`Оценка: ${score} / 100`);
  lines.push('Шкала: внутренний coaching score проекта, не HLTV Rating. V6 positional heuristics не меняют score автоматически.');

  lines.push('', 'Подтверждённые сильные стороны:');
  if (!strengths.length) lines.push('— По доступным метрикам выраженных сильных сторон не выделено.');
  strengths.forEach((item, i) => {
    const note = item.note ? ` ${item.note}` : '';
    lines.push(`${i + 1}. ${item.text} (${item.evidence}).${note}`);
  });

  lines.push('', 'Подтверждённые проблемы:');
  if (!problems.length) lines.push('— Явные проблемы по доступным метрикам не подтверждены.');
  problems.forEach((item, i) => lines.push(`${i + 1}. ${item.text} (${item.evidence}).`));

  lines.push('', 'Позиционный контекст V6:');
  if (!availability.playerPositions || !metrics.positionSamples) {
    lines.push('— Координатные снимки в этой демке недоступны.');
  } else {
    lines.push(`• Смертей с координатами: ${metrics.positionSamples}.`);
    if (availability.teammateSpacing && metrics.avgNearestTeammateDistanceAtDeath !== null) {
      lines.push(`• Средняя 2D-дистанция до ближайшего живого тиммейта при смерти: ${metrics.avgNearestTeammateDistanceAtDeath} units; условно изолированных смертей: ${metrics.isolatedDeathsHeuristic}/${metrics.spacingSamples} (${metrics.isolatedDeathPct}%).`);
    }
    if (availability.movementAtDeath && metrics.avgVelocityAtDeath !== null) {
      lines.push(`• Средняя скорость при смерти: ${metrics.avgVelocityAtDeath} u/s; high-speed samples: ${metrics.highSpeedDeaths}/${metrics.movementDeathSamples} (${metrics.highSpeedDeathPct}%).`);
    }
    if (availability.flashedAtDeath && metrics.flashedDeathPct !== null) {
      lines.push(`• Смерти под активным ослеплением: ${metrics.flashedDeaths}/${metrics.flashedDeathSamples} (${metrics.flashedDeathPct}%).`);
    }
    if (availability.facingAtDeath && metrics.attackerOutsideFrontPct !== null) {
      lines.push(`• Атакующий вне фронтального сектора по yaw-эвристике: ${metrics.attackerOutsideFrontDeaths}/${metrics.facingDeathSamples} (${metrics.attackerOutsideFrontPct}%).`);
    }
    if (availability.placeNames && metrics.topDeathPlace) {
      lines.push(`• Самая частая named-zone смерти: ${metrics.topDeathPlace} — ${metrics.topDeathPlaceDeaths}/${metrics.positionSamples} (${metrics.topDeathPlacePct}%).`);
    }
    if (metrics.avgDuelDistanceAtDeath !== null) lines.push(`• Средняя 2D-дистанция до атакующего при смерти: ${metrics.avgDuelDistanceAtDeath} units.`);
    lines.push('• Ограничение: V6 пока не знает стены, этажи, navmesh и line-of-sight; high-speed death не равен wide-peek, а повторная зона не равна repeek.');
  }

  lines.push('', 'Что нельзя определить по этим данным:');
  unknowns.slice(0, 10).forEach((item) => lines.push(`• ${item}`));

  lines.push('', 'Действия на тренировку:');
  actions.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${item.text}`));

  const strongest = strengths[0]?.text?.toLowerCase();
  const mainProblem = problems[0]?.text?.toLowerCase();
  let conclusion = 'Матч нужно оценивать по подтверждённым числам; V6 добавляет позиционный контекст, но не подменяет просмотр демки.';
  if (strongest && mainProblem) conclusion = `Главный плюс — ${strongest}; главная зона роста — ${mainProblem}. V6-эвристики используй как фильтр эпизодов для просмотра, а не как окончательный диагноз.`;
  else if (strongest) conclusion = `Главный подтверждённый плюс — ${strongest}. V6 помогает выбрать позиционные эпизоды для ручной проверки.`;
  else if (mainProblem) conclusion = `Главная подтверждённая зона роста — ${mainProblem}. V6-эвристики нужно подтвердить просмотром конкретных раундов.`;
  lines.push('', 'Вывод:', conclusion);
  return lines.join('\n');
}

app.get('/health', async (_req, res) => {
  try {
    const response = await ollamaRequest('/api/tags');
    const data = await response.json().catch(() => ({}));
    const models = asArray(data?.models).map((item) => item?.name).filter(Boolean);
    res.status(response.ok ? 200 : 502).json({
      ok: response.ok,
      provider: 'ollama-local',
      ollamaUrl,
      model,
      timeoutMs,
      evidenceMode: 'positional-context-v6',
      modelInstalled: models.some((name) => name === model || name.startsWith(`${model}:`)),
      models,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      provider: 'ollama-local',
      model,
      evidenceMode: 'positional-context-v6',
      error: `Ollama недоступен: ${error?.message || error}`,
    });
  }
});

app.post('/v1/analyze', authorize, async (req, res) => {
  const match = req.body?.match;
  const validationError = validateMatch(match);
  if (validationError) return res.status(400).json({ error: validationError });

  const availability = match.dataAvailability || {};
  const metrics = deriveVerifiedMetrics(match);
  const score = deterministicScore(metrics, availability);
  const { strengths, problems } = buildFacts(metrics, availability);
  const unknowns = buildUnknowns(match);
  const actions = actionLibrary(metrics, problems, availability);

  const priorities = await choosePriorities(strengths, problems, actions, metrics);
  const selectedStrengths = orderedByIds(strengths, priorities.strengthIds, 3);
  const selectedProblems = orderedByIds(problems, priorities.problemIds, 3);
  const selectedActions = orderedByIds(actions, priorities.actionIds, 5);

  const analysis = formatReport({
    score,
    metrics,
    strengths: selectedStrengths,
    problems: selectedProblems,
    unknowns,
    actions: selectedActions,
    availability,
  });

  res.json({
    analysis,
    model,
    provider: 'ollama-local-priority-selector',
    evidenceMode: 'positional-context-v6',
    verifiedMetrics: metrics,
    deterministicScore: score,
  });
});

app.listen(port, host, () => {
  console.log(`Local Ollama gateway: http://${host}:${port}`);
  console.log(`Ollama: ${ollamaUrl}`);
  console.log(`Model: ${model}`);
  console.log('Evidence mode: positional-context-v6');
  console.log(`AI timeout: ${Math.round(timeoutMs / 1000)}s`);
});
