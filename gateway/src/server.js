import 'dotenv/config';
import express from 'express';

const app = express();
const port = Number(process.env.PORT || 8080);
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const gatewayToken = String(process.env.AI_GATEWAY_TOKEN || '').trim();
const limitPerMinute = Math.max(1, Number(process.env.RATE_LIMIT_PER_MINUTE || 30));

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '512kb' }));

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of buckets) {
    if (now - value.startedAt > 120_000) buckets.delete(key);
  }
}, 60_000).unref();

function rateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    buckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > limitPerMinute) {
    return res.status(429).json({ error: 'Слишком много запросов к AI gateway. Попробуй через минуту.' });
  }
  next();
}

function authorize(req, res, next) {
  if (!gatewayToken) {
    return res.status(503).json({ error: 'AI_GATEWAY_TOKEN не настроен на gateway' });
  }
  const auth = String(req.headers.authorization || '');
  if (auth !== `Bearer ${gatewayToken}`) {
    return res.status(401).json({ error: 'Неверный AI gateway token' });
  }
  next();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of asArray(data?.output)) {
    for (const content of asArray(item?.content)) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

function validateMatch(match) {
  if (!match || typeof match !== 'object') return 'Нет данных матча';
  if (!match.selectedPlayer || typeof match.selectedPlayer !== 'object') return 'Не выбран игрок';
  if (!Array.isArray(match.scoreboard) || match.scoreboard.length === 0) return 'Нет scoreboard';
  if (match.scoreboard.length > 20) return 'Слишком много игроков в payload';
  if (Array.isArray(match.relatedKillEvents) && match.relatedKillEvents.length > 80) return 'Слишком много событий в payload';
  return null;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    tokenConfigured: Boolean(gatewayToken),
    model,
  });
});

app.post('/v1/analyze', rateLimit, authorize, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY не настроен на gateway' });
  }

  const match = req.body?.match;
  const validationError = validateMatch(match);
  if (validationError) return res.status(400).json({ error: validationError });

  const instructions = [
    'Ты тренер по Counter-Strike 2 и аналитик демок.',
    'Отвечай по-русски, кратко и предметно.',
    'Опирайся только на переданную статистику и события; не выдумывай позиции и тайминги, которых нет в данных.',
    'Формат: оценка 0-100; 3 сильные стороны; 3 главные ошибки/риска; 5 конкретных действий на следующую тренировку; затем короткий вывод.',
    'Если данных недостаточно для тактического вывода, прямо укажи это и предложи, какие метрики нужно добавить.',
  ].join(' ');

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions,
        input: `Разбери эту CS2 демку для выбранного игрока:\n${JSON.stringify(match)}`,
        max_output_tokens: 1400,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || `OpenAI API HTTP ${response.status}`,
      });
    }

    const analysis = extractOutputText(data);
    if (!analysis) return res.status(502).json({ error: 'OpenAI API вернул ответ без текста' });

    res.json({ analysis, model, provider: 'openai-gateway' });
  } catch (error) {
    console.error(error);
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(502).json({ error: timeout ? 'OpenAI API не ответил за 90 секунд' : `Ошибка OpenAI API: ${error?.message || error}` });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error?.message || 'Ошибка gateway' });
});

app.listen(port, () => {
  console.log(`CS2 AI Gateway listening on :${port}`);
  console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? 'configured' : 'not configured'}`);
  console.log(`Gateway token: ${gatewayToken ? 'configured' : 'not configured'}`);
});
