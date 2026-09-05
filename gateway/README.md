# CS2 AI Gateway

Этот сервис принимает **только компактный JSON со статистикой матча**, а не `.dem`, и уже с удалённого сервера вызывает OpenAI API.

## Переменные окружения

```env
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5.4-mini
AI_GATEWAY_TOKEN=длинный-секретный-токен
PORT=8080
RATE_LIMIT_PER_MINUTE=30
```

`AI_GATEWAY_TOKEN` должен совпадать с токеном в локальном `.env` основного проекта.

## Запуск без Docker

```bash
npm install
npm start
```

## Docker

```bash
docker build -t cs2-ai-gateway .
docker run --rm -p 8080:8080 --env-file .env cs2-ai-gateway
```

## Проверка

Открой `https://ТВОЙ-ДОМЕН/health`. Должно быть `ok: true`, `openaiConfigured: true`, `tokenConfigured: true`.

После деплоя внеси URL сервиса в локальный `.env`:

```env
AI_GATEWAY_URL=https://ТВОЙ-ДОМЕН
AI_GATEWAY_TOKEN=тот-же-токен
OPENAI_API_KEY=
```
