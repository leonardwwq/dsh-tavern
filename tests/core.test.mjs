import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { applyFreeAction, applyCheck, applyEncounter, canonicalJson, cloneJson, contentHash, d20Check, initialCampaignState, moveScene, publicCampaign, restPlayer, rollD20, validateContentPath, validateScript } from '../lib/core.js';

async function demo() {
  const read = async (file) => parse(await readFile(new URL(`./fixtures/graystone/${file}`, import.meta.url), 'utf8'));
  return validateScript({ manifest: await read('manifest.yaml'), adventure: await read('adventure.yaml'), characters: await Promise.all(['warrior', 'ranger', 'cleric'].map((name) => read(`characters/${name}.yaml`))), assets: {} });
}
async function campaign() {
  const snapshot = await demo();
  return { id: 'example', scriptKey: 'graystone-mine@1.0.0', scriptId: 'graystone-mine', scriptVersion: '1.0.0', title: 'Test', createdAt: '2026-01-01', updatedAt: '2026-01-01', ownerSessionId: 's1', snapshot, state: initialCampaignState(snapshot, Object.fromEntries(snapshot.characters.map((npc) => [npc.id, npc.initialState]))) };
}

test('free actions expose only public observations and authored defeated-enemy materials', async () => {
  const game = await campaign();
  const scene = game.snapshot.adventure.scenes[0];
  const target = scene.place;
  const before = structuredClone({ hp: game.state.player.hp, flags: game.state.flags });
  assert.throws(() => applyFreeAction(game, { kind: 'explore', target }, `不要搜索${target}`), { code: 'ACTION_NOT_EXPLICIT' });
  const unknown = applyFreeAction(game, { kind: 'explore', target: '秘密通道' }, '搜索秘密通道');
  assert.match(unknown.outcome, /尚不能确认/);
  assert.deepEqual(unknown.items, []);
  assert.equal(applyFreeAction(game, { kind: 'explore', target }, `搜索${target}`).kind, 'explore');
  assert.equal(applyFreeAction(game, { kind: 'explore', target }, `搜索${target}`).alreadyExplored, true);
  assert.equal(publicCampaign(game).state.freeActionResults.length, 2);
  assert.deepEqual({ hp: game.state.player.hp, flags: game.state.flags }, before);
  moveScene(game, 'fork'); moveScene(game, 'chamber');
  const encounter = game.snapshot.adventure.scenes.find((s) => s.id === 'chamber').encounter;
  encounter.materials = [{ id: 'scale', name: '鳞片', collectible: true }];
  assert.throws(() => applyFreeAction(game, { kind: 'loot', target: '鳞片' }, '拾取鳞片'), { code: 'ACTION_DURING_COMBAT' });
  applyEncounter(game, { playerRoll: 20, enemyRoll: 1 });
  applyEncounter(game, { playerRoll: 20, enemyRoll: 1 });
  assert.throws(() => applyFreeAction(game, { kind: 'loot', target: '牙' }, '拔牙'), { code: 'MATERIAL_UNAVAILABLE' });
  assert.equal(applyFreeAction(game, { kind: 'loot', target: '鳞片' }, '拾取鳞片').items[0].name, '鳞片');
  assert.equal(applyFreeAction(game, { kind: 'loot', target: '鳞片' }, '拾取鳞片').alreadyCollected, true);
  assert.equal(publicCampaign(game).state.inventory.length, 1);
});

test('free actions preserve target spelling while normalizing only surrounding syntax', async () => {
  const game = await campaign();
  const scene = game.snapshot.adventure.scenes[0];
  const names = ['旧 木箱', 'Silver Key', '红,蓝宝箱', '红，蓝宝箱', '观察站', '检查站'];
  scene.opening = names.join('、');
  for (const target of names) {
    assert.equal(applyFreeAction(game, { kind: 'explore', target }, `我， 查看 ${target} 一下！`).target, target);
    assert.equal(applyFreeAction(game, { kind: 'explore', target }, `我去 ${target} 看看`).position.relation, 'near');
    for (const text of [`不要查看${target}`, `如果我查看${target}`, `他说“查看${target}”`, `让他查看${target}`, `查看${target}，不要查看${target}`, `先休息，再查看${target}`]) {
      assert.throws(() => applyFreeAction(game, { kind: 'explore', target }, text), { code: 'ACTION_NOT_EXPLICIT' }, text);
    }
  }
  for (const target of ['箱子，不要查看宝箱', '箱子，我不去宝箱', '箱子，查看宝箱', '“箱子”']) {
    scene.opening += target;
    assert.throws(() => applyFreeAction(game, { kind: 'explore', target }, `查看${target}`), { code: 'ACTION_NOT_EXPLICIT' }, target);
  }
  moveScene(game, 'fork'); moveScene(game, 'chamber');
  const encounter = game.snapshot.adventure.scenes.find((s) => s.id === 'chamber').encounter;
  encounter.materials = [{ id: 'scale', name: 'Silver, Scale', collectible: true }];
  applyEncounter(game, { playerRoll: 20, enemyRoll: 1 });
  applyEncounter(game, { playerRoll: 20, enemyRoll: 1 });
  assert.equal(applyFreeAction(game, { kind: 'loot', target: 'Silver, Scale' }, '我，拾取 Silver, Scale').items[0].name, 'Silver, Scale');
  assert.throws(() => applyFreeAction(game, { kind: 'loot', target: 'Silver, Scale' }, '拾取Silver,Scale'), { code: 'MATERIAL_UNAVAILABLE' });
});

