import {
  getRadarMeta,
  pointBelongsToLayer,
  worldToRadarFraction,
} from './radar-catalog.js';

const state = {
  match: null,
  meta: null,
  selectedDeath: null,
  selectedPlayerName: '',
  enabled: true,
  view: { zoom: 1, panX: 0, panY: 0 },
  drag: null,
  renderQueued: false,
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (/\/api\/analyze(?:\?|$)/.test(url) && response.ok) {
      response.clone().json().then(async (data) => {
        state.match = data;
        state.selectedDeath = null;
        state.selectedPlayerName = '';
        state.view = { zoom: 1, panX: 0, panY: 0 };
        try {
          state.meta = data?.map ? await getRadarMeta(data.map) : null;
        } catch {
          state.meta = null;
        }
        queueRender();
      }).catch(() => {});
    }
  } catch {
    // Never interfere with the main app fetch flow.
  }
  return response;
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[m]));
const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function setupVisualCoachUi() {
  const controls = $('.radar-controls');
  if (controls && !$('#visualCoachToggle')) {
    const label = document.createElement('label');
    label.className = 'radar-toggle visual-coach-toggle';
    label.innerHTML = '<input id="visualCoachToggle" type="checkbox" checked /> визуальный coach';
    const reset = $('#radarReset');
    controls.insertBefore(label, reset || null);
    label.querySelector('input')?.addEventListener('change', (event) => {
      state.enabled = Boolean(event.target.checked);
      renderCoachCard();
      queueRender();
    });
  }

  const wrap = $('#positionCanvasWrap');
  if (wrap && !$('#coachOverlayCanvas')) {
    const canvas = document.createElement('canvas');
    canvas.id = 'coachOverlayCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrap.appendChild(canvas);
  }

  const detail = $('#radarDetail');
  if (detail && !$('#visualCoachCard')) {
    const card = document.createElement('div');
    card.id = 'visualCoachCard';
    card.className = 'visual-coach-card hidden';
    detail.insertAdjacentElement('afterend', card);
  }

  const legend = document.querySelector('.position-legend');
  if (legend && !legend.querySelector('.coach-legend-stop')) {
    const stop = document.createElement('span');
    stop.innerHTML = '<i class="coach-legend-stop"></i> STOP/HOLD';
    const route = document.createElement('span');
    route.innerHTML = '<i class="coach-legend-route"></i> рекомендуемое действие';
    const danger = document.createElement('span');
    danger.innerHTML = '<i class="coach-legend-danger"></i> не форсить';
    legend.insertBefore(stop, legend.lastElementChild);
    legend.insertBefore(route, legend.lastElementChild);
    legend.insertBefore(danger, legend.lastElementChild);
  }
}

function selectedPlayer() {
  const row = $('#scoreBody tr.selected');
  const id = String(row?.dataset?.id || '');
  const players = state.match?.players || [];
  return players.find((p) => String(p.steamid || p.name) === id) || players[0] || null;
}

function playerPositioning(player) {
  if (!player?.name) return null;
  return state.match?.positioning?.players?.[player.name] || null;
}

function detailValue(label) {
  const cells = [...document.querySelectorAll('#radarDetail .detail-cell')];
  for (const cell of cells) {
    const key = cell.querySelector('span')?.textContent?.trim();
    if (key === label) return cell.querySelector('strong')?.textContent?.trim() || '';
  }
  return '';
}

function syncSelectedDeathFromUi() {
  const detail = $('#radarDetail');
  const title = detail?.querySelector(':scope > b')?.textContent || '';
  if (!detail || detail.classList.contains('hidden') || !title.startsWith('Смерть')) {
    state.selectedDeath = null;
    renderCoachCard();
    queueRender();
    return;
  }

  const player = selectedPlayer();
  const data = playerPositioning(player);
  if (!player || !data?.deaths?.length) return;

  const round = Number(detailValue('Раунд'));
  const time = parseFloat(detailValue('Время'));
  const place = detailValue('Зона');
  const weapon = detailValue('Оружие');
  let candidates = data.deaths.filter((p) => !Number.isFinite(round) || Number(p.round) === round);
  if (place && place !== '—') {
    const exact = candidates.filter((p) => String(p.place || '') === place);
    if (exact.length) candidates = exact;
  }
  if (weapon && weapon !== '—') {
    const exact = candidates.filter((p) => String(p.weapon || '') === weapon);
    if (exact.length) candidates = exact;
  }
  candidates.sort((a, b) => {
    const at = finite(a.secondsIntoRound);
    const bt = finite(b.secondsIntoRound);
    const ad = Number.isFinite(time) && at !== null ? Math.abs(at - time) : 0;
    const bd = Number.isFinite(time) && bt !== null ? Math.abs(bt - time) : 0;
    return ad - bd;
  });

  state.selectedDeath = candidates[0] || null;
  state.selectedPlayerName = player.name;
  renderCoachCard();
  queueRender();
}

