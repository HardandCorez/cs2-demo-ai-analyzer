const originalFetch = window.fetch.bind(window);
let lastPerformance = null;

function formatSeconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}с` : `${Math.round(value)}мс`;
}

function renderPerformanceBadge() {
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

window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (/\/api\/analyze(?:\?|$)/.test(url) && response.ok) {
      response.clone().json().then((data) => {
        lastPerformance = data?.parsePerformance || null;
        setTimeout(renderPerformanceBadge, 80);
      }).catch(() => {});
    }
  } catch {}
  return response;
};

// app.js uses a timer-based percentage while one POST is running. Keep the bar,
// but do not pretend that 76%/88% is a specific backend parser stage.
const observer = new MutationObserver(() => {
  const label = document.querySelector('#progressLabel');
  const percent = Number((document.querySelector('#progressPercent')?.textContent || '').replace(/[^0-9.]/g, ''));
  if (!label || !Number.isFinite(percent) || percent < 55 || percent >= 100) return;
  if (label.textContent !== 'Fast Core: разбираем .dem…') label.textContent = 'Fast Core: разбираем .dem…';
  renderPerformanceBadge();
});
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
