import 'dotenv/config';
import express from 'express';

const app = express();
const host = '127.0.0.1';
const port = Number(process.env.OLLAMA_GATEWAY_PORT || 11435);
const ollamaUrl = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
const model = String(process.env.OLLAMA_MODEL || 'qwen3:4b').trim();
const gatewayToken = String(process.env.AI_GATEWAY_TOKEN || '').trim();
const timeoutMs = Math.max(60_000, Number(process.env.AI_TIMEOUT_MS || 600_000));

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const asArray = (value) => (Array.isArray(value) ? value : []);
const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const fixed = (value, digits = 2) => Number(asNumber(value).toFixed(digits));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function authorize(req, res, next) {
  if (!gatewayToken) return next();
  if (String(req.headers.authorization || '') !== `Bearer ${gatewayToken}`) {
    return res.status(401).json({ error: 'Неверный локальный AI gateway token' });
  }
  next();
}

function validateMatch(match) {
  if (!match || typeof match !== 'object') return 'Нет данных матча';
  if (!match.selectedPlayer || typeof match.selectedPlayer !== 'object') return 'Не выбран игрок';
  if (!Array.isArray(match.scoreboard) || match.scoreboard.length === 0) return 'Нет scoreboard';
  if (match.scoreboard.length > 20) return 'Слишком много игроков в payload';
  return null;
}

