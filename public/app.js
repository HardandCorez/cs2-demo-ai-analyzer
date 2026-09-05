import {
  defaultRadarLayer,
  getRadarMeta,
  layerForZ,
  loadRadarImage,
  pointBelongsToLayer,
  worldToRadarFraction,
} from './radar-catalog.js';

const $ = (selector) => document.querySelector(selector);
const els = {
  health: $('#healthStatus'), input: $('#demoInput'), drop: $('#dropZone'), choose: $('#chooseBtn'),
  progressWrap: $('#progressWrap'), progressLabel: $('#progressLabel'), progressPercent: $('#progressPercent'), progressBar: $('#progressBar'),
  error: $('#errorBox'), results: $('#results'), matchTitle: $('#matchTitle'), matchMeta: $('#matchMeta'), matchBadges: $('#matchBadges'),
  metrics: $('#metrics'), scoreBody: $('#scoreBody'), timeline: $('#timeline'), timelineFilter: $('#timelineFilter'),
  selectedPlayer: $('#selectedPlayer'), aiBtn: $('#aiBtn'), aiOutput: $('#aiOutput'),
  positionMode: $('#positionMode'), positionCanvas: $('#positionCanvas'), positionSummary: $('#positionSummary'), positionEmpty: $('#positionEmpty'),
  radarLayer: $('#radarLayer'), radarStatus: $('#radarStatus'), positionTooltip: $('#positionTooltip'), positionCanvasWrap: $('#positionCanvasWrap'),
  radarRound: $('#radarRound'), trajectoryToggle: $('#trajectoryToggle'), radarReset: $('#radarReset'), radarZoom: $('#radarZoom'), radarDetail: $('#radarDetail'),
};

let match = null;
let selectedSteamid = null;
let radarMeta = null;
let radarLoadError = '';
let positionRenderToken = 0;
let radarHitPoints = [];
let selectedRadarHit = null;
let radarView = { zoom: 1, panX: 0, panY: 0 };
let dragState = null;
let dragRenderQueued = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[m]));
}

