// Бейдж производительности разбора + честный прогресс-бар.
// Раньше модуль сам патчил window.fetch; теперь слушает событие из analysis-events.js.

import { getLastPerformance } from './analysis-events.js';

function formatSeconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}с` : `${Math.round(value)}мс`;
}

function renderPerformanceBadge() {
  const lastPerformance = getLastPerformance();
  if (!lastPerformance) return;
  const box = document.querySelector('#matchBadges');
  if (!box) return;
  box.querySelector('[data-fastcore-badge]')?.remove();

  const fallback = lastPerformance.fallbackUsed === true;
  const total = lastPerformance.timingsMs?.total ?? lastPerformance.wrapperElapsedMs;
  const elapsed = formatSeconds(total);
  const mode = lastPerformance.tickPassMode || (fallback ? 'stable fallback' : 'fast core');
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.dataset.fastcoreBadge = '1';
  badge.textContent = fallback
    ? `Stable fallback${elapsed ? ` · ${elapsed}` : ''}`
    : `Fast Core · ${mode}${elapsed ? ` · ${elapsed}` : ''}`;
  badge.title = fallback
    ? `Fast Core не использован: ${lastPerformance.fastCoreError || 'включён совместимый стабильный парсер'}`
    : 'Время реального серверного разбора .dem. Не является фейковым прогрессом интерфейса.';
  box.appendChild(badge);
}

window.addEventListener('cs2:match-analyzed', () => setTimeout(renderPerformanceBadge, 80));

// app.js использует таймерный процент, пока идёт один POST. Бар оставляем,
// но не притворяемся, что 76%/88% — это конкретная стадия серверного парсера.
const observer = new MutationObserver(() => {
  const label = document.querySelector('#progressLabel');
  const percent = Number((document.querySelector('#progressPercent')?.textContent || '').replace(/[^0-9.]/g, ''));
  if (!label || !Number.isFinite(percent) || percent < 55 || percent >= 100) return;
  if (label.textContent !== 'Разбираем .dem…') label.textContent = 'Разбираем .dem…';
  renderPerformanceBadge();
});
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
