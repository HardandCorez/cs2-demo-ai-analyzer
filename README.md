# HardandCore CS2 Demo AI Analyzer — Remote AI Gateway edition

Рабочая схема:

```text
браузер
   ↓
локальный Node.js :3000
   ├─ @laihoe/demoparser2 читает .dem локально
   └─ формирует компактный JSON
              ↓ HTTPS
      удалённый AI Gateway
              ↓
         OpenAI API
```

**Важно:** `.dem` не отправляется на удалённый AI-сервер. Туда уходит только выбранный игрок, scoreboard и до 45 связанных kill-events.

## 1. Локальный запуск

Нужен Node.js 20+.

```powershell
cd путь\к\cs2-demo-ai-analyzer-remote
npm install
Copy-Item .env.example .env
notepad .env
```

Пока gateway ещё не развернут, оставь `AI_GATEWAY_URL` пустым. После деплоя заполни:

```env
AI_GATEWAY_URL=https://ТВОЙ-GATEWAY-ДОМЕН
AI_GATEWAY_TOKEN=ТВОЙ-СЕКРЕТНЫЙ-ТОКЕН
AI_TIMEOUT_MS=90000

OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
PORT=3000
MAX_DEMO_MB=800
```

Запуск:

```powershell
npm start
```

Открой `http://localhost:3000`.

## 2. Создание токена

В папке проекта:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\new-gateway-token.ps1
```

Скопируй результат. Один и тот же токен нужно поставить:

- на удалённом сервере: `AI_GATEWAY_TOKEN=...`
- локально: `AI_GATEWAY_TOKEN=...`

## 3. Деплой удалённого gateway

В каталоге `gateway/` находится отдельное Node.js-приложение и Dockerfile.

На хостинге/сервере в поддерживаемой OpenAI стране настрой:

```env
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5.4-mini
AI_GATEWAY_TOKEN=тот-же-токен
PORT=8080
RATE_LIMIT_PER_MINUTE=30
```

Команда запуска:

```bash
npm install && npm start
```

или используй `gateway/Dockerfile`.

После деплоя проверь:

```text
https://ТВОЙ-ДОМЕН/health
```

Затем URL без `/health` внеси в локальный `.env` как `AI_GATEWAY_URL`.

## 4. Что изменилось

- `.dem` парсится на твоём ПК.
- OpenAI API key хранится **только на удалённом gateway**.
- Локальный сервер не обращается к OpenAI напрямую, когда задан `AI_GATEWAY_URL`.
- Между локальным приложением и gateway используется Bearer token.
- Gateway имеет простую защиту от частых запросов.
- Если gateway не настроен, старый прямой режим через `OPENAI_API_KEY` остаётся как fallback.

## 5. Проверка режима

После `npm start` верхний индикатор сайта должен показать:

```text
Парсер готов · AI gateway
```

Если показывает `AI direct`, значит используется локальный `OPENAI_API_KEY`.
Если показывает `AI не настроен`, проверь `.env`.

## Безопасность

Не добавляй `.env` в Git. Не вставляй API key в `public/app.js`, HTML или любой клиентский код. Если ключ когда-либо был опубликован в чате, репозитории или скриншоте, его следует отозвать и создать новый.
