import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExternalState } from 'dsh-cultivation/core';
import { zipSync } from 'fflate';
import { parse } from 'yaml';
import { createStore, parseArchive } from '../lib/store.js';
import { initialCampaignState, currentScene, canUseExit, moveScene, applyCheck, applyEncounter, publicCampaign, publicScene } from '../lib/core.js';
import { applyStoryReport } from '../lib/story.js';
import { makeDmPrompt } from '../lib/runtime.js';

const base = new URL('../demo/curtain-castle/', import.meta.url);
async function loadDemo() {
  const manifest = parse(await readFile(new URL('manifest.yaml', base), 'utf8'));
  const names = ['manifest.yaml', manifest.adventure, ...manifest.characters];
  const entries = Object.fromEntries(await Promise.all(names.map(async (name) => [name, new Uint8Array(await readFile(new URL(name, base)))])));
  return parseArchive(zipSync(entries));
}
function campaign(snapshot) {
  return { id: 'demo-test', scriptKey: `${snapshot.manifest.id}@${snapshot.manifest.version}`, scriptId: snapshot.manifest.id, scriptVersion: snapshot.manifest.version, title: snapshot.manifest.title, createdAt: '2026-01-01', updatedAt: '2026-01-01', ownerSessionId: 'demo-test-session', snapshot, state: initialCampaignState(snapshot, Object.fromEntries(snapshot.characters.map((npc) => [npc.id, npc.initialState]))) };
}

// Explore authored checks (both outcomes), combat rewards, and legal exits using
// real core mutations: graph-only reachability would miss impossible flag gates.
function explore(snapshot) {
  const states = new Map(), edges = new Map(), queue = [];
  const key = (game) => JSON.stringify([game.state.sceneId, Object.entries(game.state.flags).sort(([a], [b]) => a.localeCompare(b)), Object.keys(game.state.checks).sort(), Object.entries(game.state.encounters).map(([id, encounter]) => [id, encounter.defeated]).sort(([a], [b]) => a.localeCompare(b))]);
  function add(game) {
    const id = key(game);
    if (!states.has(id)) { states.set(id, game); queue.push(id); }
    return id;
  }
  add(campaign(snapshot));
  for (let index = 0; index < queue.length; index++) {
    assert.ok(queue.length < 10000, 'Demo state space unexpectedly large');
    const id = queue[index], game = states.get(id), scene = currentScene(game), next = [];
    if (!game.state.completed) {
      for (const check of scene.checks ?? []) {
        if (!check.repeatable && Object.hasOwn(game.state.checks, `${scene.id}:${check.id}`)) continue;
        for (const roll of [1, 20]) {
          const copy = structuredClone(game); applyCheck(copy, check.id, { roll }); next.push(add(copy));
        }
      }
      if (scene.encounter && !game.state.encounters[scene.id]?.defeated) {
        const copy = structuredClone(game);
        for (let attacks = 0; !copy.state.encounters[scene.id]?.defeated; attacks++) {
          assert.ok(attacks < 100, 'Demo encounter must be beatable');
          applyEncounter(copy, { playerRoll: 20, enemyRoll: 1 });
        }
        next.push(add(copy));
      }
      for (const exit of scene.exits.filter((item) => canUseExit(item, game.state))) {
        const copy = structuredClone(game); moveScene(copy, exit.to); next.push(add(copy));
      }
    }
    edges.set(id, next);
  }
  return { states, edges };
}

test('default curtain-castle v2 separates three companions from world characters', async () => {
  const snapshot = await loadDemo();
  assert.equal(snapshot.manifest.id, 'curtain-castle');
  assert.equal(snapshot.manifest.version, '2.1.1');
  assert.equal(snapshot.manifest.formatVersion, 2);
  assert.equal(snapshot.manifest.title, '这帮人脑子好像都有问题');
  assert.deepEqual(snapshot.characters.filter((npc) => npc.kind !== 'world').map((npc) => npc.id).sort(), ['bran', 'elin', 'lyra']);
  assert.deepEqual(snapshot.characters.filter((npc) => npc.kind === 'world').map((npc) => npc.id).sort(), ['adela', 'duke', 'sevian']);
  assert.equal(new Set(snapshot.adventure.scenes.map((scene) => scene.id)).size, snapshot.adventure.scenes.length);
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.ending));
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.encounter));
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.allowRest));
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.checks?.length));
  assert.equal(snapshot.adventure.entry, 'commission');
  assert.equal(snapshot.adventure.scenes.length, 14);
  const encounters = snapshot.adventure.scenes.filter((scene) => scene.encounter);
  assert.deepEqual(encounters.map((scene) => scene.id), ['gate', 'gallery', 'kennel', 'pantry', 'vestry', 'stairs']);
  for (const scene of encounters) {
    assert.equal(scene.encounter.hp, 1, `${scene.id} is a single weak-point encounter`);
    assert.ok(Object.keys(scene.encounter.rewardFlags).length > 0);
  }
  assert.equal(snapshot.adventure.player.attackBonus, 0);
  assert.equal(snapshot.adventure.player.damage, 1);
  assert.deepEqual(snapshot.adventure.scenes.filter((scene) => scene.ending).map((scene) => scene.id), ['epilogue']);
  assert.ok(!snapshot.adventure.scenes.find((scene) => scene.id === 'withdrawal').ending, 'refusal has a playable farewell');
});

