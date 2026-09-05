import 'dotenv/config';
import express from 'express';

const app = express();
const host = '127.0.0.1';
const port = Number(process.env.OLLAMA_GATEWAY_PORT || 11435);
const ollamaUrl = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
const model = String(process.env.OLLAMA_MODEL || 'qwen3:8b').trim();
const gatewayToken = String(process.env.AI_GATEWAY_TOKEN || '').trim();
const timeoutMs = Math.max(30_000, Number(process.env.AI_TIMEOUT_MS || 180_000));

app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

  const system = [
    'Ты тренер по Counter-Strike 2 и аналитик демок.',
    'Отвечай по-русски, структурировано и предметно.',
    'Опирайся только на переданную статистику и события.',
    'Не выдумывай позиции, гранаты и тайминги, которых нет в данных.',
    'Формат: оценка 0-100; 3 сильные стороны; 3 главные ошибки или риска; 5 конкретных действий на следующую тренировку; короткий вывод.',
    'Если данных недостаточно для тактического вывода, прямо скажи об этом и перечисли, какие метрики нужно добавить.',
  ].join(' ');

  try {
    const response = await ollamaRequest('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Разбери эту CS2 демку для выбранного игрока:\n${JSON.stringify(match)}` },
        ],
        options: {
          temperature: 0.2,
          num_ctx: 8192,
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

    const analysis = String(data?.message?.content || '').trim();
    if (!analysis) return res.status(502).json({ error: 'Ollama вернул ответ без текста' });

    res.json({ analysis, model, provider: 'ollama-local' });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(502).json({
      error: timeout
        ? `Локальная модель не ответила за ${Math.round(timeoutMs / 1000)} секунд`
        : `Ollama недоступен: ${error?.message || error}`,
      hint: 'Проверь, что Ollama запущен и отвечает на http://127.0.0.1:11434.',
    });
  }
});

app.listen(port, host, () => {
  console.log(`Local Ollama gateway: http://${host}:${port}`);
  console.log(`Ollama: ${ollamaUrl}`);
  console.log(`Model: ${model}`);
});
