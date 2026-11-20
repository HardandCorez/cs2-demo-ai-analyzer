// Единая точка перехвота ответа /api/analyze для всех UI-модулей.
// Раньше fastcore-ui.js и v10-lite.js каждый патчили window.fetch по отдельности;
// теперь перехват один, а модули подписываются на событие 'cs2:match-analyzed'.

const originalFetch = window.fetch.bind(window);
let lastMatch = null;
let lastPerformance = null;

window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (/\/api\/analyze(?:\?|$)/.test(url) && response.ok) {
      response.clone().json().then((data) => {
        lastMatch = data;
        lastPerformance = data?.parsePerformance || null;
        window.dispatchEvent(new CustomEvent('cs2:match-analyzed', { detail: data }));
      }).catch(() => {});
    }
  } catch {}
  return response;
};

export function getLastMatch() { return lastMatch; }
export function getLastPerformance() { return lastPerformance; }
