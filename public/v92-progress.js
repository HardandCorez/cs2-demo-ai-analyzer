const label = document.querySelector('#progressLabel');
const percent = document.querySelector('#progressPercent');

if (label) {
  const replacements = new Map([
    ['Снимаем V7.1 траектории и positioning…', 'V9.2: собираем replay + player state одним проходом…'],
    ['Парсер читает события CS2…', 'V9.2: читаем события CS2…'],
    ['Считаем V5/V6.1 метрики…', 'V9.2: считаем метрики и positioning…'],
  ]);

  let slowTimer = null;
  const resetSlowTimer = () => {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (percent?.textContent?.trim() === '88%' || Number.parseInt(percent?.textContent || '0', 10) >= 80) {
        label.textContent = 'V9.2: финализируем replay, utility и duel telemetry…';
      }
    }, 3500);
  };

  const observer = new MutationObserver(() => {
    const next = replacements.get(label.textContent.trim());
    if (next) label.textContent = next;
    resetSlowTimer();
  });

  observer.observe(label, { childList: true, subtree: true, characterData: true });
  if (percent) observer.observe(percent, { childList: true, subtree: true, characterData: true });
}
