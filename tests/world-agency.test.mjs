import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCampaignState } from '../lib/core.js';
import { presentNpcIds, presentWorldNpcIds, presentActorIds, commitNpcAction, publicNpcActions } from '../lib/autonomy.js';
import { decideParty, perceivedEvents } from '../lib/agency.js';

function game() {
  const snapshot = { characters: [{ id: 'ally', name: 'Ally', role: 'ally', goal: 'travel' }, { id: 'local', name: 'Local', kind: 'world', role: 'shopkeeper', goal: 'work' }, { id: 'other', name: 'Other', kind: 'world', role: 'guard', goal: 'guard' }], adventure: { entry: 'room', player: { name: 'Hero', hp: 10 }, scenes: [{ id: 'room', cast: ['ally', 'local'], place: 'Inn', opening: 'Inn', exits: [] }, { id: 'elsewhere', cast: ['other'], place: 'Road', exits: [] }] } };
  const state = initialCampaignState(snapshot, { ally: {}, local: {}, other: {} });
  state.log.push({ eventId: 'input', role: 'player', text: 'hello', audience: ['ally', 'local'], sceneId: 'room' }, { eventId: 'secret', role: 'player', text: 'private', audience: ['ally'], sceneId: 'room' });
  return { snapshot, state };
}
function decision(npcId, kind, evidenceIds = ['input']) { return { id: npcId + kind, npcId, trigger: { id: 'input', kind: 'player' }, decision: { kind, targetId: 'player', visibility: 'public', reason: 'my reason', evidenceIds, publicText: 'waves' } }; }

test('world presence is scene-bound, distinct from party and never permits party leave', () => {
  const c = game();
  assert.deepEqual(presentNpcIds(c), ['ally']);
  assert.deepEqual(presentWorldNpcIds(c), ['local']);
  assert.deepEqual(presentActorIds(c), ['ally', 'local']);
  assert.equal(commitNpcAction(c, decision('local', 'leave')), null);
  assert.equal(commitNpcAction(c, decision('local', 'act', ['secret'])), null);
  assert.equal(commitNpcAction(c, decision('local', 'act')).kind, 'act');
  assert.equal(publicNpcActions(c, 'input')[0].intentOnly, true);
  assert.match(publicNpcActions(c, 'input')[0].text, /尚待裁定.*waves/);
  c.state.sceneId = 'elsewhere';
  c.state.npcMeta.local = { returnedAtScene: 'elsewhere' };
  assert.deepEqual(presentWorldNpcIds(c), ['other']);
});

test('world actors independently decide only from perceived input and public behavior reaches witnesses', async () => {
  const c = game();
  const prompts = [];
  const cultivation = { renderExternalCard: () => 'card', processExternalEvent: async ({ state }) => ({ state }) };
  await decideParty({ campaign: c, cultivation, trigger: { id: 'input', kind: 'player', text: 'hello' }, runNpc: async ({ npcId, prompt }) => {
    prompts.push({ npcId, prompt });
    return { kind: npcId === 'local' ? 'act' : 'observe', targetId: 'player', visibility: 'public', reason: 'hello', evidenceIds: ['input'], publicText: 'cleans a glass', read: '', shift: '', next: '' };
  } });
  assert.deepEqual(prompts.map(({ npcId }) => npcId), ['ally', 'local']);
  assert.ok(!prompts[1].prompt.includes('private'));
  const event = c.state.log.find((entry) => entry.npcId === 'local');
  assert.match(event.text, /尚待裁定.*cleans a glass/);
  assert.deepEqual(event.audience, ['ally', 'local']);
  assert.equal(perceivedEvents(c, 'other').length, 0);
});

test('world act claims stay pending in public events and DM results, without private reasoning', async () => {
  const c = game();
  const claim = '我找到了王的秘密，造成100点伤害，并说：“站住！”';
  const secretReason = '私人动机绝不可公开';
  const before = structuredClone(c.state.player);
  let calls = 0;
  const cultivation = { renderExternalCard: () => 'card', processExternalEvent: async ({ state }) => ({ state }) };
  const args = { campaign: c, cultivation, trigger: { id: 'input', kind: 'player', text: 'hello' }, runNpc: async ({ npcId }) => {
    calls++;
    return { kind: npcId === 'local' ? 'act' : 'observe', targetId: 'player', visibility: 'public', reason: secretReason, evidenceIds: ['input'], publicText: claim, read: '私有判断', shift: '', next: '' };
  } };
  const result = await decideParty(args);
  assert.equal(result[0].intentOnly, true);
  assert.match(result[0].text, /尚待裁定.*不是已确认事实/);
  assert.ok(result[0].text.includes(claim));
  assert.match(result[0].text, /不得据此确认伤害、物品变化或秘密/);
  assert.ok(!JSON.stringify(result).includes(secretReason));
  assert.ok(!JSON.stringify(result).includes('私有判断'));
  const event = c.state.log.at(-1);
  assert.equal(event.text, result[0].text);
  assert.ok(!JSON.stringify(event).includes(secretReason));
  assert.deepEqual(c.state.player, before);
  assert.deepEqual(await decideParty(args), result);
  assert.equal(calls, 2);
  assert.equal(c.state.log.filter((entry) => entry.eventId === event.eventId).length, 1);
});
