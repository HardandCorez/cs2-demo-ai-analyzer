# Рефакторинг-чистка 5.0.0

## Что меняется

Была цепочка из трёх HTTP-сервисов в одном процессе:
`server-v10fast.js (:3000)` → прокси → `server-v10lite.js (:3001)` → прокси → `server.js (:3002)`,
плюс `server-fastcore.js (:3003)`. Дублировались хелперы парсинга (~70% кода
`server.js` и `server-fastcore.js` совпадали), файлы эпизодов существовали в трёх копиях,
а на фронте `fastcore-ui.js` и `v10-lite.js` каждый патчили `window.fetch`.

Стало — один процесс, один порт:

```
src/
  server.js            — единый express: static, /api/analyze (fast → stable fallback),
                         /api/episode-replay, /api/episode-coach, /api/ai
  security.js          — requireLoopbackHost (бывший local-security.js, без изменений)
  demo/
    shared.js          — общие хелперы парсинга (из server.js + server-fastcore.js)
    parse-fast.js      — Fast Core: combined single-pass parseTicks (бывший server-fastcore.js)
    parse-stable.js    — стабильный multi-pass парсер (бывшее тело server.js)
  episodes.js          — эпизоды смертей + safe-default coach (бывший server-v10lite.js)
  ai.js                — payload, инструкции, direct/gateway вызовы (бывший server.js /api/ai)
  v5-metrics.js, v6-positioning.js — без изменений
public/
  analysis-events.js   — НОВЫЙ: единый перехват fetch, событие 'cs2:match-analyzed'
  bootstrap-v72.js     — импортирует analysis-events.js первым
  fastcore-ui.js       — слушает событие вместо собственного патча fetch
  v10-lite.js          — слушает событие вместо собственного патча fetch
gateway/               — без изменений
```

## Поведение сохранено

- `/api/analyze`: сначала Fast Core; при ошибке — автоматический stable fallback,
  `parsePerformance.fallbackUsed/fastCoreError` на месте (бейдж в UI работает как раньше).
- Ответ включает `replayEpisodes`, `criticalEpisodes`, `dataAvailability` — как раньше.
- `/api/health`: те же ключи плюс `engines`; индикатор в UI покажет режим AI как раньше
  (ключи `aiMode`/`aiConfigured` сохранены).
- `.env` менять не нужно.

## Порядок применения

1. Скопируй новые файлы из архива поверх репозитория (с заменой `src/server.js`,
   `public/bootstrap-v72.js`, `public/fastcore-ui.js`, `public/v10-lite.js`, `package.json`).
2. `powershell -ExecutionPolicy Bypass -File .\scripts\cleanup.ps1 -WhatIf` — посмотри, что удалится.
3. Убедись, что страница истории матчей не использует `matches.html` (см. заметку в cleanup.ps1),
   затем запусти cleanup без `-WhatIf`.
4. `npm install` (package.json обновлён до 5.0.0; зависимости те же).
5. `npm run check && npm test`.
6. `npm start` — открой `http://localhost:3000`, загрузи демку, проверь:
   scoreboard, бейдж Fast Core/Stable fallback, эпизоды + replay + coach, AI-разбор.

## Что проверить вручную (не смог проверить удалённо)

- `tests/*.test.js` — они могут импортировать старые пути (`src/server.js` сохранён,
  но `src/local-security.js` теперь `src/security.js`). Если тесты импортируют
  `local-security` — поправь импорт на `./security.js`.
- `public/v10-lite-allplayers.js` — я его не читал; если он тоже патчит `window.fetch`,
  переведи его на событие `cs2:match-analyzed` по образцу v10-lite.js.
- `public/match-history.js` — проверь, не ведёт ли он на `matches.html`
  (тогда не удаляй matches.html/matches-page.js/matches.css).
- Локальный Ollama-режим (`npm run start:ollama-gateway`) удалён вместе с легаси-файлами.
  Если он нужен — оставь `src/ollama-gateway-v62.js` и верни скрипт в package.json.

## Заодно исправлено

- Внутренние HTTP-вызовы между парсерами (и их зависания) исчезли — fallback теперь
  in-process вызов функции.
- Двойной monkey-patch `window.fetch` на фронте заменён одним перехватом + событие.
- `uploads/` (мёртвая папка) удалена.

## Следующие шаги (не входят в эту итерацию)

- Кэш результатов парсинга по SHA-256 файла (мгновенный повторный разбор).
- Единое состояние матча на фронте вместо событийной связки.
- ESLint + Prettier.