function selectedTrajectory() {
  if (!state.selectedDeath || !state.selectedPlayerName) return null;
  const data = state.match?.positioning?.players?.[state.selectedPlayerName];
  return (data?.deathTrajectories || []).find((t) => Number(t.deathTick) === Number(state.selectedDeath.tick)) || null;
}

function closestTrajectoryPoint(trajectory, targetMinusSec) {
  const points = trajectory?.points || [];
  if (!points.length) return null;
  return points.reduce((best, point) => {
    const delta = Math.abs(Number(point.tMinusSec || 0) - targetMinusSec);
    const bestDelta = Math.abs(Number(best?.tMinusSec || 0) - targetMinusSec);
    return !best || delta < bestDelta ? point : best;
  }, null);
}

function interpolateWorld(a, b, t) {
  if (!a || !b) return null;
  return {
    x: Number(a.x) + (Number(b.x) - Number(a.x)) * t,
    y: Number(a.y) + (Number(b.y) - Number(a.y)) * t,
    z: Number(a.z || 0) + (Number(b.z || 0) - Number(a.z || 0)) * t,
  };
}

function timelineEventForDeath() {
  if (!state.selectedDeath) return null;
  return (state.match?.timeline || []).find((e) => Number(e.tick) === Number(state.selectedDeath.tick)) || null;
}

function coachPlan() {
  const death = state.selectedDeath;
  if (!state.enabled || !death) return null;
  const trajectory = selectedTrajectory();
  const branch = closestTrajectoryPoint(trajectory, death.repeekLike ? 1.35 : 0.9)
    || closestTrajectoryPoint(trajectory, 0.7)
    || trajectory?.points?.[0]
    || death;
  const retreat = closestTrajectoryPoint(trajectory, 2.35)
    || trajectory?.points?.[0]
    || branch;
  const info = interpolateWorld(branch, death, 0.28);
  const event = timelineEventForDeath();
  const attacker = event?.attackerPosition && finite(event.attackerPosition.x) !== null && finite(event.attackerPosition.y) !== null
    ? event.attackerPosition
    : null;

  let mode = 'control';
  let headline = 'Контролируемый контакт';
  const notes = [];
  if (death.repeekLike) {
    mode = 'reset';
    headline = 'После фрага — reset вместо автоматического repeek*';
    notes.push('фиолетовая стрелка: уйти с прежней линии и удержать новую точку');
  } else if (death.widePeekLike) {
    mode = 'short-peek';
    headline = 'Короткий info-peek вместо полного wide-swing*';
    notes.push('жёлтый STOP: погасить боковую скорость до следующего решения');
    notes.push('бирюзовый INFO → BACK: коротко открыть сектор и вернуться');
  } else {
    notes.push('жёлтый STOP: отделить движение от первого точного выстрела');
    notes.push('бирюзовая стрелка: короткий контролируемый контакт вместо продолжения движения');
  }
  if (attacker) notes.push('розовый ENEMY*: позиция убийцы в момент события, если она доступна в parser snapshot');

  return { death, trajectory, branch, retreat, info, attacker, mode, headline, notes };
}

