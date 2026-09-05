const $ = (selector) => document.querySelector(selector);
const els = {
  health: $('#healthStatus'), input: $('#demoInput'), drop: $('#dropZone'), choose: $('#chooseBtn'),
  progressWrap: $('#progressWrap'), progressLabel: $('#progressLabel'), progressPercent: $('#progressPercent'), progressBar: $('#progressBar'),
  error: $('#errorBox'), results: $('#results'), matchTitle: $('#matchTitle'), matchMeta: $('#matchMeta'), matchBadges: $('#matchBadges'),
  metrics: $('#metrics'), scoreBody: $('#scoreBody'), timeline: $('#timeline'), timelineFilter: $('#timelineFilter'),
  selectedPlayer: $('#selectedPlayer'), aiBtn: $('#aiBtn'), aiOutput: $('#aiOutput'),
};

let match = null;
let selectedSteamid = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[m]));
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
    const v5 = data.advancedMetricsVersion ? ' · V5' : '';
    els.health.innerHTML = `<span class="dot"></span>${data.ok ? 'Парсер готов' : 'Ошибка сервера'} · ${aiLabel}${v5}`;
  } catch {
    els.health.innerHTML = '<span class="dot"></span>Сервер недоступен';
  }
}

function fakeProgressUntil(responsePromise) {
  let pct = 5;
  setProgress(pct, 'Загрузка демки…');
  const timer = setInterval(() => {
    pct = Math.min(88, pct + Math.max(1, (90 - pct) * 0.08));
    const label = pct < 35 ? 'Загрузка демки…' : pct < 72 ? 'Парсер читает события CS2…' : 'Считаем V5-метрики…';
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
    match.advancedMetricsVersion && `<span class="badge">V5 advanced</span>`,
    match.networkProtocol && `<span class="badge">protocol ${esc(match.networkProtocol)}</span>`,
  ].filter(Boolean).join('');

  const top = match.players?.[0];
  const avgAdr = match.players?.length ? Math.round(match.players.reduce((s,p)=>s+(p.adr||0),0)/match.players.length) : 0;
  const kastValues = (match.players || []).map((p) => Number(p.kastPct)).filter(Number.isFinite);
  const avgKast = kastValues.length ? `${Math.round(kastValues.reduce((s,n)=>s+n,0)/kastValues.length)}%` : '—';
  els.metrics.innerHTML = [
    ['Раунды', match.rounds || 0],
    ['Лучший по impact', top?.name || '—'],
    ['Топ K/D', top?.kd ?? '—'],
    ['Средний KAST', avgKast],
  ].map(([label, value]) => `<div class="metric"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');

  renderScoreboard();
  renderFilters();
  renderTimeline();
  renderSelectedPlayer();
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
      <td class="good">${p.entryKills}</td><td class="${p.openingDeaths > p.entryKills ? 'bad' : ''}">${p.openingDeaths}</td><td>${p.utilityDamage}</td>
    </tr>`;
  }).join('');
  els.scoreBody.querySelectorAll('tr').forEach((row) => row.addEventListener('click', () => {
    selectedSteamid = row.dataset.id;
    renderScoreboard();
    renderSelectedPlayer();
    els.timelineFilter.value = selectedSteamid;
    renderTimeline();
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
  els.timeline.innerHTML = rows.map((e) => `<div class="event">
    <div class="event-round">R${e.round || '?'}</div>
    <div class="event-main"><strong>${esc(e.attacker || 'world')}</strong> → <strong>${esc(e.victim || '?')}</strong>
      ${e.weapon ? `<span class="weapon"> · ${esc(e.weapon)}</span>` : ''}${e.headshot ? '<span class="hs">HS</span>' : ''}
      ${Number.isFinite(Number(e.secondsIntoRound)) ? `<span class="weapon"> · ${Number(e.secondsIntoRound).toFixed(1)}s</span>` : ''}
      ${e.tradeKill ? '<span class="hs">TRADE</span>' : ''}
    </div>
  </div>`).join('');
}

function renderSelectedPlayer() {
  const p = playerById(selectedSteamid);
  if (!p) {
    els.selectedPlayer.textContent = 'Выбери игрока в таблице';
    els.aiBtn.disabled = true;
    return;
  }
  const advanced = [
    p.kastPct != null ? `KAST ${p.kastPct}%` : null,
    match?.dataAvailability?.tradeDetection ? `Trades ${p.tradeKills || 0} · traded deaths ${p.tradedDeaths || 0}${p.tradedDeathPct != null ? ` (${p.tradedDeathPct}%)` : ''}` : null,
    `2K+ rounds ${p.multiKillRounds || 0}`,
    match?.dataAvailability?.clutchDetection ? `Clutch ${p.clutchWins || 0}/${p.clutchAttempts || 0}` : null,
    match?.dataAvailability?.firstContactTiming && p.avgOpeningDuelTimeSec != null ? `Opening timing ${p.avgOpeningDuelTimeSec}s` : null,
  ].filter(Boolean).join(' · ');
  els.selectedPlayer.innerHTML = `<strong>${esc(p.name)}</strong><br><span class="muted">${p.kills}/${p.deaths}/${p.assists} · ADR ${p.adr} · HS ${p.hsPct}% · Entry ${p.entryKills}:${p.openingDeaths}</span>${advanced ? `<br><span class="muted">${esc(advanced)}</span>` : ''}`;
  els.aiBtn.disabled = false;
  els.aiOutput.textContent = 'Готов к локальному AI-разбору с V5-метриками.';
  els.aiOutput.classList.add('muted');
}

async function runAI() {
  if (!match || !selectedSteamid) return;
  const p = playerById(selectedSteamid);
  els.aiBtn.disabled = true;
  els.aiBtn.textContent = 'Анализирую…';
  els.aiOutput.classList.remove('muted');
  els.aiOutput.textContent = `Локальная модель разбирает игру ${p?.name || ''}…`;
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
els.aiBtn.addEventListener('click', runAI);

checkHealth();