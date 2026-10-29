import { cloneJson, currentScene, isRecord, rollD20 } from './core.js';

const KINDS = new Set(['observe', 'assist', 'protect', 'risk_rescue', 'refuse', 'sabotage', 'confront', 'leave']);
const TRIGGERS = new Set(['player', 'combat', 'check', 'scene']);
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const validId = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !unsafe.has(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const clamp = (value) => Math.max(-4, Math.min(4, value));

/** Presence includes explicit returns, but never a departed or incapacitated NPC. */
export function presentNpcIds(campaign) {
  const scene = currentScene(campaign);
  return campaign.snapshot.characters.filter(({ id }) => {
    const meta = campaign.state.npcMeta?.[id] ?? {};
    const condition = Array.isArray(meta.condition) ? meta.condition : [];
    return (scene.cast.includes(id) || meta.returnedAtScene === scene.id)
      && (meta.status ?? 'active') === 'active'
      && !condition.some((item) => ['重伤', '失踪', '被俘', '昏迷', 'incapacitated', 'unconscious', 'dead'].includes(item));
  }).map(({ id }) => id);
}

function ledger(campaign) {
  const value = campaign.state.autonomy ??= { actions: [], receipts: {} };
  value.actions ??= [];
  value.receipts ??= {};
  return value;
}

/**
 * Call inside withCampaign. Decisions express character beliefs, not intimacy
 * thresholds. Only perceived log events can justify consequences. Invalid input
 * and observation do not create a ledger. Return a private record or null.
 */
export function commitNpcAction(campaign, input) {
  if (!isRecord(input)) return null;
  const { id, npcId, trigger, decision } = input;
  if (!validId(id) || !validId(npcId)) return null;
  const previous = campaign.state.autonomy?.actions?.find((item) => item.id === id);
  if (previous) return previous.npcId === npcId && previous.trigger.id === trigger?.id ? cloneJson(previous) : null;
  if (!isRecord(trigger) || !validId(trigger.id) || !TRIGGERS.has(trigger.kind)
    || (trigger.text !== undefined && !text(trigger.text, 8000)) || !isRecord(decision) || !KINDS.has(decision.kind)) return null;
  const present = presentNpcIds(campaign);
  if (!present.includes(npcId)) return null;
  const { kind, targetId, visibility, reason, evidenceIds, publicText } = decision;
  if (kind === 'observe') return null;
  if (!['public', 'secret'].includes(visibility) || (visibility === 'secret' && kind !== 'sabotage')) return null;
  if (!text(reason, 2000) || !Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > 32
    || !evidenceIds.every((eventId) => validId(eventId) && campaign.state.log.some((entry) => entry.eventId === eventId && Array.isArray(entry.audience) && entry.audience.includes(npcId)))) return null;
  if (visibility === 'public' && !text(publicText, 2000)) return null;
  if (visibility === 'secret' && publicText !== undefined && typeof publicText !== 'string') return null;
  if (!validId(targetId) || (targetId !== 'player' && (!present.includes(targetId) || targetId === npcId))) return null;
  if (['assist', 'sabotage'].includes(kind) && (targetId !== 'player' || !['combat', 'check'].includes(trigger.kind))) return null;
  if (['protect', 'risk_rescue'].includes(kind) && trigger.kind !== 'combat') return null;
  // A caller/DM cannot manufacture a combat/check opportunity by relabeling an
  // ordinary scene event. Exact check selection remains the runtime's capability.
  const scene = currentScene(campaign);
  if (['assist', 'sabotage', 'protect', 'risk_rescue'].includes(kind)) {
    if (trigger.kind === 'combat' && (!scene.encounter || campaign.state.player.hp <= 0 || campaign.state.encounters?.[scene.id]?.defeated)) return null;
    if (trigger.kind === 'check' && !(scene.checks ?? []).some((check) => check.repeatable || !Object.hasOwn(campaign.state.checks ?? {}, `${scene.id}:${check.id}`))) return null;
  }
  if (campaign.state.autonomy?.actions?.some((item) => item.npcId === npcId && item.trigger.id === trigger.id)) return null;
  const name = campaign.snapshot.characters.find((npc) => npc.id === npcId).name;
  const targetName = targetId === 'player' ? campaign.state.player.name : campaign.snapshot.characters.find((npc) => npc.id === targetId).name;
  // A model cannot announce a successful rescue before the enemy even hits.
  const visibleText = kind === 'protect' ? `${name}准备掩护${targetName}。`
    : kind === 'risk_rescue' ? `${name}冒险上前，准备替${targetName}挡伤。` : publicText;
  const action = { id, npcId, trigger: { id: trigger.id, kind: trigger.kind }, sceneId: campaign.state.sceneId, kind, targetId, visibility, reason: reason.trim(), evidenceIds: [...new Set(evidenceIds)], publicText: visibility === 'secret' ? '' : visibleText.trim(), consumed: false };
  const state = ledger(campaign);
  state.actions.push(action);
  // Own-property writes avoid prototype-sensitive keys even after JSON reload.
  state.receipts[id] = { npcId, triggerId: trigger.id };
  if (kind === 'leave') {
    campaign.state.npcMeta ??= {};
    const meta = campaign.state.npcMeta[npcId] ??= {};
    meta.status = 'left'; // Preserve injury, history, and return metadata.
    meta.publicStatus = 'left';
  }
  return cloneJson(action);
}

function activeActions(campaign, triggerId, triggerKind) {
  const present = new Set(presentNpcIds(campaign));
  return (campaign.state.autonomy?.actions ?? []).filter((item) => item.trigger.id === triggerId && item.trigger.kind === triggerKind && item.sceneId === campaign.state.sceneId && !item.consumed && present.has(item.npcId));
}

export function npcCombatEffects(campaign, triggerId) {
  let attackBonus = 0;
  let damageReduction = 0;
  for (const action of activeActions(campaign, triggerId, 'combat')) {
    if (action.targetId !== 'player') continue;
    if (action.kind === 'assist') attackBonus += 2;
    if (action.kind === 'sabotage') attackBonus -= 2;
    if (action.kind === 'protect') damageReduction += 2;
    if (action.kind === 'risk_rescue') damageReduction += 4;
  }
  return { attackBonus: clamp(attackBonus), damageReduction: Math.min(4, damageReduction) };
}

export function npcCheckBonus(campaign, triggerId) {
  return clamp(activeActions(campaign, triggerId, 'check').reduce((bonus, action) => bonus + (action.kind === 'assist' ? 2 : action.kind === 'sabotage' ? -2 : 0), 0));
}

/**
 * Settle once after applyEncounter. Only damage actually intercepted injures a
 * defender; capped reduction is allocated in commit order. Current encounters
 * attack only the player. Ally guards can redirect a player defender's actual
 * injury burden once, never newly redirected burden (no chains/cycles). They do
 * not add player damage reduction or invent an otherwise nonexistent ally hit.
 */
export function settleNpcCombat(campaign, triggerId, result, { random = Math.random } = {}) {
  const actions = activeActions(campaign, triggerId, 'combat');
  const validDamage = Number.isFinite(result?.rawReceived) && Number.isFinite(result?.received)
    && result.rawReceived > 0 && result.received >= 0 && result.retaliation?.success === true;
  let intercepted = validDamage ? Math.min(4, Math.max(0, result.rawReceived - result.received)) : 0;
  const costs = new Map();
  for (const action of actions) {
    if (intercepted <= 0 || action.targetId !== 'player' || !['protect', 'risk_rescue'].includes(action.kind)) continue;
    const amount = Math.min(intercepted, action.kind === 'risk_rescue' ? 4 : 2);
    intercepted -= amount;
    costs.set(action.npcId, { action, amount });
  }
  // Only original player-defender costs are redirectable. A guard helping a
  // guard cannot propagate injury through a chain or exploit ordering/cycles.
  const originalCosts = new Map([...costs].map(([id, cost]) => [id, cost.amount]));
  for (const action of actions) {
    if (action.targetId === 'player' || !['protect', 'risk_rescue'].includes(action.kind)) continue;
    const remaining = originalCosts.get(action.targetId) ?? 0;
    if (remaining <= 0) continue;
    const amount = Math.min(remaining, action.kind === 'risk_rescue' ? 4 : 2);
    originalCosts.set(action.targetId, remaining - amount);
    costs.get(action.targetId).amount -= amount;
    costs.set(action.npcId, { action, amount });
  }
  // Roll before mutating, so invalid random sources cannot partially settle.
  const injuries = [...costs.values()].filter(({ amount }) => amount > 0).map(({ action, amount }) => ({
    action, amount, condition: action.kind === 'risk_rescue' && rollD20(random) <= 5 ? '重伤' : '受伤',
  }));
  for (const { action, amount, condition } of injuries) {
    campaign.state.npcMeta ??= {};
    const meta = campaign.state.npcMeta[action.npcId] ??= {};
    const existing = Array.isArray(meta.condition) ? meta.condition : [];
    meta.condition = [...new Set([...existing.filter((item) => condition !== '重伤' || item !== '受伤'), condition])];
    action.condition = [...meta.condition];
    action.interceptedDamage = amount;
  }
  // Consume even actors that left/became unavailable after commitment.
  for (const action of campaign.state.autonomy?.actions ?? []) {
    if (action.trigger.id === triggerId && action.trigger.kind === 'combat') action.consumed = true;
  }
  return publicNpcActions(campaign, triggerId);
}

export function consumeNpcCheck(campaign, triggerId) {
  for (const action of campaign.state.autonomy?.actions ?? []) {
    if (action.trigger.id === triggerId && action.trigger.kind === 'check') action.consumed = true;
  }
}

/** A strict public projection; hidden actions and their supplied text never leak. */
export function publicNpcActions(campaign, triggerId) {
  return (campaign.state.autonomy?.actions ?? []).filter((item) => item.trigger.id === triggerId && item.visibility === 'public').map((item) => ({
    npcId: item.npcId,
    name: campaign.snapshot.characters.find(({ id }) => id === item.npcId)?.name ?? item.npcId,
    kind: item.kind,
    targetId: item.targetId,
    text: item.publicText,
    ...(Array.isArray(item.condition) ? { condition: [...item.condition] } : {}),
  }));
}
