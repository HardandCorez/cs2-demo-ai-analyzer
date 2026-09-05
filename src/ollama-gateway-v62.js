import 'dotenv/config';
import express from 'express';

const host = '127.0.0.1';
const publicPort = Number(process.env.OLLAMA_GATEWAY_PORT || 11435);
const internalPort = publicPort + 1;
const timeoutMs = Math.max(60_000, Number(process.env.AI_TIMEOUT_MS || 600_000));

// Keep the stable deterministic V6.1 analyzer untouched on a private port.
// V6.2 post-processes only the coaching section: instead of telling the user
// to re-watch the demo, it returns a concrete safe-default playbook derived
// from already verified metrics / flags.
const previousPort = process.env.OLLAMA_GATEWAY_PORT;
process.env.OLLAMA_GATEWAY_PORT = String(internalPort);
await import('./ollama-gateway-v61.js');
if (previousPort === undefined) delete process.env.OLLAMA_GATEWAY_PORT;
else process.env.OLLAMA_GATEWAY_PORT = previousPort;

const internalBase = `http://${host}:${internalPort}`;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const asArray = (value) => (Array.isArray(value) ? value : []);
const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function metricsOf(match) {
  const p = match?.selectedPlayer || {};
  const v = match?.verifiedMetrics || {};
  const entryKills = asNumber(v.entryKills ?? p.entryKills);
  const openingDeaths = asNumber(v.openingDeaths ?? p.openingDeaths);
  const openingAttempts = asNumber(v.openingAttempts, entryKills + openingDeaths);
  const openingSuccessPct = v.openingSuccessPct ?? p.openingSuccessPct
    ?? (openingAttempts > 0 ? Math.round((entryKills / openingAttempts) * 100) : null);

  return {
    kills: asNumber(v.kills ?? p.kills),
    deaths: asNumber(v.deaths ?? p.deaths),
    kd: Number(v.kd ?? p.kd ?? 0),
    adr: Number(v.adr ?? p.adr ?? 0),
    entryKills,
    openingDeaths,
    openingAttempts,
    openingSuccessPct,
    tradedDeathPct: v.tradedDeathPct ?? p.tradedDeathPct ?? null,
    avgNearestTeammateDistanceAtDeath: v.avgNearestTeammateDistanceAtDeath ?? p.avgNearestTeammateDistanceAtDeath ?? null,
    topDeathPlace: String(v.topDeathPlace ?? p.topDeathPlace ?? ''),
    topDeathPlaceDeaths: asNumber(v.topDeathPlaceDeaths ?? p.topDeathPlaceDeaths),
    positionSamples: asNumber(v.positionSamples ?? p.positionSamples),
    widePeekLikeDeaths: asNumber(p.widePeekLikeDeaths),
    widePeekSamples: asNumber(p.widePeekSamples),
    widePeekLikeDeathPct: p.widePeekLikeDeathPct ?? null,
    wideRounds: asArray(p.widePeekLikeDeathRounds).map(Number).filter(Number.isFinite),
    repeekLikeDeaths: asNumber(p.repeekLikeDeaths),
    repeekEligibleSamples: asNumber(p.repeekEligibleSamples),
    repeekLikePct: p.repeekLikePct ?? null,
    repeekRounds: asArray(p.repeekLikeDeathRounds).map(Number).filter(Number.isFinite),
    flashedDeaths: asNumber(v.flashedDeaths ?? p.flashedDeaths),
    flashedDeathPct: v.flashedDeathPct ?? p.flashedDeathPct ?? null,
    attackerOutsideFrontPct: v.attackerOutsideFrontPct ?? p.attackerOutsideFrontPct ?? null,
  };
}

function roundsText(rounds) {
  const unique = [...new Set(asArray(rounds).map(Number).filter(Number.isFinite))];
  return unique.length ? unique.join(', ') : 'отмеченных эпизодах';
}

