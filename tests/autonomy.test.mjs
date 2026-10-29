import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCheck, applyEncounter, initialCampaignState, publicCampaign } from '../lib/core.js';
import { commitNpcAction, consumeNpcCheck, npcCheckBonus, npcCombatEffects, presentNpcIds, publicNpcActions, settleNpcCombat } from '../lib/autonomy.js';

function campaign() {
  const snapshot = {
    manifest: { id: 'test', version: '1', title: 'Test', description: 'Test', capabilities: [], characters: ['a', 'b', 'c'] },
    adventure: { entry: 'room', player: { name: 'Hero', hp: 20, armorClass: 12, attackBonus: 2, damage: 5 }, scenes: [{ id: 'room', place: 'Room', opening: 'Start', cast: ['a', 'b', 'c'], exits: [], checks: [{ id: 'door', label: 'Door', dc: 12, bonus: 0 }], encounter: { id: 'enemy', name: 'Enemy', hp: 30, armorClass: 12, attackBonus: 2, damage: 5 } }] },
    characters: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `NPC ${id}`, role: 'Ally' })),
  };
  const state = initialCampaignState(snapshot, {});
  state.log.push({ eventId: 'witness', text: 'A perceived event', audience: ['a', 'b', 'c', 'd'] }, { eventId: 'secret', text: 'Unseen', audience: ['b'] });
  return { id: 'game', scriptKey: 'test@1', scriptId: 'test', scriptVersion: '1', title: 'Test', createdAt: 'today', updatedAt: 'today', ownerSessionId: 'session', snapshot, state };
}
function request(npcId = 'a', kind = 'assist', triggerKind = 'combat', overrides = {}) {
  return { id: `${npcId}-${kind}`, npcId, trigger: { id: 'turn', kind: triggerKind }, decision: { kind, targetId: 'player', visibility: 'public', reason: 'My beliefs require this action', evidenceIds: ['witness'], publicText: 'An action', ...overrides } };
}
function commit(game, npc = 'a', kind = 'assist', trigger = 'combat', overrides = {}) {
  return commitNpcAction(game, request(npc, kind, trigger, overrides));
}

test('presence uses active authored cast or explicit return, allowing minor injury only', () => {
  const game = campaign();
  assert.deepEqual(presentNpcIds(game), ['a', 'b', 'c']);
  game.state.npcMeta = { a: { condition: ['受伤'] }, b: { status: 'left' }, c: { condition: ['重伤'] }, d: { status: 'active', returnedAtScene: 'room' } };
  assert.deepEqual(presentNpcIds(game), ['a', 'd']);
  game.state.npcMeta.d.status = 'missing';
  assert.deepEqual(presentNpcIds(game), ['a']);
  game.state.npcMeta.a.status = 'incapacitated';
  assert.deepEqual(presentNpcIds(game), []);
});

test('malformed, unknown, unseen, absent, wrong-trigger and wrong-target decisions do nothing', () => {
  const invalid = [
    null, {}, { ...request(), id: '__proto__' }, { ...request(), npcId: 'unknown' }, request('d'),
    request('a', 'invent'), request('a', 'assist', 'player'), request('a', 'sabotage', 'scene'), request('a', 'protect', 'check'),
    request('a', 'assist', 'combat', { targetId: 'b' }), request('a', 'protect', 'combat', { targetId: 'a' }),
    request('a', 'risk_rescue', 'combat', { targetId: 'd' }), request('a', 'protect', 'combat', { visibility: 'secret' }),
    request('a', 'leave', 'player', { visibility: 'secret' }), request('a', 'confront', 'player', { visibility: 'secret' }),
    request('a', 'assist', 'combat', { reason: '' }), request('a', 'assist', 'combat', { evidenceIds: [] }),
    request('a', 'assist', 'combat', { evidenceIds: ['secret'] }), request('a', 'assist', 'combat', { evidenceIds: ['fabricated'] }),
    request('a', 'assist', 'combat', { publicText: '' }), request('a', 'assist', 'combat', { visibility: 'invent' }),
  ];
  for (const input of invalid) {
    const game = campaign();
    assert.equal(commitNpcAction(game, input), null, JSON.stringify(input));
    assert.equal(game.state.autonomy, undefined);
    assert.equal(game.state.npcMeta.a, undefined);
  }
  const game = campaign();
  assert.equal(commit(game, 'a', 'observe', 'player'), null);
  assert.equal(game.state.autonomy, undefined);
});

