import { defaultRadarLayer, getRadarMeta, loadRadarImage, worldToRadarFraction } from './radar-catalog.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[m]));

const state = {
  match: null,
  file: null,
  selectedPlayerId: null,
  episode: null,
  replay: null,
  coach: null,
  meta: null,
  time: -4,
  playing: false,
  raf: 0,
  lastTs: 0,
};

function captureFile(file) {
  if (file?.name?.toLowerCase().endsWith('.dem')) state.file = file;
}

document.querySelector('#demoInput')?.addEventListener('change', (e) => captureFile(e.target.files?.[0]));
document.querySelector('#dropZone')?.addEventListener('drop', (e) => captureFile(e.dataTransfer?.files?.[0]));

const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (/\/api\/analyze(?:\?|$)/.test(url) && response.ok) {
      response.clone().json().then(async (data) => {
        state.match = data;
        state.selectedPlayerId = String(data?.players?.[0]?.steamid || data?.players?.[0]?.name || '');
        state.episode = null;
        state.replay = null;
        state.coach = null;
        try { state.meta = data?.map ? await getRadarMeta(data.map) : null; } catch { state.meta = null; }
        setTimeout(renderEpisodePanel, 0);
      }).catch(() => {});
    }
  } catch {}
  return response;
};

function playerById(id) {
  if (!state.match) return null;
  return state.match.players?.find((p) => String(p.steamid || p.name) === String(id)) || null;
}

function selectedPlayerName() {
  if (!state.match) return '';
  const explicit = playerById(state.selectedPlayerId);
  if (explicit) return explicit.name || '';
  const row = document.querySelector('#scoreBody tr.selected');
  if (!row) return '';
  return playerById(row.dataset.id)?.name || '';
}

function setSelectedPlayer(id, { clearViewer = true } = {}) {
  const next = String(id || '');
  if (!next || !playerById(next)) return;
  const changed = next !== String(state.selectedPlayerId || '');
  state.selectedPlayerId = next;
  if (changed && clearViewer) {
    state.playing = false;
    stopAnimation();
    state.episode = null;
    state.replay = null;
    state.coach = null;
    renderViewerMessage('Выбери эпизод нового игрока и нажми «▶ 8с Replay».');
  }
  renderEpisodePanel();
}

function episodesForView() {
  const all = Array.isArray(state.match?.replayEpisodes) && state.match.replayEpisodes.length
    ? state.match.replayEpisodes
    : Array.isArray(state.match?.criticalEpisodes) ? state.match.criticalEpisodes : [];
  const selected = selectedPlayerName();
  if (!selected) return all.slice(0, 30);
  return all.filter((e) => e.player === selected).slice(0, 30);
}

