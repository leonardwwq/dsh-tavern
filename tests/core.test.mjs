import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { applyCheck, applyEncounter, canonicalJson, cloneJson, contentHash, d20Check, initialCampaignState, moveScene, publicCampaign, restPlayer, rollD20, validateContentPath, validateScript } from '../lib/core.js';

async function demo() {
  const read = async (file) => parse(await readFile(new URL(`../demo/graystone/${file}`, import.meta.url), 'utf8'));
  return validateScript({ manifest: await read('manifest.yaml'), adventure: await read('adventure.yaml'), characters: await Promise.all(['warrior', 'ranger', 'cleric'].map((name) => read(`characters/${name}.yaml`))), assets: {} });
}
async function campaign() {
  const snapshot = await demo();
  return { id: 'example', scriptKey: 'graystone-mine@1.0.0', scriptId: 'graystone-mine', scriptVersion: '1.0.0', title: 'Test', createdAt: '2026-01-01', updatedAt: '2026-01-01', ownerSessionId: 's1', snapshot, state: initialCampaignState(snapshot, Object.fromEntries(snapshot.characters.map((npc) => [npc.id, npc.initialState]))) };
}

test('demo validates with four scenes and three distinct local NPCs', async () => {
  const script = await demo();
  assert.equal(script.adventure.scenes.length, 4);
  assert.deepEqual(script.characters.map((npc) => npc.role), ['战士', '游侠', '牧师']);
  const copy = validateScript(script);
  copy.adventure.dm.secrets.truth = 'changed';
  assert.notEqual(script.adventure.dm.secrets.truth, 'changed');
});

test('broken references, unsupported capabilities and duplicate IDs are rejected', async () => {
  for (const mutate of [
    (s) => s.adventure.scenes[0].exits[0].to = 'missing',
    (s) => s.adventure.scenes[0].cast.push('missing'),
    (s) => s.adventure.entry = 'missing',
    (s) => s.characters[1].id = s.characters[0].id,
    (s) => s.manifest.capabilities.push('global.persona'),
    (s) => s.manifest.formatVersion = 2,
    (s) => s.adventure.scenes[0].checks[0].successFlags = ['not-a-map'],
    (s) => s.adventure.scenes[0].npcGoals.unknown = 'goal',
  ]) {
    const script = await demo(); mutate(script);
    assert.throws(() => validateScript(script));
  }
});

test('strict JSON copies reject pollution, cycles, accessors and non-finite numbers', () => {
  for (const input of [JSON.parse('{"__proto__":{"polluted":true}}'), JSON.parse('{"nested":{"constructor":{}}}'), { value: NaN }, { value: undefined }, new Date()]) assert.throws(() => cloneJson(input));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => cloneJson(cycle));
  const accessor = {}; Object.defineProperty(accessor, 'x', { enumerable: true, get() { throw new Error('getter should not run'); } });
  assert.throws(() => cloneJson(accessor), /accessors/);
  assert.equal({}.polluted, undefined);
  assert.equal(canonicalJson({ b: [2], a: 1 }), canonicalJson({ a: 1, b: [2] }));
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
});

test('archive paths reject traversal, Windows absolute and ambiguous names', () => {
  for (const value of ['../a', 'a/../b', '/etc/a', 'C:/a', 'C:\\a', '\\\\server\\share', 'a//b', './x', 'a\0b', 'a/__proto__/b']) assert.throws(() => validateContentPath(value));
  assert.equal(validateContentPath('characters/warrior.yaml'), 'characters/warrior.yaml');
});

test('d20 boundaries, natural outcomes, and deterministic rolls', () => {
  assert.equal(rollD20(() => 0), 1);
  assert.equal(rollD20(() => 0.99999), 20);
  assert.throws(() => rollD20(() => 1));
  assert.equal(d20Check({ dc: 12, bonus: 2, roll: 10 }).success, true);
  assert.equal(d20Check({ dc: 2, bonus: 20, roll: 1 }).success, false);
  assert.equal(d20Check({ dc: 40, bonus: -20, roll: 20 }).success, true);
  assert.throws(() => d20Check({ dc: 10, roll: 0 }));
});

test('branch check is authored, cached, and opens the noncombat ending', async () => {
  const game = await campaign();
  assert.throws(() => moveScene(game, 'dawn'), { code: 'INVALID_EXIT' });
  moveScene(game, 'fork');
  assert.throws(() => moveScene(game, 'dawn'), { code: 'EXIT_LOCKED' });
  const result = applyCheck(game, 'trace-airflow', { roll: 12 });
  assert.equal(result.success, true);
  const repeated = applyCheck(game, 'trace-airflow', { roll: 1 });
  assert.equal(repeated.cached, true);
  assert.equal(repeated.roll, 12);
  moveScene(game, 'dawn');
  assert.equal(game.state.completed, true);
  assert.equal(game.state.status, 'completed');
});

test('failed route still permits combat, retreat and safe recovery without resetting enemy', async () => {
  const game = await campaign();
  moveScene(game, 'fork');
  assert.equal(applyCheck(game, 'trace-airflow', { roll: 1 }).success, false);
  moveScene(game, 'chamber');
  assert.throws(() => restPlayer(game), { code: 'REST_NOT_ALLOWED' });
  const turn = applyEncounter(game, { playerRoll: 10, enemyRoll: 20 });
  assert.equal(turn.damage, 6);
  assert.equal(turn.received, 8);
  assert.equal(turn.enemyHp, 12);
  moveScene(game, 'fork'); moveScene(game, 'camp');
  assert.equal(restPlayer(game).healed, 8);
  moveScene(game, 'fork'); moveScene(game, 'chamber');
  const finish = applyEncounter(game, { playerRoll: 20, enemyRoll: 20 });
  assert.equal(finish.damage, 12);
  assert.equal(finish.retaliation, null);
  assert.equal(game.state.flags.core_recovered, true);
  assert.throws(() => applyEncounter(game), { code: 'ENCOUNTER_DEFEATED' });
  moveScene(game, 'dawn');
  assert.equal(game.state.completed, true);
});

test('public projection never exposes DM secrets or local NPC memories / state internals', async () => {
  const game = await campaign();
  game.state.flags.private_flag = 'PRIVATE_FLAG';
  game.state.log.push({ secret: 'PRIVATE_LOG' });
  const view = publicCampaign(game);
  const serialized = JSON.stringify(view);
  for (const marker of ['PRIVATE_', 'privateHistory', 'initialState', 'npcKnowledge', 'knows', 'intimacy', 'memory', 'npcGoals']) assert.equal(serialized.includes(marker), false, marker);
  assert.equal(view.script.characterCount, 3);
  assert.equal(view.state.player.hp, 24);
  view.state.player.hp = 0;
  assert.equal(game.state.player.hp, 24);
});
