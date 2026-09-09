const STORAGE_KEY='hc_match_history_v1';
const PRIMARY_KEY='hc_primary_player';
const $=(s)=>document.querySelector(s);
const arr=(v)=>Array.isArray(v)?v:[];
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const text=(v)=>String(v??'').trim();
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

function readHistory(){try{const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(value)?value:[];}catch{return[];}}
function writeHistory(items){localStorage.setItem(STORAGE_KEY,JSON.stringify(items));}
function primary(){return text(localStorage.getItem(PRIMARY_KEY));}
function performanceIndex(p){if(!p)return null;const kast=Number.isFinite(Number(p.kastPct))?Number(p.kastPct):70;return clamp(Math.round(50+(num(p.kd,1)-1)*20+(num(p.adr,70)-70)*.25+(kast-70)*.4+(num(p.entryKills)-num(p.openingDeaths))*1.5),0,100);}
function mapName(v){return (text(v)||'unknown').replace(/^de_/,'').toUpperCase();}
function dateLabel(v){try{return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(v));}catch{return v||'—';}}

let history=readHistory();
let openId='';

function frequentPlayers(){
  const counts=new Map();
  for(const match of history)for(const p of arr(match.players))counts.set(p.name,(counts.get(p.name)||0)+1);
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,25);
}

function playerFor(match){
  const wanted=primary();
  return arr(match.players).find((p)=>p.name===wanted)||arr(match.players).find((p)=>p.name===match.selectedPlayer)||arr(match.players)[0]||null;
}

function episodesFor(match,p){
  const eps=arr(match.criticalEpisodes);if(!p)return eps;
  const mine=eps.filter((e)=>e.player===p.name);return mine.length?mine:eps;
}

function issueFor(match,p){
  const counts={};
  for(const ep of episodesFor(match,p))for(const reason of arr(ep.reasons))counts[reason]=(counts[reason]||0)+1;
  const top=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  return top?{name:top[0],count:top[1]}:null;
}

function configurePlayerSelect(){
  const sel=$('#primaryPlayer');if(!sel)return;
  const current=primary();
  const options=frequentPlayers();
  sel.innerHTML='<option value="">Авто: лучший игрок матча</option>'+options.map(([name,count])=>`<option value="${esc(name)}">${esc(name)} · ${count} матч.</option>`).join('');
  sel.value=options.some(([name])=>name===current)?current:'';
  sel.onchange=()=>{const v=sel.value;if(v)localStorage.setItem(PRIMARY_KEY,v);else localStorage.removeItem(PRIMARY_KEY);render();};
}

function filteredHistory(){
  const q=text($('#matchSearch')?.value).toLowerCase();
  const map=$('#mapFilter')?.value||'all';
  const sort=$('#sortMatches')?.value||'newest';
  const list=history.filter((m)=>{
    const hit=!q||`${m.fileName} ${m.map} ${m.server}`.toLowerCase().includes(q);
    return hit&&(map==='all'||m.map===map);
  });
  const metric=(m,key)=>{const p=playerFor(m);if(key==='rating')return performanceIndex(p)??-1;if(key==='adr')return num(p?.adr,-1);if(key==='kast')return Number.isFinite(Number(p?.kastPct))?Number(p.kastPct):-1;return new Date(m.analyzedAt||0).getTime();};
  return list.sort((a,b)=>metric(b,sort==='newest'?'date':sort)-metric(a,sort==='newest'?'date':sort));
}

function renderMapFilter(){
  const sel=$('#mapFilter');if(!sel)return;const current=sel.value||'all';
  const maps=[...new Set(history.map((m)=>m.map).filter(Boolean))].sort();
  sel.innerHTML='<option value="all">Все карты</option>'+maps.map((m)=>`<option value="${esc(m)}">${esc(mapName(m))}</option>`).join('');
  sel.value=maps.includes(current)?current:'all';
}

function trend(){
  const ratings=history.map((m)=>performanceIndex(playerFor(m))).filter(Number.isFinite);
  if(ratings.length<2)return{label:'Недостаточно данных',className:'trend-flat'};
  const latest=ratings.slice(0,5);const prev=ratings.slice(5,10);
  if(!prev.length){const d=ratings[0]-ratings[1];return{label:`${d>=0?'+':''}${d} к прошлому матчу`,className:d>0?'trend-up':d<0?'trend-down':'trend-flat'};}
  const avg=(a)=>a.reduce((s,v)=>s+v,0)/a.length;const d=Math.round(avg(latest)-avg(prev));
  return{label:`${d>=0?'+':''}${d} к предыдущим 5`,className:d>0?'trend-up':d<0?'trend-down':'trend-flat'};
}

function renderKpis(){
  const box=$('#matchKpis');if(!box)return;
  const ps=history.map((m)=>playerFor(m)).filter(Boolean);
  const avg=(values)=>values.length?values.reduce((s,v)=>s+v,0)/values.length:null;
  const adr=avg(ps.map((p)=>num(p.adr)));const kd=avg(ps.map((p)=>num(p.kd)));const kastVals=ps.map((p)=>Number(p.kastPct)).filter(Number.isFinite);const kast=avg(kastVals);
  const issueCounts={};for(const m of history){const i=issueFor(m,playerFor(m));if(i)issueCounts[i.name]=(issueCounts[i.name]||0)+i.count;}
  const main=Object.entries(issueCounts).sort((a,b)=>b[1]-a[1])[0];const tr=trend();
  const cards=[
    ['Матчи',history.length,'локальная история'],
    ['Средний ADR',adr==null?'—':adr.toFixed(1),primary()||'авто'],
    ['Средний K/D',kd==null?'—':kd.toFixed(2),tr.label,tr.className],
    ['Средний KAST',kast==null?'—':kast.toFixed(1)+'%','по доступным матчам'],
    ['Главный паттерн',main?main[0]:'—',main?`${main[1]} эпизодов`:'нет данных'],
  ];
  box.innerHTML=cards.map(([label,value,small,cls])=>`<div class="match-kpi"><span>${esc(label)}</span><b>${esc(value)}</b><small class="${cls||''}">${esc(small)}</small></div>`).join('');
}

