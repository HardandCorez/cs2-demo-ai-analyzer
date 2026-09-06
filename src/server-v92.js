import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEvent, parseTicks } from '@laihoe/demoparser2';
import { estimateTickRate } from './v71-trajectories.js';
import { buildReplay, normalizeRoundBounds, sampleTicksForRounds } from './v8-replay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const publicPort = Number(process.env.PORT || 3000);
const internalPort = publicPort + 1;
const maxDemoMb = Math.max(50, Number(process.env.MAX_DEMO_MB || 800));
const replayHz = Math.max(1, Math.min(8, Number(process.env.REPLAY_HZ || 4)));

// V9.2 removes the V8 runtime layer. We reuse the stable V7.1 parser internally,
// then build replay + player state from ONE shared parseTicks pass.
const previousPort = process.env.PORT;
process.env.PORT = String(internalPort);
await import('./server-v71.js');
if (previousPort === undefined) delete process.env.PORT;
else process.env.PORT = previousPort;

const internalBase = `http://127.0.0.1:${internalPort}`;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use(express.static(publicDir));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: maxDemoMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => path.extname(file.originalname).toLowerCase() === '.dem'
    ? cb(null, true)
    : cb(new Error('Можно загружать только файлы .dem')),
});

const arr = (v) => Array.isArray(v) ? v : [];
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const text = (v) => String(v ?? '').trim();
const pick = (row, ...keys) => {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  return undefined;
};

async function forwardDemo(file) {
  const form = new FormData();
  form.append('demo', await openAsBlob(file.path, { type: 'application/octet-stream' }), file.originalname);
  const response = await fetch(`${internalBase}/api/analyze`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `V7.1 parser HTTP ${response.status}`);
    error.status = response.status;
    error.details = data?.details;
    error.hint = data?.hint;
    throw error;
  }
  return data;
}

function eventRows(filePath, name, playerProps = [], otherProps = []) {
  try { return arr(parseEvent(filePath, name, playerProps, otherProps)); }
  catch { try { return arr(parseEvent(filePath, name)); } catch { return []; } }
}

function roundForTick(replay, tick) {
  return arr(replay?.rounds).find((r) => tick >= num(r.startTick) && tick <= num(r.endTick)) || null;
}

function parseReplayRows(filePath, ticks) {
  if (!ticks.length) return [];
  const richProps = [
    'X','Y','Z','yaw','team_num','team_name','is_alive','health','last_place_name',
    'armor_value','has_helmet','has_defuser','money','active_weapon_name',
  ];
  try { return parseTicks(filePath, richProps, ticks); }
  catch (error) {
    console.warn('V9.2 rich replay/state pass unavailable, retrying core props:', error?.message || error);
    try { return parseTicks(filePath, ['X','Y','Z','yaw','team_num','team_name','is_alive','health','last_place_name'], ticks); }
    catch (fallbackError) {
      console.warn('V9.2 replay pass unavailable:', fallbackError?.message || fallbackError);
      return [];
    }
  }
}

function applyStateToReplay(replay, rows) {
  const byKey = new Map();
  for (const row of arr(rows)) byKey.set(`${num(row.tick)}|${text(row.name ?? row.player_name)}`, row);
  for (const round of arr(replay?.rounds)) for (const frame of arr(round.frames)) for (const p of arr(frame.players)) {
    const row = byKey.get(`${num(frame.tick)}|${text(p.name)}`);
    if (!row) continue;
    p.hp = Number.isFinite(Number(row.health)) ? Number(row.health) : p.hp;
    p.armor = Number.isFinite(Number(row.armor_value)) ? Number(row.armor_value) : null;
    p.helmet = row.has_helmet === undefined ? null : Boolean(row.has_helmet);
    p.defuser = row.has_defuser === undefined ? null : Boolean(row.has_defuser);
    p.money = Number.isFinite(Number(row.money)) ? Number(row.money) : null;
    p.weapon = text(row.active_weapon_name).replace(/^weapon_/, '');
  }
  return replay;
}

