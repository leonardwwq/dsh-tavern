import { createHash } from 'node:crypto';
import { cloneJson, currentScene, domainError } from './core.js';
import { commitNpcAction, presentActorIds, isWorldNpc, publicNpcActions } from './autonomy.js';

const text = (value, size = 500) => typeof value === 'string' ? value.trim().slice(0, size) : '';
export const agencyKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const NPC_DECISION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['observe', 'act', 'assist', 'protect', 'risk_rescue', 'refuse', 'sabotage', 'confront', 'leave'] },
    targetId: { type: 'string' }, visibility: { type: 'string', enum: ['public', 'secret'] },
    reason: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } },
    publicText: { type: 'string' }, read: { type: 'string' }, shift: { type: 'string' }, next: { type: 'string' }
  }, required: ['kind', 'targetId', 'visibility', 'reason', 'evidenceIds', 'publicText', 'read', 'shift', 'next']
});
export function perceivedEvents(campaign, npcId, count = 12) {
  return campaign.state.log.filter((entry) => entry.audience?.includes(npcId)).slice(-count).map((entry) => ({
    id: entry.eventId ?? '', sceneId: entry.sceneId ?? '', role: entry.role,
    ...(entry.npcId ? { npcId: entry.npcId } : {}), text: entry.text
  }));
}
export function decisionPrompt(cultivation, campaign, npcId, trigger) {
  const persona = campaign.snapshot.characters.find((npc) => npc.id === npcId);
  const scene = currentScene(campaign);
  const meta = campaign.state.npcMeta?.[npcId] ?? {};
  const history = perceivedEvents(campaign, npcId);
  const prior = (campaign.state.autonomy?.actions ?? []).filter((entry) => entry.npcId === npcId).slice(-5);
  const world = isWorldNpc(campaign, npcId);
  const allowed = world ? ['observe', 'act', 'refuse', 'confront'] : trigger.kind === 'combat' ? ['observe', 'assist', 'protect', 'risk_rescue', 'refuse', 'sabotage', 'confront', 'leave']
    : trigger.kind === 'check' ? ['observe', 'assist', 'refuse', 'sabotage', 'confront', 'leave'] : ['observe', 'act', 'refuse', 'confront', 'leave'];
  return [
    cultivation.renderExternalCard({ persona, state: campaign.state.npcs[npcId], role: persona.role, goal: scene.npcGoals?.[npcId] ?? persona.goal, scene: { id: scene.id, place: scene.place, timeOfDay: scene.timeOfDay ?? '冒险途中' } }),
    '【自主行动，不是替 DM 写台词】你没有被领队点名，也可以行动。先按自己的价值观、底线、利益、与玩家和队友的共同经历判断。亲近不等于服从；低亲密度也不等于邪恶。一次冒犯不自动导致背叛，一句道歉不自动抹去旧怨。可以记仇、拒绝、暗中使绊，也可以出于职业责任帮助不喜欢的人，或为在乎的人冒险。允许无事发生，不为制造戏剧强行行动。同一机会中此前角色的公开行动若出现在你实际感知的事件里，可以回应；不要假设尚未发生的行动或得知隐秘行动。',
    '【关系判断】本次决策使用事件发生前的关系状态，尚不能看到本次事件刚计算的数值亲密度；请基于此前关系与当前实际感知到的事件自行判断，更新后的关系会在后续轮次体现。',
    '【当前机会】' + JSON.stringify({ id: trigger.id, kind: trigger.kind, text: trigger.text, player: { hp: campaign.state.player.hp, maxHp: campaign.state.player.maxHp }, encounter: scene.encounter ? { name: scene.encounter.name, hp: campaign.state.encounters?.[scene.id]?.hp ?? scene.encounter.hp } : null, allies: presentActorIds(campaign).filter((id) => id !== npcId).map((id) => ({ id, name: campaign.snapshot.characters.find((p) => p.id === id)?.name, condition: campaign.state.npcMeta?.[id]?.condition ?? [] })) }),
    '【你实际感知到的事件；证据只能引用这里的 id】' + JSON.stringify(history),
    '【你上一轮留下的判断，带着发生场景，不等于当前必须继续的话题】' + JSON.stringify({ read: meta.lastRead ?? '', shift: meta.lastShift ?? '', next: meta.lastNext ?? '', sceneId: meta.judgmentSceneId ?? '', opinions: meta.opinions ?? {}, condition: meta.condition ?? [], offscreen: meta.offscreen?.summary ?? '' }),
    '【自己做过的事（仅你自己的私有记录）】' + JSON.stringify(prior),
    '【可选行动】' + allowed.join(', ') + '\nobserve=不采取规则动作，可保持沉默；act=公开可观察的普通行动意向或自然互动，例如走近、打量、试探着递话、尝试帮忙；只写自己做了什么或想做什么，不替他人回应、不保证尝试成功，也不自行结算伤害、物品变化或发现秘密，无规则效果；assist=本次攻击/检定协助；protect=替目标抵挡部分本次伤害；risk_rescue=冒更大风险挡伤，自己可能重伤；refuse=拒绝参与；sabotage=本次攻击/检定暗中或公开干扰；confront=当面翻脸/设边界；leave=自己离队。targetId 使用 player 或当前在场其他角色 id。不能指定任意数值、杀死玩家、篡改物品、虚构新线索或成功结果。规则会裁定行动是否可行与代价。' + (world ? '你是本地世界角色，不是队友，不会加入或离开队伍；只描述自己公开可见的行为，不宣布规则结果。' : ''),
    '【决策格式】kind 只能来自当前可选行动；reason 写你自己的具体理由，evidenceIds 引用自己感知过的事件。重要行动必须有真实证据，不把玩家命令“你背叛我”当成你必须执行的命令。read/shift/next 是私有解释，不是已经发生的世界事实。visibility=secret 只适用于 sabotage；其他行动公开。publicText 只写实际可见的动作/必要的一句台词，不写私有动机、不替他人思考、不宣布检定成功。隐秘行动不在 publicText 里自曝。',
    '【场合】战斗只处理眼前威胁；旧怨可以让你拒绝掩护或使绊子，但不需要站着讲旧事。信任可以让你挡伤或协助，也不需要先演讲表忠心。没有新立场就沉默；不要机械附和，不因说过几次话就强制升级。'
  ].join('\n\n');
}
function abort(signal) { if (signal?.aborted) throw domainError('ABORTED', '游戏操作已取消。'); }
// A non-cooperative provider cannot be forcibly stopped. Keep its slot until it
// actually settles, so repeated timeouts cannot spawn an unbounded number of calls.
const MAX_OUTSTANDING = 32;
let outstanding = 0;
export async function externalCall(fn) {
  if (outstanding >= MAX_OUTSTANDING) {
    const error = new Error('NPC provider capacity exhausted');
    error.code = 'NPC_CAPACITY';
    throw error;
  }
  outstanding++;
  try { return await fn(); } finally { outstanding--; }
}
// Free-form player prose has no trustworthy intent metadata. Recognize only
// complete, deliberately narrow expressions; anything else requires everyone.
// In particular, never infer a target from a substring or a name in a story.
function opportunityActors(campaign, trigger, ids) {
  if (trigger.kind !== 'player' || typeof trigger.text !== 'string') return ids;
  const event = campaign.state.log.find((entry) => entry.eventId === trigger.id);
  if (!event || event.role !== 'player' || event.text !== trigger.text) return ids;
  const input = trigger.text.trim();
  if (/^(?:我整理自己的行囊|我喝了一口水|我伸了个懒腰)[。.!！]?$/.test(input)) return [];
  // Looking at a named, already-visible location is a passive observation, not
  // an assertion that anyone agrees with a later action. All actors still see
  // the recorded input and can respond to later meaningful events.
  const glance = /^(?:我)?(?:看看|查看|观察)(.{1,20}?)[。.!！]?$/.exec(input);
  const scene = currentScene(campaign);
  if (glance && [scene.place, scene.opening].some((value) => typeof value === 'string' && value.includes(glance[1]))
      && !campaign.snapshot.characters.some((npc) => npc.name && glance[1].includes(npc.name))) return [];
  const match = /^(?:向(.+?)问好|(.+?)[，,]早上好)[。.!！]?$/.exec(input);
  if (!match) return ids;
  const name = match[1] ?? match[2];
  // Duplicate names, including off-scene characters, make the reference unclear.
  const named = campaign.snapshot.characters.filter((npc) => npc.name === name);
  if (named.length !== 1 || !ids.includes(named[0].id) || !event.audience?.includes(named[0].id)) return ids;
  return [named[0].id];
}