test('explicit pavilion observation and emphatic entry preserve action boundaries', async () => {
  const game = await campaign();
  const scene = game.snapshot.adventure.scenes[0];
  scene.opening = '旁边有一座维修亭。';
  const action = { kind: 'explore', target: '维修亭' };
  const observed = applyFreeAction(game, action, '看看维修亭里有什么');
  assert.equal(observed.examined, true);
  assert.equal(game.state.playerPosition, undefined);
  const entered = applyFreeAction(game, action, '我踏马的要进维修亭看看，我说第三遍了');
  assert.equal(entered.examined, true);
  assert.equal(entered.position.relation, 'inside');
  for (const text of [
    '不要看看维修亭里有什么', '看看维修亭里有什么吗？', '如果看看维修亭里有什么',
    '他说“看看维修亭里有什么”',
    '如果我踏马的要进维修亭看看，我说第三遍了', '我不要进维修亭看看',
    '他说“我踏马的要进维修亭看看，我说第三遍了”',
    '所有人都进去看',
  ]) assert.throws(() => applyFreeAction(game, action, text), { code: 'ACTION_NOT_EXPLICIT' }, text);
  const npc = game.snapshot.characters[0].name;
  assert.throws(() => applyFreeAction(game, action, `${npc}看看维修亭里有什么`), { code: 'ACTION_NOT_EXPLICIT' });
  scene.opening = '旁边有一座维修亭，入口被锁住。';
  assert.throws(() => applyFreeAction(game, action, '我踏马的要进维修亭看看，我说第三遍了'), { code: 'ACTION_UNCERTAIN' });
});

test('movement applies only to the target governed by the player action', async () => {
  const game = await campaign();
  game.snapshot.adventure.scenes[0].opening = '旁边有维修亭，远处是河边。';
  const before = structuredClone(game.state);
  assert.throws(() => applyFreeAction(game, { kind: 'explore', target: '维修亭' }, '我看看维修亭，然后去河边'), { code: 'ACTION_UNCERTAIN' });
  assert.deepEqual(game.state, before);
  assert.equal(applyFreeAction(game, { kind: 'explore', target: '河边' }, '我看看维修亭，然后去河边').position.target, '河边');
});

test('natural pavilion movement resolves a visible diminutive without inventing targets', async () => {
  const game = await campaign();
  const scene = game.snapshot.adventure.scenes[0];
  scene.opening = '铁门后石像鬼挡住道路，门边有一间维修小亭。';
  const action = { kind: 'explore', target: '维修亭' };
  const result = applyFreeAction(game, action, '去维修亭看看');
  assert.equal(result.examined, true);
  assert.equal(result.position.relation, 'near');
  assert.equal(game.state.playerPosition.target, '维修亭');
  assert.equal(applyFreeAction(game, action, '我查看维修亭一下').examined, true);
  assert.equal(applyFreeAction(game, action, '我走进维修亭看看里面有什么').position.relation, 'inside');
  const entered = applyFreeAction(game, action, '我进维修亭');
  assert.equal(entered.position.relation, 'inside');
  assert.match(entered.outcome, /已进入/);
  assert.throws(() => applyFreeAction(game, action, '不要进维修亭'), { code: 'ACTION_NOT_EXPLICIT' });
  scene.opening = '旁边有一间维修亭，门被锁住。';
  assert.throws(() => applyFreeAction(game, action, '我进维修亭'), { code: 'ACTION_UNCERTAIN' });
  scene.opening = '铁门后石像鬼挡住道路，门边有一间维修小亭。';
  assert.equal(applyFreeAction(game, action, `${game.snapshot.characters[0].name}，我去维修亭看看`).position.relation, 'near');
  assert.throws(() => applyFreeAction(game, action, `${game.snapshot.characters[0].name}，你去维修亭看看`), { code: 'ACTION_NOT_EXPLICIT' });
  assert.throws(() => applyFreeAction(game, action, '不要去维修亭看看'), { code: 'ACTION_NOT_EXPLICIT' });
  assert.throws(() => applyFreeAction(game, { kind: 'explore', target: '秘密亭' }, '去秘密亭看看'), { code: 'ACTION_UNCERTAIN' });
  scene.opening += '远处还有一座维修亭。';
  assert.throws(() => applyFreeAction(game, action, '我想去维修亭看一看'), { code: 'ACTION_TARGET_NOT_PUBLIC' });
  const npcName = game.snapshot.characters[0].name;
  scene.opening = `旁边有一间${npcName}的小屋。`;
  assert.equal(applyFreeAction(game, { kind: 'explore', target: `${npcName}的小屋` }, `查看${npcName}的小屋`).examined, true);
});

