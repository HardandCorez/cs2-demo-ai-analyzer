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
app.use(express.json({ limit: '512kb' }));

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
  const assists = asNumber(p.assists);
  const entryKills = asNumber(p.entryKills);
  const openingDeaths = asNumber(p.openingDeaths);
  const openingAttempts = entryKills + openingDeaths;
  return {
    kills,
    deaths,
    assists,
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
    avgFirstKillTimeSec: p.avgFirstKillTimeSec ?? null,
    avgDeathTimeSec: p.avgDeathTimeSec ?? null,
  };
}

function deterministicScore(m, availability) {
  let score = 50;
  if (m.kd >= 1) score += clamp((m.kd - 1) * 30, 0, 18);
  else score -= clamp((1 - m.kd) * 35, 0, 20);
  score += clamp((m.adr - 70) * 0.35, -15, 15);
  score += clamp((m.killsPerRound - 0.65) * 25, -10, 10);
  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null) score += clamp((m.openingSuccessPct - 50) * 0.2, -10, 10);
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
    if (m.deaths >= 8 && m.tradedDeathPct !== null && m.tradedDeathPct < 30) problems.push({ id: 'low_traded_deaths', text: 'Малая доля смертей была разменяна', evidence: `${m.tradedDeaths}/${m.deaths} = ${m.tradedDeathPct}% в окне 5с` });
  }

  if (availability.multikills && m.multiKillRounds >= 3) strengths.push({ id: 'multikill_impact', text: 'Регулярные multikill-раунды', evidence: `${m.multiKillRounds} раундов 2K+; 2K ${m.twoK}, 3K ${m.threeK}, 4K ${m.fourK}, 5K ${m.fiveK}` });

  if (availability.clutchDetection && m.clutchWins > 0) strengths.push({ id: 'clutch_wins', text: 'Есть выигранные клатчи', evidence: `${m.clutchWins}/${m.clutchAttempts} выиграно` });
  else if (availability.clutchDetection && m.clutchAttempts >= 3 && m.clutchWins === 0) problems.push({ id: 'clutch_misses', text: 'Клатч-попытки пока без побед', evidence: `0/${m.clutchAttempts}` });

  if (m.hsPct >= 60 && m.kills >= 10) strengths.push({ id: 'high_hs', text: 'Высокая доля убийств в голову', evidence: `HS ${m.hsPct}% (${m.headshots}/${m.kills})`, note: 'Это характеристика стрельбы, а не доказательство хорошего позиционирования.' });

  return { strengths: strengths.slice(0, 7), problems: problems.slice(0, 7) };
}