function prepareOverlayCanvas() {
  const base = $('#positionCanvas');
  const overlay = $('#coachOverlayCanvas');
  if (!base || !overlay) return null;
  const rect = base.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  overlay.width = Math.floor(width * dpr);
  overlay.height = Math.floor(height * dpr);
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function applyView(x, y, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  return {
    x: cx + (x - cx) * state.view.zoom + state.view.panX,
    y: cy + (y - cy) * state.view.zoom + state.view.panY,
  };
}

function projector(width, height) {
  if (state.meta?.available) {
    const baseMapSize = Math.min(width - 18, height - 18);
    const baseMapX = (width - baseMapSize) / 2;
    const baseMapY = (height - baseMapSize) / 2;
    return (p) => {
      const f = worldToRadarFraction(state.meta, p?.x, p?.y);
      if (!f || !Number.isFinite(f.fx) || !Number.isFinite(f.fy)) return null;
      const baseX = baseMapX + f.fx * baseMapSize;
      const baseY = baseMapY + f.fy * baseMapSize;
      return applyView(baseX, baseY, width, height);
    };
  }

  const bounds = state.match?.positioning?.bounds;
  if (!bounds) return () => null;
  const pad = 34;
  const spanX = Math.max(1, Number(bounds.maxX) - Number(bounds.minX));
  const spanY = Math.max(1, Number(bounds.maxY) - Number(bounds.minY));
  return (p) => {
    const baseX = pad + ((Number(p.x) - Number(bounds.minX)) / spanX) * (width - pad * 2);
    const baseY = height - pad - ((Number(p.y) - Number(bounds.minY)) / spanY) * (height - pad * 2);
    return applyView(baseX, baseY, width, height);
  };
}

function drawArrow(ctx, a, b, color, label, { dashed = false, width = 3 } = {}) {
  if (!a || !b) return;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = 9;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [8, 6] : []);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  if (label) drawLabel(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2 - 10, label, color);
  ctx.restore();
}

function drawLabel(ctx, x, y, text, color) {
  ctx.save();
  ctx.font = '700 10px system-ui';
  const padX = 6;
  const width = ctx.measureText(text).width + padX * 2;
  const height = 20;
  ctx.fillStyle = 'rgba(5,8,12,.88)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - width / 2, y - height / 2, width, height, 6);
  else ctx.rect(x - width / 2, y - height / 2, width, height);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function drawStop(ctx, q) {
  if (!q) return;
  ctx.save();
  ctx.strokeStyle = '#ffd166';
  ctx.fillStyle = 'rgba(255,209,102,.13)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(q.x, q.y, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  drawLabel(ctx, q.x, q.y - 23, 'STOP', '#ffd166');
  ctx.restore();
}

function drawEnemy(ctx, q) {
  if (!q) return;
  ctx.save();
  ctx.translate(q.x, q.y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#ff82ca';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.fillRect(-5, -5, 10, 10);
  ctx.strokeRect(-5, -5, 10, 10);
  ctx.restore();
  drawLabel(ctx, q.x, q.y - 18, 'ENEMY*', '#ff82ca');
}

function renderOverlay() {
  setupVisualCoachUi();
  const prepared = prepareOverlayCanvas();
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  const plan = coachPlan();
  if (!plan) return;

  const layerId = $('#radarLayer')?.value || 'all';
  if (state.meta?.available && layerId !== 'all' && !pointBelongsToLayer(state.meta, plan.death, layerId)) return;

  const project = projector(width, height);
  const qDeath = project(plan.death);
  const qBranch = project(plan.branch);
  const qRetreat = project(plan.retreat);
  const qInfo = project(plan.info);
  const qAttacker = plan.attacker ? project(plan.attacker) : null;
  if (!qDeath || !qBranch) return;

  ctx.save();
  ctx.globalAlpha = 0.98;

  // Duel line is factual geometry at the event tick when attacker coordinates exist.
  if (qAttacker) {
    ctx.strokeStyle = 'rgba(255,130,202,.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(qDeath.x, qDeath.y);
    ctx.lineTo(qAttacker.x, qAttacker.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawEnemy(ctx, qAttacker);
  }

  drawStop(ctx, qBranch);

  if (plan.mode === 'reset') {
    drawArrow(ctx, qBranch, qRetreat, '#c9a7ff', 'RESET / HOLD', { width: 3.2 });
    drawArrow(ctx, qBranch, qDeath, '#ff6b75', 'НЕ REPEEK*', { dashed: true, width: 2.2 });
  } else {
    if (qInfo) {
      drawArrow(ctx, qBranch, qInfo, '#56e6ff', 'INFO', { width: 3.1 });
      drawArrow(ctx, qInfo, qBranch, '#56e6ff', 'BACK', { dashed: true, width: 2.3 });
      drawArrow(ctx, qInfo, qDeath, '#ff6b75', 'НЕ ФОРСИТЬ', { dashed: true, width: 2.2 });
    }
  }

  ctx.strokeStyle = '#ff6b75';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(qDeath.x - 7, qDeath.y - 7);
  ctx.lineTo(qDeath.x + 7, qDeath.y + 7);
  ctx.moveTo(qDeath.x + 7, qDeath.y - 7);
  ctx.lineTo(qDeath.x - 7, qDeath.y + 7);
  ctx.stroke();
  drawLabel(ctx, qDeath.x, qDeath.y + 22, 'DEATH', '#ff6b75');
  ctx.restore();
}

function renderCoachCard() {
  setupVisualCoachUi();
  const card = $('#visualCoachCard');
  if (!card) return;
  const plan = coachPlan();
  if (!plan) {
    card.classList.add('hidden');
    card.innerHTML = '';
    return;
  }
  const flags = [plan.death.widePeekLike ? 'WIDE*' : '', plan.death.repeekLike ? 'REPEEK*' : ''].filter(Boolean).join(' + ') || 'контроль контакта';
  card.innerHTML = `
    <div class="visual-coach-head">
      <div><span>VISUAL COACH V7.2</span><b>${esc(plan.headline)}</b></div>
      <strong>R${esc(plan.death.round || '?')} · ${esc(flags)}</strong>
    </div>
    <div class="visual-coach-notes">
      ${plan.notes.map((note) => `<div>• ${esc(note)}</div>`).join('')}
    </div>
    <div class="visual-coach-disclaimer">Схема показывает решение относительно реально измеренных координат и собственной траектории. Это не рассчитанный navmesh-маршрут и не утверждение, что конкретная стена/угол гарантированно безопасны.</div>`;
  card.classList.remove('hidden');
}

function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderOverlay();
  });
}