function normalizeBombEvents(filePath, replay) {
  const specs = [
    ['bomb_planted','bomb_planted'],['bomb_defused','bomb_defused'],['bomb_exploded','bomb_exploded'],
    ['bomb_dropped','bomb_dropped'],['bomb_pickup','bomb_pickup'],
  ];
  const out = [];
  for (const [eventName, type] of specs) for (const row of eventRows(filePath, eventName)) {
    const tick = num(row?.tick);
    const round = roundForTick(replay, tick);
    if (!round) continue;
    out.push({ type, tick, round: round.round, t: Number(((tick - round.startTick) / Math.max(1, num(replay.tickRate,64))).toFixed(2)), player: text(pick(row,'user_name','player_name','name')) });
  }
  return out;
}

function buildReplayFast(filePath, base) {
  const starts = eventRows(filePath, 'round_start', [], ['total_rounds_played','is_warmup_period']);
  const ends = eventRows(filePath, 'round_end', [], ['total_rounds_played','is_warmup_period']);
  const bounds = normalizeRoundBounds(starts, ends);
  if (!bounds.length) return null;
  const tickRate = estimateTickRate(base?.timeline || []);
  const sampled = sampleTicksForRounds(bounds, tickRate, replayHz);
  const rows = parseReplayRows(filePath, sampled.ticks);
  if (!rows.length) return null;
  let replay = buildReplay({ roundBounds: bounds, snapshotRows: rows, tickRate, sampleHz: sampled.hz, timeline: base?.timeline || [], bombEvents: [] });
  applyStateToReplay(replay, rows);
  const bombs = normalizeBombEvents(filePath, replay);
  for (const round of arr(replay?.rounds)) round.events = [...arr(round.events), ...bombs.filter((e) => e.round === round.round)].sort((a,b) => num(a.t)-num(b.t));
  replay.fastParser = true;
  replay.statePasses = 1;
  return replay;
}

function normalizeUtility(filePath, replay) {
  const specs = [
    ['smokegrenade_detonate','smoke',18],['smokegrenade_expired','smoke_end',0],
    ['flashbang_detonate','flash',1.5],['hegrenade_detonate','he',0.6],
    ['inferno_startburn','molotov',7],['inferno_expire','molotov_end',0],
    ['molotov_detonate','molotov',7],['decoy_started','decoy',15],
  ];
  const out = [];
  for (const [eventName,type,duration] of specs) for (const row of eventRows(filePath,eventName,['team_name','team_num'],['x','y','z'])) {
    const tick = num(row?.tick), round = roundForTick(replay,tick);
    if (!round) continue;
    out.push({ type,tick,round:round.round,t:Number(((tick-round.startTick)/Math.max(1,num(replay?.tickRate,64))).toFixed(2)),duration,player:text(pick(row,'user_name','player_name','name')),teamNumber:num(pick(row,'user_team_num','player_team_num','team_num')),x:num(pick(row,'x','X'),NaN),y:num(pick(row,'y','Y'),NaN),z:num(pick(row,'z','Z'),0) });
  }
  return out.filter((e) => Number.isFinite(e.x) && Number.isFinite(e.y));
}

function normalizeCombat(filePath) {
  const fires = eventRows(filePath,'weapon_fire',['team_name','team_num'],['weapon']).map((row)=>({ tick:num(row.tick),player:text(pick(row,'user_name','player_name','name')),weapon:text(pick(row,'weapon','weapon_name')).replace(/^weapon_/,'') })).filter((e)=>e.tick>0&&e.player);
  const hurts = eventRows(filePath,'player_hurt',['team_name','team_num'],['dmg_health','health','weapon','hitgroup']).map((row)=>({ tick:num(row.tick),attacker:text(pick(row,'attacker_name','attacker_player_name','attacker')),victim:text(pick(row,'user_name','victim_name','player_name')),damage:num(pick(row,'dmg_health','damage')),health:num(pick(row,'health')),weapon:text(pick(row,'weapon','weapon_name')).replace(/^weapon_/,'') })).filter((e)=>e.tick>0&&e.attacker&&e.victim);
  return { fires, hurts };
}

