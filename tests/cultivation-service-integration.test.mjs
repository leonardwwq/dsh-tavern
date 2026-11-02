import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import cultivationPlugin from 'dsh-cultivation';
import { createStore } from '../lib/store.js';
import { createGameRuntime } from '../lib/runtime.js';

// Uses the actual cultivation host service and actual campaign store/runtime.
// Both LLM stream output and prose recorder output below are deterministic MOCKS:
// this checks plumbing/persistence, not the quality or availability of a real model.
test('actual cultivation service with MOCK model fixtures settles multi-round narration and survives reopen', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tavern-cultivation-integration-'));
  const previousHome = process.env.DSH_HOME;
  const key = Symbol.for('dsh-cultivation/shared-state');
  const previousShared = globalThis[key];
  process.env.DSH_HOME = dir;
  const globalData = { version: 8, templates: {}, relations: {}, sessions: {}, sessionMoods: {} };
  globalThis[key] = { state: { data: globalData }, loading: null, writeChain: Promise.resolve(), writePending: false, migratedOnLoad: false };
  let store;
  t.after(async () => {
    if (store) await store.close();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousShared === undefined) delete globalThis[key]; else globalThis[key] = previousShared;
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.match(path.basename(dir), /^tavern-cultivation-integration-/);
    await rm(dir, { recursive: true, force: true });
  });
  const services = {}, requests = [], developmentRequests = [], appraisalRequests = [];
  const seenEvents = { a: [], b: [] };
  const ctx = {
    fs: new Proxy({}, { get() { assert.fail('cultivation must not access global files'); } }),
    sandboxPolicy: {}, agents: { roots: () => [] },
    systemPrompt: { section: () => () => {} }, webServer: { register: () => () => {} },
    tools: { register: () => () => {} }, on: () => {}, effect: (fn) => fn(),
    provide: (name, service) => { services[name] = service; return () => {}; },
    agentDefaultModel: { currentSelection: () => ({ provider: 'MOCK-OFFLINE', model: 'DETERMINISTIC-FIXTURE' }) },
    llm: { stream: async function* (request) {
      requests.push(request);
      const payload = JSON.parse(request.messages[0].content[0].text);
      if (payload.tasks) {
        developmentRequests.push({ request, payload });
        assert.deepEqual(payload.tasks, ['growth', 'mood']);
        const npcId = payload.event.npcText.startsWith('守卫') ? 'a' : 'b';
        assert.equal(seenEvents[npcId].length, 3);
        yield { type: 'text-delta', text: JSON.stringify({
          growth: { trait: npcId === 'a' ? '愿意交托后背' : '开始主动分享担忧', note: npcId === 'a' ? '三次并肩守夜后逐渐信赖玩家' : '多次共同照料伤者后愿意表达自己的顾虑', evidence: seenEvents[npcId].slice(0, 2) },
          mood: npcId === 'a' ? '安心但仍警觉' : '疲惫而欣慰'
        }) };
      } else {
        appraisalRequests.push({ request, payload });
        const npcId = payload.agentResponse.startsWith('守卫') ? 'a' : 'b';
        const turn = seenEvents[npcId].length + 1;
        seenEvents[npcId].push(payload.id);
        assert.equal(payload.observations[0], `OBS-${npcId}-${turn}`);
        const other = npcId === 'a' ? 'b' : 'a';
        assert.ok(!request.system.includes(`MEMORY-${other}-`), 'appraisal cannot read another NPC accumulated memory');
        if (turn > 1) assert.ok(request.system.includes(`MEMORY-${npcId}-${turn - 1}`), 'appraisal receives latest own accumulated state');
        // No mood field here: its independent 3-event development threshold must fire.
        yield { type: 'text-delta', text: JSON.stringify({ relevance: 1, valence: 1, arousal: 0.5, relationshipRelevance: 1, uncertainty: 0,
          memory: { facts: [`MEMORY-${npcId}-${turn}`] }, memoryLog: [`LOG-${npcId}-${turn}`] }) };
      }
    } }
  };
  await cultivationPlugin.apply(ctx);
  const cultivation = services.cultivation;
  assert.equal(cultivation.apiVersion, 1);
  assert.equal(typeof cultivation.developExternalState, 'function');
  const characters = [
    { id: 'a', name: '守卫', role: '守卫', goal: '守住城门', fields: { name: '守卫', traitTags: ['谨慎'] }, initialState: { intimacy: 11, memoryLog: [] } },
    { id: 'b', name: '药师', role: '药师', goal: '照料伤者', fields: { name: '药师', traitTags: ['温柔'] }, initialState: { intimacy: 21, memoryLog: [] } }
  ];
  const manifest = { formatVersion: 1, id: 'integration', version: '1.0.0', title: '测试', description: '离线集成测试冒险', capabilities: ['cultivation.external.v1'], adventure: 'adventure.json', characters: ['a.json', 'b.json'] };
  const adventure = { dm: { secret: '秘密', instructions: '主持冒险' }, entry: 'foyer', player: { name: '勇者', hp: 20, maxHp: 20, armorClass: 12, attackBonus: 3, damage: 5 }, scenes: [{ id: 'foyer', place: '门厅', timeOfDay: '霜月第三夜', opening: '门厅', cast: ['a', 'b'], exits: [] }] };
  const files = { 'manifest.json': manifest, 'adventure.json': adventure, ...Object.fromEntries(characters.map((npc) => [`${npc.id}.json`, npc])) };
  const archive = zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(JSON.stringify(value))])));
  store = await createStore({ dir: path.join(dir, 'store'), cultivation });
  await store.importArchive(archive);
  const campaign = await store.createCampaign({ scriptKey: 'integration@1.0.0', sessionId: 'game' });
  const recordRequests = [];
  const makeRuntime = () => createGameRuntime({ store, cultivation,
    runNpc: async () => assert.fail('retired react/speak chain must not execute'),
    runStoryReport: async (request) => {
      recordRequests.push(request);
      assert.equal(request.phase, 'record');
      const context = JSON.parse(request.prompt.split('\n\n').at(-1));
      const turn = Number(context.narration.eventId.split('-').at(-1));
      assert.equal(context.narration.text, `第${turn}轮：守卫与玩家一起守门；药师与玩家照料伤者。`);
      assert.equal(context.playerInput.text, `第${turn}轮我愿意帮忙。`);
      return { summary: `第${turn}轮合作已发生`, sceneId: '', location: '', items: [], events: [],
        npcs: [
          { npcId: 'a', speech: `守卫：第${turn}轮谢谢你守门。`, observations: [`OBS-a-${turn}`] },
          { npcId: 'b', speech: `药师：第${turn}轮谢谢你照料伤者。`, observations: [`OBS-b-${turn}`] }
        ] };
    }
  });
  let runtime = makeRuntime();
  for (let turn = 1; turn <= 3; turn++) {
    await runtime.recordInput('game', { id: `message-${turn}`, role: 'user', content: [{ type: 'text', text: `第${turn}轮我愿意帮忙。` }] });
    const narration = `第${turn}轮：守卫与玩家一起守门；药师与玩家照料伤者。`;
    await runtime.recordNarration('game', `dm-${turn}`, narration);
    assert.equal(requests.length, (turn - 1) * 2, 'committing prose does not wait for or run appraisal');
    await runtime.settleNarration('game');
    const saved = await store.getCampaign(campaign.id);
    assert.equal(saved.state.storyTasks[`dm-${turn}`].status, 'recorded');
    assert.deepEqual(Object.values(saved.state.storyTasks[`dm-${turn}`].cultivation).map((entry) => entry.status), ['done', 'done']);
    for (const npcId of ['a', 'b']) {
      const state = saved.state.npcs[npcId];
      assert.equal(state.processedEventIds.length, turn);
      assert.deepEqual(state.memory.facts, Array.from({ length: turn }, (_, i) => `MEMORY-${npcId}-${i + 1}`));
      assert.deepEqual(state.knows, Array.from({ length: turn }, (_, i) => `OBS-${npcId}-${i + 1}`));
      assert.equal(state.intimacy, (npcId === 'a' ? 11 : 21) + turn * 2);
      assert.equal(state.development.growth, turn < 3 ? 0 : 3);
      assert.equal(state.development.mood, turn < 3 ? 0 : 3);
      assert.equal(state.growth.length, turn < 3 ? 0 : 1);
    }
    const prompt = await runtime.makePrompt('game');
    for (const npcId of ['a', 'b']) for (let i = 1; i <= turn; i++) assert.ok(prompt.includes(`MEMORY-${npcId}-${i}`), 'both independent accumulated cards enter next DM prompt');
    if (turn < 3) assert.equal(developmentRequests.length, 0, 'no per-turn forced development');
    if (turn === 2) {
      const before = structuredClone(saved.state.npcs);
      await store.close();
      store = await createStore({ dir: path.join(dir, 'store'), cultivation });
      runtime = makeRuntime();
      assert.deepEqual((await store.getCampaign(campaign.id)).state.npcs, before, 'event-count progress survives reopen before threshold');
    }
  }
  assert.equal(recordRequests.length, 3);
  assert.equal(appraisalRequests.length, 6);
  assert.equal(developmentRequests.length, 2);
  assert.equal(requests.length, 8);
  const final = await store.getCampaign(campaign.id);
  assert.equal(final.state.npcs.a.growth[0].trait, '愿意交托后背');
  assert.equal(final.state.npcs.b.growth[0].trait, '开始主动分享担忧');
  assert.deepEqual(final.state.npcs.a.mood, { text: '安心但仍警觉', since: '霜月第三夜' });
  assert.deepEqual(final.state.npcs.b.mood, { text: '疲惫而欣慰', since: '霜月第三夜' });
  const prompt = await runtime.makePrompt('game');
  for (const text of ['愿意交托后背', '开始主动分享担忧', '安心但仍警觉', '疲惫而欣慰']) assert.ok(prompt.includes(text));

  await store.close();
  store = await createStore({ dir: path.join(dir, 'store'), cultivation });
  runtime = makeRuntime();
  assert.equal(await runtime.recordInput('game', { id: 'message-3', content: [{ type: 'text', text: '重复输入不得推进' }] }), false);
  await runtime.recordNarration('game', 'dm-3', '重复正文不得覆盖');
  await runtime.settleNarration('game', { retry: true });
  await runtime.settleNarration('game');
  assert.deepEqual((await store.getCampaign(campaign.id)).state, final.state);
  assert.equal(requests.length, 8);
  assert.equal(recordRequests.length, 3);
  // Also exercise the service's saved event receipt and development watermark directly.
  const receipt = final.state.storyReports['dm-3'].npcEvents[0];
  const npcState = final.state.npcs[receipt.npcId];
  const persona = characters.find((npc) => npc.id === receipt.npcId);
  assert.deepEqual(await cultivation.processExternalEvent({ persona, state: npcState, event: receipt.event }), { state: npcState, changes: [] });
  assert.deepEqual(await cultivation.developExternalState({ persona, state: npcState, event: receipt.event }), { state: npcState, changes: [], pendingTasks: [] });
  assert.equal(requests.length, 8);
  assert.deepEqual(globalData, { version: 8, templates: {}, relations: {}, sessions: {}, sessionMoods: {} });
  assert.deepEqual(await readdir(dir), ['store'], 'no global persona file or diagnostic log is written');
});
