import {
  getRadarMeta,
  pointBelongsToLayer,
  worldToRadarFraction,
} from './radar-catalog.js';

const $ = (selector) => document.querySelector(selector);
const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[m]));

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
    // Visual layer must never break the main parser flow.
  }
  return response;
};

function setupUi() {
  const controls = $('.radar-controls');
  if (controls && !$('#visualCoachToggle')) {
    const label = document.createElement('label');
    label.className = 'radar-toggle visual-coach-toggle';
    label.innerHTML = '<input id="visualCoachToggle" type="checkbox" checked /> схема решения';
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
  if (legend && !legend.querySelector('.coach-v74-legend')) {
    const item = document.createElement('span');
    item.className = 'coach-v74-legend';
    item.innerHTML = '<i class="coach-v74-actual"></i> факт <i class="coach-v74-better"></i> лучше <i class="coach-v74-risk"></i> риск';
    legend.insertBefore(item, legend.lastElementChild);
  }
}

function selectedPlayer() {
  const row = $('#scoreBody tr.selected');
  const id = String(row?.dataset?.id || '');
  const players = state.match?.players || [];
  return players.find((p) => String(p.steamid || p.name) === id) || players[0] || null;
}

function playerPositioning(player) {
  return player?.name ? state.match?.positioning?.players?.[player.name] || null : null;
}

function detailValue(label) {
  for (const cell of [...document.querySelectorAll('#radarDetail .detail-cell')]) {
    if (cell.querySelector('span')?.textContent?.trim() === label) {
      return cell.querySelector('strong')?.textContent?.trim() || '';
    }
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
  let candidates = data.deaths.filter((p) => !Number.isFinite(round) || Number(p.round) === round);
  if (place && place !== '—') {
    const exact = candidates.filter((p) => String(p.place || '') === place);
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
    if (!best) return point;
    const delta = Math.abs(Number(point.tMinusSec || 0) - targetMinusSec);
    const bestDelta = Math.abs(Number(best.tMinusSec || 0) - targetMinusSec);
    return delta < bestDelta ? point : best;
  }, null);
}

function timelineEventForDeath() {
  if (!state.selectedDeath) return null;
  return (state.match?.timeline || []).find((e) => Number(e.tick) === Number(state.selectedDeath.tick)) || null;
}

function coachPlan() {
  const death = state.selectedDeath;
  if (!state.enabled || !death) return null;
  const trajectory = selectedTrajectory();
  const stopPoint = closestTrajectoryPoint(trajectory, death.repeekLike ? 1.3 : 0.85)
    || closestTrajectoryPoint(trajectory, 0.7)
    || trajectory?.points?.[0]
    || death;
  const safePoint = closestTrajectoryPoint(trajectory, 2.5)
    || trajectory?.points?.[0]
    || stopPoint;
  const event = timelineEventForDeath();
  const attacker = event?.attackerPosition && finite(event.attackerPosition.x) !== null && finite(event.attackerPosition.y) !== null
    ? event.attackerPosition
    : null;

  const mode = death.repeekLike ? 'repeek' : death.widePeekLike ? 'wide' : 'control';
  const headline = mode === 'repeek'
    ? 'После фрага: остановиться и сменить линию'
    : mode === 'wide'
      ? 'Не продолжать широкий выход'
      : 'Разделить движение и дуэль';
  return { death, trajectory, stopPoint, safePoint, attacker, mode, headline };
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
    const size = Math.min(width - 18, height - 18);
    const x0 = (width - size) / 2;
    const y0 = (height - size) / 2;
    return (p) => {
      const f = worldToRadarFraction(state.meta, p?.x, p?.y);
      if (!f || !Number.isFinite(f.fx) || !Number.isFinite(f.fy)) return null;
      return applyView(x0 + f.fx * size, y0 + f.fy * size, width, height);
    };
  }
  const bounds = state.match?.positioning?.bounds;
  if (!bounds) return () => null;
  const pad = 34;
  const spanX = Math.max(1, Number(bounds.maxX) - Number(bounds.minX));
  const spanY = Math.max(1, Number(bounds.maxY) - Number(bounds.minY));
  return (p) => applyView(
    pad + ((Number(p.x) - Number(bounds.minX)) / spanX) * (width - pad * 2),
    height - pad - ((Number(p.y) - Number(bounds.minY)) / spanY) * (height - pad * 2),
    width,
    height,
  );
}