function deriveMetrics(match) {
  const p = match?.selectedPlayer || {};
  const v = match?.verifiedMetrics || {};
  const rounds = Math.max(0, asNumber(match?.rounds));
  const kills = asNumber(v.kills ?? p.kills);
  const deaths = asNumber(v.deaths ?? p.deaths);
  const entryKills = asNumber(v.entryKills ?? p.entryKills);
  const openingDeaths = asNumber(v.openingDeaths ?? p.openingDeaths);
  const openingAttempts = asNumber(v.openingAttempts, entryKills + openingDeaths);

  return {
    kills,
    deaths,
    assists: asNumber(v.assists ?? p.assists),
    kd: fixed(v.kd ?? (deaths > 0 ? kills / deaths : kills), 2),
    adr: fixed(v.adr ?? p.adr, 1),
    headshots: asNumber(v.headshots ?? p.headshots),
    hsPct: asNumber(v.hsPct ?? p.hsPct),
    entryKills,
    openingDeaths,
    openingAttempts,
    openingSuccessPct: v.openingSuccessPct ?? p.openingSuccessPct ?? (openingAttempts > 0 ? Math.round((entryKills / openingAttempts) * 100) : null),
    killsPerRound: v.killsPerRound ?? p.killsPerRound ?? (rounds > 0 ? fixed(kills / rounds, 2) : 0),

    tradeKills: asNumber(v.tradeKills ?? p.tradeKills),
    tradedDeaths: asNumber(v.tradedDeaths ?? p.tradedDeaths),
    tradedDeathPct: v.tradedDeathPct ?? p.tradedDeathPct ?? null,
    kastPct: v.kastPct ?? p.kastPct ?? null,
    multiKillRounds: asNumber(v.multiKillRounds ?? p.multiKillRounds),
    twoK: asNumber(v.twoK ?? p.twoK),
    threeK: asNumber(v.threeK ?? p.threeK),
    fourK: asNumber(v.fourK ?? p.fourK),
    fiveK: asNumber(v.fiveK ?? p.fiveK),
    clutchAttempts: asNumber(v.clutchAttempts ?? p.clutchAttempts),
    clutchWins: asNumber(v.clutchWins ?? p.clutchWins),
    clutchWinPct: v.clutchWinPct ?? p.clutchWinPct ?? null,
    avgOpeningDuelTimeSec: v.avgOpeningDuelTimeSec ?? p.avgOpeningDuelTimeSec ?? null,

    positionSamples: asNumber(v.positionSamples ?? p.positionSamples),
    spacingSamples: asNumber(v.spacingSamples ?? p.spacingSamples),
    avgNearestTeammateDistanceAtDeath: v.avgNearestTeammateDistanceAtDeath ?? p.avgNearestTeammateDistanceAtDeath ?? null,
    isolatedDeathsHeuristic: asNumber(v.isolatedDeathsHeuristic ?? p.isolatedDeathsHeuristic),
    isolatedDeathPct: v.isolatedDeathPct ?? p.isolatedDeathPct ?? null,
    movementDeathSamples: asNumber(v.movementDeathSamples ?? p.movementDeathSamples),
    avgVelocityAtDeath: v.avgVelocityAtDeath ?? p.avgVelocityAtDeath ?? null,
    highSpeedDeaths: asNumber(v.highSpeedDeaths ?? p.highSpeedDeaths),
    highSpeedDeathPct: v.highSpeedDeathPct ?? p.highSpeedDeathPct ?? null,
    flashedDeathSamples: asNumber(v.flashedDeathSamples ?? p.flashedDeathSamples),
    flashedDeaths: asNumber(v.flashedDeaths ?? p.flashedDeaths),
    flashedDeathPct: v.flashedDeathPct ?? p.flashedDeathPct ?? null,
    facingDeathSamples: asNumber(v.facingDeathSamples ?? p.facingDeathSamples),
    attackerOutsideFrontDeaths: asNumber(v.attackerOutsideFrontDeaths ?? p.attackerOutsideFrontDeaths),
    attackerOutsideFrontPct: v.attackerOutsideFrontPct ?? p.attackerOutsideFrontPct ?? null,
    avgDuelDistanceAtDeath: v.avgDuelDistanceAtDeath ?? p.avgDuelDistanceAtDeath ?? null,
    topDeathPlace: String(v.topDeathPlace ?? p.topDeathPlace ?? ''),
    topDeathPlaceDeaths: asNumber(v.topDeathPlaceDeaths ?? p.topDeathPlaceDeaths),
    topDeathPlacePct: v.topDeathPlacePct ?? p.topDeathPlacePct ?? null,

    widePeekSamples: asNumber(p.widePeekSamples),
    widePeekLikeDeaths: asNumber(p.widePeekLikeDeaths),
    widePeekLikeDeathPct: p.widePeekLikeDeathPct ?? null,
    avgWidePeekLateralRatio: p.avgWidePeekLateralRatio ?? null,
    widePeekLikeDeathRounds: asArray(p.widePeekLikeDeathRounds).map(Number).filter(Number.isFinite),
    widePeekKillSamples: asNumber(p.widePeekKillSamples),
    widePeekLikeKills: asNumber(p.widePeekLikeKills),
    widePeekLikeKillPct: p.widePeekLikeKillPct ?? null,
    repeekEligibleSamples: asNumber(p.repeekEligibleSamples),
    repeekLikeDeaths: asNumber(p.repeekLikeDeaths),
    repeekLikePct: p.repeekLikePct ?? null,
    avgRepeekDelaySec: p.avgRepeekDelaySec ?? null,
    repeekLikeDeathRounds: asArray(p.repeekLikeDeathRounds).map(Number).filter(Number.isFinite),
  };
}

function availability(match, metrics) {
  const a = match?.dataAvailability || {};
  return {
    ...a,
    widePeekHeuristic: metrics.widePeekSamples > 0,
    repeekHeuristic: metrics.repeekEligibleSamples > 0,
    confirmedWidePeek: false,
    confirmedRepeek: false,
  };
}

function deterministicScore(m, a) {
  let score = 50;
  if (m.kd >= 1) score += clamp((m.kd - 1) * 30, 0, 18);
  else score -= clamp((1 - m.kd) * 35, 0, 20);
  score += clamp((m.adr - 70) * 0.35, -15, 15);
  score += clamp((m.killsPerRound - 0.65) * 25, -10, 10);
  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null) {
    score += clamp((m.openingSuccessPct - 50) * 0.2, -10, 10);
  }
  if (a.kast && m.kastPct !== null) score += clamp((m.kastPct - 70) * 0.3, -6, 6);
  return Math.round(clamp(score, 0, 100));
}

