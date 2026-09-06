import { defaultRadarLayer, getRadarMeta, loadRadarImage, worldToRadarFraction } from './radar-catalog.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
const state={match:null,meta:null,round:null,time:0,playing:false,speed:1,lastTs:0,focus:'all',episode:null};

const originalFetch=window.fetch.bind(window);
window.fetch=async(...args)=>{
  const response=await originalFetch(...args);
  try{
    const input=args[0];
    const url=typeof input==='string'?input:String(input?.url||'');
    if(/\/api\/analyze(?:\?|$)/.test(url)&&response.ok){
      response.clone().json().then(async data=>{
        state.match=data; state.round=data?.replay?.rounds?.[0]?.round||null; state.time=0; state.playing=false; state.lastTs=0;
        try{state.meta=data?.map?await getRadarMeta(data.map):null;}catch{state.meta=null;}
        setup(); renderAll();
      }).catch(()=>{});
    }
  }catch{}
  return response;
};

function setup(){
  const results=$('#results'); if(!results)return;
  if(!$('#replayV9Panel')){
    const positioning=$('.positioning-panel');
    const panel=document.createElement('div'); panel.id='replayV9Panel'; panel.className='panel replay-v9-panel';
    panel.innerHTML=`
      <div class="panel-head replay-v9-head"><div><div class="eyebrow">V9 · 2D ROUND REPLAY</div><h3>Тактический реплей</h3><div id="v9ReplayStatus" class="replay-status">Загрузи демку.</div></div>
      <div class="replay-controls"><select id="v9Round"></select><button class="ghost-btn" id="v9Play">▶</button><button class="ghost-btn" id="v9Back">−5с</button><button class="ghost-btn" id="v9Forward">+5с</button><select id="v9Speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><select id="v9Focus"><option value="all">Все игроки</option><option value="t">Только T</option><option value="ct">Только CT</option><option value="selected">Фокус: выбранный</option></select></div></div>
      <div class="v9-replay-grid"><div class="replay-canvas-wrap"><canvas id="v9Canvas"></canvas><div id="v9BombState" class="v9-bomb-state"></div></div><div id="v9Hud" class="v9-hud"></div></div>
      <div class="replay-bottom"><input id="v9Range" class="replay-range" type="range" min="0" max="1" step="0.02" value="0"/><div id="v9Time" class="replay-time">0:00 / 0:00</div></div>
      <div id="v9Events" class="replay-event-strip"></div>
      <div class="replay-legend"><span>T/CT и HP в реальном времени</span><span>smoke / flash / HE / molotov</span><span>сглаживание между sampled frames</span></div>`;
    (positioning||results.lastElementChild).insertAdjacentElement('beforebegin',panel);
    $('#v9Round')?.addEventListener('change',e=>{state.round=Number(e.target.value);state.time=0;state.playing=false;renderAll();});
    $('#v9Play')?.addEventListener('click',togglePlay); $('#v9Back')?.addEventListener('click',()=>seek(state.time-5)); $('#v9Forward')?.addEventListener('click',()=>seek(state.time+5));
    $('#v9Speed')?.addEventListener('change',e=>state.speed=Number(e.target.value)||1); $('#v9Focus')?.addEventListener('change',e=>{state.focus=e.target.value;renderReplay();});
    $('#v9Range')?.addEventListener('input',e=>{state.time=Number(e.target.value)||0;state.playing=false;renderAll();});
    window.addEventListener('resize',renderReplay);
  }
  if(!$('#v9Insights')){
    const twoCol=$('.two-col');
    const panel=document.createElement('div'); panel.id='v9Insights'; panel.className='panel v9-insights';
    panel.innerHTML=`<div class="panel-head"><div><div class="eyebrow">V9 · COACHING INTELLIGENCE</div><h3>Критические эпизоды и механика</h3></div><div class="hint">клик → нужный момент replay</div></div><div class="v9-insight-grid"><div><h4>Критические эпизоды</h4><div id="v9Episodes"></div></div><div><h4>Aim / duels</h4><div id="v9Aim"></div></div></div><div id="v9EpisodeOutput" class="ai-output muted">Выбери эпизод и нажми «AI по эпизоду».</div>`;
    (twoCol||results.lastElementChild).insertAdjacentElement('beforebegin',panel);
  }
}