function scoreText(m){
  const values=Object.values(m.roundWinsBySide||{}).map(Number).filter(Number.isFinite);
  if(values.length>=2)return values.sort((a,b)=>b-a).slice(0,2).join(':');
  return `${num(m.rounds)}R`;
}

function episodeRows(m,p){
  const eps=episodesFor(m,p).slice(0,12);
  if(!eps.length)return'<div class="muted">Критических эпизодов не сохранено.</div>';
  return `<div class="episode-list">${eps.map((ep)=>`<div class="episode-row"><div><b>R${ep.round}${ep.t==null?'':` · ${Number(ep.t).toFixed(1)}с`}</b><span>${esc(ep.player)} ← ${esc(ep.attacker||'opponent')}</span></div><i>${esc(arr(ep.reasons).join(' · ')||'DEATH REVIEW')}</i></div>`).join('')}</div>`;
}

function details(m,p){
  const rows=arr(m.players).map((x)=>`<tr class="${p&&x.name===p.name?'primary-row':''}"><td>${esc(x.name)}</td><td>${x.kills}</td><td>${x.deaths}</td><td>${x.kd}</td><td>${x.adr}</td><td>${x.kastPct==null?'—':x.kastPct+'%'}</td><td>${x.entryKills}:${x.openingDeaths}</td></tr>`).join('');
  return `<div class="match-details"><div class="match-detail-grid"><div class="detail-block"><h4>Scoreboard</h4><table class="mini-score"><thead><tr><th>Игрок</th><th>K</th><th>D</th><th>K/D</th><th>ADR</th><th>KAST</th><th>Entry</th></tr></thead><tbody>${rows}</tbody></table></div><div class="detail-block"><h4>Критические эпизоды</h4>${episodeRows(m,p)}<div class="local-note" style="margin-top:12px">Чтобы открыть 8-секундный replay, исходную .dem нужно снова открыть на странице анализа — браузер не хранит сам файл.</div></div></div></div>`;
}

function renderList(){
  const box=$('#matchesList'),empty=$('#matchesEmpty');if(!box||!empty)return;
  const list=filteredHistory();
  empty.classList.toggle('hidden',history.length>0);box.classList.toggle('hidden',history.length===0);
  if(!history.length){box.innerHTML='';return;}
  if(!list.length){box.innerHTML='<div class="panel matches-empty"><h2>Ничего не найдено</h2><p>Измени карту или поисковый запрос.</p></div>';return;}
  box.innerHTML=list.map((m)=>{
    const p=playerFor(m),rating=performanceIndex(p),issue=issueFor(m,p),eps=episodesFor(m,p);
    return `<article class="match-card ${openId===m.id?'open':''}" data-match-id="${esc(m.id)}"><div class="match-card-head">
      <div class="match-main"><div class="map">${esc(mapName(m.map))} <small>${esc(scoreText(m))}</small></div><span class="meta">${esc(dateLabel(m.analyzedAt))} · ${esc(m.fileName||'demo.dem')}</span></div>
      <div class="match-stat"><span>Игрок</span><b>${esc(p?.name||'—')}</b></div>
      <div class="match-stat"><span>K/D · ADR</span><b>${p?`${p.kd} · ${p.adr}`:'—'}</b></div>
      <div class="match-stat optional-stat"><span>KAST</span><b>${p?.kastPct==null?'—':p.kastPct+'%'}</b></div>
      <div class="match-stat match-rating"><span>Index*</span><b>${rating??'—'}</b>${rating==null?'':`<div class="rating-bar"><i style="width:${rating}%"></i></div>`}</div>
      <div class="match-issue"><span>Главная проблема</span><b>${issue?`${esc(issue.name)} <em>×${issue.count}</em>`:'Критических паттернов нет'}</b><span>${eps.length} эпизодов сохранено</span></div>
      <div class="match-actions"><button class="ghost-btn open-match" type="button">${openId===m.id?'Скрыть':'Отчёт'}</button><button class="ghost-btn delete-match" type="button" title="Удалить">×</button></div>
    </div>${details(m,p)}</article>`;
  }).join('');

  box.querySelectorAll('.match-card').forEach((card)=>{
    const id=card.dataset.matchId;
    card.querySelector('.open-match')?.addEventListener('click',()=>{openId=openId===id?'':id;renderList();});
    card.querySelector('.delete-match')?.addEventListener('click',()=>{history=history.filter((m)=>m.id!==id);writeHistory(history);if(openId===id)openId='';render();});
  });
}

function render(){history=readHistory();configurePlayerSelect();renderMapFilter();renderKpis();renderList();}

$('#matchSearch')?.addEventListener('input',renderList);
$('#mapFilter')?.addEventListener('change',renderList);
$('#sortMatches')?.addEventListener('change',renderList);
$('#clearHistory')?.addEventListener('click',()=>{if(!history.length)return;if(confirm('Очистить всю локальную историю матчей?')){history=[];writeHistory([]);openId='';render();}});
window.addEventListener('storage',render);
render();
