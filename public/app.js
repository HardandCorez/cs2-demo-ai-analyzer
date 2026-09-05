const $ = (selector) => document.querySelector(selector);
const els = {
  health: $('#healthStatus'), input: $('#demoInput'), drop: $('#dropZone'), choose: $('#chooseBtn'),
  progressWrap: $('#progressWrap'), progressLabel: $('#progressLabel'), progressPercent: $('#progressPercent'), progressBar: $('#progressBar'),
  error: $('#errorBox'), results: $('#results'), matchTitle: $('#matchTitle'), matchMeta: $('#matchMeta'), matchBadges: $('#matchBadges'),
  metrics: $('#metrics'), scoreBody: $('#scoreBody'), timeline: $('#timeline'), timelineFilter: $('#timelineFilter'),
  selectedPlayer: $('#selectedPlayer'), aiBtn: $('#aiBtn'), aiOutput: $('#aiOutput'),
  positionMode: $('#positionMode'), positionCanvas: $('#positionCanvas'), positionSummary: $('#positionSummary'), positionEmpty: $('#positionEmpty'),
};

let match = null;
let selectedSteamid = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[m]));
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
    els.health.innerHTML = `<span class="dot"></span>${data.ok ? 'Парсер готов' : 'Ошибка сервера'} · ${aiLabel} · V6.1`;
  } catch {
    els.health.innerHTML = '<span class="dot"></span>Сервер недоступен';
  }
}

