const STORAGE_KEY='hc_match_history_v1';
const PRIMARY_KEY='hc_primary_player';
const MAX_MATCHES=40;

const arr=(v)=>Array.isArray(v)?v:[];
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const text=(v)=>String(v??'').trim();
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

function readHistory(){
  try{const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(value)?value:[];}catch{return[];}
}

function writeHistory(items){
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(items.slice(0,MAX_MATCHES)));return true;}catch(error){console.warn('Match history storage unavailable:',error);return false;}
}

function primaryName(){return text(localStorage.getItem(PRIMARY_KEY));}

function compactPlayer(p){
  return {
    steamid:text(p?.steamid),name:text(p?.name),teamNumber:num(p?.teamNumber),teamName:text(p?.teamName),
    kills:num(p?.kills),deaths:num(p?.deaths),assists:num(p?.assists),kd:num(p?.kd),adr:num(p?.adr),hsPct:num(p?.hsPct),
    kastPct:Number.isFinite(Number(p?.kastPct))?Number(p.kastPct):null,tradeKills:num(p?.tradeKills),tradedDeaths:num(p?.tradedDeaths),
    entryKills:num(p?.entryKills),openingDeaths:num(p?.openingDeaths),impact:num(p?.impact),topDeathPlace:text(p?.topDeathPlace),
    isolatedDeathPct:Number.isFinite(Number(p?.isolatedDeathPct))?Number(p.isolatedDeathPct):null,
    highSpeedDeathPct:Number.isFinite(Number(p?.highSpeedDeathPct))?Number(p.highSpeedDeathPct):null,
    flashedDeathPct:Number.isFinite(Number(p?.flashedDeathPct))?Number(p.flashedDeathPct):null,
  };
}

function compactEpisode(ep){
  return {round:num(ep?.round),tick:num(ep?.tick),t:Number.isFinite(Number(ep?.t))?Number(ep.t):null,player:text(ep?.player),attacker:text(ep?.attacker),weapon:text(ep?.weapon),reasons:arr(ep?.reasons).map(text).filter(Boolean),score:num(ep?.score),severity:text(ep?.severity)||'medium'};
}

function performanceIndex(player){
  if(!player)return null;
  const kast=Number.isFinite(Number(player.kastPct))?Number(player.kastPct):70;
  const rating=50+(num(player.kd,1)-1)*20+(num(player.adr,70)-70)*0.25+(kast-70)*0.4+(num(player.entryKills)-num(player.openingDeaths))*1.5;
  return clamp(Math.round(rating),0,100);
}

function summarizeMatch(data){
  if(!data?.players?.length)return null;
  const players=arr(data.players).slice(0,10).map(compactPlayer);
  const episodes=arr(data.criticalEpisodes).slice(0,24).map(compactEpisode);
  const lastTick=arr(data.timeline).reduce((m,e)=>Math.max(m,num(e?.tick)),0);
  const signature=[text(data.fileName),text(data.map),num(data.rounds),lastTick].join('|');
  const selected=players.find((p)=>p.name===primaryName())||players[0]||null;
  const issueCounts={};
  for(const ep of episodes)for(const reason of ep.reasons)issueCounts[reason]=(issueCounts[reason]||0)+1;
  const mainIssue=Object.entries(issueCounts).sort((a,b)=>b[1]-a[1])[0]||null;
  const kastValues=players.map((p)=>p.kastPct).filter(Number.isFinite);
  return {
    id:signature,
    analyzedAt:new Date().toISOString(),
    fileName:text(data.fileName),map:text(data.map)||'unknown',server:text(data.server),rounds:num(data.rounds),
    roundWinsBySide:data.roundWinsBySide&&typeof data.roundWinsBySide==='object'?data.roundWinsBySide:{},
    parser:text(data.parser),build:text(data.build||data.advancedMetricsVersion),
    players,criticalEpisodes:episodes,
    topPlayer:players[0]?.name||'',
    avgAdr:players.length?Number((players.reduce((s,p)=>s+p.adr,0)/players.length).toFixed(1)):0,
    avgKast:kastValues.length?Number((kastValues.reduce((s,v)=>s+v,0)/kastValues.length).toFixed(1)):null,
    mainIssue:mainIssue?{name:mainIssue[0],count:mainIssue[1]}:null,
    selectedPlayer:selected?.name||'',
    performanceIndex:performanceIndex(selected),
  };
}

function saveMatch(data){
  const summary=summarizeMatch(data);if(!summary)return;
  const history=readHistory().filter((item)=>item?.id!==summary.id);
  history.unshift(summary);
  writeHistory(history);
  window.dispatchEvent(new CustomEvent('hc:match-history-updated',{detail:{match:summary}}));
}

const nativeFetch=window.fetch.bind(window);
window.fetch=async(...args)=>{
  const response=await nativeFetch(...args);
  try{
    const input=args[0];const url=typeof input==='string'?input:String(input?.url||'');
    if(/\/api\/analyze(?:\?|$)/.test(url)&&response.ok){
      response.clone().json().then(saveMatch).catch(()=>{});
    }
  }catch{}
  return response;
};

function addMatchesNav(){
  const topbar=document.querySelector('.topbar');if(!topbar||document.querySelector('#matchesNav'))return;
  const link=document.createElement('a');
  link.id='matchesNav';link.href='/matches.html';link.className='ghost-btn';link.textContent='Матчи';
  const status=document.querySelector('#healthStatus');
  status?.insertAdjacentElement('beforebegin',link);
}
addMatchesNav();

window.HCMatchHistory={read:readHistory,write:writeHistory,save:saveMatch,storageKey:STORAGE_KEY,primaryKey:PRIMARY_KEY,performanceIndex};