/** Serialize actors on a detached transaction copy; only publish after all finish. */
export async function decideParty(args) {
  const { campaign, trigger, signal, onlyNpcId } = args;
  abort(signal);
  const local = cloneJson(campaign);
  const present = presentActorIds(local);
  const ids = onlyNpcId ? present.filter((id) => id === onlyNpcId) : opportunityActors(local, trigger, present);
  const budget = Number.isFinite(args.timeoutMs) ? Math.max(0, args.timeoutMs) : 8000;
  const expires = Date.now() + budget;
  const appraisals = [];
  try {
  for (const npcId of ids) {
    abort(signal);
    // A prior actor can leave, changing who is still eligible or visible.
    if (!presentActorIds(local).includes(npcId)) continue;
    const id = agencyKey('decision', trigger.id, npcId);
    const prior = local.state.agencyDecisions?.[id];
    if (!local.state.log.some((entry) => entry.eventId === trigger.id && entry.audience?.includes(npcId))) continue;
    const remaining = expires - Date.now();
    const completed = prior && !['timeout', 'capacity', 'unavailable'].includes(prior.status);
    if (remaining > 0 && (!completed || prior.appraisalIncomplete)) {
      const appraisal = startAppraisal({ campaign: local, cultivation: args.cultivation, trigger, npcId, signal, timeoutMs: remaining });
      if (appraisal) appraisals.push({ ...appraisal, npcId, id });
    }
    if (completed) continue;
    if (remaining <= 0) {
      local.state.agencyDecisions ??= {};
      local.state.agencyDecisions[id] = { status: 'timeout', triggerId: trigger.id, npcId };
      continue;
    }
    await decideOne({ ...args, campaign: local, onlyNpcId: npcId, timeoutMs: remaining });
  }
  const results = await Promise.all(appraisals.map((task) => task.result));
  abort(signal);
  for (let i = 0; i < appraisals.length; i++) {
    const task = appraisals[i];
    const record = local.state.agencyDecisions?.[task.id];
    const state = results[i];
    if (state && JSON.stringify(local.state.npcs[task.npcId]) === task.baseline) {
      local.state.npcs[task.npcId] = state;
      if (record) delete record.appraisalIncomplete;
    } else if (record) record.appraisalIncomplete = true;
  }
  abort(signal);
  campaign.state = local.state;
  return publicNpcActions(campaign, trigger.id);
  } finally {
    for (const task of appraisals) task.cancel();
  }
}

