// Professional analyst: deterministic evidence layer, not an LLM verdict.
// Do not infer visibility, sound, subtick accuracy or counterfactual win rates.
const finite = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const arr = (x) => Array.isArray(x) ? x : [];
const dist = (a,b) => a && b && [a.x,a.y,b.x,b.y].every(finite) ? Math.hypot(Number(a.x)-Number(b.x),Number(a.y)-Number(b.y)) : null;
const round = (v,d=0) => finite(v) ? Math.round(Number(v)*10**d)/10**d : null;
function closest(frames, t) { return frames.reduce((a,b)=>Math.abs(Number(b.t)-t)<Math.abs(Number(a.t)-t)?b:a,frames[0]); }
function player(frame,name,steamid) {
  return arr(frame?.players).find(p => steamid && String(p.steamid)===String(steamid))
    || arr(frame?.players).find(p => p.name===name) || null;
}
function angleDiff(yaw,a,b) {
  if (!finite(yaw) || !a || !b || dist(a,b)===null) return null;
  const bearing=Math.atan2(Number(b.y)-Number(a.y),Number(b.x)-Number(a.x))*180/Math.PI;
  return Math.abs(((bearing-Number(yaw)+540)%360)-180);
}
export function analyzeProfessionalEpisode(episode,replay) {
  const frames=arr(replay?.frames).filter(f=>finite(f?.t)).sort((a,b)=>Number(a.t)-Number(b.t));
  if (!episode?.player || frames.length<2) throw new Error('Нужны эпизод и минимум два кадра replay');
  const ref=closest(frames,-0.05), early=closest(frames,-1.5), mid=closest(frames,-0.5);
  const get=(f)=>player(f,episode.player,episode.playerSteamid);
  const victim=get(ref), before=get(early), midPlayer=get(mid);
  const enemy=player(ref,episode.attacker,episode.attackerSteamid);
  const team=arr(ref.players).filter(p=>victim && p.name!==victim.name && p.alive!==false && finite(p.teamNumber) && Number(p.teamNumber)===Number(victim.teamNumber));
  const teammateDistances=team.map(p=>dist(victim,p)).filter(finite);
  const nearest=teammateDistances.length?Math.min(...teammateDistances):null;
  const moved=dist(before,victim), movedHalf=dist(midPlayer,victim);
  const duration=before?Math.abs(Number(ref.t)-Number(early.t)):null;
  const speed=finite(moved)&&duration>0?moved/duration:null;
  const facing=angleDiff(victim?.yaw,victim,enemy);
  const distance=dist(victim,enemy);
  const evidence=[];
  const add=(id,label,value,unit,t,source='telemetry')=>{
    if(!finite(value))return;
    evidence.push({id,label,value:round(value,1),unit,t:round(t,2),source,confidence:'measured'});
  };
  add('hp','HP перед событием',victim?.hp,'HP',ref.t);
  add('duel_distance','2D-дистанция до противника',distance,'u',ref.t);
  add('movement','Перемещение за окно ~1.5с',moved,'u',ref.t);
  add('average_speed','Средняя скорость по прямой',speed,'u/s',ref.t);
  add('teammate_distance','Ближайший живой союзник (2D)',nearest,'u',ref.t);
  add('facing','Угол между yaw и направлением на противника (2D)',facing,'°',ref.t);
  const findings=[];
  const mark=(id,kind,level,headline,observation,interpretation,action,reason)=>{
    findings.push({id,kind,level,headline,observation,interpretation,action,
      confidence:'hypothesis',evidenceIds:reason,anchor:{round:episode.round,tick:episode.tick,t:0}});
  };
  const reasons=arr(episode.reasons);
  if(reasons.includes('REPEEK*'))mark('repeek','decision','review','Возможный повторный выход',
    'Исходный анализ пометил эпизод как REPEEK*.',
    'Повторный выход может быть читаемым, но без информации о предыдущем контакте и видимости это не доказанная ошибка.',
    'Проверь контакт до выхода: можно ли сбросить тайминг, поменять угол или сыграть от флешки?',[]);
  if(reasons.includes('WIDE*'))mark('wide','movement','review','Возможный широкий пик',
    'Исходный анализ пометил эпизод как WIDE*.',
    'Ширина пика сама по себе не означает ошибку: учитывай дистанцию, прицел, информацию и наличие размена.',
    'Сравни широкий выход с коротким открытием одного угла; выбери вариант по позиции противника.',[]);
  if(reasons.includes('FLASH'))mark('flash','information','review','Контакт на фоне ослепления',
    'Первичный анализ отмечает эффект флешки в момент смерти.',
    'Нужно проверить точное время и степень ослепления перед выводом о неверном действии.',
    'Сверь момент ослепления с решением об открытии угла и возможностью переждать за укрытием.',[]);
  if(nearest!==null && nearest>900)mark('trade','teamplay','review','Дистанция до размена',
    'Ближайший живой тиммейт находился на расстоянии '+round(nearest)+'u по прямой.',
    'Расстояние не подтверждает невозможность размена: стены, этаж и LOS здесь не учитываются.',
    'Проверь маршрут тиммейта и реальную линию огня до того, как делать вывод об изоляции.',
    ['teammate_distance']);
  if(facing!==null && facing>60)mark('facing','mechanics','review','Угол прицела требует проверки',
    'Разница между yaw и направлением на известную из демки позицию врага: '+round(facing)+'°.',
    'Это расчёт по горизонтали с полной информацией из демки, а не доказательство ошибки crosshair placement.',
    'Посмотри POV непосредственно до контакта и сравни положение прицела только с реально ожидаемым углом.',
    ['facing']);
  const evidenceLimits=[
    'Данные replay дискретные: частота выборки '+(finite(replay.sampleHz)?replay.sampleHz:'неизвестна')+' Гц; не измеряется точный момент контрстрейфа/первой пули.',
    'Нет доказанного line-of-sight, навигационной геометрии, звуков и информации игрока; позиции врагов в демке могут быть скрыты от игрока.',
    'Без событий выстрелов, попаданий и input/subtick нельзя оценить точность первой пули, реакцию или механику остановки.',
    'Любые альтернативные траектории будут обучающей симуляцией, а не записью реально возможного исхода.'
  ];
  return {
    version:'professional-analyst-v1',mode:'professional',episode:{id:episode.id,round:episode.round,tick:episode.tick,player:episode.player,attacker:episode.attacker},
    verdict:{status:'insufficient-evidence',label:'Ошибка не доказана',summary:findings.length
      ? 'Есть '+findings.length+' сигнал(ов) для проверки, но недостаточно данных для подтверждённого тактического вывода.'
      : 'Смерть сама по себе не является ошибкой; подтверждённых сигналов недостаточно.'},
    evidence,findings,limits:evidenceLimits,
    comparison:{actual:{label:'Фактическая траектория',source:'demo',frames:frames.map(f=>({tick:f.tick,t:f.t,player:get(f)?{x:get(f).x,y:get(f).y,z:get(f).z,yaw:get(f).yaw}:null})).filter(f=>f.player)},
      alternative:{label:'Рекомендация аналитика',source:'hypothesis',frames:[],simulationReady:false}},
    training:{objective:findings.length?'Проверить отмеченные гипотезы в POV, затем отработать только подтверждённую проблему':'Найти решение до контакта и оценить качество без привязки к результату',
      exercise:'Просмотри момент за 2с до смерти; запиши доступную информацию, варианты действий и критерий выбора. Сравни 3 повторения аналогичного эпизода.',
      successMetric:'3 эпизода с аргументированным решением; не считать любую смерть ошибкой'},
    missingData:['LOS/геометрия','POV visibility','audio/information','shot and damage events','tick/subtick movement']};
}