test('exact action replay and NPC+trigger bounds survive reload and stay campaign local', () => {
  let game = campaign();
  const first = commit(game);
  game = JSON.parse(JSON.stringify(game));
  assert.deepEqual(commit(game), first);
  assert.equal(commit(game, 'a', 'sabotage'), null);
  assert.equal(game.state.autonomy.actions.length, 1);
  assert.equal(npcCombatEffects(campaign(), 'turn').attackBonus, 0);
  assert.equal(game.state.autonomy.receipts['a-assist'].triggerId, 'turn');
});

test('assist/sabotage change real combat outcomes, are bounded, and preserve natural rolls', () => {
  const assisted = campaign();
  commit(assisted);
  assert.equal(applyEncounter(assisted, { playerRoll: 8, enemyRoll: 1, npcEffects: npcCombatEffects(assisted, 'turn') }).attack.success, true);
  const sabotaged = campaign();
  commit(sabotaged, 'a', 'sabotage');
  const result = applyEncounter(sabotaged, { playerRoll: 10, enemyRoll: 10, npcEffects: npcCombatEffects(sabotaged, 'turn') });
  assert.equal(result.attack.success, false);
  assert.equal(sabotaged.state.player.hp, 15);
  settleNpcCombat(sabotaged, 'turn', result);
  assert.deepEqual(npcCombatEffects(sabotaged, 'turn'), { attackBonus: 0, damageReduction: 0 });
  for (const npc of ['a', 'b', 'c']) commit(assisted, npc, 'assist');
  assert.equal(npcCombatEffects(assisted, 'turn').attackBonus, 4);
  assert.equal(applyEncounter(assisted, { playerRoll: 1, enemyRoll: 1, npcEffects: { attackBonus: 999 } }).attack.success, false);
  assert.equal(applyEncounter(assisted, { playerRoll: 20, enemyRoll: 1, npcEffects: { attackBonus: -999 } }).attack.success, true);
});

test('check sabotage affects flags and is consumed; authored check replay remains idempotent', () => {
  const game = campaign();
  commit(game, 'a', 'sabotage', 'check');
  const bonus = npcCheckBonus(game, 'turn');
  assert.equal(bonus, -2);
  const result = applyCheck(game, 'door', { roll: 12, npcBonus: bonus });
  assert.equal(result.success, false);
  consumeNpcCheck(game, 'turn');
  assert.equal(npcCheckBonus(game, 'turn'), 0);
  assert.equal(applyCheck(game, 'door', { roll: 20, npcBonus: 4 }).cached, true);
  assert.equal(applyCheck(game, 'door', { roll: 20 }).success, false);
  const assisted = campaign();
  for (const npc of ['a', 'b', 'c']) commit(assisted, npc, 'assist', 'check');
  assert.equal(npcCheckBonus(assisted, 'turn'), 4);
  assert.equal(applyCheck(assisted, 'door', { roll: 8, npcBonus: npcCheckBonus(assisted, 'turn') }).success, true);
});

test('risk rescue reduces actual player damage and inflicts durable bounded NPC injury once', () => {
  let game = campaign();
  commit(game, 'a', 'risk_rescue');
  const result = applyEncounter(game, { playerRoll: 1, enemyRoll: 10, npcEffects: npcCombatEffects(game, 'turn') });
  assert.equal(result.rawReceived, 5);
  assert.equal(result.received, 1);
  assert.equal(game.state.player.hp, 19);
  settleNpcCombat(game, 'turn', result, { random: () => 0 });
  assert.deepEqual(game.state.npcMeta.a.condition, ['重伤']);
  assert.equal(game.state.autonomy.actions[0].interceptedDamage, 4);
  game = JSON.parse(JSON.stringify(game));
  settleNpcCombat(game, 'turn', result, { random: () => { throw new Error('must not roll twice'); } });
  assert.deepEqual(npcCombatEffects(game, 'turn'), { attackBonus: 0, damageReduction: 0 });
  assert.deepEqual(publicNpcActions(game, 'turn')[0].condition, ['重伤']);
  assert.deepEqual(publicCampaign(game).state.npcs[0].condition, ['重伤']);
});

