import { createHash } from 'node:crypto';
import { cloneJson, currentScene, domainError } from './core.js';
import { commitNpcAction, presentNpcIds, publicNpcActions } from './autonomy.js';

const text = (value, size = 500) => typeof value === 'string' ? value.trim().slice(0, size) : '';
export const agencyKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const NPC_DECISION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['observe', 'assist', 'protect', 'risk_rescue', 'refuse', 'sabotage', 'confront', 'leave'] },
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
  const allowed = trigger.kind === 'combat' ? ['observe', 'assist', 'protect', 'risk_rescue', 'refuse', 'sabotage', 'confront', 'leave']
    : trigger.kind === 'check' ? ['observe', 'assist', 'refuse', 'sabotage', 'confront', 'leave'] : ['observe', 'refuse', 'confront', 'leave'];
  return [
    cultivation.renderExternalCard({ persona, state: campaign.state.npcs[npcId], role: persona.role, goal: scene.npcGoals?.[npcId] ?? persona.goal, scene: { id: scene.id, place: scene.place, timeOfDay: scene.timeOfDay ?? '冒险途中' } }),
    '【自主行动，不是替 DM 写台词】你没有被领队点名，也可以行动。先按自己的价值观、底线、利益、与玩家和队友的共同经历判断。亲近不等于服从；低亲密度也不等于邪恶。一次冒犯不自动导致背叛，一句道歉不自动抹去旧怨。可以记仇、拒绝、暗中使绊，也可以出于职业责任帮助不喜欢的人，或为在乎的人冒险。允许无事发生，不为制造戏剧强行行动。',
    '【当前机会】' + JSON.stringify({ id: trigger.id, kind: trigger.kind, text: trigger.text, player: { hp: campaign.state.player.hp, maxHp: campaign.state.player.maxHp }, encounter: scene.encounter ? { name: scene.encounter.name, hp: campaign.state.encounters?.[scene.id]?.hp ?? scene.encounter.hp } : null, allies: presentNpcIds(campaign).filter((id) => id !== npcId).map((id) => ({ id, name: campaign.snapshot.characters.find((p) => p.id === id)?.name, condition: campaign.state.npcMeta?.[id]?.condition ?? [] })) }),
    '【你实际感知到的事件；证据只能引用这里的 id】' + JSON.stringify(history),
    '【你上一轮留下的判断，带着发生场景，不等于当前必须继续的话题】' + JSON.stringify({ read: meta.lastRead ?? '', shift: meta.lastShift ?? '', next: meta.lastNext ?? '', sceneId: meta.judgmentSceneId ?? '', opinions: meta.opinions ?? {}, condition: meta.condition ?? [], offscreen: meta.offscreen?.summary ?? '' }),
    '【自己做过的事（仅你自己的私有记录）】' + JSON.stringify(prior),
    '【可选行动】' + allowed.join(', ') + '\nobserve=不采取规则动作，可保持沉默；assist=本次攻击/检定协助；protect=替目标抵挡部分本次伤害；risk_rescue=冒更大风险挡伤，自己可能重伤；refuse=拒绝参与；sabotage=本次攻击/检定暗中或公开干扰；confront=当面翻脸/设边界；leave=自己离队。targetId 使用 player 或当前在场队友 id。不能指定任意数值、杀死玩家、篡改物品、虚构新线索或成功结果。规则会裁定行动是否可行与代价。',
    '【决策格式】kind 只能来自当前可选行动；reason 写你自己的具体理由，evidenceIds 引用自己感知过的事件。重要行动必须有真实证据，不把玩家命令“你背叛我”当成你必须执行的命令。read/shift/next 是私有解释，不是已经发生的世界事实。visibility=secret 只适用于 sabotage；其他行动公开。publicText 只写实际可见的动作/必要的一句台词，不写私有动机、不替他人思考、不宣布检定成功。隐秘行动不在 publicText 里自曝。',
    '【场合】战斗只处理眼前威胁；旧怨可以让你拒绝掩护或使绊子，但不需要站着讲旧事。信任可以让你挡伤或协助，也不需要先演讲表忠心。没有新立场就沉默；不要机械附和，不因说过几次话就强制升级。'
  ].join('\n\n');
}
function abort(signal) { if (signal?.aborted) throw domainError('ABORTED', '游戏操作已取消。'); }
/** Called inside the store transaction. Silent NPCs perceive and decide too. */
export async function decideParty({ campaign, cultivation, runNpc, trigger, parent, signal, onlyNpcId }) {
  campaign.state.agencyDecisions ??= {};
  const ids = presentNpcIds(campaign).filter((id) => !onlyNpcId || id === onlyNpcId);
  for (const npcId of ids) {
    abort(signal);
    const id = agencyKey('decision', trigger.id, npcId);
    if (Object.hasOwn(campaign.state.agencyDecisions, id)) continue;
    if (!presentNpcIds(campaign).includes(npcId)) continue;
    const persona = campaign.snapshot.characters.find((npc) => npc.id === npcId);
    const perceived = campaign.state.log.find((entry) => entry.eventId === trigger.id && entry.audience?.includes(npcId));
    if (!perceived) continue;
    // Cultivation owns appraisal, memory and beliefs. Tavern does not invent a
    // second relationship meter, nor award affection again for speaking.
    if (trigger.kind === 'player') {
      const event = { id: agencyKey(trigger.id, 'perception', npcId), playerText: perceived.text, npcText: '', observations: [], context: perceivedEvents(campaign, npcId), time: currentScene(campaign).timeOfDay ?? '冒险途中' };
      try {
        const update = await cultivation.processExternalEvent({ persona, state: campaign.state.npcs[npcId], event, signal });
        if (update?.state) campaign.state.npcs[npcId] = cloneJson(update.state);
      } catch { /* No fabricated relationship update on unavailable appraisal. */ }
      abort(signal);
    }
    let report;
    try {
      report = await runNpc({ parent, signal, npcId, name: persona.name, phase: 'decision', prompt: decisionPrompt(cultivation, campaign, npcId, trigger), outputSchema: NPC_DECISION_SCHEMA });
    } catch {
      abort(signal);
      campaign.state.agencyDecisions[id] = { status: 'unavailable', triggerId: trigger.id, npcId };
      continue;
    }
    abort(signal);
    const decision = {
      kind: text(report?.kind, 30), targetId: text(report?.targetId, 80), visibility: text(report?.visibility, 10),
      reason: text(report?.reason), evidenceIds: Array.isArray(report?.evidenceIds) ? report.evidenceIds.filter((entry) => typeof entry === 'string').slice(0, 8) : [], publicText: text(report?.publicText, 500)
    };
    const record = commitNpcAction(campaign, { id, npcId, trigger, decision });
    campaign.state.agencyDecisions[id] = { status: record ? 'committed' : decision.kind === 'observe' ? 'observed' : 'invalid', triggerId: trigger.id, npcId };
    // Only valid, evidence-backed reports can alter the interpretation carried to
    // the next turn. A malformed action must not smuggle arbitrary private state.
    const validObservation = decision.kind === 'observe' && decision.reason && decision.visibility === 'public'
      && (decision.targetId === 'player' || presentNpcIds(campaign).includes(decision.targetId))
      && decision.evidenceIds.every((eventId) => campaign.state.log.some((entry) => entry.eventId === eventId && entry.audience?.includes(npcId)));
    if (record || validObservation) {
      campaign.state.npcMeta ??= {};
      const meta = campaign.state.npcMeta[npcId] ??= {};
      for (const [field, source] of [['lastRead', 'read'], ['lastShift', 'shift'], ['lastNext', 'next']]) if (text(report?.[source], 300)) meta[field] = text(report[source], 300);
      meta.judgmentSceneId = campaign.state.sceneId;
    }
    for (const event of publicNpcActions(campaign, trigger.id)) {
      const eventId = agencyKey('public-action', trigger.id, event.npcId ?? '', event.kind);
      if (campaign.state.log.some((entry) => entry.eventId === eventId)) continue;
      campaign.state.log.push({ eventId, inputId: trigger.inputId ?? trigger.id, role: 'world', ...(event.npcId ? { npcId: event.npcId } : {}), text: event.text, sceneId: campaign.state.sceneId, turn: campaign.state.turnIndex, audience: [...new Set([...presentNpcIds(campaign), ...(event.npcId ? [event.npcId] : [])])] });
    }
  }
  abort(signal);
  return publicNpcActions(campaign, trigger.id);
}