function addUnique(list, id, text) {
  if (!list.some((item) => item.id === id)) list.push({ id, text });
}

function buildPrescriptivePlaybook(match) {
  const m = metricsOf(match);
  const actions = [];

  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null && m.openingSuccessPct < 45) {
    addUnique(actions, 'opening_protocol',
      `Opening ${m.entryKills}/${m.openingAttempts} (${m.openingSuccessPct}%): не форсируй первый контакт как полный swing. Правильный шаблон — короткий info/jiggle → возврат за укрытие → повторный выход только с преимуществом (флешка, контакт тиммейта или подтверждённый тайминг). Если принимаешь дуэль — сначала останови боковое движение counter-strafe, затем стреляй.`);
  }

  if (m.widePeekLikeDeaths >= 2) {
    addUnique(actions, 'wide_protocol',
      `В раундах ${roundsText(m.wideRounds)} вместо непрерывного wide-swing открывай угол поэтапно: один сектор → полная остановка → первый точный выстрел → только затем следующий сектор. Если нужна только информация, используй shoulder/jiggle, а не полный широкий выход.`);
  }

  if (m.repeekLikeDeaths >= 2) {
    addUnique(actions, 'post_kill_protocol',
      `После собственного фрага в раундах ${roundsText(m.repeekRounds)} базовое решение — разорвать повторный контакт: шаг назад за ближайшее укрытие, смена угла и короткая пауза. Повторно выходи только когда появилось новое преимущество — utility, контакт тиммейта или подтверждённая информация; не отдавай сопернику заранее ожидаемый второй пик.`);
  }

  if (m.topDeathPlace && m.topDeathPlaceDeaths >= 3) {
    addUnique(actions, 'zone_protocol',
      `В зоне «${m.topDeathPlace}», где зафиксировано ${m.topDeathPlaceDeaths} смертей, не открывай несколько линий одновременно. Играй от ближайшего укрытия, изолируй один угол за раз и после контакта меняй точку повторного выхода, а не возвращайся на ту же линию.`);
  }

  if (m.tradedDeathPct !== null && Number(m.tradedDeathPct) < 35) {
    addUnique(actions, 'trade_protocol',
      `Перед агрессивным контактом убедись, что тиммейт реально может дать refrag. Если trade-path отсутствует, не делай первый полный выход: дождись сближения, синхронизируй пик или сначала возьми информацию безопасным движением.`);
  }

  if (m.flashedDeathPct !== null && Number(m.flashedDeathPct) >= 20) {
    addUnique(actions, 'antiflash_protocol',
      `При ожидаемой флешке заранее выбери антифлеш-позицию: держись рядом с укрытием, отворачивайся до детонации и не продолжай выход вслепую. После ослепления сначала восстанови обзор, затем принимай дуэль.`);
  }

  if (m.attackerOutsideFrontPct !== null && Number(m.attackerOutsideFrontPct) >= 40) {
    addUnique(actions, 'angle_isolation',
      `Сократи число одновременно открытых направлений: при каждом перемещении оставляй укрытие с одной стороны модели и чисти углы последовательно. Не выходи в пространство, где два разных сектора могут стрелять по тебе одновременно.`);
  }

  // Safe-default prescriptions fill the block to five concrete actions without
  // inventing a specific wall/angle that the parser cannot prove.
  addUnique(actions, 'first_bullet_discipline',
    'На агрессивном пике разделяй движение и стрельбу: выход → counter-strafe/полная остановка → первый точный выстрел. Не начинай очередь в момент максимальной боковой скорости.');

  addUnique(actions, 'after_kill_reset',
    'После первого фрага сначала конвертируй преимущество: убери модель из прежней линии огня, перезайми другой угол и заставь соперника самому искать следующий контакт. Второй пик должен иметь новую причину, а не быть автоматическим продолжением первого.');

  const mateContext = Number.isFinite(Number(m.avgNearestTeammateDistanceAtDeath))
    ? ` Текущая средняя дистанция до ближайшего живого тиммейта при смерти — ${Math.round(Number(m.avgNearestTeammateDistanceAtDeath))}u; сама по себе она не доказывает хороший или плохой trade-path.`
    : '';
  addUnique(actions, 'tradeable_position',
    `Перед входом в рискованный контакт задай простой критерий: если ты умрёшь здесь, сможет ли ближайший тиммейт сразу увидеть того же соперника? Если нет — сократи риск, дождись синхронизации или возьми информацию без полного выхода.${mateContext}`);

  return actions.slice(0, 5);
}