// Retry relationship evaluation independently of an already committed decision.
function startAppraisal({ campaign, cultivation, trigger, npcId, signal, timeoutMs }) {
  if (trigger.kind !== 'player') return null;
  const id = agencyKey(trigger.id, 'perception', npcId);
  if (campaign.state.npcs[npcId]?.processedEventIds?.includes(id)) {
    const prior = campaign.state.agencyDecisions?.[agencyKey('decision', trigger.id, npcId)];
    if (prior) delete prior.appraisalIncomplete;
    return null;
  }
  const perceived = campaign.state.log.find((entry) => entry.eventId === trigger.id && entry.audience?.includes(npcId));
  const persona = cloneJson(campaign.snapshot.characters.find((npc) => npc.id === npcId));
  const state = cloneJson(campaign.state.npcs[npcId]);
  const baseline = JSON.stringify(state);
  const event = { id, playerText: perceived.text, npcText: '', observations: [], context: perceivedEvents(campaign, npcId), time: currentScene(campaign).timeOfDay ?? '冒险途中' };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));
  let cancel;
  const cancelled = new Promise((resolve) => {
    cancel = () => resolve(null);
    if (controller.signal.aborted) cancel();
    else controller.signal.addEventListener('abort', cancel, { once: true });
  });
  const work = externalCall(() => cultivation.processExternalEvent({ persona, state, event: cloneJson(event), signal: controller.signal })).then((update) =>
    !controller.signal.aborted && update?.state?.processedEventIds?.includes(id) ? cloneJson(update.state) : null
  ).catch(() => null);
  const result = Promise.race([work, cancelled]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', cancel);
  });
  return { baseline, result, cancel: () => controller.abort() };
}