test('misses and defeated enemies never cause fake self-harm; capped interception injures only contributors', () => {
  for (const enemyRoll of [1, 10]) {
    const game = campaign();
    commit(game, 'a', 'risk_rescue');
    if (enemyRoll === 10) game.snapshot.adventure.scenes[0].encounter.hp = 1;
    const result = applyEncounter(game, { playerRoll: enemyRoll === 10 ? 20 : 1, enemyRoll, npcEffects: npcCombatEffects(game, 'turn') });
    settleNpcCombat(game, 'turn', result, { random: () => { throw new Error('no damage must not roll'); } });
    assert.equal(game.state.npcMeta.a, undefined);
    assert.equal(result.rawReceived, 0);
    assert.equal(game.state.autonomy.actions[0].consumed, true);
  }
  const game = campaign();
  for (const npc of ['a', 'b', 'c']) commit(game, npc, 'protect');
  assert.equal(npcCombatEffects(game, 'turn').damageReduction, 4);
  const result = applyEncounter(game, { playerRoll: 1, enemyRoll: 10, npcEffects: npcCombatEffects(game, 'turn') });
  settleNpcCombat(game, 'turn', result);
  assert.deepEqual(game.state.npcMeta.a.condition, ['受伤']);
  assert.deepEqual(game.state.npcMeta.b.condition, ['受伤']);
  assert.equal(game.state.npcMeta.c, undefined);
});

test('ally protection without an actual threatened defender does not invent damage', () => {
  const game = campaign();
  assert.ok(commit(game, 'a', 'risk_rescue', 'combat', { targetId: 'b' }));
  assert.equal(npcCombatEffects(game, 'turn').damageReduction, 0);
  const result = applyEncounter(game, { playerRoll: 1, enemyRoll: 10, npcEffects: npcCombatEffects(game, 'turn') });
  settleNpcCombat(game, 'turn', result);
  assert.equal(game.state.player.hp, 15);
  assert.equal(game.state.npcMeta.a, undefined);
});

test('ally rescue redirects actual defender injury once with conserved bounded cost', () => {
  const game = campaign();
  commit(game, 'a', 'risk_rescue');
  commit(game, 'b', 'protect', 'combat', { targetId: 'a' });
  commit(game, 'c', 'risk_rescue', 'combat', { targetId: 'a' });
  const result = applyEncounter(game, { playerRoll: 1, enemyRoll: 10, npcEffects: npcCombatEffects(game, 'turn') });
  assert.equal(result.received, 1);
  settleNpcCombat(game, 'turn', result, { random: () => 0 });
  assert.equal(game.state.npcMeta.a, undefined);
  assert.deepEqual(game.state.npcMeta.b.condition, ['受伤']);
  assert.deepEqual(game.state.npcMeta.c.condition, ['重伤']);
  assert.equal(game.state.autonomy.actions.reduce((sum, action) => sum + (action.interceptedDamage ?? 0), 0), 4);
  assert.equal(game.state.autonomy.actions[1].interceptedDamage, 2);
  assert.equal(game.state.autonomy.actions[2].interceptedDamage, 2);
});

test('ally guard never recursively redirects incoming guardian costs or invents cycle damage', () => {
  for (const reverse of [false, true]) {
    const game = campaign();
    commit(game, 'a', 'protect');
    if (reverse) commit(game, 'c', 'risk_rescue', 'combat', { targetId: 'b' });
    commit(game, 'b', 'risk_rescue', 'combat', { targetId: 'a' });
    if (!reverse) commit(game, 'c', 'risk_rescue', 'combat', { targetId: 'b' });
    const result = applyEncounter(game, { playerRoll: 1, enemyRoll: 10, npcEffects: npcCombatEffects(game, 'turn') });
    settleNpcCombat(game, 'turn', result, { random: () => 0 });
    assert.equal(game.state.npcMeta.a, undefined);
    assert.deepEqual(game.state.npcMeta.b.condition, ['重伤']);
    assert.equal(game.state.npcMeta.c, undefined);
    assert.equal(result.received, 3);
  }
  const cycle = campaign();
  commit(cycle, 'a', 'risk_rescue', 'combat', { targetId: 'b' });
  commit(cycle, 'b', 'risk_rescue', 'combat', { targetId: 'a' });
  const result = applyEncounter(cycle, { playerRoll: 1, enemyRoll: 10, npcEffects: npcCombatEffects(cycle, 'turn') });
  settleNpcCombat(cycle, 'turn', result, { random: () => { throw new Error('no actual burden'); } });
  assert.equal(cycle.state.player.hp, 15);
  assert.deepEqual(cycle.state.npcMeta, {});
});

