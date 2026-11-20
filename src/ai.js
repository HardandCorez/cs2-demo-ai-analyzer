// AI-разбор: компактный payload, инструкции, прямые и gateway-вызовы.
// Вынесено из бывшего server.js при унификации (5.0.0).

import { asArray, asNumber, fixed, perRound } from './demo/shared.js';

const aiGatewayUrl = String(process.env.AI_GATEWAY_URL || '').trim().replace(/\/+$/, '');
const aiGatewayToken = String(process.env.AI_GATEWAY_TOKEN || '').trim();
const aiTimeoutMs = Math.max(10_000, Number(process.env.AI_TIMEOUT_MS || 600_000));

const aiRequests = new Map();

export function aiRateLimit(req, res, next) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const prior = aiRequests.get(key);
  if (!prior || now - prior.startedAt >= 60_000) {
    aiRequests.set(key, { startedAt: now, count: 1 });
    return next();
  }
  prior.count += 1;
  if (prior.count > 10) return res.status(429).json({ error: 'Слишком много AI-запросов. Повтори через минуту.' });
  next();
}

export function getAIMode() {
  return aiGatewayUrl ? 'gateway' : process.env.OPENAI_API_KEY ? 'direct' : 'none';
}

export function isLocalGateway() {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(aiGatewayUrl);
}

export function buildVerifiedMetrics(selected, rounds) {
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
    positionSamples: asNumber(selected.positionSamples),
    spacingSamples: asNumber(selected.spacingSamples),
    avgNearestTeammateDistanceAtDeath: selected.avgNearestTeammateDistanceAtDeath ?? null,
    isolatedDeathsHeuristic: asNumber(selected.isolatedDeathsHeuristic),
    isolatedDeathPct: selected.isolatedDeathPct ?? null,
    movementDeathSamples: asNumber(selected.movementDeathSamples),
    avgVelocityAtDeath: selected.avgVelocityAtDeath ?? null,
    highSpeedDeaths: asNumber(selected.highSpeedDeaths),
    highSpeedDeathPct: selected.highSpeedDeathPct ?? null,
    flashedDeathSamples: asNumber(selected.flashedDeathSamples),
    flashedDeaths: asNumber(selected.flashedDeaths),
    flashedDeathPct: selected.flashedDeathPct ?? null,
    facingDeathSamples: asNumber(selected.facingDeathSamples),
    attackerOutsideFrontDeaths: asNumber(selected.attackerOutsideFrontDeaths),
    attackerOutsideFrontPct: selected.attackerOutsideFrontPct ?? null,
    avgFacingErrorAtDeathDeg: selected.avgFacingErrorAtDeathDeg ?? null,
    duelDistanceSamples: asNumber(selected.duelDistanceSamples),
    avgDuelDistanceAtDeath: selected.avgDuelDistanceAtDeath ?? null,
    topDeathPlace: selected.topDeathPlace || '',
    topDeathPlaceDeaths: asNumber(selected.topDeathPlaceDeaths),
    topDeathPlacePct: selected.topDeathPlacePct ?? null,
    customImpact: fixed(selected.impact, 2),
  };
}