function rounds(){return state.match?.replay?.rounds||[];}
function currentRound(){return rounds().find(r=>Number(r.round)===Number(state.round))||rounds()[0]||null;}
function fmtTime(sec){const s=Math.max(0,Number(sec)||0);return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;}
function playerId(){const row=document.querySelector('#scoreBody tr.selected'); return row?.dataset?.id||'';}
function selectedName(){const id=playerId(); const p=state.match?.players?.find(x=>String(x.steamid||x.name)===String(id)); return p?.name||'';}

function framePair(round,time){
  const frames=round?.frames||[]; if(!frames.length)return [null,null,0];
  if(time<=frames[0].t)return [frames[0],frames[0],0]; if(time>=frames.at(-1).t)return [frames.at(-1),frames.at(-1),0];
  let lo=0,hi=frames.length-1; while(lo+1<hi){const mid=(lo+hi)>>1;if(frames[mid].t<=time)lo=mid;else hi=mid;}
  const a=frames[lo],b=frames[hi]; const span=Math.max(.001,Number(b.t)-Number(a.t)); return [a,b,clamp((time-Number(a.t))/span,0,1)];
}

function interpFrame(round,time){
  const [a,b,f]=framePair(round,time); if(!a)return null;
  const byB=new Map((b.players||[]).map(p=>[p.steamid||p.name,p]));
  return {tick:Math.round(Number(a.tick)+(Number(b.tick)-Number(a.tick))*f),t:time,players:(a.players||[]).map(p=>{
    const q=byB.get(p.steamid||p.name)||p; const lerp=(x,y)=>Number(x)+(Number(y)-Number(x))*f;
    const yawA=Number(p.yaw),yawB=Number(q.yaw); let yaw=Number.isFinite(yawA)?yawA:null;
    if(Number.isFinite(yawA)&&Number.isFinite(yawB)){let d=((yawB-yawA+540)%360)-180;yaw=yawA+d*f;}
    return {...p,x:lerp(p.x,q.x),y:lerp(p.y,q.y),z:lerp(p.z||0,q.z||0),yaw,hp:f<.5?p.hp:q.hp,alive:f<.5?p.alive:q.alive,weapon:q.weapon||p.weapon,armor:q.armor??p.armor,money:q.money??p.money};
  })};
}

function projectFactory(width,height){
  const size=Math.min(width-18,height-18),x0=(width-size)/2,y0=(height-size)/2; const meta=state.meta;
  return {size,x0,y0,project:p=>{
    if(meta?.available){const f=worldToRadarFraction(meta,p.x,p.y);if(!f)return null;return{x:x0+f.fx*size,y:y0+f.fy*size};}
    const b=state.match?.positioning?.bounds;if(!b)return null;return{x:40+((p.x-b.minX)/(b.maxX-b.minX||1))*(width-80),y:height-40-((p.y-b.minY)/(b.maxY-b.minY||1))*(height-80)};
  }};
}