function fakeProgressUntil(responsePromise) {
  let pct = 5;
  setProgress(pct, 'Загрузка демки…');
  const timer = setInterval(() => {
    pct = Math.min(88, pct + Math.max(1, (90 - pct) * 0.08));
    const label = pct < 30 ? 'Загрузка демки…' : pct < 62 ? 'Парсер читает события CS2…' : pct < 80 ? 'Считаем V5 метрики…' : 'Считаем V6.1 positioning + peek heuristics…';
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
    renderMatch();
  } catch (error) {
    els.progressWrap.classList.add('hidden');
    setError(error.message || 'Не удалось разобрать демку');
  }
}

function renderMatch() {
  els.results.classList.remove('hidden');
  els.matchTitle.textContent = match.map ? match.map.replace(/^de_/, '').toUpperCase() : 'CS2 MATCH';
  els.matchMeta.textContent = `${match.fileName} · ${match.rounds || 0} раундов${match.server ? ` · ${match.server}` : ''}`;
  els.matchBadges.innerHTML = [
    match.demoVersion && `<span class="badge">${esc(match.demoVersion)}</span>`,
    match.parser && `<span class="badge">${esc(match.parser)}</span>`,
    `<span class="badge">V6.1 peek heuristics</span>`,
    match.networkProtocol && `<span class="badge">protocol ${esc(match.networkProtocol)}</span>`,
  ].filter(Boolean).join('');

  const top = match.players?.[0];
  const avgAdr = match.players?.length ? Math.round(match.players.reduce((s,p)=>s+(p.adr||0),0)/match.players.length) : 0;
  const avgKastValues = (match.players || []).map((p) => Number(p.kastPct)).filter(Number.isFinite);
  const avgKast = avgKastValues.length ? (avgKastValues.reduce((s,n)=>s+n,0) / avgKastValues.length).toFixed(1) : '—';
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
  requestAnimationFrame(renderPositioning);
  els.results.scrollIntoView({ behavior:'smooth', block:'start' });
}

function renderScoreboard() {
  els.scoreBody.innerHTML = (match.players || []).map((p, i) => {
    const id = p.steamid || p.name;
    const selected = String(id) === String(selectedSteamid) ? 'selected' : '';
    return `<tr class="${selected}" data-id="${esc(id)}">
      <td class="rank">${i+1}</td>
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
  els.timelineFilter.innerHTML = `<option value="all">Все игроки</option>` + (match.players || []).map((p) =>
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
  const padX = Math.max(100, (maxX - minX) * .08);
  const padY = Math.max(100, (maxY - minY) * .08);
  return { minX:minX-padX, maxX:maxX+padX, minY:minY-padY, maxY:maxY+padY };
}

function renderPositioning() {
  if (!els.positionCanvas || !match) return;
  const player = playerById(selectedSteamid);
  const data = positioningForPlayer(player);
  const mode = els.positionMode?.value || 'both';
  const deaths = data?.deaths || [];
  const kills = data?.kills || [];
  const drawDeaths = mode !== 'kills' ? deaths : [];
  const drawKills = mode !== 'deaths' ? kills : [];
  const points = [...drawDeaths, ...drawKills];
  const hasData = points.length > 0;
  els.positionEmpty.classList.toggle('hidden', hasData);
  els.positionCanvas.classList.toggle('hidden', !hasData);

  if (!player) {
    els.positionSummary.innerHTML = '<span class="muted">Выбери игрока.</span>';
    return;
  }

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
  els.positionSummary.innerHTML = chips.map(([label,value]) => `<div class="position-chip"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('') +
    '<div class="position-disclaimer">* V6.1 эвристики без стен/navmesh/line-of-sight. WIDE* = высокая боковая скорость относительно линии на соперника. REPEEK* = смерть вскоре после собственного фрага рядом с предыдущей точкой/зоной.</div>';

  if (!hasData) return;
  const canvas = els.positionCanvas;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(320, Math.floor(rect.width || canvas.parentElement.clientWidth || 900));
  const cssHeight = Math.max(360, Math.min(520, Math.floor(cssWidth * 0.52)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssWidth,cssHeight);

  const bounds = normalizedBounds(points);
  if (!bounds) return;
  const pad = 34;
  const spanX = Math.max(1, Number(bounds.maxX) - Number(bounds.minX));
  const spanY = Math.max(1, Number(bounds.maxY) - Number(bounds.minY));
  const project = (p) => ({
    x: pad + ((Number(p.x) - Number(bounds.minX)) / spanX) * (cssWidth - pad * 2),
    y: cssHeight - pad - ((Number(p.y) - Number(bounds.minY)) / spanY) * (cssHeight - pad * 2),
  });

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0,0,cssWidth,cssHeight);
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i=1;i<6;i++) {
    const x = pad + (cssWidth-pad*2)*(i/6);
    const y = pad + (cssHeight-pad*2)*(i/6);
    ctx.beginPath(); ctx.moveTo(x,pad); ctx.lineTo(x,cssHeight-pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(cssWidth-pad,y); ctx.stroke();
  }

  for (const p of drawDeaths) {
    const q = project(p);
    const g = ctx.createRadialGradient(q.x,q.y,2,q.x,q.y,20);
    g.addColorStop(0,'rgba(255,107,117,.72)');
    g.addColorStop(1,'rgba(255,107,117,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(q.x,q.y,20,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ff6b75';
    ctx.beginPath(); ctx.arc(q.x,q.y,3.2,0,Math.PI*2); ctx.fill();

    if (p.widePeekLike) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x,q.y,8,0,Math.PI*2); ctx.stroke();
    }
    if (p.repeekLike) {
      ctx.strokeStyle = '#d8b8ff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(q.x-7,q.y-7,14,14); ctx.stroke();
    }
  }

  for (const p of drawKills) {
    const q = project(p);
    ctx.fillStyle = 'rgba(107,231,255,.2)';
    ctx.beginPath(); ctx.arc(q.x,q.y,10,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#6be7ff';
    ctx.beginPath(); ctx.arc(q.x,q.y,3,0,Math.PI*2); ctx.fill();
    if (p.widePeekLike) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(q.x,q.y,7,0,Math.PI*2); ctx.stroke();
    }
  }

  const topPlace = player.topDeathPlace;
  if (topPlace) {
    const placePoints = deaths.filter((p) => p.place === topPlace);
    if (placePoints.length) {
      const center = placePoints.reduce((acc,p)=>({x:acc.x+Number(p.x),y:acc.y+Number(p.y)}),{x:0,y:0});
      center.x /= placePoints.length; center.y /= placePoints.length;
      const q = project(center);
      ctx.font = '12px system-ui';
      ctx.fillStyle = 'rgba(245,247,251,.9)';
      ctx.fillText(`${topPlace} · ${placePoints.length} deaths`, Math.min(cssWidth-180,q.x+8), Math.max(18,q.y-8));
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
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ match, selectedSteamid }),
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
els.aiBtn.addEventListener('click', runAI);
window.addEventListener('resize', () => { if (match) requestAnimationFrame(renderPositioning); });

checkHealth();
