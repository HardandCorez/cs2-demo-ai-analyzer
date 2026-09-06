import { getRadarMeta, worldToRadarFraction } from './radar-catalog.js';

const $ = (s) => document.querySelector(s);
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#039;'}[m]));

const state={match:null,meta:null,episode:null,index:-1,monitor:0,mode:'idle'};

const originalFetch=window.fetch.bind(window);
window.fetch=async(...args)=>{
  const response=await originalFetch(...args);
  try{
    const input=args[0];
    const url=typeof input==='string'?input:String(input?.url||'');
    if(/\/api\/analyze(?:\?|$)/.test(url)&&response.ok){
      response.clone().json().then(async data=>{
        state.match=data;
        state.episode=null;
        state.index=-1;
        state.mode='idle';
        try{state.meta=data?.map?await getRadarMeta(data.map):null;}catch{state.meta=null;}
        setup();hideCoach();
      }).catch(()=>{});
    }
  }catch{}
  return response;
};

function setup(){
  const replay=$('#replayV9Panel');
  if(!replay)return;
  if(!$('#v10CoachBar')){
    const bar=document.createElement('div');
    bar.id='v10CoachBar';
    bar.className='v10-coach-bar hidden';
    bar.innerHTML=`
      <div class="v10-coach-copy">
        <div class="v10-eyebrow">V10 · AI REPLAY COACH</div>
        <div id="v10Title" class="v10-title">Эпизод</div>
        <div id="v10Meta" class="v10-meta"></div>
        <div id="v10Countdown" class="v10-countdown"></div>
      </div>
      <div class="v10-actions">
        <button id="v10PlayToError" class="primary" type="button">▶ Проиграть до ошибки</button>
        <button id="v10JumpBack" class="ghost-btn" type="button">−4с</button>
        <button id="v10JumpError" class="ghost-btn" type="button">К ошибке</button>
        <button id="v10Close" class="ghost-btn" type="button">Закрыть</button>
      </div>`;
    replay.querySelector('.replay-v9-head')?.insertAdjacentElement('afterend',bar);
    $('#v10PlayToError')?.addEventListener('click',playToError);
    $('#v10JumpBack')?.addEventListener('click',()=>seekToEpisode(-4));
    $('#v10JumpError')?.addEventListener('click',()=>pauseAtError());
    $('#v10Close')?.addEventListener('click',hideCoach);
  }
  const wrap=replay.querySelector('.replay-canvas-wrap');
  if(wrap&&!$('#v10Overlay')){
    const canvas=document.createElement('canvas');
    canvas.id='v10Overlay';
    canvas.className='v10-overlay';
    wrap.appendChild(canvas);
  }
}

function hideCoach(){
  stopMonitor();
  state.episode=null;
  state.mode='idle';
  $('#v10CoachBar')?.classList.add('hidden');
  $('#replayV9Panel')?.classList.remove('v10-error-moment');
  clearOverlay();
}

function episodeAt(index){return state.match?.criticalEpisodes?.[Number(index)]||null;}

function launch(index){
  setup();
  const ep=episodeAt(index);
  if(!ep)return;
  state.episode=ep; state.index=Number(index); state.mode='armed';
  const bar=$('#v10CoachBar'); bar?.classList.remove('hidden');
  const reasons=(ep.reasons||[]).join(' · ')||'эпизод риска';
  if($('#v10Title'))$('#v10Title').textContent=`R${ep.round} · ${Number(ep.t||0).toFixed(1)}с · ${ep.player||'игрок'}`;
  if($('#v10Meta'))$('#v10Meta').innerHTML=`${esc(reasons)}${ep.attacker?` · против <b>${esc(ep.attacker)}</b>`:''}`;
  seekToEpisode(-4);
  updateCountdown();
  $('#replayV9Panel')?.scrollIntoView({behavior:'smooth',block:'start'});
}

function setRound(round){
  const select=$('#v9Round'); if(!select)return;
  if(String(select.value)!==String(round)){
    select.value=String(round);
    select.dispatchEvent(new Event('change',{bubbles:true}));
  }
}

function setTime(sec){
  const range=$('#v9Range'); if(!range)return;
  const max=Number(range.max)||999;
  range.value=String(clamp(Number(sec)||0,0,max));
  range.dispatchEvent(new Event('input',{bubbles:true}));
  drawOverlay();
  updateCountdown();
}

function currentTime(){return Number($('#v9Range')?.value||0);}
function isPlaying(){return ($('#v9Play')?.textContent||'').trim()!=='▶';}
function pauseReplay(){if(isPlaying())$('#v9Play')?.click();}

function seekToEpisode(offset=0){
  const ep=state.episode;if(!ep)return;
  pauseReplay();
  setRound(ep.round);
  requestAnimationFrame(()=>requestAnimationFrame(()=>setTime(Math.max(0,Number(ep.t||0)+offset))));
  state.mode=offset===0?'paused':'armed';
  $('#replayV9Panel')?.classList.toggle('v10-error-moment',offset===0);
}

function playToError(){
  const ep=state.episode;if(!ep)return;
  seekToEpisode(-4);
  setTimeout(()=>{
    if(!isPlaying())$('#v9Play')?.click();
    state.mode='playing';
    startMonitor();
  },80);
}

function startMonitor(){
  stopMonitor();
  const tick=()=>{
    const ep=state.episode;if(!ep)return;
    const now=currentTime();
    if(now>=Number(ep.t||0)-0.035){pauseAtError();return;}
    updateCountdown();drawOverlay();
    state.monitor=requestAnimationFrame(tick);
  };
  state.monitor=requestAnimationFrame(tick);
}
function stopMonitor(){if(state.monitor)cancelAnimationFrame(state.monitor);state.monitor=0;}

