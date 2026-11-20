# cleanup.ps1 — удаляет устаревшие файлы после применения рефакторинга 5.0.0.
# Запускать из корня репозитория ПОСЛЕ того, как новые файлы из архива рефакторинга
# скопированы на свои места. Сначала можно прогнать с -WhatIf.
# Пример: powershell -ExecutionPolicy Bypass -File .\scripts\cleanup.ps1

param([switch]$WhatIf)

$legacy = @(
  # Серверная версионная свалка (заменена src/server.js + src/demo/* + src/episodes.js + src/ai.js)
  'src/server-v10fast.js',
  'src/server-v10lite.js',
  'src/server-fastcore.js',
  'src/server-v8.js',
  'src/server-v9.js',
  'src/server-v71.js',
  'src/server-v92.js',
  'src/v8-replay.js',
  'src/v71-trajectories.js',
  # Локальные Ollama-gateway'и (напрямую не используются unified-сервером;
  # удалённый gateway в gateway/ сохраняется)
  'src/ollama-gateway.js',
  'src/ollama-gateway-v61.js',
  'src/ollama-gateway-v62.js',
  # Переименован в src/security.js
  'src/local-security.js',
  # Фронтенд-остатки старых версий (не подключены к index.html/bootstrap-v72.js)
  'public/v9-suite.js',
  'public/v9.css',
  'public/v91-ui.js',
  'public/v91.css',
  'public/v92-progress.js',
  'public/v10.css',
  'public/v10-replay-coach.js',
  'public/visual-coach-v72.js',
  'public/zoom-controls-v73.js',
  # Не используется: multer пишет в os.tmpdir()
  'uploads'
  # ВНИМАНИЕ: matches.html / matches-page.js / matches.css удаляй только если
  # страница истории матчей не открывается из UI (проверь ссылки в match-history.js).
)

foreach ($path in $legacy) {
  if (Test-Path $path) {
    Remove-Item -Recurse -Force -WhatIf:$WhatIf $path
    Write-Host "deleted: $path"
  } else {
    Write-Host "not found (ok): $path"
  }
}
Write-Host ''
Write-Host 'Готово. Проверь git status, затем npm run check && npm test, и только после этого коммить.'