function buildDuels(base, combat) {
  const rate = Math.max(1,num(base?.replay?.tickRate,64)), duels=[];
  for (const kill of arr(base?.timeline)) {
    const kt=num(kill.tick), attacker=text(kill.attacker), victim=text(kill.victim);
    if (!kt||!attacker||!victim||attacker===victim) continue;
    const w=Math.round(rate*4), shots=combat.fires.filter((e)=>e.player===attacker&&e.tick<=kt&&e.tick>=kt-w), hits=combat.hurts.filter((e)=>e.attacker===attacker&&e.victim===victim&&e.tick<=kt&&e.tick>=kt-w), firstShot=shots[0]?.tick||null, firstHit=hits[0]?.tick||null;
    duels.push({ round:num(kill.round),tick:kt,t:kill.secondsIntoRound??null,attacker,victim,weapon:kill.weapon||shots.at(-1)?.weapon||'',shots:shots.length,hits:hits.length,damage:hits.reduce((s,h)=>s+h.damage,0),ttkSec:firstShot?Number(((kt-firstShot)/rate).toFixed(3)):null,firstBulletHitHeuristic:firstShot&&firstHit?Math.abs(firstHit-firstShot)<=Math.round(rate*.18):null,widePeekLike:Boolean(kill.victimWidePeekLike),repeekLike:Boolean(kill.repeekLike),traded:Boolean(kill.tradeKill||kill.tradedDeath),nearestTeammateDistance:kill.nearestTeammateDistance??null });
  }
  return duels;
}

function aggregateAim(base, combat, duels) {
  const out={};
  for (const p of arr(base?.players)) {
    const name=p.name, shots=combat.fires.filter((e)=>e.player===name).length, hits=combat.hurts.filter((e)=>e.attacker===name).length, ds=duels.filter((d)=>d.attacker===name), ttks=ds.map((d)=>d.ttkSec).filter(Number.isFinite), first=ds.map((d)=>d.firstBulletHitHeuristic).filter((v)=>v!==null);
    out[name]={ shots,hits,accuracyPct:shots?Number((hits/shots*100).toFixed(1)):null,avgTtkSec:ttks.length?Number((ttks.reduce((a,b)=>a+b,0)/ttks.length).toFixed(3)):null,firstBulletHitPctHeuristic:first.length?Number((first.filter(Boolean).length/first.length*100).toFixed(1)):null };
  }
  return out;
}

function buildCriticalEpisodes(base, duels) {
  const result=[];
  for (const e of arr(base?.timeline)) {
    const reasons=[]; let score=0;
    if (e.repeekLike) { score+=4; reasons.push('повторный пик'); }
    if (e.victimWidePeekLike) { score+=3; reasons.push('широкий выход'); }
    if (e.flashed===true) { score+=2; reasons.push('смерть во флешке'); }
    if (Number.isFinite(Number(e.nearestTeammateDistance))&&Number(e.nearestTeammateDistance)>900) { score+=2; reasons.push('далеко от размена'); }
    if (score<3||!e.victim) continue;
    const duel=duels.find((d)=>d.tick===num(e.tick)&&d.victim===e.victim);
    result.push({ id:`${e.round}-${e.tick}-${e.victim}`,round:num(e.round),tick:num(e.tick),t:e.secondsIntoRound??null,player:e.victim,attacker:e.attacker,weapon:e.weapon,severity:score>=7?'critical':score>=5?'high':'medium',score,reasons,duel,recommendation:e.repeekLike?'После контакта разорвать линию и не отдавать ожидаемый второй пик без нового преимущества.':e.victimWidePeekLike?'Открывать сектор поэтапно и остановиться перед первым точным выстрелом.':'Снизить риск: играть ближе к укрытию и сохранять trade-path.' });
  }
  return result.sort((a,b)=>b.score-a.score||a.round-b.round).slice(0,20);
}

function compactForAI(match) {
  const copy={...match}; delete copy.replay; delete copy.utility; delete copy.duels; delete copy.aim; delete copy.criticalEpisodes; return copy;
}

async function proxyJson(url, body) {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({})); return {response,data};
}

