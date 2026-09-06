import { defaultRadarLayer, getRadarMeta, loadRadarImage, worldToRadarFraction } from './radar-catalog.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));

const state={match:null,meta:null,round:null,time:0,playing:false,speed:1,lastTs:0,raf:0};

const originalFetch=window.fetch.bind(window);
window.fetch=async(...args)=>{
  const response=await originalFetch(...args);
  try{
    const input=args[0];
    const url=typeof input==='string'?input:String(input?.url||'');
    if(/\/api\/analyze(?:\?|$)/.test(url)&&response.ok){
      response.clone().json().then(async data=>{
        state.match=data;
        state.round=data?.replay?.rounds?.[0]?.round||null;
        state.time=0;state.playing=false;state.lastTs=0;
        try{state.meta=data?.map?await getRadarMeta(data.map):null;}catch{state.meta=null;}
        setup();renderControls();render();
      }).catch(()=>{});
    }
  }catch{}
  return response;
};

function setup(){
  const results=$('#results');
  if(!results||$('#replayV8Panel'))return;
  const positioning=$('.positioning-panel');
  const panel=document.createElement('div');
  panel.id='replayV8Panel';
  panel.className='panel replay-v8-panel';
  panel.innerHTML=`
    <div class="panel-head replay-v8-head">
      <div><div class="eyebrow">V8 · 2D ROUND REPLAY</div><h3>Реплей раунда</h3><div class="replay-status" id="replayStatus">Загрузи демку.</div></div>
      <div class="replay-controls">
        <select id="replayRound" aria-label="Раунд"></select>
        <button class="ghost-btn replay-play" id="replayPlay" type="button">▶</button>
        <button class="ghost-btn" id="replayBack" type="button">−5с</button>
        <button class="ghost-btn" id="replayForward" type="button">+5с</button>
        <select id="replaySpeed" class="replay-speed" aria-label="Скорость"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
      </div>
    </div>
    <div class="replay-canvas-wrap"><canvas id="replayCanvas" class="replay-v8-canvas"></canvas></div>
    <div class="replay-bottom"><input id="replayRange" class="replay-range" type="range" min="0" max="1" step="0.05" value="0"/><div id="replayTime" class="replay-time">0:00 / 0:00</div></div>
    <div class="replay-event-strip" id="replayEvents"></div>
    <div class="replay-legend"><span><i class="replay-team-dot t"></i>T</span><span><i class="replay-team-dot ct"></i>CT</span><span>✕ погиб</span><span>клик по событию → перемотка</span></div>`;
  (positioning||results.lastElementChild).insertAdjacentElement('beforebegin',panel);
  $('#replayRound')?.addEventListener('change',e=>{state.round=Number(e.target.value);state.time=0;state.playing=false;renderControls();render();});
  $('#replayPlay')?.addEventListener('click',()=>togglePlay());
  $('#replayBack')?.addEventListener('click',()=>seek(state.time-5));
  $('#replayForward')?.addEventListener('click',()=>seek(state.time+5));
  $('#replaySpeed')?.addEventListener('change',e=>{state.speed=Number(e.target.value)||1;});
  $('#replayRange')?.addEventListener('input',e=>{state.time=Number(e.target.value)||0;state.playing=false;renderControls();render();});
  window.addEventListener('resize',render);
}

function rounds(){return state.match?.replay?.rounds||[];}
function currentRound(){return rounds().find(r=>Number(r.round)===Number(state.round))||rounds()[0]||null;}
function formatTime(sec){const s=Math.max(0,Number(sec)||0);return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;}

function renderControls(){
  setup();
  const list=rounds();
  const select=$('#replayRound');
  if(select){
    const current=String(state.round??'');
    select.innerHTML=list.map(r=>`<option value="${r.round}">Раунд ${r.round}${r.winnerTeamNumber===2?' · T':r.winnerTeamNumber===3?' · CT':''}</option>`).join('');
    if(current)select.value=current;
  }
  const r=currentRound();
  const range=$('#replayRange');
  if(range){range.max=String(Math.max(.1,r?.durationSec||.1));range.value=String(clamp(state.time,0,r?.durationSec||0));}
  const play=$('#replayPlay');if(play)play.textContent=state.playing?'❚❚':'▶';
  const time=$('#replayTime');if(time)time.textContent=`${formatTime(state.time)} / ${formatTime(r?.durationSec||0)}`;
  const status=$('#replayStatus');if(status)status.textContent=state.match?.replay?`Все игроки · ${state.match.replay.sampleHz} кадров/с · ${state.match.replay.totalFrames} кадров`:'Replay недоступен для этой демки';
  renderEvents();
}

function renderEvents(){
  const box=$('#replayEvents');if(!box)return;
  const r=currentRound();
  box.innerHTML=(r?.events||[]).map(e=>{
    const label=e.type==='kill'?`${formatTime(e.t)} · ${esc(e.attacker)} → ${esc(e.victim)}${e.headshot?' · HS':''}`:`${formatTime(e.t)} · ${esc(e.type.replaceAll('_',' '))}`;
    return `<button class="replay-event ${esc(e.type)}" data-time="${Number(e.t)||0}" type="button">${label}</button>`;
  }).join('')||'<span class="muted">Событий в раунде нет.</span>';
  box.querySelectorAll('[data-time]').forEach(btn=>btn.addEventListener('click',()=>seek(Number(btn.dataset.time)||0)));
}

