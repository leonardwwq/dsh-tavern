import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { parse } from 'yaml';
import { parseArchive } from '../lib/store.js';
import { initialCampaignState, currentScene, canUseExit, moveScene, applyCheck, applyEncounter } from '../lib/core.js';

const base = new URL('../demo/curtain-castle/', import.meta.url);
async function loadDemo() {
  const manifest = parse(await readFile(new URL('manifest.yaml', base), 'utf8'));
  const names = ['manifest.yaml', manifest.adventure, ...manifest.characters];
  const entries = Object.fromEntries(await Promise.all(names.map(async (name) => [name, new Uint8Array(await readFile(new URL(name, base)))])));
  return parseArchive(zipSync(entries));
}
function campaign(snapshot) {
  return { snapshot, state: initialCampaignState(snapshot, Object.fromEntries(snapshot.characters.map((npc) => [npc.id, npc.initialState]))) };
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

test('default curtain-castle source is a valid versioned package with three stable NPC IDs', async () => {
  const snapshot = await loadDemo();
  assert.equal(snapshot.manifest.id, 'curtain-castle');
  assert.equal(snapshot.manifest.version, '1.0.0');
  assert.equal(snapshot.manifest.title, '这帮人脑子好像都有问题');
  assert.deepEqual(snapshot.characters.map((npc) => npc.id).sort(), ['bran', 'elin', 'lyra']);
  assert.equal(new Set(snapshot.adventure.scenes.map((scene) => scene.id)).size, snapshot.adventure.scenes.length);
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.ending));
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.encounter));
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.allowRest));
  assert.ok(snapshot.adventure.scenes.some((scene) => scene.checks?.length));
  assert.equal(snapshot.adventure.entry, 'commission');
  assert.equal(snapshot.adventure.scenes.length, 13);
  const encounters = snapshot.adventure.scenes.filter((scene) => scene.encounter);
  assert.deepEqual(encounters.map((scene) => scene.id), ['gate', 'gallery', 'kennel', 'pantry', 'vestry', 'stairs']);
  for (const scene of encounters) {
    assert.equal(scene.encounter.hp, 1, `${scene.id} is a single weak-point encounter`);
    assert.ok(Object.keys(scene.encounter.rewardFlags).length > 0);
  }
  assert.equal(snapshot.adventure.player.attackBonus, 0);
  assert.equal(snapshot.adventure.player.damage, 1);
  assert.deepEqual(snapshot.adventure.scenes.filter((scene) => scene.ending).map((scene) => scene.id).sort(), ['departure', 'withdrawal']);
});

test('curtain reveal follows a deliberate bedroom exit, not combat or an automatic ending', async () => {
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

test('curtain-castle authored routes reach every scene and no check outcome creates a softlock', async () => {
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

test('weak-point luck never turns a missed attack into progress', async () => {
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

test('built default ZIP matches the validated source snapshot', async () => {
  const source = await loadDemo();
  const archive = parseArchive(await readFile(new URL('../demo/curtain-castle.zip', import.meta.url)));
  assert.deepEqual(archive, source);
});
