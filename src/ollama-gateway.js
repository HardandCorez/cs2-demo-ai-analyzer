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
    damage: asNumber(p.damage),
    utilityDamage: asNumber(p.utilityDamage),
    enemiesFlashed: asNumber(p.enemiesFlashed),
    entryKills,
    openingDeaths,
    openingAttempts,
    openingSuccessPct: openingAttempts > 0 ? Math.round((entryKills / openingAttempts) * 100) : null,
    killsPerRound: rounds > 0 ? fixed(kills / rounds, 2) : 0,
    deathsPerRound: rounds > 0 ? fixed(deaths / rounds, 2) : 0,
    assistsPerRound: rounds > 0 ? fixed(assists / rounds, 2) : 0,
    utilityDamagePerRound: rounds > 0 ? fixed(asNumber(p.utilityDamage) / rounds, 1) : 0,
    enemiesFlashedPerRound: rounds > 0 ? fixed(asNumber(p.enemiesFlashed) / rounds, 2) : 0,
    roundSurvivalPctEstimate: rounds > 0 ? clamp(Math.round(((rounds - deaths) / rounds) * 100), 0, 100) : null,
    customImpact: fixed(p.impact, 2),
  };
}

function deterministicScore(m) {
  let score = 50;

  if (m.kd >= 1) score += clamp((m.kd - 1) * 30, 0, 18);
  else score -= clamp((1 - m.kd) * 35, 0, 20);

  score += clamp((m.adr - 70) * 0.35, -15, 15);
  score += clamp((m.killsPerRound - 0.65) * 25, -10, 10);

  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null) {
    score += clamp((m.openingSuccessPct - 50) * 0.2, -10, 10);
  }

  return Math.round(clamp(score, 0, 100));
}

function buildFacts(m) {
  const strengths = [];
  const problems = [];

  if (m.kd >= 1.2) {
    strengths.push({ id: 'strong_kd', text: 'Сильный K/D', evidence: `${m.kills}/${m.deaths} = ${m.kd}` });
  } else if (m.kd < 0.9) {
    problems.push({ id: 'weak_kd', text: 'Низкий K/D', evidence: `${m.kills}/${m.deaths} = ${m.kd}` });
  }

  if (m.adr >= 85) {
    strengths.push({ id: 'strong_adr', text: 'Высокий урон за раунд', evidence: `ADR ${m.adr}` });
  } else if (m.adr < 65) {
    problems.push({ id: 'weak_adr', text: 'Низкий урон за раунд', evidence: `ADR ${m.adr}` });
  }

  if (m.killsPerRound >= 0.8) {
    strengths.push({ id: 'strong_kpr', text: 'Высокая результативность по убийствам', evidence: `KPR ${m.killsPerRound}` });
  } else if (m.killsPerRound < 0.55) {
    problems.push({ id: 'weak_kpr', text: 'Низкая результативность по убийствам', evidence: `KPR ${m.killsPerRound}` });
  }

  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null) {
    const sample = m.openingAttempts < 10 ? '; выборка небольшая' : '';
    if (m.openingSuccessPct >= 55) {
      strengths.push({
        id: 'strong_opening',
        text: 'Положительный результат opening-дуэлей',
        evidence: `${m.entryKills}/${m.openingAttempts} = ${m.openingSuccessPct}%${sample}`,
      });
    } else if (m.openingSuccessPct < 45) {
      problems.push({
        id: 'weak_opening',
        text: 'Слабый результат opening-дуэлей',
        evidence: `${m.entryKills}/${m.openingAttempts} = ${m.openingSuccessPct}%${sample}`,
      });
    }
  }

  if (m.hsPct >= 60 && m.kills >= 10) {
    strengths.push({
      id: 'high_hs',
      text: 'Высокая доля убийств в голову',
      evidence: `HS ${m.hsPct}% (${m.headshots}/${m.kills})`,
      note: 'Это характеристика стрельбы, а не доказательство хорошего позиционирования или решений.',
    });
  }

  return {
    strengths: strengths.slice(0, 4),
    problems: problems.slice(0, 4),
  };
}

function buildUnknowns(match) {
  const a = {
    reactionTime: false,
    playerPositions: false,
    tradeDetection: false,
    clutchDetection: false,
    economy: false,
    kast: false,
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
    ['flashbangsThrown', 'количество именно брошенных флешек'],
    ['utilityCoordinates', 'качество конкретных гранат по позициям'],
    ['sideSplitMetrics', 'T/CT-сплит'],
  ];

  return map.filter(([key]) => !a[key]).map(([, text]) => text);
}

