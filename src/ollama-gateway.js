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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fixed(value, digits = 2) {
  return Number(asNumber(value).toFixed(digits));
}

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
  if (Array.isArray(match.relatedKillEvents) && match.relatedKillEvents.length > 80) return 'Слишком много событий в payload';
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
    roundSurvivalPctEstimate: rounds > 0 ? Math.max(0, Math.min(100, Math.round(((rounds - deaths) / rounds) * 100))) : null,
    customImpact: fixed(p.impact, 2),
  };
}

function buildCoachPayload(match) {
  const availability = {
    exactRoundStartTiming: false,
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

  return {
    map: match.map,
    rounds: match.rounds,
    selectedPlayerName: match.selectedPlayer?.name,
    verifiedMetrics: deriveVerifiedMetrics(match),
    metricDefinitions: {
      kd: 'kills divided by deaths',
      adr: 'total damage divided by match rounds',
      hsPct: 'headshot kills divided by kills, percent',
      enemiesFlashed: 'registered enemy flash effects; NOT the number of flashbangs thrown',
      openingSuccessPct: 'entryKills / (entryKills + openingDeaths), percent',
      roundSurvivalPctEstimate: 'estimate from match rounds and deaths for a normal full-match participant',
      customImpact: 'internal project heuristic; NOT HLTV Rating',
      ...(match?.metricDefinitions || {}),
    },
    dataAvailability: availability,
    generalHeuristics: {
      note: 'These are broad context hints, not universal role/level benchmarks.',
      kd: 'around 1.00 is neutral; 1.20+ is generally a strong individual result; below 0.90 is generally weak',
      adr: '85+ is generally strong; 70-85 is solid; below 65 is generally low',
      openingSuccessPct: 'above 50% is generally positive; below 45% may indicate a weak opening-duel outcome if sample size is meaningful',
      hsPct: 'high HS% shows headshot conversion/style, but does NOT by itself prove good decision-making',
    },
    scoreboard: asArray(match.scoreboard),
    relatedKillEvents: asArray(match.relatedKillEvents),
  };
}

const answerSchema = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    strengths: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['point', 'evidence'],
      },
    },
    problems: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['point', 'evidence'],
      },
    },
    unknowns: { type: 'array', maxItems: 8, items: { type: 'string' } },
    actions: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
    conclusion: { type: 'string' },
  },
  required: ['score', 'strengths', 'problems', 'unknowns', 'actions', 'conclusion'],
};

function stripThinkBlocks(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

function parseStructuredAnswer(raw) {
  const cleaned = stripThinkBlocks(raw);
  try {
    return JSON.parse(cleaned);
  } catch {}

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch {}
  }
  return null;
}

function formatAnswer(answer) {
  const lines = [];
  lines.push(`Оценка: ${Math.max(0, Math.min(100, asNumber(answer?.score)))} / 100`);

  lines.push('', 'Подтверждённые сильные стороны:');
  const strengths = asArray(answer?.strengths).slice(0, 3);
  if (!strengths.length) lines.push('— Недостаточно данных для подтверждённых сильных сторон.');
  strengths.forEach((item, i) => lines.push(`${i + 1}. ${String(item?.point || '').trim()} (${String(item?.evidence || '').trim()})`));

  lines.push('', 'Подтверждённые проблемы:');
  const problems = asArray(answer?.problems).slice(0, 3);
  if (!problems.length) lines.push('— Явные проблемы по доступным метрикам не подтверждены.');
  problems.forEach((item, i) => lines.push(`${i + 1}. ${String(item?.point || '').trim()} (${String(item?.evidence || '').trim()})`));

  lines.push('', 'Что нельзя определить по этим данным:');
  const unknowns = asArray(answer?.unknowns).slice(0, 8);
  if (!unknowns.length) lines.push('— Дополнительных ограничений не указано.');
  unknowns.forEach((item) => lines.push(`• ${String(item || '').trim()}`));

  lines.push('', 'Действия на тренировку:');
  asArray(answer?.actions).slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${String(item || '').trim()}`));

  lines.push('', 'Вывод:', String(answer?.conclusion || '').trim());
  return lines.join('\n').trim();
}

async function ollamaRequest(path, options = {}) {
  return fetch(`${ollamaUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
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
      evidenceMode: 'verified-json-v3',
      modelInstalled: models.some((name) => name === model || name.startsWith(`${model}:`)),
      models,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      provider: 'ollama-local',
      model,
      error: `Ollama недоступен: ${error?.message || error}`,
    });
  }
});