async function renderReplay(){
  setup(); const canvas=$('#v9Canvas'),round=currentRound(); if(!canvas||!round)return;
  const rect=canvas.getBoundingClientRect(); const width=Math.max(620,Math.floor(rect.width||900)),height=Math.max(520,Math.min(780,Math.floor(width*.72))),dpr=Math.min(2,devicePixelRatio||1);
  canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.height=`${height}px`;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle='#070a0f';ctx.fillRect(0,0,width,height);
  const {size,x0,y0,project}=projectFactory(width,height); if(state.meta?.available){try{const img=await loadRadarImage(defaultRadarLayer(state.meta));ctx.drawImage(img,x0,y0,size,size);ctx.fillStyle='rgba(2,5,8,.18)';ctx.fillRect(x0,y0,size,size);}catch{}}
  const frame=interpFrame(round,state.time); if(!frame)return;
  drawUtility(ctx,round,project); const selected=selectedName();
  let players=frame.players||[]; if(state.focus==='t')players=players.filter(p=>Number(p.teamNumber)===2); if(state.focus==='ct')players=players.filter(p=>Number(p.teamNumber)===3); if(state.focus==='selected'&&selected)players=players.filter(p=>p.name===selected);
  for(const p of players){const q=project(p);if(!q)continue;const ct=Number(p.teamNumber)===3,isSel=p.name===selected;ctx.save();ctx.globalAlpha=p.alive===false?.28:(selected&&!isSel?.58:1);ctx.fillStyle=ct?'#65baff':'#f1c75b';ctx.strokeStyle=isSel?'#9cff2e':'#061018';ctx.lineWidth=isSel?3:2;ctx.beginPath();ctx.arc(q.x,q.y,isSel?10:8,0,Math.PI*2);ctx.fill();ctx.stroke();if(p.alive===false){ctx.strokeStyle='#ff6675';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(q.x-6,q.y-6);ctx.lineTo(q.x+6,q.y+6);ctx.moveTo(q.x+6,q.y-6);ctx.lineTo(q.x-6,q.y+6);ctx.stroke();}if(Number.isFinite(Number(p.yaw))){const a=Number(p.yaw)*Math.PI/180;ctx.strokeStyle='#fff';ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(q.x,q.y);ctx.lineTo(q.x+Math.cos(a)*16,q.y+Math.sin(a)*16);ctx.stroke();}ctx.font=`${isSel?'700':'600'} 10px system-ui`;ctx.textAlign='center';ctx.fillStyle='#fff';ctx.shadowColor='#000';ctx.shadowBlur=4;if(isSel||state.focus!=='all')ctx.fillText(p.name||'?',q.x,q.y-13);ctx.restore();}
  ctx.fillStyle='rgba(255,255,255,.65)';ctx.font='11px system-ui';ctx.textAlign='left';ctx.fillText(`R${round.round} · ${fmtTime(state.time)} · ${frame.players.filter(p=>p.alive!==false).length} alive`,14,height-14);
  renderHud(frame); renderBomb(round,project);
}

function activeUtility(round){
  return (round.events||[]).filter(e=>['smoke','flash','he','molotov','decoy'].includes(e.type)&&Number(e.t)<=state.time&&state.time<=Number(e.t)+(Number(e.duration)||0.8));
}
function drawUtility(ctx,round,project){
  for(const e of activeUtility(round)){if(!Number.isFinite(Number(e.x))||!Number.isFinite(Number(e.y)))continue;const q=project(e);if(!q)continue;ctx.save();
    if(e.type==='smoke'){ctx.fillStyle='rgba(165,178,190,.38)';ctx.beginPath();ctx.arc(q.x,q.y,24,0,Math.PI*2);ctx.fill();}
    else if(e.type==='molotov'){ctx.fillStyle='rgba(255,126,53,.38)';ctx.beginPath();ctx.arc(q.x,q.y,22,0,Math.PI*2);ctx.fill();}
    else if(e.type==='flash'){ctx.strokeStyle='rgba(255,255,220,.95)';ctx.lineWidth=3;ctx.beginPath();ctx.arc(q.x,q.y,16,0,Math.PI*2);ctx.stroke();}
    else if(e.type==='he'){ctx.strokeStyle='rgba(255,80,80,.85)';ctx.lineWidth=3;ctx.beginPath();ctx.arc(q.x,q.y,18,0,Math.PI*2);ctx.stroke();}
    else{ctx.strokeStyle='rgba(190,120,255,.8)';ctx.beginPath();ctx.arc(q.x,q.y,18,0,Math.PI*2);ctx.stroke();}ctx.restore();
  }
}