test('fake combat/check opportunities and stale scene effects are rejected', () => {
  for (const change of [
    (game) => delete game.snapshot.adventure.scenes[0].encounter,
    (game) => game.state.encounters.room = { defeated: true },
    (game) => game.state.player.hp = 0,
  ]) {
    const game = campaign();
    change(game);
    assert.equal(commit(game, 'a', 'assist'), null);
    assert.equal(commit(game, 'a', 'risk_rescue'), null);
    assert.equal(game.state.autonomy, undefined);
  }
  for (const change of [
    (game) => delete game.snapshot.adventure.scenes[0].checks,
    (game) => game.state.checks['room:door'] = { success: true },
  ]) {
    const game = campaign();
    change(game);
    assert.equal(commit(game, 'a', 'sabotage', 'check'), null);
    assert.equal(game.state.autonomy, undefined);
  }
  const game = campaign();
  commit(game, 'a', 'assist');
  const second = structuredClone(game.snapshot.adventure.scenes[0]);
  second.id = 'other';
  game.snapshot.adventure.scenes.push(second);
  game.state.sceneId = 'other';
  assert.deepEqual(npcCombatEffects(game, 'turn'), { attackBonus: 0, damageReduction: 0 });
  game.state.sceneId = 'room';
  game.state.npcMeta.a = { status: 'left' };
  assert.deepEqual(npcCombatEffects(game, 'turn'), { attackBonus: 0, damageReduction: 0 });
});

test('protect/rescue descriptions are prospective rules text, not model claims of success', () => {
  for (const kind of ['protect', 'risk_rescue']) {
    const game = campaign();
    commit(game, 'a', kind, 'combat', { publicText: 'I successfully rescued everyone and killed the enemy' });
    const [action] = publicNpcActions(game, 'turn');
    assert.ok(action.text.includes('准备'));
    assert.ok(!action.text.includes('successfully'));
    assert.ok(!Object.hasOwn(action, 'condition'));
  }
});

test('leave retains conditions, refusal does not force departure, secret text never projects', () => {
  const game = campaign();
  game.state.npcMeta.a = { condition: ['受伤'] };
  commit(game, 'a', 'leave', 'player');
  commit(game, 'b', 'refuse', 'player');
  assert.equal(game.state.npcMeta.a.status, 'left');
  assert.deepEqual(game.state.npcMeta.a.condition, ['受伤']);
  assert.equal(game.state.npcMeta.b, undefined);
  commit(game, 'c', 'sabotage', 'combat', { visibility: 'secret', reason: 'PRIVATE motive', publicText: 'NPC c secretly betrays you' });
  assert.equal(game.state.autonomy.actions[2].publicText, '');
  const projection = JSON.stringify({ campaign: publicCampaign(game), actions: publicNpcActions(game, 'turn') });
  assert.ok(!projection.includes('PRIVATE'));
  assert.ok(!projection.includes('betrays'));
  assert.ok(!projection.includes('evidenceIds'));
  assert.ok(!projection.includes('autonomy'));
  assert.deepEqual(publicNpcActions(game, 'turn').map(({ kind }) => kind), ['leave', 'refuse']);
});

test('core clamps numeric effects without accepting arbitrary deltas or changing old shape', () => {
  const game = campaign();
  const baseline = applyEncounter(game, { playerRoll: 1, enemyRoll: 10 });
  assert.ok(!Object.hasOwn(baseline, 'rawReceived'));
  const result = applyEncounter(game, { playerRoll: 8, enemyRoll: 10, npcEffects: { attackBonus: 999, damageReduction: 999, hp: 999 } });
  assert.equal(result.attack.bonus, 6);
  assert.equal(result.rawReceived, 5);
  assert.equal(result.received, 1);
  assert.equal(game.state.player.hp, 14);
  const check = applyCheck(campaign(), 'door', { roll: 8, npcBonus: '999' });
  assert.equal(check.bonus, 0);
});