function actionLibrary(m, problems) {
  const actions = [];
  const ids = new Set(problems.map((p) => p.id));

  if (ids.has('weak_opening')) {
    actions.push({ id: 'review_openings', text: `Пересмотри все ${m.openingAttempts} opening-дуэлей: ${m.entryKills} побед и ${m.openingDeaths} смертей. Для каждого отметь, был ли первый контакт обязательным и был ли безопасный план выхода.` });
    actions.push({ id: 'opening_sample', text: 'На следующей серии матчей собери минимум 10 opening-дуэлей и сравни процент успеха с текущим значением, а не делай вывод по одной маленькой выборке.' });
    actions.push({ id: 'prefire_opening', text: 'Добавь короткий блок prefire/first-bullet тренировки перед матчами и отдельно отслеживай качество первых дуэлей.' });
  }

  if (ids.has('weak_kd')) {
    actions.push({ id: 'review_deaths', text: 'Разбери все смерти и раздели их на обязательные размены, лишние повторные пики и проигранные чистые дуэли.' });
  }

  if (ids.has('weak_adr')) {
    actions.push({ id: 'damage_focus', text: 'На тренировке фокусируйся на стабильном нанесении урона до смерти: не только на фраге, но и на полезном первом контакте.' });
  }

  if (ids.has('weak_kpr')) {
    actions.push({ id: 'duel_volume', text: 'Пересмотри раунды с нулём убийств и отметь, где ты слишком рано выпал из розыгрыша или не участвовал в ключевых дуэлях.' });
  }

  actions.push({ id: 'track_core', text: `После каждого матча фиксируй один и тот же набор: K/D, ADR, KPR и opening %. Это позволит сравнивать форму без субъективных выводов.` });
  actions.push({ id: 'dont_overrate_hs', text: 'Не оценивай матч только по HS%: высокий процент хедшотов не заменяет ADR, K/D и результат первых дуэлей.' });

  return actions.slice(0, 6);
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
  return fetch(`${ollamaUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
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
          {
            role: 'system',
            content: '/no_think Выбери только приоритетные ID из разрешённых списков. Никакого свободного текста. Не добавляй новые факты.',
          },
          {
            role: 'user',
            content: JSON.stringify({ metrics, strengths, problems, actions }),
          },
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
  if (chosen.length) return chosen;
  return items.slice(0, fallbackMax);
}

function formatReport({ score, metrics, strengths, problems, unknowns, actions }) {
  const lines = [];
  lines.push(`Оценка: ${score} / 100`);
  lines.push('Шкала: внутренний coaching score проекта, не HLTV Rating. Оценка считается кодом из K/D, ADR, KPR и opening %, а не придумывается моделью.');

  lines.push('', 'Подтверждённые сильные стороны:');
  if (!strengths.length) lines.push('— По доступным метрикам выраженных сильных сторон не выделено.');
  strengths.forEach((item, i) => {
    const note = item.note ? ` ${item.note}` : '';
    lines.push(`${i + 1}. ${item.text} (${item.evidence}).${note}`);
  });

  lines.push('', 'Подтверждённые проблемы:');
  if (!problems.length) lines.push('— Явные проблемы по доступным метрикам не подтверждены.');
  problems.forEach((item, i) => lines.push(`${i + 1}. ${item.text} (${item.evidence}).`));

  lines.push('', 'Что нельзя определить по этим данным:');
  unknowns.slice(0, 8).forEach((item) => lines.push(`• ${item}`));

  lines.push('', 'Действия на тренировку:');
  actions.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${item.text}`));

  const strongest = strengths[0]?.text?.toLowerCase();
  const mainProblem = problems[0]?.text?.toLowerCase();
  let conclusion = 'Матч нужно оценивать по подтверждённым числам, без выводов о позициях, коммуникации и решениях, которых парсер пока не измеряет.';
  if (strongest && mainProblem) conclusion = `Главный плюс — ${strongest}; главная зона роста — ${mainProblem}. Остальные выводы ограничены доступными метриками.`;
  else if (strongest) conclusion = `Главный подтверждённый плюс — ${strongest}. Явной критической проблемы по доступным метрикам не найдено.`;
  else if (mainProblem) conclusion = `Главная подтверждённая зона роста — ${mainProblem}. Остальные выводы требуют дополнительных данных.`;

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
      evidenceMode: 'deterministic-facts-v4',
      modelInstalled: models.some((name) => name === model || name.startsWith(`${model}:`)),
      models,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      provider: 'ollama-local',
      model,
      evidenceMode: 'deterministic-facts-v4',
      error: `Ollama недоступен: ${error?.message || error}`,
    });
  }
});

app.post('/v1/analyze', authorize, async (req, res) => {
  const match = req.body?.match;
  const validationError = validateMatch(match);
  if (validationError) return res.status(400).json({ error: validationError });

  const metrics = deriveVerifiedMetrics(match);
  const score = deterministicScore(metrics);
  const { strengths, problems } = buildFacts(metrics);
  const unknowns = buildUnknowns(match);
  const actions = actionLibrary(metrics, problems);

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
  });

  res.json({
    analysis,
    model,
    provider: 'ollama-local-priority-selector',
    evidenceMode: 'deterministic-facts-v4',
    verifiedMetrics: metrics,
    deterministicScore: score,
  });
});

app.listen(port, host, () => {
  console.log(`Local Ollama gateway: http://${host}:${port}`);
  console.log(`Ollama: ${ollamaUrl}`);
  console.log(`Model: ${model}`);
  console.log('Evidence mode: deterministic-facts-v4');
  console.log(`AI timeout: ${Math.round(timeoutMs / 1000)}s`);
});