function fact(id, text, evidence, note = '') {
  return { id, text, evidence, note };
}

function buildFacts(m, a) {
  const strengths = [];
  const problems = [];

  if (m.kd >= 1.2) strengths.push(fact('strong_kd', 'Сильный K/D', `${m.kills}/${m.deaths} = ${m.kd}`));
  else if (m.kd < 0.9) problems.push(fact('weak_kd', 'Низкий K/D', `${m.kills}/${m.deaths} = ${m.kd}`));

  if (m.adr >= 85) strengths.push(fact('strong_adr', 'Высокий урон за раунд', `ADR ${m.adr}`));
  else if (m.adr < 65) problems.push(fact('weak_adr', 'Низкий урон за раунд', `ADR ${m.adr}`));

  if (m.killsPerRound >= 0.8) strengths.push(fact('strong_kpr', 'Высокая результативность по убийствам', `KPR ${m.killsPerRound}`));
  else if (m.killsPerRound < 0.55) problems.push(fact('weak_kpr', 'Низкая результативность по убийствам', `KPR ${m.killsPerRound}`));

  if (m.openingAttempts >= 5 && m.openingSuccessPct !== null) {
    const sample = m.openingAttempts < 10 ? '; выборка небольшая' : '';
    if (m.openingSuccessPct >= 55) strengths.push(fact('strong_opening', 'Положительный результат opening-дуэлей', `${m.entryKills}/${m.openingAttempts} = ${m.openingSuccessPct}%${sample}`));
    else if (m.openingSuccessPct < 45) problems.push(fact('weak_opening', 'Слабый результат opening-дуэлей', `${m.entryKills}/${m.openingAttempts} = ${m.openingSuccessPct}%${sample}`));
  }

  if (a.kast && m.kastPct !== null) {
    if (m.kastPct >= 75) strengths.push(fact('strong_kast', 'Высокая вовлечённость по KAST', `KAST ${m.kastPct}%`));
    else if (m.kastPct < 65) problems.push(fact('weak_kast', 'Низкая вовлечённость по KAST', `KAST ${m.kastPct}%`));
  }

  if (a.tradeDetection && m.tradeKills >= 3) strengths.push(fact('trade_impact', 'Заметный refrag-вклад', `trade kills ${m.tradeKills}`));
  if (a.tradeDetection && m.deaths >= 8 && m.tradedDeathPct !== null && m.tradedDeathPct < 30) {
    problems.push(fact('low_traded_deaths', 'Низкая доля разменянных смертей', `${m.tradedDeaths}/${m.deaths} = ${m.tradedDeathPct}% в окне 5с`));
  }

  if (a.multikills && m.multiKillRounds >= 3) {
    strengths.push(fact('multikill_impact', 'Регулярные multikill-раунды', `${m.multiKillRounds} раундов 2K+; 2K ${m.twoK}, 3K ${m.threeK}, 4K ${m.fourK}, 5K ${m.fiveK}`));
  }

  if (a.clutchDetection && m.clutchWins > 0) strengths.push(fact('clutch_wins', 'Есть выигранные клатчи', `${m.clutchWins}/${m.clutchAttempts}`));
  else if (a.clutchDetection && m.clutchAttempts >= 3 && m.clutchWins === 0) problems.push(fact('clutch_misses', 'Клатч-попытки без побед', `0/${m.clutchAttempts}`));

  if (m.hsPct >= 60 && m.kills >= 10) {
    strengths.push(fact('high_hs', 'Высокая доля убийств в голову', `HS ${m.hsPct}% (${m.headshots}/${m.kills})`, 'Это характеристика стрельбы, а не доказательство хороших решений.'));
  }

  if (a.teammateSpacing && m.spacingSamples >= 6 && m.isolatedDeathPct !== null && m.isolatedDeathPct >= 45) {
    problems.push(fact('isolated_deaths', 'Много смертей далеко от ближайшего тиммейта', `${m.isolatedDeathsHeuristic}/${m.spacingSamples} = ${m.isolatedDeathPct}% по spacing-эвристике`, 'Стены и этажи не учитываются.'));
  }
  if (a.flashedAtDeath && m.flashedDeathSamples >= 6 && m.flashedDeathPct !== null && m.flashedDeathPct >= 25) {
    problems.push(fact('flashed_deaths', 'Заметная доля смертей под активным ослеплением', `${m.flashedDeaths}/${m.flashedDeathSamples} = ${m.flashedDeathPct}%`));
  }
  if (a.facingAtDeath && m.facingDeathSamples >= 6 && m.attackerOutsideFrontPct !== null && m.attackerOutsideFrontPct >= 45) {
    problems.push(fact('outside_front', 'Атакующий часто был вне фронтального сектора', `${m.attackerOutsideFrontDeaths}/${m.facingDeathSamples} = ${m.attackerOutsideFrontPct}%`, 'Геометрическая yaw-эвристика без line-of-sight.'));
  }
  if (a.placeNames && m.positionSamples >= 6 && m.topDeathPlace && m.topDeathPlaceDeaths >= 3 && m.topDeathPlacePct >= 30) {
    problems.push(fact('repeat_death_place', 'Смерти концентрируются в одной named-zone', `${m.topDeathPlace}: ${m.topDeathPlaceDeaths}/${m.positionSamples} = ${m.topDeathPlacePct}%`));
  }

  if (a.widePeekHeuristic && m.widePeekSamples >= 5 && m.widePeekLikeDeaths >= 2 && m.widePeekLikeDeathPct >= 35) {
    const rounds = m.widePeekLikeDeathRounds.length ? `; раунды ${m.widePeekLikeDeathRounds.join(', ')}` : '';
    problems.push(fact(
      'wide_peek_like_deaths',
      'Часть смертей похожа на wide-peek по движению',
      `${m.widePeekLikeDeaths}/${m.widePeekSamples} = ${m.widePeekLikeDeathPct}%${rounds}`,
      'Это wide-peek-like эвристика: высокая боковая скорость относительно линии на соперника, без проверки стен и line-of-sight.',
    ));
  }

  if (a.repeekHeuristic && m.repeekEligibleSamples >= 3 && m.repeekLikeDeaths >= 2 && m.repeekLikePct >= 40) {
    const rounds = m.repeekLikeDeathRounds.length ? `; раунды ${m.repeekLikeDeathRounds.join(', ')}` : '';
    problems.push(fact(
      'post_kill_repeek_like',
      'Есть смерти, похожие на повторный пик после собственного фрага',
      `${m.repeekLikeDeaths}/${m.repeekEligibleSamples} = ${m.repeekLikePct}% среди подходящих эпизодов${rounds}`,
      'Это post-kill repeek-like эвристика по времени и близости координат, не подтверждение одного и того же угла.',
    ));
  }

  return { strengths: strengths.slice(0, 9), problems: problems.slice(0, 12) };
}

