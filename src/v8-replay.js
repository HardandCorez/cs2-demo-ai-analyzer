const asArray = (value) => (Array.isArray(value) ? value : []);
const num = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const finite = (value) => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const text = (value) => String(value ?? '').trim();
const fixed = (value, digits = 2) => Number(Number(value).toFixed(digits));

export function normalizeRoundBounds(startRows, endRows) {
  const starts = asArray(startRows)
    .filter((r) => !Boolean(r?.is_warmup_period))
    .map((r, index) => ({ roundHint: num(r?.total_rounds_played, index) + 1, tick: num(r?.tick) }))
    .filter((r) => r.tick > 0)
    .sort((a,b)=>a.tick-b.tick);
  const ends = asArray(endRows)
    .filter((r) => !Boolean(r?.is_warmup_period))
    .map((r) => ({ tick:num(r?.tick), winnerTeamNumber:num(r?.winner ?? r?.winner_team_num ?? r?.team,0) }))
    .filter((r)=>r.tick>0)
    .sort((a,b)=>a.tick-b.tick);

  // Do not join round_start/round_end by total_rounds_played: CS2 events can expose
  // that counter on opposite sides of the increment. Pair by actual tick order instead.
  return starts.map((start,index)=>{
    const nextStart=starts[index+1];
    const explicit=ends.find(e=>e.tick>start.tick && (!nextStart || e.tick<nextStart.tick));
    const fallbackEnd=nextStart ? nextStart.tick-1 : start.tick+64*180;
    return {
      round:index+1,
      startTick:start.tick,
      endTick:Math.max(start.tick+1, explicit?.tick || fallbackEnd),
      winnerTeamNumber:explicit?.winnerTeamNumber || 0,
    };
  });
}

export function sampleTicksForRounds(rounds, tickRate=64, hz=4){
  const safeRate=Math.max(1,Number(tickRate)||64), safeHz=Math.max(1,Math.min(16,Number(hz)||4));
  const step=Math.max(1,Math.round(safeRate/safeHz)); const ticks=new Set();
  for(const round of asArray(rounds)){const start=num(round?.startTick),end=num(round?.endTick);if(start<=0||end<=start)continue;for(let tick=start;tick<=end;tick+=step)ticks.add(tick);ticks.add(end);}
  return {ticks:[...ticks].sort((a,b)=>a-b),step,hz:fixed(safeRate/step,2)};
}
function normalizePlayerRow(row){const x=finite(row?.X??row?.x),y=finite(row?.Y??row?.y);if(x===null||y===null)return null;return{tick:num(row?.tick),steamid:String(row?.steamid??row?.player_steamid??''),name:text(row?.name??row?.player_name),teamNumber:num(row?.team_num??row?.team_number,0),teamName:text(row?.team_name),alive:row?.is_alive===undefined?true:Boolean(row.is_alive),hp:finite(row?.health??row?.health_value),x,y,z:finite(row?.Z??row?.z)??0,yaw:finite(row?.yaw),place:text(row?.last_place_name)};}
function roundForTick(rounds,tick){for(const round of rounds)if(tick>=round.startTick&&tick<=round.endTick)return round;return null;}
export function buildReplay({roundBounds,snapshotRows,tickRate=64,sampleHz=4,timeline=[],bombEvents=[]}){
 const rounds=asArray(roundBounds),rows=asArray(snapshotRows).map(normalizePlayerRow).filter(Boolean),framesByRound=new Map(rounds.map(r=>[r.round,new Map()]));
 for(const row of rows){const round=roundForTick(rounds,row.tick);if(!round)continue;const map=framesByRound.get(round.round);if(!map.has(row.tick))map.set(row.tick,[]);map.get(row.tick).push({steamid:row.steamid,name:row.name,teamNumber:row.teamNumber,teamName:row.teamName,alive:row.alive,hp:row.hp,x:row.x,y:row.y,z:row.z,yaw:row.yaw,place:row.place});}
 // Assign events by their tick to the corrected temporal round bounds. This avoids the same CS2 round-counter offset bug.
 const rawEvents=[...asArray(timeline).map(e=>({type:'kill',tick:num(e?.tick),attacker:text(e?.attacker),victim:text(e?.victim),weapon:text(e?.weapon),headshot:Boolean(e?.headshot)})),...asArray(bombEvents).map(e=>({...e,tick:num(e?.tick)}))].filter(e=>e.tick>0);
 const payloadRounds=rounds.map(round=>{const frameMap=framesByRound.get(round.round)||new Map();const frames=[...frameMap.entries()].sort((a,b)=>a[0]-b[0]).map(([tick,players])=>({tick,t:fixed((tick-round.startTick)/tickRate,2),players}));const events=rawEvents.filter(e=>e.tick>=round.startTick&&e.tick<=round.endTick).sort((a,b)=>a.tick-b.tick).map(e=>({...e,round:round.round,t:fixed((e.tick-round.startTick)/tickRate,2)}));const actualEnd=frames.length?frames[frames.length-1].tick:round.endTick;return{round:round.round,startTick:round.startTick,endTick:round.endTick,durationSec:fixed(Math.max(0,(actualEnd-round.startTick)/tickRate),2),winnerTeamNumber:round.winnerTeamNumber||0,frames,events};}).filter(r=>r.frames.length>0);
 return{version:'v8.0.1',tickRate:fixed(tickRate,2),sampleHz:fixed(sampleHz,2),rounds:payloadRounds,totalFrames:payloadRounds.reduce((s,r)=>s+r.frames.length,0),totalPlayerSamples:payloadRounds.reduce((s,r)=>s+r.frames.reduce((a,f)=>a+f.players.length,0),0)};
}
