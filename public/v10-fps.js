const $ = (s) => document.querySelector(s);

const fpsState = {
  raf: 0,
  windowStart: 0,
  frames: 0,
  renderFps: null,
  lastDataFps: null,
};

function replayIsPlaying() {
  const button = $('#v10LitePlay');
  return Boolean(button && button.textContent.includes('❚'));
}

function readDataFps() {
  const text = $('.v10-lite-perf')?.textContent || '';
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*fps/i);
  const value = match ? Number(match[1]) : null;
  return Number.isFinite(value) ? value : null;
}

function ensureFpsHud() {
  const wrap = $('.v10-lite-canvas-wrap');
  if (!wrap) return null;
  let hud = $('#v10FpsHud');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'v10FpsHud';
    hud.className = 'v10-fps-hud';
    hud.title = 'DATA FPS — частота кадров, извлечённых из .dem. RENDER FPS — фактическая частота обновления браузера во время воспроизведения.';
    hud.innerHTML = `
      <span class="v10-fps-chip"><small>DATA</small><b id="v10DataFps">—</b><em>FPS</em></span>
      <span class="v10-fps-chip render"><small>RENDER</small><b id="v10RenderFps">—</b><em>FPS</em></span>`;
    wrap.appendChild(hud);
  }
  return hud;
}

function resetCounter(ts = performance.now()) {
  fpsState.windowStart = ts;
  fpsState.frames = 0;
  fpsState.renderFps = null;
}

function updateHud(active) {
  ensureFpsHud();
  const dataFps = readDataFps();
  if (Number.isFinite(dataFps)) fpsState.lastDataFps = dataFps;

  const dataEl = $('#v10DataFps');
  const renderEl = $('#v10RenderFps');
  const renderChip = renderEl?.closest('.v10-fps-chip');

  if (dataEl) dataEl.textContent = Number.isFinite(fpsState.lastDataFps) ? String(fpsState.lastDataFps) : '—';
  if (renderEl) renderEl.textContent = active && Number.isFinite(fpsState.renderFps) ? String(fpsState.renderFps) : '—';
  renderChip?.classList.toggle('active', active);
}

function loop(ts) {
  const active = replayIsPlaying();
  if (active) {
    if (!fpsState.windowStart) resetCounter(ts);
    fpsState.frames += 1;
    const elapsed = ts - fpsState.windowStart;
    if (elapsed >= 750) {
      fpsState.renderFps = Math.max(1, Math.round((fpsState.frames * 1000) / elapsed));
      fpsState.windowStart = ts;
      fpsState.frames = 0;
    }
  } else if (fpsState.frames || fpsState.renderFps !== null) {
    resetCounter(ts);
  }

  updateHud(active);
  fpsState.raf = requestAnimationFrame(loop);
}

const observer = new MutationObserver(() => {
  ensureFpsHud();
  const dataFps = readDataFps();
  if (Number.isFinite(dataFps)) fpsState.lastDataFps = dataFps;
});
observer.observe(document.documentElement, { childList: true, subtree: true });

fpsState.raf = requestAnimationFrame(loop);