function buildUnknowns(a) {
  const unknowns = [];
  if (!a.reactionTime) unknowns.push('время реакции');
  if (!a.lineOfSight) unknowns.push('точный line-of-sight через геометрию карты');
  if (!a.navMesh) unknowns.push('стены, этажи и navmesh');
  if (!a.economy) unknowns.push('экономические решения');
  if (!a.sideSplitMetrics) unknowns.push('полный T/CT-сплит');
  if (!a.flashbangsThrown) unknowns.push('количество именно брошенных флешек');
  unknowns.push('подтверждённый wide-peek и подтверждённый repeek: V6.1 даёт только эвристические флаги, которые нужно проверить в демке');
  return unknowns;
}

function actionLibrary(m, problems, a) {
  const actions = [];
  const ids = new Set(problems.map((p) => p.id));

  if (ids.has('weak_opening')) {
    actions.push({ id: 'review_openings', text: `Пересмотри все ${m.openingAttempts} opening-дуэлей и вручную классифицируй причину каждой смерти.` });
  }
  if (ids.has('weak_kd')) actions.push({ id: 'review_deaths', text: 'Раздели смерти на обязательные размены, лишние пики и проигранные чистые дуэли.' });
  if (ids.has('weak_adr')) actions.push({ id: 'damage_focus', text: 'Отметь раунды с низким damage и проверь, успевал ли ты дать полезный урон до смерти.' });
  if (ids.has('weak_kast')) actions.push({ id: 'kast_review', text: 'Разбери раунды без K/A/S/T и пометь, почему ты выпал из полезного действия.' });
  if (ids.has('low_traded_deaths')) actions.push({ id: 'trade_review', text: 'Пересмотри неразменянные смерти и проверь реальную возможность refrag для ближайшего тиммейта.' });
  if (ids.has('isolated_deaths')) actions.push({ id: 'spacing_review', text: 'Открой смерти, помеченные как isolated, и проверь стены/этажи и фактический trade path.' });
  if (ids.has('flashed_deaths')) actions.push({ id: 'antiflash_review', text: `Разбери ${m.flashedDeaths} смертей под flash: можно ли было отвернуться, переждать или играть от тиммейта.` });
  if (ids.has('outside_front')) actions.push({ id: 'angle_review', text: 'Проверь эпизоды outside-front и отдели нормальные crossfire/спину от реально потерянного угла.' });
  if (ids.has('repeat_death_place')) actions.push({ id: 'zone_review', text: `Собери смерти в зоне «${m.topDeathPlace}» и сравни, повторяется ли один и тот же сценарий.` });
  if (ids.has('wide_peek_like_deaths')) actions.push({ id: 'wide_peek_review', text: `Пересмотри wide-peek-like раунды ${m.widePeekLikeDeathRounds.join(', ') || 'из V6.1'}: оцени stop/counter-strafe, ширину выхода, флеш-поддержку и необходимость самого пика.` });
  if (ids.has('post_kill_repeek_like')) actions.push({ id: 'repeek_review', text: `Пересмотри post-kill repeek-like раунды ${m.repeekLikeDeathRounds.join(', ') || 'из V6.1'}: после первого фрага сравни удержание, отход и повторный выход на тот же сектор.` });

  if (a.tradeDetection) actions.push({ id: 'track_trades', text: `Продолжай отслеживать trade kills (${m.tradeKills}) и traded deaths (${m.tradedDeaths}) по серии матчей.` });
  actions.push({ id: 'track_core', text: 'После каждого матча фиксируй K/D, ADR, KPR, opening %, KAST, trades и V6.1 peek-флаги одним и тем же набором.' });
  return actions.slice(0, 12);
}