function rewriteAnalysis(analysis, match) {
  const source = String(analysis || '').trim();
  if (!source) return source;
  const actions = buildPrescriptivePlaybook(match);
  const actionBlock = actions.map((item, index) => `${index + 1}. ${item.text}`).join('\n');

  const actionMarker = '\nДействия на тренировку:';
  const conclusionMarker = '\n\nВывод:';
  const actionIndex = source.indexOf(actionMarker);
  const conclusionIndex = source.indexOf(conclusionMarker);
  const prefix = actionIndex >= 0 ? source.slice(0, actionIndex) : source;

  const m = metricsOf(match);
  const priorities = [];
  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null && m.openingSuccessPct < 45) priorities.push(`opening ${m.entryKills}/${m.openingAttempts} (${m.openingSuccessPct}%)`);
  if (m.widePeekLikeDeaths >= 2) priorities.push(`wide-peek-like ${m.widePeekLikeDeaths}/${m.widePeekSamples}`);
  if (m.repeekLikeDeaths >= 2) priorities.push(`post-kill repeek-like ${m.repeekLikeDeaths}/${m.repeekEligibleSamples}`);
  const priorityText = priorities.length ? priorities.slice(0, 3).join(', ') : 'сохранение сильных показателей при более контролируемом риске';

  const conclusion = `Приоритет на похожие ситуации: ${priorityText}. Блок «Как лучше было сыграть» даёт конкретный безопасный default-план по измеренным паттернам; WIDE/REPEEK всё ещё являются эвристиками и не доказывают конкретный угол или стену.`;

  // Do not keep the old "go watch the demo" action/conclusion language.
  return `${prefix}\n\nКак лучше было сыграть:\n${actionBlock}\n\nВывод:\n${conclusion}`;
}

async function forward(path, req) {
  const headers = { 'Content-Type': 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  return fetch(`${internalBase}${path}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {}),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });
}

app.get('/health', async (req, res) => {
  try {
    const response = await forward('/health', req);
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json({
      ...data,
      evidenceMode: 'prescriptive-coach-v6.2',
      coachingMode: 'correct-play-playbook',
      internalGateway: internalBase,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      evidenceMode: 'prescriptive-coach-v6.2',
      error: `V6.1 analyzer недоступен: ${error?.message || error}`,
    });
  }
});

app.post('/v1/analyze', async (req, res) => {
  try {
    const response = await forward('/v1/analyze', req);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json(data);
    const analysis = rewriteAnalysis(data?.analysis, req.body?.match || {});
    res.json({
      ...data,
      analysis,
      provider: 'ollama-local-prescriptive-coach',
      evidenceMode: 'prescriptive-coach-v6.2',
      coachingMode: 'correct-play-playbook',
    });
  } catch (error) {
    res.status(502).json({
      error: `Prescriptive gateway error: ${error?.message || error}`,
      hint: 'Проверь Ollama и перезапусти npm run start:ollama-gateway.',
    });
  }
});

app.listen(publicPort, host, () => {
  console.log(`Local Ollama prescriptive gateway: http://${host}:${publicPort}`);
  console.log(`Base V6.1 gateway internal: ${internalBase}`);
  console.log('Evidence mode: prescriptive-coach-v6.2');
  console.log('Coaching mode: correct-play-playbook');
});
