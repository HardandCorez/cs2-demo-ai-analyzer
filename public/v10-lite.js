import { defaultRadarLayer, getRadarMeta, loadRadarImage, worldToRadarFraction } from './radar-catalog.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[m]));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const state = {
  match: null,
  file: null,
  episode: null,
  replay: null,
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
        state.episode = null;
        state.replay = null;
        try { state.meta = data?.map ? await getRadarMeta(data.map) : null; } catch { state.meta = null; }
        setTimeout(renderEpisodePanel, 0);
      }).catch(() => {});
    }
  } catch {}
  return response;
};

function selectedPlayerName() {
  const row = document.querySelector('#scoreBody tr.selected');
  if (!row || !state.match) return '';
  const id = String(row.dataset.id || '');
  return state.match.players?.find((p) => String(p.steamid || p.name) === id)?.name || '';
}

function episodesForView() {
  const all = Array.isArray(state.match?.criticalEpisodes) ? state.match.criticalEpisodes : [];
  const selected = selectedPlayerName();
  if (!selected) return all;
  const mine = all.filter((e) => e.player === selected);
  return mine.length ? mine : all;
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
        <div class="eyebrow">V10 LITE · ON-DEMAND EPISODE REPLAY</div>
        <h3>Критические эпизоды</h3>
        <div class="hint">Полный replay матча не строится. Загружается только короткое окно вокруг выбранной смерти.</div>
      </div>
    </div>
    <div class="v10-lite-grid">
      <div id="v10LiteEpisodes" class="v10-lite-episodes"></div>
      <div id="v10LiteViewer" class="v10-lite-viewer">
        <div class="muted">Выбери эпизод и нажми «▶ 8с Replay».</div>
      </div>
    </div>`;
  const twoCol = $('.two-col');
  (twoCol || results.lastElementChild)?.insertAdjacentElement('beforebegin', panel);
  return panel;
}

function renderEpisodePanel() {
  const panel = ensurePanel();
  if (!panel || !state.match) return;
  const box = $('#v10LiteEpisodes');
  const eps = episodesForView();
  if (!eps.length) {
    box.innerHTML = '<div class="muted">Критические эпизоды по текущим эвристикам не найдены.</div>';
    return;
  }
  box.innerHTML = eps.map((ep, i) => `
    <div class="v10-lite-episode ${ep.severity || 'medium'}">
      <div>
        <b>R${ep.round} · ${ep.t == null ? '—' : Number(ep.t).toFixed(1) + 'с'}</b>
        <span>${esc(ep.player)} → смерть от ${esc(ep.attacker || 'соперника')}</span>
        <div class="v10-lite-tags">${(ep.reasons || []).map((r) => `<i>${esc(r)}</i>`).join('')}</div>
      </div>
      <button class="ghost-btn" data-replay-index="${i}" type="button">▶ 8с Replay</button>
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
    $('#v10LitePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    renderViewerMessage(`Replay эпизода недоступен: ${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
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
    ctx.fillText('МОМЕНТ ОШИБКИ', 18, 28);
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

const observer = new MutationObserver(() => {
  if (state.match && !$('#v10LitePanel')) renderEpisodePanel();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('resize', () => { if (state.replay) drawFrame(); });