function pickOrderFallback(items, max) {
  return items.slice(0, max).map((item) => item.id);
}

function selectionSchema(strengthIds, problemIds, actionIds) {
  return {
    type: 'object',
    properties: {
      strengthIds: { type: 'array', maxItems: 3, items: { type: 'string', enum: strengthIds.length ? strengthIds : ['none'] } },
      problemIds: { type: 'array', maxItems: 3, items: { type: 'string', enum: problemIds.length ? problemIds : ['none'] } },
      actionIds: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: actionIds.length ? actionIds : ['none'] } },
    },
    required: ['strengthIds', 'problemIds', 'actionIds'],
  };
}

async function ollamaRequest(path, options = {}) {
  return fetch(`${ollamaUrl}${path}`, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function choosePriorities(strengths, problems, actions, metrics) {
  const fallback = {
    strengthIds: pickOrderFallback(strengths, 3),
    problemIds: pickOrderFallback(problems, 3),
    actionIds: pickOrderFallback(actions, 5),
  };
  if (!strengths.length && !problems.length) return fallback;

  const schema = selectionSchema(
    strengths.map((x) => x.id),
    problems.map((x) => x.id),
    actions.map((x) => x.id),
  );

  try {
    const response = await ollamaRequest('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: schema,
        keep_alive: '15m',
        messages: [
          {
            role: 'system',
            content: '/no_think Выбери только ID из разрешённых списков. Не создавай факты. wide-peek-like и post-kill repeek-like — только эвристики, не доказанные игровые причины.',
          },
          { role: 'user', content: JSON.stringify({ metrics, strengths, problems, actions }) },
        ],
        options: { temperature: 0, num_ctx: 3072, num_predict: 220 },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return fallback;
    const parsed = JSON.parse(String(data?.message?.content || '{}'));
    const allowedStrengths = new Set(strengths.map((x) => x.id));
    const allowedProblems = new Set(problems.map((x) => x.id));
    const allowedActions = new Set(actions.map((x) => x.id));
    return {
      strengthIds: asArray(parsed.strengthIds).filter((id) => allowedStrengths.has(id)).slice(0, 3),
      problemIds: asArray(parsed.problemIds).filter((id) => allowedProblems.has(id)).slice(0, 3),
      actionIds: asArray(parsed.actionIds).filter((id) => allowedActions.has(id)).slice(0, 5),
    };
  } catch {
    return fallback;
  }
}

function orderedByIds(items, ids, fallbackMax) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chosen = asArray(ids).map((id) => byId.get(id)).filter(Boolean);
  return chosen.length ? chosen : items.slice(0, fallbackMax);
}

function formatReport({ score, m, a, strengths, problems, unknowns, actions }) {
  const lines = [];
  lines.push(`Оценка: ${score} / 100`);
  lines.push('Шкала: внутренний coaching score проекта, не HLTV Rating. Peek-эвристики V6.1 не меняют score автоматически.');

  lines.push('', 'Подтверждённые сильные стороны:');
  if (!strengths.length) lines.push('— По доступным метрикам выраженных сильных сторон не выделено.');
  strengths.forEach((item, i) => lines.push(`${i + 1}. ${item.text} (${item.evidence}).${item.note ? ` ${item.note}` : ''}`));

  lines.push('', 'Подтверждённые проблемы и V6.1 флаги:');
  if (!problems.length) lines.push('— Явные проблемы по доступным метрикам не подтверждены.');
  problems.forEach((item, i) => lines.push(`${i + 1}. ${item.text} (${item.evidence}).${item.note ? ` ${item.note}` : ''}`));

  lines.push('', 'Позиционный контекст V6.1:');
  if (!a.playerPositions || !m.positionSamples) {
    lines.push('— Координатные снимки в этой демке недоступны.');
  } else {
    lines.push(`• Смертей с координатами: ${m.positionSamples}.`);
    if (m.avgNearestTeammateDistanceAtDeath !== null) lines.push(`• Средняя дистанция до ближайшего живого тиммейта при смерти: ${m.avgNearestTeammateDistanceAtDeath}u.`);
    if (m.flashedDeathPct !== null) lines.push(`• Смерти под flash: ${m.flashedDeaths}/${m.flashedDeathSamples} (${m.flashedDeathPct}%).`);
    if (a.widePeekHeuristic) lines.push(`• Wide-peek-like: ${m.widePeekLikeDeaths}/${m.widePeekSamples} (${m.widePeekLikeDeathPct ?? 0}%). Порог использует скорость и долю бокового движения относительно линии на соперника.`);
    if (a.repeekHeuristic) lines.push(`• Post-kill repeek-like: ${m.repeekLikeDeaths}/${m.repeekEligibleSamples} (${m.repeekLikePct ?? 0}%) среди смертей после недавнего собственного фрага в том же раунде.`);
    if (m.topDeathPlace) lines.push(`• Самая частая named-zone смерти: ${m.topDeathPlace} — ${m.topDeathPlaceDeaths}/${m.positionSamples}.`);
    lines.push('• Ограничение: без геометрии карты, LOS и navmesh эти peek-флаги являются кандидатами на просмотр, а не доказательством ошибки.');
  }

  lines.push('', 'Что нельзя заключить автоматически:');
  unknowns.slice(0, 10).forEach((item) => lines.push(`• ${item}`));

  lines.push('', 'Действия на тренировку:');
  actions.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${item.text}`));

  const strongest = strengths[0]?.text?.toLowerCase();
  const mainProblem = problems[0]?.text?.toLowerCase();
  let conclusion = 'V6.1 добавляет heatmap, spacing и peek-флаги, но финальную причину эпизода нужно подтверждать просмотром демки.';
  if (strongest && mainProblem) conclusion = `Главный плюс — ${strongest}; главный кандидат на разбор — ${mainProblem}. Peek-флаги V6.1 используй как навигацию по раундам.`;
  else if (strongest) conclusion = `Главный подтверждённый плюс — ${strongest}. V6.1 помогает найти позиционные эпизоды для ручной проверки.`;
  else if (mainProblem) conclusion = `Главный кандидат на улучшение — ${mainProblem}. Подтверди V6.1-флаг просмотром конкретных раундов.`;
  lines.push('', 'Вывод:', conclusion);
  return lines.join('\n');
}

app.get('/health', async (_req, res) => {
  try {
    const response = await ollamaRequest('/api/tags');
    const data = await response.json().catch(() => ({}));
    const models = asArray(data?.models).map((item) => item?.name).filter(Boolean);
    res.status(response.ok ? 200 : 502).json({
      ok: response.ok,
      provider: 'ollama-local',
      ollamaUrl,
      model,
      timeoutMs,
      evidenceMode: 'peek-heuristics-v6.1',
      modelInstalled: models.some((name) => name === model || name.startsWith(`${model}:`)),
      models,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      provider: 'ollama-local',
      model,
      evidenceMode: 'peek-heuristics-v6.1',
      error: `Ollama недоступен: ${error?.message || error}`,
    });
  }
});

app.post('/v1/analyze', authorize, async (req, res) => {
  const match = req.body?.match;
  const validationError = validateMatch(match);
  if (validationError) return res.status(400).json({ error: validationError });

  const metrics = deriveMetrics(match);
  const a = availability(match, metrics);
  const score = deterministicScore(metrics, a);
  const { strengths, problems } = buildFacts(metrics, a);
  const unknowns = buildUnknowns(a);
  const actions = actionLibrary(metrics, problems, a);

  const priorities = await choosePriorities(strengths, problems, actions, metrics);
  const selectedStrengths = orderedByIds(strengths, priorities.strengthIds, 3);
  const selectedProblems = orderedByIds(problems, priorities.problemIds, 3);
  const selectedActions = orderedByIds(actions, priorities.actionIds, 5);

  const analysis = formatReport({
    score,
    m: metrics,
    a,
    strengths: selectedStrengths,
    problems: selectedProblems,
    unknowns,
    actions: selectedActions,
  });

  res.json({
    analysis,
    model,
    provider: 'ollama-local-priority-selector',
    evidenceMode: 'peek-heuristics-v6.1',
    verifiedMetrics: metrics,
    deterministicScore: score,
  });
});

app.listen(port, host, () => {
  console.log(`Local Ollama gateway: http://${host}:${port}`);
  console.log(`Ollama: ${ollamaUrl}`);
  console.log(`Model: ${model}`);
  console.log('Evidence mode: peek-heuristics-v6.1');
  console.log(`AI timeout: ${Math.round(timeoutMs / 1000)}s`);
});