function drawPath(ctx, points, color, width, dashed = false, alpha = 1) {
  if (points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(dashed ? [8, 7] : []);
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.stroke();
  ctx.restore();
}

function drawArrow(ctx, a, b, color, width = 5) {
  if (!a || !b) return;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = 12;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNumberMarker(ctx, q, number, fill, stroke = '#ffffff') {
  if (!q) return;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(q.x, q.y, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#061017';
  ctx.font = '900 12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), q.x, q.y + 0.5);
  ctx.restore();
}

function drawDeath(ctx, q) {
  if (!q) return;
  ctx.save();
  ctx.strokeStyle = '#ff6675';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(q.x, q.y, 13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(q.x - 7, q.y - 7); ctx.lineTo(q.x + 7, q.y + 7);
  ctx.moveTo(q.x + 7, q.y - 7); ctx.lineTo(q.x - 7, q.y + 7);
  ctx.stroke();
  ctx.restore();
}

function drawEnemy(ctx, q) {
  if (!q) return;
  ctx.save();
  ctx.translate(q.x, q.y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#ff82ca';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.fillRect(-7, -7, 14, 14);
  ctx.strokeRect(-7, -7, 14, 14);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = '#1b0a17';
  ctx.font = '900 9px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('E', 0, 0.5);
  ctx.restore();
}

function renderOverlay() {
  setupUi();
  const prepared = prepareOverlayCanvas();
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  const plan = coachPlan();
  if (!plan) return;

  const layerId = $('#radarLayer')?.value || 'all';
  if (state.meta?.available && layerId !== 'all' && !pointBelongsToLayer(state.meta, plan.death, layerId)) return;

  const project = projector(width, height);
  const qDeath = project(plan.death);
  const qStop = project(plan.stopPoint);
  let qSafe = project(plan.safePoint);
  const qEnemy = plan.attacker ? project(plan.attacker) : null;
  if (!qDeath || !qStop) return;

  if (qSafe && Math.hypot(qSafe.x - qStop.x, qSafe.y - qStop.y) < 26 && plan.trajectory?.points?.length) {
    qSafe = project(plan.trajectory.points[0]) || qSafe;
  }

  ctx.save();
  ctx.fillStyle = 'rgba(2,5,8,.28)';
  ctx.fillRect(0, 0, width, height);

  const actual = (plan.trajectory?.points || []).map(project).filter(Boolean);
  drawPath(ctx, actual, '#a7ff3f', 2.2, false, 0.58);
  drawPath(ctx, [qStop, qDeath], '#ff6675', 3, true, 0.9);
  if (qSafe) drawArrow(ctx, qStop, qSafe, '#5de7ff', 5.2);

  if (qEnemy) {
    drawPath(ctx, [qDeath, qEnemy], '#ff82ca', 1.5, true, 0.65);
    drawEnemy(ctx, qEnemy);
  }

  drawNumberMarker(ctx, qStop, 1, '#ffd166');
  if (qSafe) drawNumberMarker(ctx, qSafe, 2, '#5de7ff');
  drawDeath(ctx, qDeath);
  ctx.restore();
}

function renderCoachCard() {
  setupUi();
  const card = $('#visualCoachCard');
  if (!card) return;
  const plan = coachPlan();
  if (!plan) {
    card.classList.add('hidden');
    card.innerHTML = '';
    return;
  }

  const flag = plan.mode === 'repeek' ? 'REPEEK*' : plan.mode === 'wide' ? 'WIDE*' : 'контакт';
  const second = plan.mode === 'repeek'
    ? 'Отойти на точку 2 / сменить линию. Не возвращаться сразу в тот же контакт.'
    : plan.mode === 'wide'
      ? 'Вернуться к точке 2 вместо продолжения широкого выхода. Новый пик — только после нового преимущества.'
      : 'Сместиться на точку 2 и заново принять решение после полной остановки.';

  card.innerHTML = `
    <div class="visual-coach-head">
      <div><span>V7.4 · СХЕМА РЕШЕНИЯ</span><b>${esc(plan.headline)}</b></div>
      <strong>R${esc(plan.death.round || '?')} · ${esc(flag)}</strong>
    </div>
    <div class="coach-compare">
      <div class="coach-compare-row bad"><span>БЫЛО</span><b>зелёная траектория → красный пунктир → ✕ смерть</b></div>
      <div class="coach-compare-row good"><span>ЛУЧШЕ</span><b>① STOP → бирюзовая стрелка → ② безопаснее</b></div>
    </div>
    <div class="coach-steps">
      <div><i>1</i><span>Остановить движение и не продолжать текущий пик.</span></div>
      <div><i>2</i><span>${esc(second)}</span></div>
      ${plan.attacker ? '<div><i class="enemy-step">E</i><span>Розовый ромб — позиция убийцы в момент события.</span></div>' : ''}
    </div>
    <div class="visual-coach-disclaimer">Это safe-default по измеренной траектории. Без navmesh/LOS схема не утверждает, что точка 2 гарантированно закрыта стеной.</div>`;
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

function resetView() {
  state.view = { zoom: 1, panX: 0, panY: 0 };
  queueRender();
}

function bindEvents() {
  setupUi();
  const canvas = $('#positionCanvas');
  canvas?.addEventListener('wheel', mirrorWheel, { passive: true, capture: true });
  canvas?.addEventListener('pointerdown', mirrorPointerDown, true);
  canvas?.addEventListener('pointermove', mirrorPointerMove, true);
  canvas?.addEventListener('pointerup', mirrorPointerUp, true);
  canvas?.addEventListener('pointercancel', mirrorPointerUp, true);
  canvas?.addEventListener('dblclick', resetView, true);
  $('#radarReset')?.addEventListener('click', resetView, true);
  $('#radarLayer')?.addEventListener('change', queueRender);
  $('#radarRound')?.addEventListener('change', queueRender);
  $('#positionMode')?.addEventListener('change', queueRender);
  $('#trajectoryToggle')?.addEventListener('change', queueRender);
  $('#scoreBody')?.addEventListener('click', () => {
    state.selectedDeath = null;
    setTimeout(() => { renderCoachCard(); queueRender(); }, 0);
  });
  window.addEventListener('resize', queueRender);

  const detail = $('#radarDetail');
  if (detail) {
    const observer = new MutationObserver(() => {
      if (!detail.classList.contains('hidden')) setTimeout(syncSelectedDeathFromUi, 0);
    });
    observer.observe(detail, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
}

bindEvents();