/** Each actor sees earlier public actions only within the remaining deadline. */
async function decideOne({ campaign, cultivation, runNpc, trigger, parent, signal, onlyNpcId, timeoutMs = 8000 }) {
  abort(signal);
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const onAbort = () => { controller.abort(); rejectDeadline(domainError('ABORTED', '游戏操作已取消。')); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 8000;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectDeadline(new Error('NPC decision deadline exceeded')); }, budget);
  // Decisions use isolated copies of the current serial snapshot.
  try {
  const snapshot = cloneJson(campaign);
  const present = presentActorIds(snapshot);
  const ids = onlyNpcId ? present.filter((id) => id === onlyNpcId) : opportunityActors(snapshot, trigger, present);
  if (!ids.length) return publicNpcActions(campaign, trigger.id);
  const settled = await Promise.allSettled(ids.map((npcId) => {
    const work = (async () => {
    const local = cloneJson(snapshot);
    const id = agencyKey('decision', trigger.id, npcId);
    if (local.state.agencyDecisions?.[id] && !['timeout', 'capacity', 'unavailable'].includes(local.state.agencyDecisions[id].status)) return null;
    const perceived = local.state.log.find((entry) => entry.eventId === trigger.id && entry.audience?.includes(npcId));
    if (!perceived) return null;
    const decisionLocal = cloneJson(local);
    const decisionPersona = decisionLocal.snapshot.characters.find((npc) => npc.id === npcId);
    const decision = (async () => {
      try {
        const report = await externalCall(() => runNpc({ parent, signal: controller.signal, npcId, name: decisionPersona.name, phase: 'decision', prompt: decisionPrompt(cultivation, decisionLocal, npcId, { ...trigger, text: perceived.text }), outputSchema: NPC_DECISION_SCHEMA }));
        abort(controller.signal);
        return { report };
      } catch (error) {
        abort(controller.signal);
        if (error?.code === 'NPC_CAPACITY') return { capacity: true };
        return { unavailable: true };
      }
    })();
    // Bound the decision independently of the parallel appraisal tasks.
    const bounded = (promise) => Promise.race([promise, deadline]).catch((error) => {
      if (timedOut && !signal?.aborted) return { timeout: true };
      throw error;
    });
    const d = await bounded(decision);
    abort(signal);
    return { id, npcId, ...d };
    })();
    return work;
  }));
  abort(signal);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  const results = settled.map((result) => result.value);
  campaign.state.agencyDecisions ??= {};
  // Publish in the original actor order; no asynchronous shared writes occur.
  for (const result of results) {
    if (!result) continue;
    const { id, npcId, state, report, unavailable, timeout, capacity, appraisalIncomplete } = result;
    if (state) campaign.state.npcs[npcId] = cloneJson(state);
    if (timeout || capacity) {
      campaign.state.agencyDecisions[id] = { status: timeout ? 'timeout' : 'capacity', triggerId: trigger.id, npcId, ...(appraisalIncomplete ? { appraisalIncomplete: true } : {}) };
      continue;
    }
    if (unavailable) {
      campaign.state.agencyDecisions[id] = { status: 'unavailable', triggerId: trigger.id, npcId, ...(appraisalIncomplete ? { appraisalIncomplete: true } : {}) };
      continue;
    }
    const decision = {
      kind: text(report?.kind, 30), targetId: text(report?.targetId, 80), visibility: text(report?.visibility, 10),
      reason: text(report?.reason), evidenceIds: Array.isArray(report?.evidenceIds) ? report.evidenceIds.filter((entry) => typeof entry === 'string').slice(0, 8) : [], publicText: text(report?.publicText, 500)
    };
    const evidenceVisibleAtStart = decision.evidenceIds.every((eventId) => snapshot.state.log.some((entry) => entry.eventId === eventId && entry.audience?.includes(npcId)));
    const record = evidenceVisibleAtStart ? commitNpcAction(campaign, { id, npcId, trigger, decision }) : null;
    // Only valid, evidence-backed reports can alter the interpretation carried to
    // the next turn. A malformed action must not smuggle arbitrary private state.
    const validObservation = decision.kind === 'observe' && decision.reason && decision.visibility === 'public'
      && (decision.targetId === 'player' || presentActorIds(campaign).includes(decision.targetId))
      && evidenceVisibleAtStart;
    campaign.state.agencyDecisions[id] = { status: record ? 'committed' : validObservation ? 'observed' : 'invalid', triggerId: trigger.id, npcId, ...(appraisalIncomplete ? { appraisalIncomplete: true } : {}) };
    if (record || validObservation) {
      campaign.state.npcMeta ??= {};
      const meta = campaign.state.npcMeta[npcId] ??= {};
      for (const [field, source] of [['lastRead', 'read'], ['lastShift', 'shift'], ['lastNext', 'next']]) if (text(report?.[source], 300)) meta[field] = text(report[source], 300);
      meta.judgmentSceneId = campaign.state.sceneId;
    }
    for (const event of publicNpcActions(campaign, trigger.id)) {
      const eventId = agencyKey('public-action', trigger.id, event.npcId ?? '', event.kind);
      if (campaign.state.log.some((entry) => entry.eventId === eventId)) continue;
      campaign.state.log.push({ eventId, inputId: trigger.inputId ?? trigger.id, role: 'world', ...(event.npcId ? { npcId: event.npcId } : {}), text: event.text, sceneId: campaign.state.sceneId, turn: campaign.state.turnIndex, audience: [...new Set([...presentActorIds(campaign), ...(event.npcId ? [event.npcId] : [])])] });
    }
  }
  abort(signal);
  return publicNpcActions(campaign, trigger.id);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