function pauseAtError(){
  const ep=state.episode;if(!ep)return;
  stopMonitor();pauseReplay();setRound(ep.round);setTime(Number(ep.t||0));
  state.mode='paused';
  $('#replayV9Panel')?.classList.add('v10-error-moment');
  if($('#v10Countdown'))$('#v10Countdown').innerHTML='<strong>Момент ошибки</strong> · replay остановлен на событии';
  drawOverlay(true);
}

function updateCountdown(){
  const ep=state.episode,box=$('#v10Countdown');if(!ep||!box)return;
  const d=Number(ep.t||0)-currentTime();
  if(Math.abs(d)<0.08)box.innerHTML='<strong>Момент ошибки</strong> · пауза';
  else if(d>0)box.textContent=`До ошибки: ${d.toFixed(1)}с`;
  else box.textContent=`После ошибки: ${Math.abs(d).toFixed(1)}с`;
}

function nearestFrame(round,time){
  const frames=round?.frames||[];if(!frames.length)return null;
  let best=frames[0],dist=Math.abs(Number(best.t)-time);
  for(const frame of frames){const d=Math.abs(Number(frame.t)-time);if(d<dist){best=frame;dist=d;}}
  return best;
}

function projectPoint(p,width,height){
  if(!p)return null;
  if(state.meta?.available){
    const f=worldToRadarFraction(state.meta,p.x,p.y);if(!f)return null;
    const size=Math.min(width-18,height-18),x0=(width-size)/2,y0=(height-size)/2;
    return{x:x0+f.fx*size,y:y0+f.fy*size};
  }
  const b=state.match?.positioning?.bounds;if(!b)return null;
  return{x:40+((p.x-b.minX)/(b.maxX-b.minX||1))*(width-80),y:height-40-((p.y-b.minY)/(b.maxY-b.minY||1))*(height-80)};
}

function prepareOverlay(){
  const base=$('#v9Canvas'),canvas=$('#v10Overlay');if(!base||!canvas)return null;
  const rect=base.getBoundingClientRect(),width=Math.max(1,Math.floor(rect.width)),height=Math.max(1,Math.floor(rect.height)),dpr=Math.min(2,window.devicePixelRatio||1);
  canvas.width=Math.floor(width*dpr);canvas.height=Math.floor(height*dpr);canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  return{ctx,width,height};
}

function clearOverlay(){const prep=prepareOverlay();if(prep)prep.ctx.clearRect(0,0,prep.width,prep.height);}

function drawOverlay(force=false){
  const ep=state.episode,prep=prepareOverlay();if(!ep||!prep)return;
  const {ctx,width,height}=prep;
  const delta=Math.abs(currentTime()-Number(ep.t||0));
  if(!force&&delta>1.15)return;
  const round=state.match?.replay?.rounds?.find(r=>Number(r.round)===Number(ep.round));
  const frame=nearestFrame(round,Number(ep.t||0));if(!frame)return;
  const victim=(frame.players||[]).find(p=>p.name===ep.player);
  const attacker=(frame.players||[]).find(p=>p.name===ep.attacker);
  const v=projectPoint(victim,width,height),a=projectPoint(attacker,width,height);
  if(a&&v){ctx.save();ctx.setLineDash([7,6]);ctx.strokeStyle='rgba(255,90,105,.65)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(v.x,v.y);ctx.stroke();ctx.restore();}
  if(v){
    ctx.save();ctx.strokeStyle='#ff596b';ctx.lineWidth=4;ctx.beginPath();ctx.arc(v.x,v.y,22,0,Math.PI*2);ctx.stroke();ctx.strokeStyle='rgba(255,89,107,.35)';ctx.lineWidth=8;ctx.beginPath();ctx.arc(v.x,v.y,31,0,Math.PI*2);ctx.stroke();
    const label=`ОШИБКА · ${(ep.reasons||[]).join(' + ').toUpperCase()}`;ctx.font='700 11px system-ui';const tw=ctx.measureText(label).width;const bx=clamp(v.x-tw/2-8,8,width-tw-16),by=clamp(v.y-52,8,height-28);ctx.fillStyle='rgba(9,12,17,.92)';ctx.fillRect(bx,by,tw+16,24);ctx.strokeStyle='rgba(255,89,107,.7)';ctx.strokeRect(bx+.5,by+.5,tw+15,23);ctx.fillStyle='#fff';ctx.fillText(label,bx+8,by+16);ctx.restore();
  }
  if(a){ctx.save();ctx.strokeStyle='#ffd166';ctx.lineWidth=3;ctx.beginPath();ctx.arc(a.x,a.y,16,0,Math.PI*2);ctx.stroke();ctx.restore();}
}

window.addEventListener('hc:v10-coach',(event)=>launch(event.detail?.index));
window.addEventListener('resize',()=>{if(state.episode)drawOverlay(state.mode==='paused');});
const rangeObserver=new MutationObserver(()=>{if(state.episode){updateCountdown();drawOverlay(state.mode==='paused');}});
const observer=new MutationObserver(()=>{setup();const range=$('#v9Range');if(range&&!range.dataset.v10bound){range.dataset.v10bound='1';range.addEventListener('input',()=>{if(state.episode){updateCountdown();drawOverlay(state.mode==='paused');}});}});
observer.observe(document.documentElement,{childList:true,subtree:true});
setup();