test('ordinary narrated movement records actual progress without an action or exit approval', async () => {
  const game = campaign(await loadDemo());
  const narration = { eventId: 'narration-gate', text: '你来到城门，走进门边的维修小亭查看。石像鬼还守在铁门后。', sceneId: 'commission', audience: ['bran', 'lyra', 'elin'] };
  game.state.log.push({ role: 'dm', ...narration });
  applyStoryReport(game, { summary: '来到维修亭', sceneId: 'gate', location: '维修小亭内', items: [], npcs: [], events: [] }, narration);
  assert.equal(game.state.sceneId, 'gate');
  assert.equal(game.state.storyLocation.location, '维修小亭内');
  assert.equal(game.state.flags.gate_clear, undefined, 'narrated movement does not forge combat flags');
  assert.deepEqual(game.state.freeActionItems ?? [], []);
});

test('narrator can read author truths and character cards without being instructed to reveal them', async () => {
  const game = campaign(await loadDemo());
  const prompt = makeDmPrompt(game, { readOnly: false });
  assert.ok(prompt.includes(game.snapshot.adventure.dm.authorTruth));
  for (const npc of game.snapshot.characters) {
    assert.ok(prompt.includes(npc.name));
    if (npc.fields.privateHistory) assert.ok(prompt.includes(npc.fields.privateHistory));
    if (npc.fields.privateKnowledge) assert.ok(prompt.includes(npc.fields.privateKnowledge));
  }
  for (const phrase of ['不要让角色互相读心', '不把秘密提前说给玩家', '场景、节拍、出口、任务是世界和冲突的参考', '不是动作审批员']) assert.ok(prompt.includes(phrase), phrase);
  assert.match(game.snapshot.adventure.dm.world, /真正的吸血鬼晒太阳不会死/);
  assert.match(game.snapshot.adventure.dm.world, /声音嘶哑/);
  assert.match(game.snapshot.adventure.dm.authorTruth, /成年男性精灵/);
});

test('initial public UI does not expose author truths, hidden identities or private relationship cards', async () => {
  const game = campaign(await loadDemo());
  const ui = JSON.stringify(publicCampaign(game));
  assert.doesNotMatch(ui, /PRIVATE_|186岁|成年男性精灵|报复他在女儿成年宴|告白信|资格考核|健美比赛海报/);
  assert.ok(!ui.includes(game.snapshot.adventure.dm.authorTruth));
  const forward = publicScene(game).exits.find((exit) => exit.to === 'gate');
  assert.ok(forward);
  assert.doesNotMatch(forward.label, /城堡|窗帘|日出/);
});

test('characters retain comic motives, ordinary competence and open-ended relationships', async () => {
  const snapshot = await loadDemo();
  for (const npc of snapshot.characters) assert.ok(typeof npc.fields.competence === 'string' && npc.fields.competence.length > 20, npc.id);
  const fields = Object.fromEntries(snapshot.characters.map((npc) => [npc.id, npc.fields]));
  assert.match(fields.bran.competence, /不强制脚滑或意外/);
  assert.match(fields.lyra.competence, /不要求全靠碰巧/);
  assert.match(fields.elin.competence, /不是永久失职/);
  assert.match(fields.bran.affection, /不擅自宣布恋情/);
  assert.match(fields.elin.affection, /不预设她必定接受莱拉/);
  assert.match(fields.adela.boundary, /不预设和任何人的恋情必成或必败/);
  assert.match(snapshot.adventure.dm.rules.join('\n'), /不等独立agent、物品审批或记账工具批准/);
  assert.match(snapshot.adventure.dm.rules.join('\n'), /不强迫感情、立场或固定结局/);
});

test('commission uses employer discretion and narrator receives distinct character initiatives', async () => {
  const snapshot = await loadDemo();
  const duke = snapshot.characters.find((npc) => npc.id === 'duke');
  assert.ok(duke.fields.knowledge.includes('给他点教训，别把事情闹大'));
  assert.ok(!duke.fields.knowledge.includes('不得杀人'));
  const prompt = makeDmPrompt(campaign(snapshot), { readOnly: false });
  assert.ok(prompt.includes(duke.fields.commissionTone));
  const initiatives = snapshot.characters.filter((npc) => npc.kind !== 'world').map((npc) => npc.fields.initiative);
  assert.equal(new Set(initiatives).size, 3);
  for (const initiative of initiatives) { assert.equal(typeof initiative, 'string'); assert.ok(prompt.includes(initiative)); }
  // This verifies delivery of author material, not that an online model's dialogue is entertaining.
});