app.post('/v1/analyze', authorize, async (req, res) => {
  const match = req.body?.match;
  const validationError = validateMatch(match);
  if (validationError) return res.status(400).json({ error: validationError });

  const coachPayload = buildCoachPayload(match);
  const system = [
    '/no_think',
    'Ты строгий аналитик Counter-Strike 2.',
    'Верни только финальный структурированный ответ по заданной JSON-схеме. Не показывай рассуждения, chain-of-thought, черновик, перевод задания или анализ JSON.',
    'Главный источник фактов — verifiedMetrics. relatedKillEvents можно использовать только как подтверждение конкретного события и раунда.',
    'Каждый плюс и минус обязан иметь числовое evidence из verifiedMetrics или номер раунда из relatedKillEvents.',
    'Если dataAvailability для метрики false, запрещено делать выводы по этой теме.',
    'Запрещено придумывать время реакции, первые секунды раунда, позиции, ротации, трейды, клатчи, экономику, T/CT-сплит, качество гранат и число брошенных флешек без соответствующих данных.',
    'enemiesFlashed — число зарегистрированных эффектов ослепления врагов, не число флешек.',
    'customImpact — внутренний коэффициент проекта, не HLTV Rating.',
    'Не называй K/D выше 1.0 низким без явного сравнительного основания.',
    'Не выдавай высокий HS% за доказательство хорошей тактики, позиции или decision-making.',
    'Если openingAttempts меньше 10, обязательно отметь малую выборку.',
    'Все текстовые значения в JSON пиши по-русски.',
  ].join(' ');

  try {
    const response = await ollamaRequest('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: answerSchema,
        keep_alive: '15m',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `/no_think\nПроанализируй только эти проверенные данные и верни ТОЛЬКО JSON по схеме:\n${JSON.stringify(coachPayload)}` },
        ],
        options: {
          temperature: 0,
          num_ctx: 4096,
          num_predict: 650,
        },
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error || `Ollama HTTP ${response.status}`;
      const hint = /model.*not found|not found/i.test(String(detail))
        ? `Скачай модель командой: ollama pull ${model}`
        : undefined;
      return res.status(response.status).json({ error: detail, hint });
    }

    const raw = String(data?.message?.content || '').trim();
    const structured = parseStructuredAnswer(raw);
    if (!structured) {
      return res.status(502).json({
        error: 'Локальная модель вернула ответ не в ожидаемом JSON-формате',
        hint: 'Перезапусти gateway после git pull. Если повторяется, попробуй qwen3:4b или обнови Ollama.',
      });
    }

    const analysis = formatAnswer(structured);
    res.json({
      analysis,
      model,
      provider: 'ollama-local',
      evidenceMode: 'verified-json-v3',
      verifiedMetrics: coachPayload.verifiedMetrics,
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(502).json({
      error: timeout
        ? `Локальная модель не ответила за ${Math.round(timeoutMs / 1000)} секунд`
        : `Ollama недоступен: ${error?.message || error}`,
      hint: timeout
        ? 'Проверь загрузку CPU/GPU и используй qwen3:4b, если 8b работает слишком медленно.'
        : 'Проверь, что Ollama запущен и отвечает на http://127.0.0.1:11434.',
    });
  }
});

app.listen(port, host, () => {
  console.log(`Local Ollama gateway: http://${host}:${port}`);
  console.log(`Ollama: ${ollamaUrl}`);
  console.log(`Model: ${model}`);
  console.log('Evidence mode: verified-json-v3');
  console.log(`AI timeout: ${Math.round(timeoutMs / 1000)}s`);
});