function ensurePanel() {
  const results = $('#results');
  if (!results) return null;
  let panel = $('#v10LitePanel');
  if (panel) return panel;
  panel = document.createElement('section');
  panel.id = 'v10LitePanel';
  panel.className = 'panel v10-lite-panel';
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <div class="eyebrow">V10 LITE · EPISODE REPLAY + SAFE-DEFAULT COACH</div>
        <h3>Эпизоды для разбора</h3>
        <div id="v10LiteHint" class="hint">Полный replay матча не строится. Для выбранного игрока доступны отдельные фрагменты его смертей.</div>
      </div>
      <select id="v10LitePlayerSelect" aria-label="Игрок для V10 Lite"></select>
    </div>
    <div class="v10-lite-grid">
      <div id="v10LiteEpisodes" class="v10-lite-episodes"></div>
      <div id="v10LiteViewer" class="v10-lite-viewer">
        <div class="muted">Выбери эпизод и нажми «▶ 8с Replay».</div>
      </div>
    </div>`;
  const twoCol = $('.two-col');
  (twoCol || results.lastElementChild)?.insertAdjacentElement('beforebegin', panel);
  $('#v10LitePlayerSelect')?.addEventListener('change', (event) => {
    const id = String(event.target.value || '');
    setSelectedPlayer(id);
    const scoreboardRow = [...document.querySelectorAll('#scoreBody tr')].find((row) => String(row.dataset.id || '') === id);
    if (scoreboardRow && !scoreboardRow.classList.contains('selected')) scoreboardRow.click();
  });
  return panel;
}

function renderPlayerSelect() {
  const select = $('#v10LitePlayerSelect');
  if (!select || !state.match) return;
  const players = state.match.players || [];
  const current = String(state.selectedPlayerId || players[0]?.steamid || players[0]?.name || '');
  select.innerHTML = players.map((p) => {
    const id = String(p.steamid || p.name);
    return `<option value="${esc(id)}">${esc(p.name)}</option>`;
  }).join('');
  if (players.some((p) => String(p.steamid || p.name) === current)) select.value = current;
}

function renderEpisodePanel() {
  const panel = ensurePanel();
  if (!panel || !state.match) return;
  renderPlayerSelect();
  const box = $('#v10LiteEpisodes');
  const eps = episodesForView();
  const selected = selectedPlayerName();
  const hint = $('#v10LiteHint');
  if (hint) hint.textContent = selected
    ? `${selected}: ${eps.length} фрагмент${eps.length === 1 ? '' : eps.length < 5 ? 'а' : 'ов'} смертей. Replay и coach-разбор загружаются только для выбранного момента.`
    : `Доступно ${eps.length} фрагментов. Выбери игрока в scoreboard или в списке справа.`;
  if (!eps.length) {
    box.innerHTML = '<div class="muted">Для выбранного игрока фрагменты смертей не найдены.</div>';
    return;
  }
  box.innerHTML = eps.map((ep, i) => `
    <div class="v10-lite-episode ${ep.severity || 'review'}">
      <div>
        <b>R${ep.round} · ${ep.t == null ? '—' : Number(ep.t).toFixed(1) + 'с'}</b>
        <span>${esc(ep.player)} → смерть от ${esc(ep.attacker || 'соперника')}${ep.weapon ? ` · ${esc(ep.weapon)}` : ''}</span>
        <div class="v10-lite-tags">${(ep.reasons || ['DEATH REVIEW']).map((r) => `<i>${esc(r)}</i>`).join('')}</div>
      </div>
      <button class="ghost-btn" data-replay-index="${i}" type="button">▶ 8с Replay + Coach</button>
    </div>`).join('');
  box.querySelectorAll('[data-replay-index]').forEach((btn) => btn.addEventListener('click', () => loadEpisodeReplay(eps[Number(btn.dataset.replayIndex)], btn)));
}

async function loadEpisodeReplay(ep, button) {
  if (!state.file) {
    renderViewerMessage('Не удалось сохранить исходный .dem в браузере. Выбери эту же демку ещё раз и повтори.');
    return;
  }
  state.episode = ep;
  state.replay = null;
  state.coach = null;
  state.playing = false;
  stopAnimation();
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Загрузка…';
  renderViewerMessage(`R${ep.round}: читаем только ±4 секунды вокруг tick ${ep.tick}…`);
  const form = new FormData();
  form.append('demo', state.file);
  form.append('tick', String(ep.tick));
  form.append('round', String(ep.round));
  form.append('before', '4');
  form.append('after', '4');
  try {
    const response = await originalFetch('/api/episode-replay', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.replay = data;
    state.time = -Number(data.beforeSec || 4);
    renderViewer();
    drawFrame();
    loadEpisodeCoach();
    $('#v10LitePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    renderViewerMessage(`Replay эпизода недоступен: ${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

async function loadEpisodeCoach() {
  const box = $('#v10LiteCoach');
  if (!box || !state.episode || !state.replay) return;
  box.innerHTML = '<div class="muted">Разбираем только выбранный эпизод…</div>';
  try {
    const response = await originalFetch('/api/episode-coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episode: state.episode, replay: state.replay }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.coach = data;
    renderCoach();
  } catch (error) {
    box.innerHTML = `<div class="v10-coach-error">Coach-разбор недоступен: ${esc(error.message || error)}</div>`;
  }
}

function evidenceCards(evidence = {}) {
  const rows = [
    ['HP перед смертью', evidence.hpBeforeDeath == null ? '—' : evidence.hpBeforeDeath],
    ['Дистанция дуэли*', evidence.duelDistance2d == null ? '—' : `${evidence.duelDistance2d}u`],
    ['Ближайший тиммейт*', evidence.nearestTeammateDistance2d == null ? '—' : `${evidence.nearestTeammateDistance2d}u`],
    ['Движение за 1.5с*', evidence.movementLast1_5s2d == null ? '—' : `${evidence.movementLast1_5s2d}u`],
    ['Facing error*', evidence.facingErrorDeg2d == null ? '—' : `${evidence.facingErrorDeg2d}°`],
  ];
  return rows.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');
}

function renderCoach() {
  const box = $('#v10LiteCoach');
  const coach = state.coach;
  if (!box || !coach) return;
  box.innerHTML = `
    <div class="v10-coach-head">
      <div><div class="eyebrow">EPISODE-ONLY COACH</div><h4>Что произошло и как сыграть безопаснее</h4></div>
      <span class="v10-coach-mode">SAFE-DEFAULT</span>
    </div>
    <div class="v10-coach-evidence">${evidenceCards(coach.evidence)}</div>
    <div class="v10-coach-columns">
      <section><h5>Почему отмечен</h5>${(coach.why || []).map((x) => `<p>${esc(x)}</p>`).join('')}</section>
      <section><h5>Риск</h5>${(coach.risks || []).map((x) => `<p>${esc(x)}</p>`).join('')}</section>
    </div>
    <div class="v10-coach-plan"><h5>Как сыграть вместо этого</h5><ol>${(coach.plan || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>
    <div class="position-disclaimer">${esc(coach.limits || '')}</div>`;
}

function renderViewerMessage(text) {
  const viewer = $('#v10LiteViewer');
  if (viewer) viewer.innerHTML = `<div class="v10-lite-message">${esc(text)}</div>`;
}

function renderViewer() {
  const viewer = $('#v10LiteViewer');
  const r = state.replay;
  const ep = state.episode;
  if (!viewer || !r || !ep) return;
  viewer.innerHTML = `
    <div class="v10-lite-head">
      <div><div class="eyebrow">R${ep.round} · ${esc((ep.reasons || []).join(' + '))}</div><h4>${esc(ep.player)} vs ${esc(ep.attacker || 'opponent')}</h4></div>
      <div class="v10-lite-perf">${r.frames.length} frames · ${r.sampleHz} fps · ${r.elapsedMs} ms</div>
    </div>
    <div class="v10-lite-canvas-wrap"><canvas id="v10LiteCanvas"></canvas></div>
    <div class="v10-lite-controls">
      <button id="v10LitePlay" class="ghost-btn" type="button">▶</button>
      <button id="v10LiteError" class="ghost-btn" type="button">К ошибке</button>
      <input id="v10LiteRange" type="range" min="-${Number(r.beforeSec || 4)}" max="${Number(r.afterSec || 4)}" step="0.05" value="-${Number(r.beforeSec || 4)}" />
      <span id="v10LiteTime">−${Number(r.beforeSec || 4).toFixed(1)}с</span>
    </div>
    <div id="v10LiteCoach" class="v10-lite-coach"><div class="muted">Готовим coach-разбор выбранного эпизода…</div></div>
    <div class="position-disclaimer">V10 Lite показывает только координаты короткого окна. WIDE*/REPEEK* — эвристики; navmesh и line-of-sight не используются.</div>`;
  $('#v10LitePlay')?.addEventListener('click', togglePlay);
  $('#v10LiteError')?.addEventListener('click', () => { state.playing = false; stopAnimation(); state.time = 0; syncControls(); drawFrame(); });
  $('#v10LiteRange')?.addEventListener('input', (e) => { state.playing = false; stopAnimation(); state.time = Number(e.target.value); syncControls(); drawFrame(); });
}

function frameAt(time) {
  const frames = state.replay?.frames || [];
  if (!frames.length) return null;
  let best = frames[0];
  let dist = Math.abs(Number(best.t) - time);
  for (const frame of frames) {
    const d = Math.abs(Number(frame.t) - time);
    if (d < dist) { best = frame; dist = d; }
  }
  return best;
}

function bounds() {
  const ps = (state.replay?.frames || []).flatMap((f) => f.players || []);
  if (!ps.length) return null;
  return {
    minX: Math.min(...ps.map((p) => p.x)), maxX: Math.max(...ps.map((p) => p.x)),
    minY: Math.min(...ps.map((p) => p.y)), maxY: Math.max(...ps.map((p) => p.y)),
  };
}

async function drawFrame() {
  const canvas = $('#v10LiteCanvas');
  const frame = frameAt(state.time);
  if (!canvas || !frame) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(560, Math.floor(rect.width || 760));
  const height = Math.max(430, Math.floor(width * 0.66));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#070a0f';
  ctx.fillRect(0, 0, width, height);

  const size = Math.min(width - 18, height - 18);
  const x0 = (width - size) / 2, y0 = (height - size) / 2;
  if (state.meta?.available) {
    try {
      const img = await loadRadarImage(defaultRadarLayer(state.meta));
      ctx.drawImage(img, x0, y0, size, size);
      ctx.fillStyle = 'rgba(2,5,8,.18)';
      ctx.fillRect(x0, y0, size, size);
    } catch {}
  }

  const b = bounds();
  const project = (p) => {
    if (state.meta?.available) {
      const f = worldToRadarFraction(state.meta, p.x, p.y);
      return f ? { x: x0 + f.fx * size, y: y0 + f.fy * size } : null;
    }
    if (!b) return null;
    return {
      x: 35 + ((p.x - b.minX) / (b.maxX - b.minX || 1)) * (width - 70),
      y: height - 35 - ((p.y - b.minY) / (b.maxY - b.minY || 1)) * (height - 70),
    };
  };

  const ep = state.episode;
  const victimPath = (state.replay?.frames || []).filter((f) => Number(f.t) <= state.time).map((f) => (f.players || []).find((p) => p.name === ep.player)).filter(Boolean).map(project).filter(Boolean);
  if (victimPath.length > 1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(86,220,145,.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(victimPath[0].x, victimPath[0].y);
    for (const q of victimPath.slice(1)) ctx.lineTo(q.x, q.y);
    ctx.stroke();
    ctx.restore();
  }

  for (const p of frame.players || []) {
    const q = project(p); if (!q) continue;
    const ct = Number(p.teamNumber) === 3;
    const isVictim = p.name === ep.player;
    const isAttacker = p.name === ep.attacker;
    ctx.save();
    ctx.globalAlpha = p.alive === false ? 0.35 : 1;
    ctx.fillStyle = ct ? '#65baff' : '#f1c75b';
    ctx.strokeStyle = isVictim ? '#ff596b' : isAttacker ? '#ffd166' : '#071018';
    ctx.lineWidth = isVictim || isAttacker ? 4 : 2;
    ctx.beginPath();
    ctx.arc(q.x, q.y, isVictim ? 11 : 8, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    if (Number.isFinite(Number(p.yaw))) {
      const a = Number(p.yaw) * Math.PI / 180;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + Math.cos(a) * 15, q.y + Math.sin(a) * 15); ctx.stroke();
    }
    if (isVictim || isAttacker) {
      ctx.fillStyle = '#fff'; ctx.font = '700 10px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(p.name, q.x, q.y - 16);
    }
    ctx.restore();
  }

  if (Math.abs(state.time) < 0.08) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,89,107,.92)';
    ctx.font = '800 13px system-ui';
    ctx.fillText('МОМЕНТ СМЕРТИ / ОШИБКИ', 18, 28);
    ctx.restore();
  }
}

function togglePlay() {
  if (!state.replay) return;
  state.playing = !state.playing;
  if (state.playing) {
    if (state.time >= Number(state.replay.afterSec || 4)) state.time = -Number(state.replay.beforeSec || 4);
    state.lastTs = performance.now();
    animate(state.lastTs);
  } else stopAnimation();
  syncControls();
}

function animate(ts) {
  if (!state.playing || !state.replay) return;
  const dt = Math.min(0.1, (ts - state.lastTs) / 1000);
  state.lastTs = ts;
  state.time += dt;
  if (state.time >= Number(state.replay.afterSec || 4)) {
    state.time = Number(state.replay.afterSec || 4);
    state.playing = false;
  }
  syncControls();
  drawFrame();
  if (state.playing) state.raf = requestAnimationFrame(animate);
}

function stopAnimation() {
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
}

function syncControls() {
  const range = $('#v10LiteRange');
  if (range) range.value = String(state.time);
  const play = $('#v10LitePlay');
  if (play) play.textContent = state.playing ? '❚❚' : '▶';
  const label = $('#v10LiteTime');
  if (label) label.textContent = `${state.time >= 0 ? '+' : '−'}${Math.abs(state.time).toFixed(1)}с`;
}

// Keep V10 Lite synced with the scoreboard. We store the clicked player ourselves,
// instead of relying on timing/class changes inside app.js.
document.addEventListener('click', (event) => {
  const row = event.target.closest('#scoreBody tr');
  if (!row) return;
  const id = String(row.dataset.id || '');
  if (id) setTimeout(() => setSelectedPlayer(id), 0);
});

const observer = new MutationObserver(() => {
  if (state.match && !$('#v10LitePanel')) renderEpisodePanel();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('resize', () => { if (state.replay) drawFrame(); });