function buildUnknowns(match) {
  const a = {
    reactionTime: false,
    playerPositions: false,
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
    ['playerPositions', 'качество позиционирования и ротаций'],
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
    actions.push({ id: 'review_openings', text: `Пересмотри все ${m.openingAttempts} opening-дуэлей: ${m.entryKills} побед и ${m.openingDeaths} смертей. Для каждого вручную пометь причину: лишний peek, отсутствие поддержки, плохой crosshair placement или проигранная стрельба.` });
    actions.push({ id: 'opening_sample', text: 'Собери минимум 10 opening-дуэлей в следующих матчах и сравни процент успеха с текущим, чтобы убрать влияние маленькой выборки.' });
  }
  if (ids.has('weak_kd')) actions.push({ id: 'review_deaths', text: 'Разбери смерти и отдели обязательные размены от лишних повторных пиков и проигранных чистых дуэлей.' });
  if (ids.has('weak_adr')) actions.push({ id: 'damage_focus', text: 'Отслеживай раунды с низким уроном и проверяй, успеваешь ли нанести полезный damage до смерти.' });
  if (ids.has('weak_kpr')) actions.push({ id: 'duel_volume', text: 'Разбери раунды без убийств и отметь, где ты рано выпал из розыгрыша или не участвовал в ключевых дуэлях.' });
  if (ids.has('weak_kast')) actions.push({ id: 'kast_review', text: 'Разбери раунды без K/A/S/T и вручную пометь, почему раунд не дал ни убийства, ни ассиста, ни выживания, ни размена.' });
  if (ids.has('low_traded_deaths')) actions.push({ id: 'trade_review', text: 'Пересмотри смерти без размена в течение 5 секунд и проверь, мог ли тиммейт физически сделать refrag. Это поможет отличить проблему дистанции от неизбежной смерти.' });
  if (ids.has('clutch_misses')) actions.push({ id: 'clutch_review', text: `Разбери ${m.clutchAttempts} clutch-попытки по отдельности: win condition, время, bomb state и порядок дуэлей.` });

  if (availability.tradeDetection) actions.push({ id: 'track_trades', text: `Следи за trade kills (${m.tradeKills}) и traded deaths (${m.tradedDeaths}); сравнивай их между матчами, а не по одному эпизоду.` });
  actions.push({ id: 'track_core', text: 'После каждого матча фиксируй K/D, ADR, KPR, opening %, KAST и trade-метрики — одинаковый набор позволяет сравнивать форму без субъективных выводов.' });
  return actions.slice(0, 7);
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

  try {
    const schema = selectionSchema(
      { strengths: strengths.map((x) => x.id), problems: problems.map((x) => x.id) },
      actions.map((x) => x.id),
    );
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
          { role: 'system', content: '/no_think Выбери только приоритетные ID из разрешённых списков. Не создавай факты и текст.' },
          { role: 'user', content: JSON.stringify({ metrics, strengths, problems, actions }) },
        ],
        options: { temperature: 0, num_ctx: 2048, num_predict: 180 },
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
  lines.push('Шкала: внутренний coaching score проекта, не HLTV Rating. Код использует K/D, ADR, KPR, opening % и KAST, когда KAST доступен.');

  const v5 = [];
  if (availability.kast && metrics.kastPct !== null) v5.push(`KAST ${metrics.kastPct}%`);
  if (availability.tradeDetection) v5.push(`trade kills ${metrics.tradeKills}`, `traded deaths ${metrics.tradedDeaths}${metrics.tradedDeathPct !== null ? ` (${metrics.tradedDeathPct}%)` : ''}`);
  if (availability.multikills) v5.push(`2K+ раунды ${metrics.multiKillRounds}`);
  if (availability.clutchDetection) v5.push(`clutch ${metrics.clutchWins}/${metrics.clutchAttempts}`);
  if (availability.firstContactTiming && metrics.avgOpeningDuelTimeSec !== null) v5.push(`opening timing ${metrics.avgOpeningDuelTimeSec}с`);
  if (v5.length) lines.push(`V5 метрики: ${v5.join(' · ')}`);

  lines.push('', 'Подтверждённые сильные стороны:');
  if (!strengths.length) lines.push('— По доступным метрикам выраженных сильных сторон не выделено.');
  strengths.forEach((item, i) => lines.push(`${i + 1}. ${item.text} (${item.evidence}).${item.note ? ` ${item.note}` : ''}`));

  lines.push('', 'Подтверждённые проблемы:');
  if (!problems.length) lines.push('— Явные проблемы по доступным метрикам не подтверждены.');
  problems.forEach((item, i) => lines.push(`${i + 1}. ${item.text} (${item.evidence}).`));

  lines.push('', 'Что нельзя определить по этим данным:');
  if (!unknowns.length) lines.push('— Основные v5-метрики доступны.');
  unknowns.slice(0, 8).forEach((item) => lines.push(`• ${item}`));

  lines.push('', 'Действия на тренировку:');
  actions.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${item.text}`));

  const strongest = strengths[0]?.text?.toLowerCase();
  const mainProblem = problems[0]?.text?.toLowerCase();
  let conclusion = 'Оценка основана только на измеряемых метриках; причины конкретных ошибок требуют просмотра соответствующих эпизодов.';
  if (strongest && mainProblem) conclusion = `Главный плюс — ${strongest}; главная зона роста — ${mainProblem}. V5-метрики позволяют точнее отделять результативность, размены и стабильность по раундам.`;
  else if (strongest) conclusion = `Главный подтверждённый плюс — ${strongest}. Критической проблемы по доступным метрикам не найдено.`;
  else if (mainProblem) conclusion = `Главная подтверждённая зона роста — ${mainProblem}. Причину нужно устанавливать по конкретным раундам, а не додумывать.`;
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
      evidenceMode: 'advanced-metrics-v5',
      modelInstalled: models.some((name) => name === model || name.startsWith(`${model}:`)),
      models,
    });
  } catch (error) {
    res.status(503).json({ ok: false, provider: 'ollama-local', model, evidenceMode: 'advanced-metrics-v5', error: `Ollama недоступен: ${error?.message || error}` });
  }
});

app.post('/v1/analyze', authorize, async (req, res) => {
  const match = req.body?.match;
  const validationError = validateMatch(match);
  if (validationError) return res.status(400).json({ error: validationError });

  const metrics = deriveVerifiedMetrics(match);
  const availability = match.dataAvailability || {};
  const score = deterministicScore(metrics, availability);
  const { strengths, problems } = buildFacts(metrics, availability);
  const unknowns = buildUnknowns(match);
  const actions = actionLibrary(metrics, problems, availability);
  const priorities = await choosePriorities(strengths, problems, actions, metrics);

  const selectedStrengths = orderedByIds(strengths, priorities.strengthIds, 3);
  const selectedProblems = orderedByIds(problems, priorities.problemIds, 3);
  const selectedActions = orderedByIds(actions, priorities.actionIds, 5);

  const analysis = formatReport({ score, metrics, strengths: selectedStrengths, problems: selectedProblems, unknowns, actions: selectedActions, availability });
  res.json({
    analysis,
    model,
    provider: 'ollama-local-priority-selector',
    evidenceMode: 'advanced-metrics-v5',
    verifiedMetrics: metrics,
    deterministicScore: score,
  });
});

app.listen(port, host, () => {
  console.log(`Local Ollama gateway: http://${host}:${port}`);
  console.log(`Ollama: ${ollamaUrl}`);
  console.log(`Model: ${model}`);
  console.log('Evidence mode: advanced-metrics-v5');
  console.log(`AI timeout: ${Math.round(timeoutMs / 1000)}s`);
});