export function compactMatchForAI(match, selectedSteamid) {
  const selected = match.players?.find((p) => String(p.steamid) === String(selectedSteamid))
    || match.players?.find((p) => p.name === selectedSteamid)
    || match.players?.[0];

  const allRelated = asArray(match.timeline)
    .filter((e) => !selected || e.attacker === selected.name || e.victim === selected.name || e.assister === selected.name || e.tradeOf === selected.name);
  const related = allRelated.slice(0, 80);
  const availability = match.dataAvailability || {};
  const thresholds = match.positioning?.thresholds || {};

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
      avgNearestTeammateDistanceAtDeath: '2D game-unit distance to the nearest alive teammate sampled at the death tick; walls and floors are not modeled',
      isolatedDeathPct: `share of spacing samples above ${thresholds.isolatedDistanceUnits ?? 900} game units; heuristic only`,
      highSpeedDeathPct: `share of movement samples above ${thresholds.highSpeedUnitsPerSec ?? 140} units/s at death; not a wide-peek detector`,
      flashedDeathPct: 'share of sampled deaths where flash_duration was still positive at the death tick',
      attackerOutsideFrontPct: `share of facing samples where attacker bearing differed from victim yaw by more than ${thresholds.outsideFrontDegrees ?? 75} degrees; no line-of-sight model`,
      topDeathPlace: 'most frequent parser last_place_name among sampled death positions',
      customImpact: 'project-specific heuristic, NOT HLTV Rating',
    },
    dataAvailability: {
      killEvents: true,
      exactRoundStartTiming: Boolean(availability.firstContactTiming),
      firstContactTiming: Boolean(availability.firstContactTiming),
      reactionTime: false,
      playerPositions: Boolean(availability.playerPositions),
      positionalHeatmap: Boolean(availability.positionalHeatmap),
      teammateSpacing: Boolean(availability.teammateSpacing),
      movementAtDeath: Boolean(availability.movementAtDeath),
      flashedAtDeath: Boolean(availability.flashedAtDeath),
      facingAtDeath: Boolean(availability.facingAtDeath),
      placeNames: Boolean(availability.placeNames),
      widePeekDetection: false,
      repeekDetection: false,
      lineOfSight: false,
      navMesh: false,
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
    'Позиционные метрики V6 являются контекстными эвристиками: координаты не учитывают стены, этажи, navmesh и line-of-sight.',
    'Запрещено называть highSpeedDeathPct wide-peek, а повторные смерти repeek: widePeekDetection и repeekDetection пока false.',
    'Никогда не выдумывай время реакции, экономику, сторону T/CT или качество гранат, если dataAvailability говорит false.',
    'Трейды, KAST, multikills, clutch, timing и positioning разрешено обсуждать только когда соответствующий dataAvailability=true.',
    'enemiesFlashed означает зарегистрированные эффекты ослепления врагов, а не количество брошенных флешек.',
    'customImpact — внутренний коэффициент проекта, не называй его HLTV Rating.',
    'Не называй K/D 1.0+ низким без явного сравнительного контекста.',
    'Высокий HS% сам по себе не доказывает хорошее принятие решений.',
    'Если метрика недоступна, прямо напиши: данных недостаточно для этого вывода.',
    'Формат ответа: Оценка 0-100; Подтвержденные сильные стороны; Подтвержденные проблемы; Позиционный контекст V6; Что нельзя заключить; 5 действий на тренировку; Короткий вывод.',
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

export async function callOpenAIDirect(payload) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY не настроен');
    error.status = 503;
    throw error;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: strictCoachInstructions(),
      input: `Разбери матч только по подтвержденным данным:\n${JSON.stringify(payload)}`,
      max_output_tokens: 1800,
    }),
    signal: AbortSignal.timeout(aiTimeoutMs),
  });

  const data = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const status = apiResponse.status === 429 ? 429 : [401, 403].includes(apiResponse.status) ? 503 : 502;
    const error = new Error(apiResponse.status === 429
      ? 'Превышен лимит OpenAI API'
      : [401, 403].includes(apiResponse.status)
        ? 'Ошибка серверной настройки доступа к OpenAI API'
        : 'OpenAI API временно недоступен');
    error.status = status;
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

export async function callAIGateway(payload) {
  // Credentials must never traverse a plaintext non-local connection.
  let endpoint;
  try {
    endpoint = new URL(aiGatewayUrl);
  } catch {
    const error = new Error('Некорректный AI_GATEWAY_URL');
    error.status = 503;
    throw error;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    const error = new Error('Удалённый AI gateway должен использовать HTTPS');
    error.status = 503;
    throw error;
  }
  if (!loopback && !aiGatewayToken) {
    const error = new Error('Для удалённого AI gateway нужен AI_GATEWAY_TOKEN');
    error.status = 503;
    throw error;
  }
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
    const error = new Error(response.status === 429
      ? 'Лимит запросов AI gateway'
      : 'AI gateway не смог обработать запрос');
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  if (!data?.analysis) {
    const error = new Error('AI Gateway вернул ответ без анализа');
    error.status = 502;
    throw error;
  }
  return data;
}