function renderBomb(round,project){
  const box=$('#v9BombState');if(!box)return;const events=(round.events||[]).filter(e=>String(e.type).startsWith('bomb_')&&Number(e.t)<=state.time).sort((a,b)=>a.t-b.t);const last=events.at(-1);
  if(!last){box.textContent='C4: в игре';return;}const labels={bomb_planted:'C4: установлена',bomb_defused:'C4: обезврежена',bomb_exploded:'C4: взорвалась',bomb_dropped:'C4: брошена',bomb_pickup:'C4: подобрана'};box.textContent=labels[last.type]||`C4: ${last.type}`;
}

function buyClass(players){
  const alive=(players||[]).filter(p=>p.alive!==false); if(!alive.length)return '—';let rifles=0,pistols=0,armor=0;
  for(const p of alive){const w=String(p.weapon||'').toLowerCase();if(/ak|m4|awp|galil|famas|aug|sg556|ssg08/.test(w))rifles++;else if(w)pistols++;if(Number(p.armor)>0)armor++;}
  if(rifles>=3&&armor>=3)return 'FULL'; if(rifles>=1||armor>=3)return 'FORCE/HALF'; return pistols>=3?'ECO/PISTOL':'ECO';
}
function renderHud(frame){
  const box=$('#v9Hud');if(!box)return;const teams=[{n:2,label:'T'},{n:3,label:'CT'}];box.innerHTML=teams.map(team=>{const ps=(frame.players||[]).filter(p=>Number(p.teamNumber)===team.n);return `<div class="v9-team"><div class="v9-team-head"><b>${team.label}</b><span>${buyClass(ps)}</span></div>${ps.map(p=>`<div class="v9-hud-player ${p.alive===false?'dead':''}"><span class="v9-hud-name">${esc(p.name)}</span><span>${p.hp==null?'—':Math.round(p.hp)} HP</span><span>${esc(p.weapon||'—')}</span><span>${p.armor==null?'':`${Math.round(p.armor)}A`}</span><span>${p.money==null?'':`$${Math.round(p.money)}`}</span></div>`).join('')}</div>`;}).join('');
}

function renderControls(){
  setup();const list=rounds(),r=currentRound();const sel=$('#v9Round');if(sel){const cur=String(state.round??'');sel.innerHTML=list.map(x=>`<option value="${x.round}">Раунд ${x.round}${x.winnerTeamNumber===2?' · T':x.winnerTeamNumber===3?' · CT':''}</option>`).join('');if(cur)sel.value=cur;}
  const range=$('#v9Range');if(range){range.max=String(Math.max(.1,r?.durationSec||.1));range.value=String(clamp(state.time,0,r?.durationSec||0));}
  if($('#v9Play'))$('#v9Play').textContent=state.playing?'❚❚':'▶';if($('#v9Time'))$('#v9Time').textContent=`${fmtTime(state.time)} / ${fmtTime(r?.durationSec||0)}`;
  if($('#v9ReplayStatus'))$('#v9ReplayStatus').textContent=state.match?.replay?`Все игроки · ${state.match.replay.sampleHz} sampled fps → плавный клиентский replay · ${state.match.replay.totalFrames} кадров`:'Replay недоступен';
  renderEvents();
}

function renderEvents(){const box=$('#v9Events'),r=currentRound();if(!box)return;box.innerHTML=(r?.events||[]).map(e=>{let label;if(e.type==='kill')label=`${fmtTime(e.t)} · ${esc(e.attacker)} → ${esc(e.victim)}${e.headshot?' · HS':''}`;else label=`${fmtTime(e.t)} · ${esc(String(e.type).replaceAll('_',' '))}`;return `<button class="replay-event ${esc(e.type)}" data-time="${Number(e.t)||0}">${label}</button>`;}).join('')||'<span class="muted">Событий нет.</span>';box.querySelectorAll('[data-time]').forEach(b=>b.addEventListener('click',()=>seek(Number(b.dataset.time)||0)));}