function seek(sec){const r=currentRound();state.time=clamp(Number(sec)||0,0,r?.durationSec||0);state.playing=false;renderControls();render();}
function togglePlay(){const r=currentRound();if(!r)return;if(state.time>=r.durationSec-.05)state.time=0;state.playing=!state.playing;state.lastTs=0;renderControls();if(state.playing)loop(performance.now());}
function loop(ts){if(!state.playing)return;const r=currentRound();if(!r){state.playing=false;return;}if(!state.lastTs)state.lastTs=ts;const dt=(ts-state.lastTs)/1000;state.lastTs=ts;state.time+=dt*state.speed;if(state.time>=r.durationSec){state.time=r.durationSec;state.playing=false;}renderControls();render();if(state.playing)state.raf=requestAnimationFrame(loop);}

function nearestFrame(round,time){
  const frames=round?.frames||[];if(!frames.length)return null;
  let lo=0,hi=frames.length-1;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(frames[mid].t<time)lo=mid+1;else hi=mid;}const a=frames[lo],b=frames[Math.max(0,lo-1)];return !b||Math.abs(a.t-time)<Math.abs(b.t-time)?a:b;
}

async function render(){
  setup();const canvas=$('#replayCanvas');const r=currentRound();if(!canvas||!r)return;
  const rect=canvas.getBoundingClientRect();const width=Math.max(500,Math.floor(rect.width||900));const height=Math.max(520,Math.min(780,Math.floor(width*.70)));const dpr=Math.min(2,window.devicePixelRatio||1);canvas.width=Math.floor(width*dpr);canvas.height=Math.floor(height*dpr);canvas.style.height=`${height}px`;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle='#070a0f';ctx.fillRect(0,0,width,height);
  const size=Math.min(width-18,height-18),x0=(width-size)/2,y0=(height-size)/2;
  let meta=state.meta;
  if(meta?.available){
    const layer=defaultRadarLayer(meta);try{const img=await loadRadarImage(layer);ctx.drawImage(img,x0,y0,size,size);ctx.fillStyle='rgba(3,6,10,.14)';ctx.fillRect(x0,y0,size,size);}catch{}
  }
  const project=p=>{
    if(meta?.available){const f=worldToRadarFraction(meta,p.x,p.y);if(!f)return null;return{x:x0+f.fx*size,y:y0+f.fy*size};}
    const b=state.match?.positioning?.bounds;if(!b)return null;return{x:40+((p.x-b.minX)/(b.maxX-b.minX||1))*(width-80),y:height-40-((p.y-b.minY)/(b.maxY-b.minY||1))*(height-80)};
  };
  const frame=nearestFrame(r,state.time);if(!frame)return;
  for(const p of frame.players||[]){const q=project(p);if(!q)continue;const ct=Number(p.teamNumber)===3;ctx.save();ctx.globalAlpha=p.alive===false?.32:1;ctx.fillStyle=ct?'#65baff':'#f1c75b';ctx.strokeStyle='#081018';ctx.lineWidth=2;ctx.beginPath();ctx.arc(q.x,q.y,8,0,Math.PI*2);ctx.fill();ctx.stroke();if(p.alive===false){ctx.strokeStyle='#ff6675';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(q.x-6,q.y-6);ctx.lineTo(q.x+6,q.y+6);ctx.moveTo(q.x+6,q.y-6);ctx.lineTo(q.x-6,q.y+6);ctx.stroke();}if(Number.isFinite(Number(p.yaw))){const a=Number(p.yaw)*Math.PI/180;ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(q.x,q.y);ctx.lineTo(q.x+Math.cos(a)*14,q.y+Math.sin(a)*14);ctx.stroke();}ctx.font='600 10px system-ui';ctx.textAlign='center';ctx.fillStyle='#fff';ctx.shadowColor='#000';ctx.shadowBlur=4;ctx.fillText(p.name||'?',q.x,q.y-12);if(p.hp!==null&&p.hp!==undefined){ctx.font='9px system-ui';ctx.fillText(String(Math.round(p.hp)),q.x,q.y+19);}ctx.restore();}
  const recent=(r.events||[]).filter(e=>Math.abs(Number(e.t)-state.time)<.8);for(const e of recent){if(e.type!=='kill')continue;const victim=(frame.players||[]).find(p=>p.name===e.victim);const q=victim?project(victim):null;if(q){ctx.strokeStyle='#ff6675';ctx.lineWidth=3;ctx.beginPath();ctx.arc(q.x,q.y,15,0,Math.PI*2);ctx.stroke();}}
  ctx.fillStyle='rgba(255,255,255,.65)';ctx.font='11px system-ui';ctx.fillText(`R${r.round} · ${formatTime(state.time)} · ${frame.players?.filter(p=>p.alive!==false).length||0} alive`,14,height-14);
}

setup();