test('reference curtain route is optional and does not define an automatic ending', async () => {
  const { adventure } = await loadDemo();
  const bedroom = adventure.scenes.find((scene) => scene.id === 'bedchamber');
  const reveal = adventure.scenes.find((scene) => scene.id === 'sunlight');
  assert.equal(bedroom.encounter, undefined, 'The castle owner is a conversation, not a seventh combat');
  assert.equal(Boolean(reveal.ending), false, 'Reveal must allow players to respond before ending');
  const incoming = adventure.scenes.flatMap((scene) => scene.exits.filter((exit) => exit.to === 'sunlight').map((exit) => ({ sceneId: scene.id, ...exit })));
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].sceneId, 'bedchamber');
  assert.match(incoming[0].label, /拉开.*窗帘/);
  assert.ok(bedroom.exits.some((exit) => exit.to === 'withdrawal'), 'Player can refuse the central action');
  assert.ok(reveal.exits.some((exit) => exit.to === 'settlement'), 'Responsibility and payment remain playable');
  assert.ok(adventure.scenes.find((scene) => scene.id === 'confessional').exits.some((exit) => exit.to === 'vestry' && !exit.requires), 'Confession and intimacy must be optional');
});

test('legacy rule-compatible reference routes reach every scene without a check softlock', async () => {
  const snapshot = await loadDemo();
  const { states, edges } = explore(snapshot);
  assert.deepEqual([...new Set([...states.values()].map((game) => game.state.sceneId))].sort(), snapshot.adventure.scenes.map((scene) => scene.id).sort());
  const completable = new Set([...states].filter(([, game]) => game.state.completed).map(([id]) => id));
  assert.ok(completable.size > 0, 'At least one legal route must complete');
  let changed;
  do {
    changed = false;
    for (const [id, destinations] of edges) {
      if (!completable.has(id) && destinations.some((next) => completable.has(next))) { completable.add(id); changed = true; }
    }
  } while (changed);
  for (const [id, game] of states) assert.ok(completable.has(id), `No ending reachable from ${game.state.sceneId} with flags ${JSON.stringify(game.state.flags)}`);
});

test('compatible encounter numbers never turn a failed attack into progress', async () => {
  const snapshot = await loadDemo();
  for (const scene of snapshot.adventure.scenes.filter((item) => item.encounter)) {
    const game = campaign(snapshot);
    game.state.sceneId = scene.id;
    const onward = scene.exits.find((exit) => exit.requires);
    assert.ok(onward);
    const miss = applyEncounter(game, { playerRoll: 1, enemyRoll: 20 });
    assert.equal(miss.defeated, false);
    assert.equal(miss.enemyHp, 1);
    assert.ok(miss.received > 0);
    assert.equal(canUseExit(onward, game.state), false);
    const hit = applyEncounter(game, { playerRoll: 19, enemyRoll: 20 });
    assert.equal(hit.defeated, true);
    assert.equal(hit.enemyHp, 0);
    assert.equal(canUseExit(onward, game.state), true);
  }
});

test('importing 2.1.1 affects only new campaigns and preserves the previous frozen snapshot', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-curtain-version-'));
  const store = await createStore({ dir, cultivation: { createExternalState } });
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('dsh-curtain-version-'));
    await rm(dir, { recursive: true, force: true });
  });
  const source = await loadDemo();
  const previous = structuredClone(source);
  previous.manifest.version = '2.0.1';
  previous.adventure.dm.authorTruth = 'FROZEN_PREVIOUS_AUTHOR_MATERIAL';
  const archiveOf = (snapshot) => zipSync(Object.fromEntries([
    ['manifest.yaml', snapshot.manifest], [snapshot.manifest.adventure, snapshot.adventure],
    ...snapshot.characters.map((npc, index) => [snapshot.manifest.characters[index], npc])
  ].map(([name, value]) => [name, new TextEncoder().encode(JSON.stringify(value))])));
  await store.importArchive(archiveOf(previous));
  const old = await store.createCampaign({ scriptKey: 'curtain-castle@2.0.1', sessionId: 'old-session' });
  const frozenBefore = (await store.getCampaign(old.id)).snapshot;
  await store.importArchive(archiveOf(source));
  const created = await store.createCampaign({ scriptKey: 'curtain-castle@2.1.1', sessionId: 'new-session' });
  const current = await store.getCampaign(created.id);
  assert.equal(current.snapshot.manifest.version, '2.1.1');
  assert.ok(current.snapshot.adventure.dm.authorTruth.includes('PRIVATE_HOST_TRUTH'));
  const unchanged = await store.getCampaign(old.id);
  assert.equal(unchanged.scriptVersion, '2.0.1');
  assert.deepEqual(unchanged.snapshot, frozenBefore);
  assert.equal(unchanged.snapshot.adventure.dm.authorTruth, 'FROZEN_PREVIOUS_AUTHOR_MATERIAL');
});

test('built default ZIP matches the validated source snapshot', async () => {
  const source = await loadDemo();
  const archive = parseArchive(await readFile(new URL('../demo/curtain-castle.zip', import.meta.url)));
  assert.deepEqual(archive, source);
});