function seek(sec){const r=currentRound();state.time=clamp(Number(sec)||0,0,r?.durationSec||0);state.playing=false;renderAll();}
function togglePlay(){const r=currentRound();if(!r)return;if(state.time>=r.durationSec-.03)state.time=0;state.playing=!state.playing;state.lastTs=0;renderControls();if(state.playing)loop(performance.now());}
function loop(ts){if(!state.playing)return;const r=currentRound();if(!r)return;if(!state.lastTs)state.lastTs=ts;const dt=(ts-state.lastTs)/1000;state.lastTs=ts;state.time+=dt*state.speed;if(state.time>=r.durationSec){state.time=r.durationSec;state.playing=false;}renderControls();renderReplay();if(state.playing)requestAnimationFrame(loop);}

function openEpisode(ep){state.episode=ep;state.round=Number(ep.round);state.time=Math.max(0,Number(ep.t||0)-4);state.playing=false;renderAll();$('#replayV9Panel')?.scrollIntoView({behavior:'smooth',block:'start'});}
async function episodeAI(ep,button){const out=$('#v9EpisodeOutput');if(!out)return;button.disabled=true;out.classList.remove('muted');out.textContent='Анализирую конкретный эпизод…';const compact={...state.match,replay:{tickRate:state.match?.replay?.tickRate},utility:undefined,duels:undefined,aim:undefined,criticalEpisodes:undefined};try{const response=await fetch('/api/episode-ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match:compact,episode:ep,selectedSteamid:ep.player})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Ошибка Episode AI');out.textContent=data.episodeAnalysis||data.analysis||'Нет ответа';}catch(e){out.textContent=`Ошибка: ${e.message}`;}finally{button.disabled=false;}}

function renderInsights(){
  const epBox=$('#v9Episodes'),aimBox=$('#v9Aim');if(!epBox||!aimBox)return;const episodes=state.match?.criticalEpisodes||[];
  epBox.innerHTML=episodes.length?episodes.map((e,i)=>`<div class="v9-episode ${e.severity==='high'?'high':''}" data-ep="${i}"><div><b>R${e.round} · ${Number.isFinite(Number(e.t))?`${Number(e.t).toFixed(1)}с`:'—'} · ${esc(e.player)}</b><span>${esc((e.reasons||[]).join(' · '))}</span></div><div class="v9-episode-actions"><button class="ghost-btn v9-open" type="button">Открыть в Replay</button><button class="ghost-btn v9-ai" type="button">AI по эпизоду</button></div></div>`).join(''):'<div class="muted">Критических эвристических эпизодов не найдено.</div>';
  epBox.querySelectorAll('[data-ep]').forEach(row=>{const ep=episodes[Number(row.dataset.ep)];row.querySelector('.v9-open')?.addEventListener('click',()=>openEpisode(ep));row.querySelector('.v9-ai')?.addEventListener('click',e=>episodeAI(ep,e.currentTarget));});
  const name=selectedName()||state.match?.players?.[0]?.name;const aim=state.match?.aim?.[name];const duels=(state.match?.duels||[]).filter(d=>d.attacker===name||d.victim===name).slice(0,8);
  aimBox.innerHTML=`<div class="v9-aim-cards"><div><span>Shots</span><b>${aim?.shots??'—'}</b></div><div><span>Hits</span><b>${aim?.hits??'—'}</b></div><div><span>Accuracy*</span><b>${aim?.accuracyPct==null?'—':aim.accuracyPct+'%'}</b></div><div><span>Avg TTK</span><b>${aim?.avgTtkSec==null?'—':aim.avgTtkSec+'s'}</b></div><div><span>1st bullet*</span><b>${aim?.firstBulletHitPctHeuristic==null?'—':aim.firstBulletHitPctHeuristic+'%'}</b></div></div><div class="v9-duels">${duels.map(d=>`<div><span>R${d.round} ${esc(d.attacker)} → ${esc(d.victim)}</span><span>${d.shots} shots · ${d.hits} hits · ${d.ttkSec==null?'TTK —':d.ttkSec+'s'}</span></div>`).join('')}</div><div class="position-disclaimer">* Accuracy и first-bullet здесь строятся из weapon_fire/player_hurt и являются аналитическими эвристиками, а не официальной engine accuracy.</div>`;
}

function renderAll(){setup();renderControls();renderReplay();renderInsights();}
setup();