test('DM semantic proposals accept natural observation without fabricating outcomes', async () => {
  const game = await campaign();
  const before = structuredClone({ flags: game.state.flags, encounters: game.state.encounters, hp: game.state.player.hp });
  for (const [target, input] of [
    ['石墙', '我仔细打量周围的墙面，寻找可疑的痕迹。'],
    ['角落', '借着火光，我想仔细观察一下那个阴暗的角落。'],
    ['可疑痕迹', '我蹲下来研究那些痕迹，看看有什么线索。'],
  ]) {
    const result = applyFreeAction(game, { kind: 'explore', target }, input);
    assert.equal(result.examined, true);
    assert.deepEqual(result.items, []);
    assert.match(result.outcome, /尚不能确认/);
  }
  assert.deepEqual({ flags: game.state.flags, encounters: game.state.encounters, hp: game.state.player.hp }, before);
  assert.equal(game.state.playerPosition, undefined);
  for (const input of ['我不搜索墙面', '我没打算查看墙面', '是否要搜索墙面', '假如我观察墙面', '让他去查看墙面', '你来调查墙面', '他说“我搜索墙面”']) {
    const prior = structuredClone(game.state);
    assert.throws(() => applyFreeAction(game, { kind: 'explore', target: '石墙' }, input), { code: 'ACTION_NOT_EXPLICIT' }, input);
    assert.deepEqual(game.state, prior);
  }
});

test('reported and negated actions do not mutate state, while direct actions remain available', async () => {
  const game = await campaign();
  const action = { kind: 'explore', target: '门厅' };
  game.snapshot.adventure.scenes[0].opening = '旁边有一间门厅，附近是营地。';
  for (const input of ['不要搜索门厅', '我能搜索门厅吗？', '队友说搜索门厅', '同伴建议查看门厅', '如果我搜索门厅会怎样', '我没搜索门厅']) {
    const before = structuredClone(game.state);
    assert.throws(() => applyFreeAction(game, action, input), { code: 'ACTION_NOT_EXPLICIT' }, input);
    assert.deepEqual(game.state, before);
  }
  const before = structuredClone(game.state);
  assert.throws(() => applyFreeAction(game, action, '我去看看营地'), { code: 'ACTION_UNCERTAIN' });
  assert.deepEqual(game.state, before);
  assert.equal(applyFreeAction(game, action, '我去门厅看看').position.relation, 'near');
});

test('material collection binds the verb to its target and permits retry', async () => {
  const game = await campaign();
  moveScene(game, 'fork'); moveScene(game, 'chamber');
  const encounter = game.snapshot.adventure.scenes.find((s) => s.id === 'chamber').encounter;
  encounter.materials = [{ id: 'scale', name: '鳞片', collectible: true }];
  applyEncounter(game, { playerRoll: 20, enemyRoll: 1 });
  applyEncounter(game, { playerRoll: 20, enemyRoll: 1 });
  const action = { kind: 'loot', target: '鳞片' };
  for (const input of ['我拿起剑，鳞片留在原地', '队友说拾取鳞片', '我想象自己拾取鳞片', '我不拾取鳞片', '我拿起剑然后拾取鳞片']) {
    const before = structuredClone(game.state);
    assert.throws(() => applyFreeAction(game, action, input), { code: 'ACTION_NOT_EXPLICIT' }, input);
    assert.deepEqual(game.state, before);
  }
  assert.equal(applyFreeAction(game, action, '我捡起鳞片').items[0].name, '鳞片');
});

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
    (s) => s.manifest.formatVersion = 3,
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
