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
};

let match = null;
let selectedSteamid = null;
let radarMeta = null;
let radarLoadError = '';
let positionRenderToken = 0;
let radarHitPoints = [];

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[m]));
}

function fmt(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '—';
  return `${value}${suffix}`;
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

async function checkHealth() {
  try {
    const r = await fetch('/api/health');
    const data = await r.json();
    els.health.classList.toggle('ok', !!data.ok);
    const aiLabel = data.aiMode === 'gateway' ? 'AI локально' : data.aiMode === 'direct' ? 'AI direct' : 'AI не настроен';
    els.health.innerHTML = `<span class="dot"></span>${data.ok ? 'Парсер готов' : 'Ошибка сервера'} · ${aiLabel} · V7 Radar`;
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
      : pct < 62
        ? 'Парсер читает события CS2…'
        : pct < 80
          ? 'Считаем V5 метрики…'
          : 'Считаем V6.1 positioning + peek heuristics…';
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
    configureRadarLayers();
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
      els.radarStatus.textContent = `Real radar: ${meta.displayName} · overview ${meta.posX}/${meta.posY} · scale ${meta.scale}${floors} · каталог ${meta.catalogCount || '?'} карт`;
    } else {
      els.radarStatus.className = 'radar-status warn';
      els.radarStatus.textContent = `${requestedMap}: radar/overview не найден в каталоге — показываем fallback-проекцию.`;
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
  const layers = radarMeta?.available ? radarMeta.layers || [] : [];
  els.radarLayer.innerHTML = '<option value="all">Все уровни</option>' + layers.map((layer) => {
    const z = layer.minZ !== null || layer.maxZ !== null
      ? ` (${layer.minZ ?? '−∞'}…${layer.maxZ ?? '+∞'} Z)`
      : '';
    return `<option value="${esc(layer.id)}">${esc(layer.label)}${esc(z)}</option>`;
  }).join('');
  els.radarLayer.value = 'all';
  els.radarLayer.disabled = !layers.length;
}

function renderMatch() {
  els.results.classList.remove('hidden');
  els.matchTitle.textContent = match.map ? match.map.replace(/^de_/, '').toUpperCase() : 'CS2 MATCH';
  els.matchMeta.textContent = `${match.fileName} · ${match.rounds || 0} раундов${match.server ? ` · ${match.server}` : ''}`;
  els.matchBadges.innerHTML = [
    match.demoVersion && `<span class="badge">${esc(match.demoVersion)}</span>`,
    match.parser && `<span class="badge">${esc(match.parser)}</span>`,
    '<span class="badge">V7 real radar</span>',
    '<span class="badge">V6.1 peek heuristics</span>',
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
    renderScoreboard();
    renderSelectedPlayer();
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

function renderTimeline() {
  const filter = els.timelineFilter.value;
  const player = filter === 'all' ? null : playerById(filter);
  const rows = (match.timeline || []).filter((e) => !player || e.attacker === player.name || e.victim === player.name || e.assister === player.name || e.tradeOf === player.name);
  if (!rows.length) {
    els.timeline.innerHTML = '<div class="muted">События убийств не найдены.</div>';
    return;
  }
  els.timeline.innerHTML = rows.map((e) => {
    const timing = Number.isFinite(Number(e.secondsIntoRound)) ? ` · ${Number(e.secondsIntoRound).toFixed(1)}с` : '';
    const trade = e.tradeKill ? '<span class="trade">TRADE</span>' : '';
    const wide = e.victimWidePeekLike ? '<span class="peek-flag">WIDE*</span>' : '';
    const repeek = e.repeekLike ? '<span class="repeek-flag">REPEEK*</span>' : '';
    const place = e.victimPlace ? `<span class="place"> · ${esc(e.victimPlace)}</span>` : '';
    const spacing = Number.isFinite(Number(e.nearestTeammateDistance)) ? `<span class="context"> · mate ${Math.round(e.nearestTeammateDistance)}u</span>` : '';
    return `<div class="event">
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

  els.selectedPlayer.innerHTML = `<strong>${esc(p.name)}</strong><br>
    <span class="muted">${p.kills}/${p.deaths}/${p.assists} · ADR ${p.adr} · HS ${p.hsPct}% · Entry ${p.entryKills}:${p.openingDeaths}</span>
    ${advanced ? `<br><span class="muted">${esc(advanced)}</span>` : ''}
    ${v6 ? `<br><span class="v6-line">V6.1 · ${esc(v6)}</span>` : ''}`;
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
  const deaths = data?.deaths || [];
  const kills = data?.kills || [];
  let drawDeaths = deaths;
  let drawKills = kills;

  if (mode === 'deaths') drawKills = [];
  else if (mode === 'kills') drawDeaths = [];
  else if (mode === 'wide') {
    drawDeaths = deaths.filter((p) => p.widePeekLike);
    drawKills = kills.filter((p) => p.widePeekLike);
  } else if (mode === 'repeek') {
    drawDeaths = deaths.filter((p) => p.repeekLike);
    drawKills = [];
  }

  const layerId = els.radarLayer?.value || 'all';
  if (radarMeta?.available && layerId !== 'all') {
    drawDeaths = drawDeaths.filter((p) => pointBelongsToLayer(radarMeta, p, layerId));
    drawKills = drawKills.filter((p) => pointBelongsToLayer(radarMeta, p, layerId));
  }
  return { drawDeaths, drawKills, deaths, kills, layerId };
}

function renderPositionSummary(player) {
  const chips = [
    ['coord deaths', player.positionSamples ?? 0],
    ['mate dist', player.avgNearestTeammateDistanceAtDeath == null ? '—' : `${Math.round(player.avgNearestTeammateDistanceAtDeath)}u`],
    ['isolated*', player.isolatedDeathPct == null ? '—' : `${player.isolatedDeathPct}%`],
    ['flash deaths', player.flashedDeathPct == null ? '—' : `${player.flashedDeathPct}%`],
    ['wide-peek*', player.widePeekLikeDeathPct == null ? '—' : `${player.widePeekLikeDeaths}/${player.widePeekSamples} · ${player.widePeekLikeDeathPct}%`],
    ['wide kills*', player.widePeekLikeKillPct == null ? '—' : `${player.widePeekLikeKills}/${player.widePeekKillSamples} · ${player.widePeekLikeKillPct}%`],
    ['repeek*', player.repeekLikePct == null ? '—' : `${player.repeekLikeDeaths}/${player.repeekEligibleSamples} · ${player.repeekLikePct}%`],
    ['duel dist', player.avgDuelDistanceAtDeath == null ? '—' : `${Math.round(player.avgDuelDistanceAtDeath)}u`],
    ['outside front*', player.attackerOutsideFrontPct == null ? '—' : `${player.attackerOutsideFrontPct}%`],
    ['top death zone', player.topDeathPlace || '—'],
  ];
  els.positionSummary.innerHTML = chips.map(([label, value]) => `<div class="position-chip"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('') +
    '<div class="position-disclaimer">* WIDE/REPEEK остаются эвристиками V6.1. V7 меняет только визуализацию: координаты теперь накладываются на настоящий radar карты.</div>';
}

function prepareCanvas(realRadar) {
  const canvas = els.positionCanvas;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(320, Math.floor(rect.width || canvas.parentElement.clientWidth || 900));
  const cssHeight = realRadar
    ? Math.max(440, Math.min(760, Math.floor(cssWidth * 0.72)))
    : Math.max(360, Math.min(540, Math.floor(cssWidth * 0.52)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { canvas, ctx, cssWidth, cssHeight };
}

function registerHitPoint(x, y, point, type, layerId = '') {
  radarHitPoints.push({ x, y, point, type, layerId });
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
  registerHitPoint(q.x, q.y, p, 'kill', layerId);
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

function drawFallbackProjection(player, drawDeaths, drawKills) {
  const points = [...drawDeaths, ...drawKills];
  const { ctx, cssWidth, cssHeight } = prepareCanvas(false);
  const bounds = normalizedBounds(points);
  if (!bounds) return false;
  const pad = 34;
  const spanX = Math.max(1, Number(bounds.maxX) - Number(bounds.minX));
  const spanY = Math.max(1, Number(bounds.maxY) - Number(bounds.minY));
  const project = (p) => ({
    x: pad + ((Number(p.x) - Number(bounds.minX)) / spanX) * (cssWidth - pad * 2),
    y: cssHeight - pad - ((Number(p.y) - Number(bounds.minY)) / spanY) * (cssHeight - pad * 2),
  });

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i += 1) {
    const x = pad + (cssWidth - pad * 2) * (i / 6);
    const y = pad + (cssHeight - pad * 2) * (i / 6);
    ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, cssHeight - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(cssWidth - pad, y); ctx.stroke();
  }
  drawPoints(ctx, drawDeaths, drawKills, project);

  if (player?.topDeathPlace) {
    ctx.font = '11px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillText('Fallback projection · real radar unavailable', 14, cssHeight - 14);
  }
  return true;
}

async function drawRealRadar(drawDeaths, drawKills, layerId, token) {
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
  const mapSize = Math.min(cssWidth - 18, cssHeight - 18);
  const mapX = (cssWidth - mapSize) / 2;
  const mapY = (cssHeight - mapSize) / 2;
  ctx.fillStyle = '#070a0f';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.drawImage(img, mapX, mapY, mapSize, mapSize);
  ctx.fillStyle = 'rgba(3,6,10,.14)';
  ctx.fillRect(mapX, mapY, mapSize, mapSize);
  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.strokeRect(mapX + 0.5, mapY + 0.5, mapSize - 1, mapSize - 1);

  const project = (p) => {
    const f = worldToRadarFraction(meta, p.x, p.y);
    if (!f || !Number.isFinite(f.fx) || !Number.isFinite(f.fy)) return null;
    if (f.fx < -0.08 || f.fx > 1.08 || f.fy < -0.08 || f.fy > 1.08) return null;
    const pointLayer = layerForZ(meta, p.z);
    return {
      x: mapX + f.fx * mapSize,
      y: mapY + f.fy * mapSize,
      layerId: pointLayer?.id || 'default',
    };
  };
  drawPoints(ctx, drawDeaths, drawKills, project);

  ctx.font = '10px system-ui';
  ctx.fillStyle = 'rgba(255,255,255,.52)';
  const floorText = layerId === 'all' && meta.layers.length > 1
    ? `фон: ${backgroundLayer.label} · точки всех Z-уровней`
    : `уровень: ${backgroundLayer.label}`;
  ctx.fillText(`${meta.displayName} · ${floorText}`, mapX + 8, mapY + mapSize - 9);
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
  if (!hasData) return;

  let realDrawn = false;
  if (radarMeta?.available) realDrawn = await drawRealRadar(drawDeaths, drawKills, layerId, token);
  if (token !== positionRenderToken) return;
  if (!realDrawn) {
    drawFallbackProjection(player, drawDeaths, drawKills);
    if (radarLoadError && els.radarStatus) {
      els.radarStatus.className = 'radar-status warn';
      els.radarStatus.textContent = `Radar image не загрузился — fallback-проекция. ${radarLoadError}`;
    }
  }
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

function handleRadarMouseMove(event) {
  if (!radarHitPoints.length || !els.positionTooltip) return;
  const rect = els.positionCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let best = null;
  let bestDistance = 16;
  for (const hit of radarHitPoints) {
    const d = Math.hypot(hit.x - x, hit.y - y);
    if (d < bestDistance) {
      best = hit;
      bestDistance = d;
    }
  }
  if (!best) {
    els.positionTooltip.classList.add('hidden');
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
els.positionCanvas?.addEventListener('mousemove', handleRadarMouseMove);
els.positionCanvas?.addEventListener('mouseleave', () => els.positionTooltip?.classList.add('hidden'));
els.aiBtn.addEventListener('click', runAI);
window.addEventListener('resize', () => { if (match) requestAnimationFrame(() => renderPositioning()); });

checkHealth();