function fmt(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '—';
  return `${value}${suffix}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setError(message = '') {
  els.error.textContent = message;
  els.error.classList.toggle('hidden', !message);
}

function setProgress(percent, label) {
  els.progressWrap.classList.remove('hidden');
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.progressPercent.textContent = `${Math.round(percent)}%`;
  els.progressLabel.textContent = label;
}

function updateZoomReadout() {
  if (els.radarZoom) els.radarZoom.textContent = `${Math.round(radarView.zoom * 100)}%`;
}

function resetRadarView({ keepSelection = true } = {}) {
  radarView = { zoom: 1, panX: 0, panY: 0 };
  if (!keepSelection) selectedRadarHit = null;
  updateZoomReadout();
  renderRadarDetail();
  if (match) renderPositioning();
}

async function checkHealth() {
  try {
    const r = await fetch('/api/health');
    const data = await r.json();
    els.health.classList.toggle('ok', !!data.ok);
    const aiLabel = data.aiMode === 'gateway' ? 'AI локально' : data.aiMode === 'direct' ? 'AI direct' : 'AI не настроен';
    els.health.innerHTML = `<span class="dot"></span>${data.ok ? 'Парсер готов' : 'Ошибка сервера'} · ${aiLabel} · V7.1`;
  } catch {
    els.health.innerHTML = '<span class="dot"></span>Сервер недоступен';
  }
}

function fakeProgressUntil(responsePromise) {
  let pct = 5;
  setProgress(pct, 'Загрузка демки…');
  const timer = setInterval(() => {
    pct = Math.min(88, pct + Math.max(1, (90 - pct) * 0.08));
    const label = pct < 30
      ? 'Загрузка демки…'
      : pct < 60
        ? 'Парсер читает события CS2…'
        : pct < 78
          ? 'Считаем V5/V6.1 метрики…'
          : 'Снимаем V7.1 траектории и positioning…';
    setProgress(pct, label);
  }, 300);
  return responsePromise.finally(() => clearInterval(timer));
}

async function analyzeFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.dem')) return setError('Нужен файл с расширением .dem');
  setError();
  els.results.classList.add('hidden');
  const form = new FormData();
  form.append('demo', file);

  try {
    const response = await fakeProgressUntil(fetch('/api/analyze', { method: 'POST', body: form }));
    const data = await response.json();
    if (!response.ok) throw new Error([data.error, data.details, data.hint].filter(Boolean).join('\n'));
    setProgress(100, 'Готово');
    setTimeout(() => els.progressWrap.classList.add('hidden'), 800);
    match = data;
    selectedSteamid = data.players?.[0]?.steamid || data.players?.[0]?.name || null;
    radarMeta = null;
    radarLoadError = '';
    selectedRadarHit = null;
    radarView = { zoom: 1, panX: 0, panY: 0 };
    updateZoomReadout();
    configureRadarLayers();
    configureRadarRounds();
    renderMatch();
    loadRadarForMatch();
  } catch (error) {
    els.progressWrap.classList.add('hidden');
    setError(error.message || 'Не удалось разобрать демку');
  }
}

async function loadRadarForMatch() {
  if (!match?.map) return;
  const requestedMap = match.map;
  els.radarStatus.className = 'radar-status';
  els.radarStatus.textContent = `Загружаем настоящий radar для ${requestedMap}…`;
  try {
    const meta = await getRadarMeta(requestedMap);
    if (!match || match.map !== requestedMap) return;
    radarMeta = meta;
    radarLoadError = '';
    configureRadarLayers();
    if (meta?.available) {
      const floors = meta.layers?.length > 1 ? ` · уровней ${meta.layers.length}` : '';
      els.radarStatus.className = 'radar-status ok';
      els.radarStatus.textContent = `Real radar: ${meta.displayName} · scale ${meta.scale}${floors} · каталог ${meta.catalogCount || '?'} карт`;
    } else {
      els.radarStatus.className = 'radar-status warn';
      els.radarStatus.textContent = `${requestedMap}: radar/overview не найден — показываем fallback-проекцию.`;
    }
    renderPositioning();
  } catch (error) {
    if (!match || match.map !== requestedMap) return;
    radarMeta = null;
    radarLoadError = String(error?.message || error);
    configureRadarLayers();
    els.radarStatus.className = 'radar-status warn';
    els.radarStatus.textContent = `Radar catalog недоступен — fallback-проекция. ${radarLoadError}`;
    renderPositioning();
  }
}

function configureRadarLayers() {
  if (!els.radarLayer) return;
  const previous = els.radarLayer.value || 'all';
  const layers = radarMeta?.available ? radarMeta.layers || [] : [];
  els.radarLayer.innerHTML = '<option value="all">Все уровни</option>' + layers.map((layer) => {
    const z = layer.minZ !== null || layer.maxZ !== null
      ? ` (${layer.minZ ?? '−∞'}…${layer.maxZ ?? '+∞'} Z)`
      : '';
    return `<option value="${esc(layer.id)}">${esc(layer.label)}${esc(z)}</option>`;
  }).join('');
  els.radarLayer.value = layers.some((layer) => layer.id === previous) ? previous : 'all';
  els.radarLayer.disabled = !layers.length;
}

function configureRadarRounds() {
  if (!els.radarRound) return;
  els.radarRound.innerHTML = '<option value="all">Все раунды</option>' + Array.from({ length: Math.max(0, Number(match?.rounds) || 0) }, (_, i) =>
    `<option value="${i + 1}">Раунд ${i + 1}</option>`).join('');
  els.radarRound.value = 'all';
}

function renderMatch() {
  els.results.classList.remove('hidden');
  els.matchTitle.textContent = match.map ? match.map.replace(/^de_/, '').toUpperCase() : 'CS2 MATCH';
  els.matchMeta.textContent = `${match.fileName} · ${match.rounds || 0} раундов${match.server ? ` · ${match.server}` : ''}`;
  els.matchBadges.innerHTML = [
    match.demoVersion && `<span class="badge">${esc(match.demoVersion)}</span>`,
    match.parser && `<span class="badge">${esc(match.parser)}</span>`,
    '<span class="badge">V7.1 interactive radar</span>',
    '<span class="badge">V6.1 peek heuristics</span>',
    match.dataAvailability?.deathTrajectories ? '<span class="badge">3s trajectories</span>' : '<span class="badge">trajectory unavailable</span>',
    match.networkProtocol && `<span class="badge">protocol ${esc(match.networkProtocol)}</span>`,
  ].filter(Boolean).join('');

  const top = match.players?.[0];
  const avgAdr = match.players?.length ? Math.round(match.players.reduce((s, p) => s + (p.adr || 0), 0) / match.players.length) : 0;
  const avgKastValues = (match.players || []).map((p) => Number(p.kastPct)).filter(Number.isFinite);
  const avgKast = avgKastValues.length ? (avgKastValues.reduce((s, n) => s + n, 0) / avgKastValues.length).toFixed(1) : '—';
  els.metrics.innerHTML = [
    ['Раунды', match.rounds || 0],
    ['Лучший по impact', top?.name || '—'],
    ['Средний ADR', avgAdr],
    ['Средний KAST', avgKast === '—' ? '—' : `${avgKast}%`],
  ].map(([label, value]) => `<div class="metric"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');

  renderScoreboard();
  renderFilters();
  renderTimeline();
  renderSelectedPlayer();
  renderRadarDetail();
  requestAnimationFrame(() => renderPositioning());
  els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderScoreboard() {
  els.scoreBody.innerHTML = (match.players || []).map((p, i) => {
    const id = p.steamid || p.name;
    const selected = String(id) === String(selectedSteamid) ? 'selected' : '';
    return `<tr class="${selected}" data-id="${esc(id)}">
      <td class="rank">${i + 1}</td>
      <td><div class="player-cell"><b>${esc(p.name)}</b><span>${esc(p.teamName || (p.teamNumber === 3 ? 'CT' : p.teamNumber === 2 ? 'T' : ''))}</span></div></td>
      <td class="good">${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td><td>${p.kd}</td><td>${p.adr}</td><td>${p.hsPct}%</td>
      <td>${fmt(p.kastPct, '%')}</td><td>${p.tradeKills ?? 0}</td><td class="good">${p.entryKills}</td><td class="${p.openingDeaths > p.entryKills ? 'bad' : ''}">${p.openingDeaths}</td>
    </tr>`;
  }).join('');
  els.scoreBody.querySelectorAll('tr').forEach((row) => row.addEventListener('click', () => {
    selectedSteamid = row.dataset.id;
    selectedRadarHit = null;
    renderScoreboard();
    renderSelectedPlayer();
    renderRadarDetail();
    els.timelineFilter.value = selectedSteamid;
    renderTimeline();
    renderPositioning();
  }));
}

function renderFilters() {
  els.timelineFilter.innerHTML = '<option value="all">Все игроки</option>' + (match.players || []).map((p) =>
    `<option value="${esc(p.steamid || p.name)}">${esc(p.name)}</option>`).join('');
  els.timelineFilter.value = selectedSteamid || 'all';
}

function playerById(id) {
  return (match.players || []).find((p) => String(p.steamid || p.name) === String(id));
}

function selectedEventTick() {
  return Number(selectedRadarHit?.point?.tick || 0);
}

function renderTimeline() {
  const filter = els.timelineFilter.value;
  const player = filter === 'all' ? null : playerById(filter);
  const roundFilter = els.radarRound?.value || 'all';
  const rows = (match.timeline || []).filter((e) => {
    const playerMatches = !player || e.attacker === player.name || e.victim === player.name || e.assister === player.name || e.tradeOf === player.name;
    const roundMatches = roundFilter === 'all' || Number(e.round) === Number(roundFilter);
    return playerMatches && roundMatches;
  });
  if (!rows.length) {
    els.timeline.innerHTML = '<div class="muted">События убийств не найдены.</div>';
    return;
  }
  const activeTick = selectedEventTick();
  els.timeline.innerHTML = rows.map((e) => {
    const timing = Number.isFinite(Number(e.secondsIntoRound)) ? ` · ${Number(e.secondsIntoRound).toFixed(1)}с` : '';
    const trade = e.tradeKill ? '<span class="trade">TRADE</span>' : '';
    const wide = e.victimWidePeekLike ? '<span class="peek-flag">WIDE*</span>' : '';
    const repeek = e.repeekLike ? '<span class="repeek-flag">REPEEK*</span>' : '';
    const place = e.victimPlace ? `<span class="place"> · ${esc(e.victimPlace)}</span>` : '';
    const spacing = Number.isFinite(Number(e.nearestTeammateDistance)) ? `<span class="context"> · mate ${Math.round(e.nearestTeammateDistance)}u</span>` : '';
    const selected = activeTick && Number(e.tick) === activeTick ? ' selected-event' : '';
    return `<div class="event${selected}" data-tick="${esc(e.tick)}" data-round="${esc(e.round)}">
      <div class="event-round">R${e.round || '?'}${timing}</div>
      <div class="event-main"><strong>${esc(e.attacker || 'world')}</strong> → <strong>${esc(e.victim || '?')}</strong>
        ${e.weapon ? `<span class="weapon"> · ${esc(e.weapon)}</span>` : ''}${e.headshot ? '<span class="hs">HS</span>' : ''}${trade}${wide}${repeek}${place}${spacing}
      </div>
    </div>`;
  }).join('');
}

function renderSelectedPlayer() {
  const p = playerById(selectedSteamid);
  if (!p) {
    els.selectedPlayer.textContent = 'Выбери игрока в таблице';
    els.aiBtn.disabled = true;
    return;
  }

  const advanced = [
    p.kastPct !== null && p.kastPct !== undefined ? `KAST ${p.kastPct}%` : null,
    `trades ${p.tradeKills ?? 0}`,
    p.tradedDeathPct !== null && p.tradedDeathPct !== undefined ? `traded ${p.tradedDeathPct}%` : null,
    p.avgOpeningDuelTimeSec !== null && p.avgOpeningDuelTimeSec !== undefined ? `opening ${p.avgOpeningDuelTimeSec}с` : null,
  ].filter(Boolean).join(' · ');

  const v6 = [
    p.avgNearestTeammateDistanceAtDeath !== null && p.avgNearestTeammateDistanceAtDeath !== undefined ? `mate dist ${Math.round(p.avgNearestTeammateDistanceAtDeath)}u` : null,
    p.flashedDeathPct !== null && p.flashedDeathPct !== undefined ? `flash deaths ${p.flashedDeathPct}%` : null,
    p.widePeekLikeDeathPct !== null && p.widePeekLikeDeathPct !== undefined ? `wide* ${p.widePeekLikeDeaths}/${p.widePeekSamples} (${p.widePeekLikeDeathPct}%)` : null,
    p.repeekLikePct !== null && p.repeekLikePct !== undefined ? `repeek* ${p.repeekLikeDeaths}/${p.repeekEligibleSamples} (${p.repeekLikePct}%)` : null,
    p.topDeathPlace ? `top zone ${p.topDeathPlace}` : null,
  ].filter(Boolean).join(' · ');

  const trajectoryCount = positioningForPlayer(p)?.deathTrajectories?.length || 0;
  els.selectedPlayer.innerHTML = `<strong>${esc(p.name)}</strong><br>
    <span class="muted">${p.kills}/${p.deaths}/${p.assists} · ADR ${p.adr} · HS ${p.hsPct}% · Entry ${p.entryKills}:${p.openingDeaths}</span>
    ${advanced ? `<br><span class="muted">${esc(advanced)}</span>` : ''}
    ${v6 ? `<br><span class="v6-line">V6.1 · ${esc(v6)}</span>` : ''}
    <br><span class="v6-line">V7.1 · death trajectories ${trajectoryCount}</span>`;
  els.aiBtn.disabled = false;
  els.aiOutput.textContent = 'Готов к локальному AI-разбору V6.1.';
  els.aiOutput.classList.add('muted');
}

function positioningForPlayer(player) {
  if (!player || !match?.positioning?.players) return null;
  return match.positioning.players[player.name] || null;
}

function normalizedBounds(points) {
  const serverBounds = match?.positioning?.bounds;
  if (serverBounds && [serverBounds.minX, serverBounds.maxX, serverBounds.minY, serverBounds.maxY].every((n) => Number.isFinite(Number(n)))) return serverBounds;
  if (!points.length) return null;
  const xs = points.map((p) => Number(p.x)).filter(Number.isFinite);
  const ys = points.map((p) => Number(p.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const padX = Math.max(100, (maxX - minX) * 0.08);
  const padY = Math.max(100, (maxY - minY) * 0.08);
  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

function filteredPositionPoints(data) {
  const mode = els.positionMode?.value || 'both';
  const roundId = els.radarRound?.value || 'all';
  const roundFilter = roundId === 'all' ? null : Number(roundId);
  const deaths = data?.deaths || [];
  const kills = data?.kills || [];
  let drawDeaths = roundFilter === null ? deaths : deaths.filter((p) => Number(p.round) === roundFilter);
  let drawKills = roundFilter === null ? kills : kills.filter((p) => Number(p.round) === roundFilter);

  if (mode === 'deaths') drawKills = [];
  else if (mode === 'kills') drawDeaths = [];
  else if (mode === 'wide') {
    drawDeaths = drawDeaths.filter((p) => p.widePeekLike);
    drawKills = drawKills.filter((p) => p.widePeekLike);
  } else if (mode === 'repeek') {
    drawDeaths = drawDeaths.filter((p) => p.repeekLike);
    drawKills = [];
  }

  const layerId = els.radarLayer?.value || 'all';
  if (radarMeta?.available && layerId !== 'all') {
    drawDeaths = drawDeaths.filter((p) => pointBelongsToLayer(radarMeta, p, layerId));
    drawKills = drawKills.filter((p) => pointBelongsToLayer(radarMeta, p, layerId));
  }
  return { drawDeaths, drawKills, deaths, kills, layerId, roundFilter };
}

function renderPositionSummary(player) {
  const trajectory = match?.positioning?.trajectory;
  const chips = [
    ['coord deaths', player.positionSamples ?? 0],
    ['mate dist', player.avgNearestTeammateDistanceAtDeath == null ? '—' : `${Math.round(player.avgNearestTeammateDistanceAtDeath)}u`],
    ['isolated*', player.isolatedDeathPct == null ? '—' : `${player.isolatedDeathPct}%`],
    ['flash deaths', player.flashedDeathPct == null ? '—' : `${player.flashedDeathPct}%`],
    ['wide-peek*', player.widePeekLikeDeathPct == null ? '—' : `${player.widePeekLikeDeaths}/${player.widePeekSamples} · ${player.widePeekLikeDeathPct}%`],
    ['wide kills*', player.widePeekLikeKillPct == null ? '—' : `${player.widePeekLikeKills}/${player.widePeekKillSamples} · ${player.widePeekLikeKillPct}%`],
    ['repeek*', player.repeekLikePct == null ? '—' : `${player.repeekLikeDeaths}/${player.repeekEligibleSamples} · ${player.repeekLikePct}%`],
    ['duel dist', player.avgDuelDistanceAtDeath == null ? '—' : `${Math.round(player.avgDuelDistanceAtDeath)}u`],
    ['top death zone', player.topDeathPlace || '—'],
    ['trajectory', trajectory?.totalTrajectories ? `${trajectory.seconds}s · ${trajectory.tickRate} tick/s` : '—'],
  ];
  els.positionSummary.innerHTML = chips.map(([label, value]) => `<div class="position-chip"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('') +
    '<div class="position-disclaimer">V7.1: колесо = zoom, drag = pan, клик = эпизод/траектория, фильтр = раунд. WIDE/REPEEK остаются эвристиками V6.1.</div>';
}

function prepareCanvas(realRadar) {
  const canvas = els.positionCanvas;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(320, Math.floor(rect.width || canvas.parentElement.clientWidth || 900));
  const cssHeight = realRadar
    ? Math.max(500, Math.min(820, Math.floor(cssWidth * 0.74)))
    : Math.max(380, Math.min(560, Math.floor(cssWidth * 0.54)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { canvas, ctx, cssWidth, cssHeight };
}

function applyView(x, y, cssWidth, cssHeight) {
  const cx = cssWidth / 2;
  const cy = cssHeight / 2;
  return {
    x: cx + (x - cx) * radarView.zoom + radarView.panX,
    y: cy + (y - cy) * radarView.zoom + radarView.panY,
  };
}

function registerHitPoint(x, y, point, type, layerId = '') {
  radarHitPoints.push({ x, y, point, type, layerId });
}

function isSelected(point, type) {
  return selectedRadarHit
    && selectedRadarHit.type === type
    && Number(selectedRadarHit.point?.tick) === Number(point?.tick);
}

function drawDeath(ctx, q, p, layerId = '') {
  const g = ctx.createRadialGradient(q.x, q.y, 2, q.x, q.y, 19);
  g.addColorStop(0, 'rgba(255,107,117,.84)');
  g.addColorStop(1, 'rgba(255,107,117,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(q.x, q.y, 19, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ff6b75';
  ctx.beginPath(); ctx.arc(q.x, q.y, 3.4, 0, Math.PI * 2); ctx.fill();
  if (p.widePeekLike) {
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(q.x, q.y, 8, 0, Math.PI * 2); ctx.stroke();
  }
  if (p.repeekLike) {
    ctx.strokeStyle = '#d8b8ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(q.x - 7, q.y - 7, 14, 14); ctx.stroke();
  }
  if (isSelected(p, 'death')) {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(q.x, q.y, 12, 0, Math.PI * 2); ctx.stroke();
  }
  registerHitPoint(q.x, q.y, p, 'death', layerId);
}

function drawKill(ctx, q, p, layerId = '') {
  ctx.fillStyle = 'rgba(107,231,255,.24)';
  ctx.beginPath(); ctx.arc(q.x, q.y, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#6be7ff';
  ctx.beginPath(); ctx.arc(q.x, q.y, 3.2, 0, Math.PI * 2); ctx.fill();
  if (p.widePeekLike) {
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2); ctx.stroke();
  }
  if (isSelected(p, 'kill')) {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.stroke();
  }
  registerHitPoint(q.x, q.y, p, 'kill', layerId);
}

function selectedTrajectory(data) {
  if (!els.trajectoryToggle?.checked || selectedRadarHit?.type !== 'death') return null;
  const tick = Number(selectedRadarHit.point?.tick);
  return (data?.deathTrajectories || []).find((trajectory) => Number(trajectory.deathTick) === tick) || null;
}

function drawTrajectory(ctx, trajectory, project, layerId) {
  if (!trajectory?.points?.length) return;
  let points = trajectory.points;
  if (radarMeta?.available && layerId !== 'all') {
    points = points.filter((point) => pointBelongsToLayer(radarMeta, point, layerId));
  }
  const projected = points.map(project).filter(Boolean);
  if (projected.length < 2) return;

  ctx.save();
  ctx.strokeStyle = 'rgba(167,255,63,.92)';
  ctx.lineWidth = 2.4;
  ctx.shadowColor = 'rgba(167,255,63,.45)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  projected.forEach((p, index) => {
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;
  for (let i = 0; i < projected.length; i += 1) {
    const radius = i === projected.length - 1 ? 3.5 : 2;
    ctx.fillStyle = i === projected.length - 1 ? '#ffffff' : '#a7ff3f';
    ctx.beginPath(); ctx.arc(projected[i].x, projected[i].y, radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawPoints(ctx, drawDeaths, drawKills, project) {
  radarHitPoints = [];
  for (const p of drawDeaths) {
    const q = project(p);
    if (!q) continue;
    drawDeath(ctx, q, p, q.layerId || '');
  }
  for (const p of drawKills) {
    const q = project(p);
    if (!q) continue;
    drawKill(ctx, q, p, q.layerId || '');
  }
}

function drawFallbackProjection(player, data, drawDeaths, drawKills, layerId) {
  const points = [...drawDeaths, ...drawKills];
  const { ctx, cssWidth, cssHeight } = prepareCanvas(false);
  const bounds = normalizedBounds(points);
  if (!bounds) return false;
  const pad = 34;
  const spanX = Math.max(1, Number(bounds.maxX) - Number(bounds.minX));
  const spanY = Math.max(1, Number(bounds.maxY) - Number(bounds.minY));
  const baseProject = (p) => ({
    x: pad + ((Number(p.x) - Number(bounds.minX)) / spanX) * (cssWidth - pad * 2),
    y: cssHeight - pad - ((Number(p.y) - Number(bounds.minY)) / spanY) * (cssHeight - pad * 2),
  });
  const project = (p) => {
    const base = baseProject(p);
    return { ...applyView(base.x, base.y, cssWidth, cssHeight), layerId: '' };
  };

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i += 1) {
    const b1 = applyView(pad + (cssWidth - pad * 2) * (i / 6), pad, cssWidth, cssHeight);
    const b2 = applyView(pad + (cssWidth - pad * 2) * (i / 6), cssHeight - pad, cssWidth, cssHeight);
    ctx.beginPath(); ctx.moveTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
  }
  const trajectory = selectedTrajectory(data);
  if (trajectory) drawTrajectory(ctx, trajectory, project, layerId);
  drawPoints(ctx, drawDeaths, drawKills, project);
  ctx.font = '11px system-ui';
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fillText('Fallback projection · real radar unavailable', 14, cssHeight - 14);
  return true;
}

async function drawRealRadar(data, drawDeaths, drawKills, layerId, token) {
  const meta = radarMeta;
  if (!meta?.available) return false;
  const backgroundLayer = layerId !== 'all'
    ? meta.layers.find((layer) => layer.id === layerId) || defaultRadarLayer(meta)
    : defaultRadarLayer(meta);
  if (!backgroundLayer) return false;

  let img;
  try {
    img = await loadRadarImage(backgroundLayer);
  } catch (error) {
    radarLoadError = String(error?.message || error);
    return false;
  }
  if (token !== positionRenderToken) return true;

  const { ctx, cssWidth, cssHeight } = prepareCanvas(true);
  const baseMapSize = Math.min(cssWidth - 18, cssHeight - 18);
  const baseMapX = (cssWidth - baseMapSize) / 2;
  const baseMapY = (cssHeight - baseMapSize) / 2;
  const center = applyView(baseMapX, baseMapY, cssWidth, cssHeight);
  const mapSize = baseMapSize * radarView.zoom;

  ctx.fillStyle = '#070a0f';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.drawImage(img, center.x, center.y, mapSize, mapSize);
  ctx.fillStyle = 'rgba(3,6,10,.14)';
  ctx.fillRect(center.x, center.y, mapSize, mapSize);
  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.strokeRect(center.x + 0.5, center.y + 0.5, mapSize - 1, mapSize - 1);

  const project = (p) => {
    const f = worldToRadarFraction(meta, p.x, p.y);
    if (!f || !Number.isFinite(f.fx) || !Number.isFinite(f.fy)) return null;
    if (f.fx < -0.15 || f.fx > 1.15 || f.fy < -0.15 || f.fy > 1.15) return null;
    const baseX = baseMapX + f.fx * baseMapSize;
    const baseY = baseMapY + f.fy * baseMapSize;
    const q = applyView(baseX, baseY, cssWidth, cssHeight);
    const pointLayer = layerForZ(meta, p.z);
    return { x: q.x, y: q.y, layerId: pointLayer?.id || 'default' };
  };

  const trajectory = selectedTrajectory(data);
  if (trajectory) drawTrajectory(ctx, trajectory, project, layerId);
  drawPoints(ctx, drawDeaths, drawKills, project);

  ctx.font = '10px system-ui';
  ctx.fillStyle = 'rgba(255,255,255,.52)';
  const floorText = layerId === 'all' && meta.layers.length > 1
    ? `фон: ${backgroundLayer.label} · точки всех Z-уровней`
    : `уровень: ${backgroundLayer.label}`;
  ctx.fillText(`${meta.displayName} · ${floorText} · zoom ${Math.round(radarView.zoom * 100)}%`, 12, cssHeight - 12);
  return true;
}

async function renderPositioning() {
  if (!els.positionCanvas || !match) return;
  const token = ++positionRenderToken;
  const player = playerById(selectedSteamid);
  const data = positioningForPlayer(player);
  if (!player) {
    els.positionSummary.innerHTML = '<span class="muted">Выбери игрока.</span>';
    return;
  }
  renderPositionSummary(player);

  const { drawDeaths, drawKills, layerId } = filteredPositionPoints(data);
  const points = [...drawDeaths, ...drawKills];
  const hasData = points.length > 0;
  els.positionEmpty.classList.toggle('hidden', hasData);
  els.positionCanvas.classList.toggle('hidden', !hasData);
  if (!hasData) {
    radarHitPoints = [];
    return;
  }

  let realDrawn = false;
  if (radarMeta?.available) realDrawn = await drawRealRadar(data, drawDeaths, drawKills, layerId, token);
  if (token !== positionRenderToken) return;
  if (!realDrawn) {
    drawFallbackProjection(player, data, drawDeaths, drawKills, layerId);
    if (radarLoadError && els.radarStatus) {
      els.radarStatus.className = 'radar-status warn';
      els.radarStatus.textContent = `Radar image не загрузился — fallback-проекция. ${radarLoadError}`;
    }
  }
}

function nearestHitAt(clientX, clientY, radius = 16) {
  if (!radarHitPoints.length) return null;
  const rect = els.positionCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = null;
  let bestDistance = radius;
  for (const hit of radarHitPoints) {
    const d = Math.hypot(hit.x - x, hit.y - y);
    if (d < bestDistance) {
      best = hit;
      bestDistance = d;
    }
  }
  return best;
}

function tooltipHtml(hit) {
  const p = hit.point || {};
  const kind = hit.type === 'death' ? 'Смерть' : 'Фраг';
  const place = p.place ? ` · ${esc(p.place)}` : '';
  const timing = Number.isFinite(Number(p.secondsIntoRound)) ? `${Number(p.secondsIntoRound).toFixed(1)}с` : '—';
  const flags = [
    p.widePeekLike ? '<span class="tt-wide">WIDE*</span>' : '',
    p.repeekLike ? '<span class="tt-repeek">REPEEK*</span>' : '',
  ].filter(Boolean).join(' · ');
  const details = [
    p.weapon ? `weapon ${esc(p.weapon)}` : '',
    Number.isFinite(Number(p.nearestTeammateDistance)) ? `mate ${Math.round(Number(p.nearestTeammateDistance))}u` : '',
    Number.isFinite(Number(p.velocity)) ? `speed ${Math.round(Number(p.velocity))}u/s` : '',
    p.flashed === true ? 'flashed' : '',
  ].filter(Boolean).join(' · ');
  return `<b>R${esc(p.round || '?')} · ${kind}${place}</b><br><span class="tt-muted">${timing}${hit.layerId ? ` · ${esc(hit.layerId)}` : ''}</span>${details ? `<br>${details}` : ''}${flags ? `<br>${flags}` : ''}`;
}

function renderRadarDetail() {
  if (!els.radarDetail) return;
  if (!selectedRadarHit) {
    els.radarDetail.classList.add('hidden');
    els.radarDetail.innerHTML = '';
    return;
  }
  const p = selectedRadarHit.point || {};
  const player = playerById(selectedSteamid);
  const data = positioningForPlayer(player);
  const trajectory = selectedRadarHit.type === 'death'
    ? (data?.deathTrajectories || []).find((item) => Number(item.deathTick) === Number(p.tick))
    : null;
  const kind = selectedRadarHit.type === 'death' ? 'Смерть' : 'Фраг';
  const trajectoryText = trajectory
    ? `${trajectory.points.length} samples · ~${match?.positioning?.trajectory?.seconds || 3}с до смерти`
    : 'нет trajectory для этого события';
  const cells = [
    ['Раунд', p.round || '—'],
    ['Время', Number.isFinite(Number(p.secondsIntoRound)) ? `${Number(p.secondsIntoRound).toFixed(1)}с` : '—'],
    ['Зона', p.place || '—'],
    ['Оружие', p.weapon || '—'],
    ['Mate dist', Number.isFinite(Number(p.nearestTeammateDistance)) ? `${Math.round(Number(p.nearestTeammateDistance))}u` : '—'],
    ['Speed', Number.isFinite(Number(p.velocity)) ? `${Math.round(Number(p.velocity))}u/s` : '—'],
    ['WIDE*', p.widePeekLike ? 'да' : 'нет'],
    ['REPEEK*', p.repeekLike ? 'да' : 'нет'],
  ];
  els.radarDetail.innerHTML = `<b>${kind} · R${esc(p.round || '?')}${p.place ? ` · ${esc(p.place)}` : ''}</b>
    <div class="detail-grid">${cells.map(([label, value]) => `<div class="detail-cell"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>
    <div class="radar-help">${esc(trajectoryText)}${trajectory ? ' · зелёная линия показывает sampled path перед смертью.' : ''}</div>`;
  els.radarDetail.classList.remove('hidden');
}

function handleRadarMouseMove(event) {
  if (dragState) return;
  const best = nearestHitAt(event.clientX, event.clientY);
  if (!best || !els.positionTooltip) {
    els.positionTooltip?.classList.add('hidden');
    return;
  }
  els.positionTooltip.innerHTML = tooltipHtml(best);
  els.positionTooltip.classList.remove('hidden');
  const wrapRect = els.positionCanvasWrap.getBoundingClientRect();
  const localX = event.clientX - wrapRect.left;
  const localY = event.clientY - wrapRect.top;
  const left = localX > wrapRect.width * 0.72 ? Math.max(8, localX - 230) : localX + 14;
  const top = localY > wrapRect.height * 0.72 ? Math.max(8, localY - 100) : localY + 14;
  els.positionTooltip.style.left = `${left}px`;
  els.positionTooltip.style.top = `${top}px`;
}

function scheduleRadarRender() {
  if (dragRenderQueued) return;
  dragRenderQueued = true;
  requestAnimationFrame(() => {
    dragRenderQueued = false;
    renderPositioning();
  });
}

function handleRadarWheel(event) {
  event.preventDefault();
  const rect = els.positionCanvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const oldZoom = radarView.zoom;
  const factor = event.deltaY < 0 ? 1.16 : 1 / 1.16;
  const newZoom = clamp(oldZoom * factor, 0.75, 6);
  const baseX = (mx - cx - radarView.panX) / oldZoom;
  const baseY = (my - cy - radarView.panY) / oldZoom;
  radarView.panX = mx - cx - baseX * newZoom;
  radarView.panY = my - cy - baseY * newZoom;
  radarView.zoom = newZoom;
  updateZoomReadout();
  scheduleRadarRender();
}

function handlePointerDown(event) {
  if (event.button !== 0) return;
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originPanX: radarView.panX,
    originPanY: radarView.panY,
    moved: false,
  };
  els.positionCanvas.setPointerCapture?.(event.pointerId);
  els.positionCanvas.classList.add('dragging');
  els.positionTooltip?.classList.add('hidden');
}

function handlePointerMove(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    handleRadarMouseMove(event);
    return;
  }
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  if (Math.hypot(dx, dy) > 3) dragState.moved = true;
  if (!dragState.moved) return;
  radarView.panX = dragState.originPanX + dx;
  radarView.panY = dragState.originPanY + dy;
  scheduleRadarRender();
}

function handlePointerUp(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const moved = dragState.moved;
  dragState = null;
  els.positionCanvas.classList.remove('dragging');
  els.positionCanvas.releasePointerCapture?.(event.pointerId);
  if (!moved) {
    const hit = nearestHitAt(event.clientX, event.clientY, 18);
    if (hit) {
      selectedRadarHit = hit;
      if (els.radarRound?.value !== 'all' && Number(els.radarRound.value) !== Number(hit.point?.round)) {
        els.radarRound.value = String(hit.point?.round || 'all');
      }
      renderRadarDetail();
      renderTimeline();
      renderPositioning();
    }
  }
}

async function runAI() {
  if (!match || !selectedSteamid) return;
  const p = playerById(selectedSteamid);
  els.aiBtn.disabled = true;
  els.aiBtn.textContent = 'Анализирую…';
  els.aiOutput.classList.remove('muted');
  els.aiOutput.textContent = `Локальная модель выбирает приоритеты V6.1 для ${p?.name || ''}…`;
  try {
    const response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match, selectedSteamid }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error([data.error, data.hint].filter(Boolean).join('\n') || 'Ошибка AI-анализа');
    els.aiOutput.textContent = data.analysis;
  } catch (error) {
    els.aiOutput.textContent = `Ошибка: ${error.message}`;
  } finally {
    els.aiBtn.disabled = false;
    els.aiBtn.textContent = 'Запустить AI-анализ';
  }
}

els.choose.addEventListener('click', (e) => { e.stopPropagation(); els.input.click(); });
els.drop.addEventListener('click', () => els.input.click());
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') els.input.click(); });
els.input.addEventListener('change', () => analyzeFile(els.input.files?.[0]));
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('drag'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('drag'));
els.drop.addEventListener('drop', (e) => { e.preventDefault(); els.drop.classList.remove('drag'); analyzeFile(e.dataTransfer.files?.[0]); });
els.timelineFilter.addEventListener('change', renderTimeline);
els.positionMode?.addEventListener('change', renderPositioning);
els.radarLayer?.addEventListener('change', renderPositioning);
els.radarRound?.addEventListener('change', () => { renderTimeline(); renderPositioning(); });
els.trajectoryToggle?.addEventListener('change', renderPositioning);
els.radarReset?.addEventListener('click', () => resetRadarView());
els.positionCanvas?.addEventListener('wheel', handleRadarWheel, { passive: false });
els.positionCanvas?.addEventListener('pointerdown', handlePointerDown);
els.positionCanvas?.addEventListener('pointermove', handlePointerMove);
els.positionCanvas?.addEventListener('pointerup', handlePointerUp);
els.positionCanvas?.addEventListener('pointercancel', handlePointerUp);
els.positionCanvas?.addEventListener('mouseleave', () => { if (!dragState) els.positionTooltip?.classList.add('hidden'); });
els.positionCanvas?.addEventListener('dblclick', () => resetRadarView());
els.aiBtn.addEventListener('click', runAI);
window.addEventListener('resize', () => { if (match) requestAnimationFrame(() => renderPositioning()); });

updateZoomReadout();
checkHealth();