function mirrorWheel(event) {
  const canvas = $('#positionCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const oldZoom = state.view.zoom;
  const factor = event.deltaY < 0 ? 1.16 : 1 / 1.16;
  const newZoom = clamp(oldZoom * factor, 0.75, 6);
  const baseX = (mx - cx - state.view.panX) / oldZoom;
  const baseY = (my - cy - state.view.panY) / oldZoom;
  state.view.panX = mx - cx - baseX * newZoom;
  state.view.panY = my - cy - baseY * newZoom;
  state.view.zoom = newZoom;
  queueRender();
}

function mirrorPointerDown(event) {
  if (event.button !== 0) return;
  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    panX: state.view.panX,
    panY: state.view.panY,
    moved: false,
  };
}

function mirrorPointerMove(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (Math.hypot(dx, dy) > 3) drag.moved = true;
  if (!drag.moved) return;
  state.view.panX = drag.panX + dx;
  state.view.panY = drag.panY + dy;
  queueRender();
}

function mirrorPointerUp(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const moved = drag.moved;
  state.drag = null;
  if (!moved) setTimeout(syncSelectedDeathFromUi, 0);
}

function resetMirroredView() {
  state.view = { zoom: 1, panX: 0, panY: 0 };
  queueRender();
}

function bindEvents() {
  setupVisualCoachUi();
  const canvas = $('#positionCanvas');
  canvas?.addEventListener('wheel', mirrorWheel, { passive: true, capture: true });
  canvas?.addEventListener('pointerdown', mirrorPointerDown, true);
  canvas?.addEventListener('pointermove', mirrorPointerMove, true);
  canvas?.addEventListener('pointerup', mirrorPointerUp, true);
  canvas?.addEventListener('pointercancel', mirrorPointerUp, true);
  canvas?.addEventListener('dblclick', resetMirroredView, true);
  $('#radarReset')?.addEventListener('click', resetMirroredView, true);
  $('#radarLayer')?.addEventListener('change', queueRender);
  $('#radarRound')?.addEventListener('change', queueRender);
  $('#positionMode')?.addEventListener('change', queueRender);
  $('#trajectoryToggle')?.addEventListener('change', queueRender);
  $('#scoreBody')?.addEventListener('click', () => {
    state.selectedDeath = null;
    setTimeout(() => {
      renderCoachCard();
      queueRender();
    }, 0);
  });
  window.addEventListener('resize', queueRender);

  const observer = new MutationObserver(() => {
    const detail = $('#radarDetail');
    if (detail && !detail.classList.contains('hidden')) setTimeout(syncSelectedDeathFromUi, 0);
  });
  const detail = $('#radarDetail');
  if (detail) observer.observe(detail, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

bindEvents();
