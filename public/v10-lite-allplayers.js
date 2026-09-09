const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[m]));

const state = {
  match: null,
  allMode: true,
  rendering: false,
};

const wrappedFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await wrappedFetch(...args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (/\/api\/analyze(?:\?|$)/.test(url) && response.ok) {
      response.clone().json().then((data) => {
        state.match = data;
        state.allMode = true;
        setTimeout(() => activateAllPlayers(), 120);
      }).catch(() => {});
    }
  } catch {}
  return response;
};

function episodes() {
  if (!state.match) return [];
  if (Array.isArray(state.match.replayEpisodes) && state.match.replayEpisodes.length) return state.match.replayEpisodes;
  if (Array.isArray(state.match.criticalEpisodes)) return state.match.criticalEpisodes;
  return [];
}

function playerIdByName(name) {
  const player = state.match?.players?.find((p) => p.name === name);
  return player ? String(player.steamid || player.name) : '';
}

function episodeKey(ep) {
  return String(ep?.id || `${ep?.round || 0}-${ep?.tick || 0}-${ep?.player || ''}`);
}

function ensureAllOption() {
  const select = $('#v10LitePlayerSelect');
  if (!select || !state.match) return;
  let option = [...select.options].find((o) => o.value === '__all__');
  if (!option) {
    option = document.createElement('option');
    option.value = '__all__';
    option.textContent = `Все игроки (${state.match.players?.length || 0})`;
    select.insertBefore(option, select.firstChild);
  }
  if (state.allMode) select.value = '__all__';
}

function groupedEpisodes() {
  const all = episodes();
  const order = new Map((state.match?.players || []).map((p, i) => [p.name, i]));
  const groups = new Map();
  for (const ep of all) {
    const name = ep.player || 'Unknown';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(ep);
  }
  return [...groups.entries()].sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999));
}

function renderAllPlayers() {
  if (!state.allMode || state.rendering || !state.match) return;
  const box = $('#v10LiteEpisodes');
  const hint = $('#v10LiteHint');
  if (!box) return;

  state.rendering = true;
  try {
    const all = episodes();
    const groups = groupedEpisodes();
    if (hint) hint.textContent = `Все игроки: ${all.length} фрагментов смертей. Выбери любой эпизод — 8с Replay и Coach загрузятся только для него.`;
    if (!all.length) {
      box.innerHTML = '<div class="muted">Фрагменты смертей не найдены.</div>';
      return;
    }

    box.innerHTML = groups.map(([player, playerEpisodes]) => `
      <section class="v10-all-group">
        <div class="v10-all-group-head">
          <b>${esc(player)}</b>
          <span>${playerEpisodes.length} эп.</span>
        </div>
        ${playerEpisodes.map((ep) => `
          <div class="v10-lite-episode ${ep.severity || 'review'}" data-all-episode="${esc(episodeKey(ep))}">
            <div>
              <b>R${ep.round} · ${ep.t == null ? '—' : Number(ep.t).toFixed(1) + 'с'}</b>
              <span>${esc(ep.player)} → смерть от ${esc(ep.attacker || 'соперника')}${ep.weapon ? ` · ${esc(ep.weapon)}` : ''}</span>
              <div class="v10-lite-tags">${(ep.reasons || ['DEATH REVIEW']).map((r) => `<i>${esc(r)}</i>`).join('')}</div>
            </div>
            <button class="ghost-btn" data-all-replay="${esc(episodeKey(ep))}" type="button">▶ 8с Replay + Coach</button>
          </div>`).join('')}
      </section>`).join('');

    box.querySelectorAll('[data-all-replay]').forEach((button) => {
      button.addEventListener('click', () => {
        const ep = all.find((x) => episodeKey(x) === button.dataset.allReplay);
        if (ep) openEpisodeThroughNativeLoader(ep, button);
      });
    });
  } finally {
    state.rendering = false;
  }
}

function activateAllPlayers() {
  ensureAllOption();
  state.allMode = true;
  const select = $('#v10LitePlayerSelect');
  if (select) select.value = '__all__';
  renderAllPlayers();
}

function openEpisodeThroughNativeLoader(ep, customButton) {
  const select = $('#v10LitePlayerSelect');
  const playerId = playerIdByName(ep.player);
  if (!select || !playerId) return;

  const oldText = customButton.textContent;
  customButton.disabled = true;
  customButton.textContent = 'Открываем…';

  state.allMode = false;
  select.value = playerId;
  select.dispatchEvent(new Event('change', { bubbles: true }));

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const playerEpisodes = episodes().filter((x) => x.player === ep.player).slice(0, 30);
    const index = playerEpisodes.findIndex((x) => episodeKey(x) === episodeKey(ep));
    const nativeButtons = [...document.querySelectorAll('#v10LiteEpisodes [data-replay-index]')];
    const nativeButton = index >= 0 ? nativeButtons[index] : null;

    if (nativeButton) nativeButton.click();

    state.allMode = true;
    ensureAllOption();
    if (select) select.value = '__all__';
    setTimeout(() => {
      renderAllPlayers();
      customButton.disabled = false;
      customButton.textContent = oldText;
    }, 40);
  }));
}

// Intercept only the synthetic "Все игроки" value. Player values continue to use
// the original V10 Lite handler and keep scoreboard ↔ replay synchronization.
document.addEventListener('change', (event) => {
  const select = event.target.closest?.('#v10LitePlayerSelect');
  if (!select) return;
  if (select.value === '__all__') {
    event.stopImmediatePropagation();
    state.allMode = true;
    renderAllPlayers();
  } else {
    state.allMode = false;
  }
}, true);

document.addEventListener('click', (event) => {
  if (event.target.closest?.('#scoreBody tr')) state.allMode = false;
});

const observer = new MutationObserver(() => {
  if (!state.match) return;
  ensureAllOption();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
