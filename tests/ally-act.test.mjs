import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCampaignState } from '../lib/core.js';
import { commitNpcAction, npcCombatEffects, npcCheckBonus } from '../lib/autonomy.js';
import { decideParty } from '../lib/agency.js';

function game() {
  const snapshot = { characters: [{ id: 'ally', name: 'Ally', role: 'companion', goal: 'travel' }], adventure: { entry: 'room', player: { name: 'Hero', hp: 10 }, scenes: [{ id: 'room', cast: ['ally'], place: 'Inn', exits: [] }] } };
  const state = initialCampaignState(snapshot, { ally: {} });
  state.log.push({ eventId: 'input', role: 'player', text: 'hello', audience: ['ally'], sceneId: 'room' }, { eventId: 'secret', role: 'player', text: 'private', audience: [], sceneId: 'room' });
  return { snapshot, state };
}
const cultivation = { renderExternalCard: () => 'card', processExternalEvent: async ({ state }) => ({ state }) };
const report = { kind: 'act', targetId: 'player', visibility: 'public', reason: 'wants to connect', evidenceIds: ['input'], publicText: '走近你，试探着问：“要一起看看吗？”', read: '', shift: '', next: '' };

test('companion naturally acts once in an ordinary opportunity without rule effects', async () => {
  const c = game();
  let calls = 0;
  const args = { campaign: c, cultivation, trigger: { id: 'input', kind: 'player', text: 'hello' }, runNpc: async ({ prompt }) => { calls++; assert.match(prompt, /observe, act, refuse/); return report; } };
  const before = structuredClone(c.state.player);
  const result = await decideParty(args);
  assert.equal(result[0].intentOnly, true);
  assert.ok(result[0].text.includes(report.publicText));
  assert.match(result[0].text, /未裁定/);
  assert.deepEqual(c.state.player, before);
  assert.deepEqual(npcCombatEffects(c, 'input'), { attackBonus: 0, damageReduction: 0 });
  assert.equal(npcCheckBonus(c, 'input'), 0);
  assert.deepEqual(await decideParty(args), result);
  assert.equal(calls, 1);
  assert.equal(c.state.log.filter((e) => e.text === result[0].text).length, 1);
});

test('claimed secret and damage remain unconfirmed intent in public event and DM result', async () => {
  const c = game();
  const claim = '我找到了王的秘密，并造成了100点伤害';
  const before = structuredClone(c.state.player);
  const result = await decideParty({ campaign: c, cultivation, trigger: { id: 'input', kind: 'player', text: 'hello' }, runNpc: async () => ({ ...report, publicText: claim }) });
  assert.equal(result[0].intentOnly, true);
  assert.match(result[0].text, /未裁定.*不是已确认事实/);
  assert.match(result[0].text, /不得据此确认伤害、物品变化或秘密/);
  assert.equal(c.state.log.at(-1).text, result[0].text);
  assert.deepEqual(c.state.player, before);
});

test('companion act retains evidence, visibility, target and opportunity validation', () => {
  const c = game();
  const input = { id: 'a', npcId: 'ally', trigger: { id: 'input', kind: 'player' }, decision: report };
  for (const decision of [{ ...report, evidenceIds: ['secret'] }, { ...report, evidenceIds: [] }, { ...report, visibility: 'secret' }, { ...report, targetId: 'ally' }]) assert.equal(commitNpcAction(c, { ...input, decision }), null);
  assert.equal(commitNpcAction(c, { ...input, trigger: { id: 'input', kind: 'combat' } }), null);
  assert.equal(commitNpcAction(c, { ...input, trigger: { id: 'input', kind: 'scene' } }).kind, 'act');
});

test('cancelled companion decision cannot publish an action', async () => {
  const c = game();
  const controller = new AbortController();
  const pending = decideParty({ campaign: c, cultivation, signal: controller.signal, trigger: { id: 'input', kind: 'player', text: 'hello' }, runNpc: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'ABORTED');
  assert.equal(c.state.autonomy?.actions?.length ?? 0, 0);
});