app.get('/api/health', async (_req,res)=>{
  try {
    const response=await fetch(`${internalBase}/api/health`), data=await response.json().catch(()=>({}));
    res.status(response.ok?200:502).json({...data,ok:response.ok&&data?.ok!==false,advancedMetricsVersion:'v9.2-fast-parser',fastParser:true,replay2D:true,episodeCoach:true,aimTelemetry:true,utilityReplay:true});
  } catch (e) { res.status(503).json({ok:false,error:`V7.1 parser недоступен: ${e?.message||e}`}); }
});

app.post('/api/analyze', upload.single('demo'), async (req,res)=>{
  if (!req.file) return res.status(400).json({error:'Файл .dem не получен'});
  const started=Date.now();
  try {
    const base=await forwardDemo(req.file);
    const replay=buildReplayFast(req.file.path,base);
    const utility=normalizeUtility(req.file.path,replay);
    for (const round of arr(replay?.rounds)) round.events=[...arr(round.events),...utility.filter((e)=>e.round===round.round)].sort((a,b)=>num(a.t)-num(b.t));
    if (replay) replay.utility=utility;
    const combat=normalizeCombat(req.file.path);
    const duels=buildDuels({...base,replay},combat);
    const aim=aggregateAim(base,combat,duels);
    const criticalEpisodes=buildCriticalEpisodes(base,duels);
    res.json({...base,replay,utility,duels,aim,criticalEpisodes,parsePerformance:{version:'v9.2',elapsedMs:Date.now()-started,replayStatePasses:1},dataAvailability:{...(base.dataAvailability||{}),replay2D:Boolean(replay?.rounds?.length),utilityReplay:utility.length>0,duelTelemetry:duels.length>0,aimTelemetry:Object.keys(aim).length>0,criticalEpisodes:criticalEpisodes.length>0},advancedMetricsVersion:'v9.2-fast-parser'});
  } catch (e) {
    console.error(e);
    res.status(Number(e?.status)||422).json({error:e?.message||'Не удалось разобрать демку',details:e?.details,hint:e?.hint});
  } finally { await fs.unlink(req.file.path).catch(()=>{}); }
});

app.post('/api/ai',async(req,res)=>{try{const{response,data}=await proxyJson(`${internalBase}/api/ai`,{...req.body,match:compactForAI(req.body?.match||{})});res.status(response.status).json(data);}catch(e){res.status(502).json({error:`AI route недоступен: ${e?.message||e}`});}});
app.post('/api/episode-ai',async(req,res)=>{const ep=req.body?.episode||{},facts=[`R${ep.round}${Number.isFinite(Number(ep.t))?` · ${Number(ep.t).toFixed(1)}с`:''}`,ep.player?`${ep.player} погиб от ${ep.attacker||'соперника'}`:'',arr(ep.reasons).length?`Флаги: ${ep.reasons.join(', ')}`:''].filter(Boolean).join(' · '),duel=ep.duel||{},duelLine=duel.attacker?`${duel.weapon||'оружие'} · ${duel.shots??'—'} shots · ${duel.hits??'—'} hits · ${duel.ttkSec==null?'TTK —':`TTK ${duel.ttkSec}s`}`:'';res.json({episodeAnalysis:`${facts}\n\nПочему отмечен:\n${arr(ep.reasons).join(' · ')||'повышенный риск'}${duelLine?`\n\nДуэль:\n${duelLine}`:''}\n\nКак лучше было сыграть:\n${ep.recommendation||'Снизить риск, изолировать один угол и сохранить возможность размена.'}`,episodeOnly:true});});

app.use((e,_req,res,_next)=>{if(e instanceof multer.MulterError&&e.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:`Демка слишком большая. Лимит: ${maxDemoMb} MB.`});res.status(400).json({error:e?.message||'Ошибка запроса'});});
app.listen(publicPort,'127.0.0.1',()=>{console.log(`CS2 Demo AI Analyzer V9.2 Fast Parser: http://localhost:${publicPort}`);console.log(`V7.1 parser internal: ${internalBase}`);console.log(`V9.2: replay + player state in one parseTicks pass @ ~${replayHz} Hz`);});
