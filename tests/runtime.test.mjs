import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createExternalState, renderExternalCard, processExternalEvent } from 'dsh-cultivation/core';
import { createStore } from '../lib/store.js';
import { createGameRuntime, DM_TOOLS, makeDmPrompt, visibleHistory } from '../lib/runtime.js';

const DM_SECRET = 'DM_SECRET_hidden_dragon_identity';
const NPC_A_SECRET = 'NPC_A_SECRET_stolen_royal_key';
const NPC_C_SECRET = 'NPC_C_SECRET_secret_oath';
const appraisal = { relevance: 1, valence: 1, arousal: 0.5, relationshipRelevance: 1, uncertainty: 0 };
function script(version = '1.0.0', intimacy = 11) {
  const characters = ['a', 'b', 'c'].map((id) => ({ id, name: `队友-${id}`, role: `职业-${id}`, goal: '保护玩家',
    fields: { name: `队友-${id}`, traitTags: ['谨慎'], speechStyle: ['简洁'], secrets: id === 'a' ? NPC_A_SECRET : id === 'c' ? NPC_C_SECRET : '只是普通路人' },
    reactions: ['真诚会逐渐赢得信任'], initialState: { intimacy, memoryLog: [] } }));
  const manifest = { formatVersion: 1, id: 'runtime-test', version, title: '封印之门', description: '测试用的冒险', capabilities: ['cultivation.external.v1'], adventure: 'adventure.json', characters: characters.map((npc) => `${npc.id}.json`) };
  const adventure = { dm: { secret: DM_SECRET, instructions: '主持一场有选择的冒险' }, entry: 'foyer', player: { name: '勇者', hp: 20, maxHp: 20, armorClass: 12, attackBonus: 3, damage: 5 }, scenes: [
    { id: 'foyer', place: '门厅', timeOfDay: '霜月第三夜', opening: '门厅灯火摇曳。', cast: ['a', 'b'], allowRest: true, checks: [{ id: 'shared', label: '门厅检定', dc: 12, bonus: 0 }], exits: [{ to: 'hall', label: '推开内门' }], encounter: { id: 'guard', name: '石像守卫', hp: 40, armorClass: 10, attackBonus: 1, damage: 3, rewardFlags: { guardDown: true } } },
    { id: 'hall', place: '大厅', timeOfDay: '破晓前', opening: '大厅中传来脚步声。', cast: ['b', 'c'], checks: [{ id: 'shared', label: '大厅检定', dc: 13, bonus: 1 }], exits: [{ to: 'foyer', label: '返回门厅' }, { to: 'ending', label: '离开遗迹' }] },
    { id: 'ending', place: '遗迹之外', opening: '众人平安离开。', cast: ['a', 'b', 'c'], ending: true, exits: [] }
  ] };
  return { manifest, adventure, characters };
}
function archive(source) {
  return zipSync(Object.fromEntries([
    ['manifest.json', source.manifest], ['adventure.json', source.adventure], ...source.characters.map((npc) => [`${npc.id}.json`, npc])
  ].map(([name, value]) => [name, strToU8(JSON.stringify(value))])));
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const report = (extra = {}) => ({ summary: '已发生事实', sceneId: '', location: '', items: [], npcs: [], events: [], ...extra });
const purse = { id: 'purse', name: '钱袋', quantity: 1, description: '已交付定金', removed: false };
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-tavern-runtime-'));
  const calls = [], evaluations = [], developments = [];
  let respond = options.runStoryReport ?? (async () => report());
  const cultivation = {
    apiVersion: 1, createExternalState, renderExternalCard,
    processExternalEvent: (input) => processExternalEvent(input, async (context) => { evaluations.push(structuredClone({ ...context, input })); return appraisal; }),
    async developExternalState(input) { developments.push(structuredClone(input)); return { state: input.state, changes: [], pendingTasks: [] }; }
  };
  const store = await createStore({ dir, cultivation });
  t.after(async () => { await store.close(); assert.equal(path.dirname(dir), path.resolve(tmpdir())); await rm(dir, { recursive: true, force: true }); });
  await store.importArchive(archive(options.script ?? script()));
  const campaign = await store.createCampaign({ scriptKey: 'runtime-test@1.0.0', sessionId: 'game-1' });
  const runtime = createGameRuntime({ store, cultivation, random: options.random ?? (() => 0.5), runStoryReport: async (request) => { calls.push(request); return respond(request); }, runNpc: async () => assert.fail('现场 NPC runner 不应调用') });
  return { dir, store, runtime, cultivation, campaign, calls, evaluations, developments, setRespond(fn) { respond = fn; },
    input: (id = 'input-1', text = '拿钱走人', sessionId = 'game-1') => runtime.recordInput(sessionId, { id, role: 'user', content: [{ type: 'text', text }] }),
    game: () => store.getCampaign(campaign.id), view: () => store.getPublicCampaign(campaign.id) };
}

test('only numerical DM tools remain; old approval operations cannot enter the runtime', async (t) => {
  const h = await setup(t);
  assert.deepEqual(DM_TOOLS, ['tavern_status', 'tavern_check', 'tavern_combat', 'tavern_rest']);
  await h.input(); const before = await h.game();
  for (const operation of ['tavern_action', 'tavern_delivery', 'tavern_speak', 'tavern_scene', 'tavern_beat', 'tavern_leave', 'tavern_return', 'tavern_offscreen']) await assert.rejects(h.runtime.perform('game-1', operation), { code: 'NARRATIVE_ACTION' });
  assert.deepEqual(await h.game(), before); assert.equal(h.calls.length, 0);
});

test('real inputs are recorded once without all-NPC reactions; compatibility react is inert', async (t) => {
  const h = await setup(t);
  assert.equal(await h.input(), true); assert.equal(await h.input(), false);
  for (let i = 0; i < 2; i++) assert.deepEqual(await h.runtime.react('game-1'), { actions: [], agencyDiagnostics: [] });
  assert.equal(h.calls.length, 0); assert.equal(h.evaluations.length, 0);
  assert.equal((await h.game()).state.turnIndex, 1);
  assert.equal((await h.game()).state.log.filter((e) => e.role === 'player').length, 1);
});

test('narrator reads all independent external cards, including absent NPCs; public views omit secrets', async (t) => {
  const h = await setup(t), seen = [];
  const cultivation = { ...h.cultivation, renderExternalCard(input) { seen.push(input); return `CARD-${input.persona.id}-${input.state.intimacy}`; } };
  const prompt = makeDmPrompt(await h.game(), {}, cultivation);
  assert.deepEqual(seen.map((entry) => entry.persona.id), ['a', 'b', 'c']);
  for (const value of ['CARD-a-11', 'CARD-b-11', 'CARD-c-11', DM_SECRET, '不等后台记账批准', '角色只知道自己亲历']) assert.ok(prompt.includes(value), value);
  assert.doesNotMatch(prompt, /tavern_speak|tavern_delivery|tavern_scene|tavern_action|tavern_beat|ask_user_question/);
  const data = JSON.stringify([await h.view(), await h.runtime.perform('game-1', 'tavern_status')]);
  for (const value of [DM_SECRET, NPC_A_SECRET, NPC_C_SECRET, 'initialState', 'processedEventIds', 'memoryLog']) assert.ok(!data.includes(value), value);
});

test('full prose precedes one recording task; duplicate narration is inert and model holds no save lock', async (t) => {
  const gate = deferred(), entered = deferred();
  const h = await setup(t, { runStoryReport: async (request) => { entered.resolve(request); return gate.promise; } });
  await h.input(); const text = '公爵交出钱袋。' + '众人离开门厅。'.repeat(400);
  await h.runtime.recordNarration('game-1', 'dm-1', text);
  await h.runtime.recordNarration('game-1', 'dm-1', '不应覆盖正文');
  assert.equal((await h.game()).state.log.find((e) => e.eventId === 'dm-1').text, text);
  assert.equal(h.calls.length, 0); assert.equal((await h.view()).state.storyRecording.pending, 1);
  const work = h.runtime.settleNarration('game-1', { parent: { id: 'dm' } });
  const request = await entered.promise;
  assert.equal(request.phase, 'record'); assert.equal(request.parent.id, 'dm'); assert.ok(request.outputSchema.properties.items); assert.ok(request.prompt.includes(text));
  await h.input('next', '继续'); gate.resolve(report({ items: [purse] })); await work;
  assert.equal((await h.game()).state.storyTasks['dm-1'].status, 'recorded');
  assert.equal((await h.game()).state.log.filter((e) => e.eventId === 'dm-1').length, 1);
  await h.runtime.settleNarration('game-1'); assert.equal(h.calls.length, 1);
});

test('frozen snapshots, sibling saves and returned objects remain isolated during recording', async (t) => {
  const h = await setup(t, { runStoryReport: async () => report({ npcs: [{ npcId: 'a', speech: '谢谢。', observations: ['玩家帮忙守门'] }] }) });
  const other = await h.store.createCampaign({ scriptKey: 'runtime-test@1.0.0', sessionId: 'game-2' });
  await h.store.importArchive(archive(script('2.0.0', 60)));
  const fresh = await h.store.createCampaign({ scriptKey: 'runtime-test@2.0.0', sessionId: 'game-3' });
  await h.input(); await h.runtime.recordNarration('game-1', 'dm-1', '队友-a向玩家道谢。'); await h.runtime.settleNarration('game-1');
  const first = await h.game(); assert.equal(first.scriptVersion, '1.0.0'); assert.equal(first.snapshot.characters[0].initialState.intimacy, 11); assert.equal(first.state.npcs.a.intimacy, 13);
  assert.equal((await h.store.getCampaign(other.id)).state.npcs.a.intimacy, 11); assert.equal((await h.store.getCampaign(fresh.id)).state.npcs.a.intimacy, 60);
  first.snapshot.characters[0].fields.name = '外部改写'; first.state.npcs.a.intimacy = 999;
  assert.notEqual((await h.game()).snapshot.characters[0].fields.name, '外部改写'); assert.equal((await h.game()).state.npcs.a.intimacy, 13);
});

test('recording failures preserve prose, stop chronological projection, and require explicit retry', async (t) => {
  const h = await setup(t, { runStoryReport: async () => { throw Error('PRIVATE_PROVIDER_ERROR'); } });
  await h.input(); await h.runtime.recordNarration('game-1', 'dm-1', '公爵给了钱袋，众人走进大厅。'); await h.runtime.recordNarration('game-1', 'dm-2', '大家在大厅等候。');
  await h.runtime.settleNarration('game-1');
  assert.equal((await h.game()).state.storyTasks['dm-1'].status, 'failed'); assert.equal((await h.game()).state.storyTasks['dm-2'].status, 'pending');
  assert.equal((await h.view()).state.storyRecording.failed, 1); assert.doesNotMatch(JSON.stringify((await h.view()).state.storyRecording), /PRIVATE_PROVIDER_ERROR/);
  h.setRespond(async () => report({ sceneId: 'hall', items: [purse] }));
  await h.runtime.settleNarration('game-1'); assert.equal(h.calls.length, 1);
  await h.runtime.settleNarration('game-1', { retry: true }); assert.equal(h.calls.length, 3); assert.equal((await h.game()).state.sceneId, 'hall');
  assert.equal((await h.view()).state.inventory.length, 1); assert.ok(Object.values((await h.game()).state.storyTasks).every((task) => task.status === 'recorded'));
  assert.equal((await h.view()).state.history.filter((entry) => entry.role === 'dm').length, 2);
});

test('parallel drains and reloaded retries preserve old items and never repeat successful NPC cultivation', async (t) => {
  const gate = deferred();
  const h = await setup(t, { runStoryReport: async () => { await gate.promise; return report({ items: [purse], npcs: ['a', 'b'].map((npcId) => ({ npcId, speech: '', observations: ['收到定金'] })) }); } });
  await h.store.withCampaign('game-1', (game) => { game.state.freeActionItems = [{ id: 'old', name: '旧钥匙', quantity: 1 }]; });
  const original = h.cultivation.processExternalEvent;
  h.cultivation.processExternalEvent = async (input) => { if (input.persona.id === 'b') throw Error('temporarily unavailable'); return original(input); };
  await h.input(); await h.runtime.recordNarration('game-1', 'dm-1', '收到定金。');
  const a = h.runtime.settleNarration('game-1'), b = h.runtime.settleNarration('game-1'); gate.resolve(); await Promise.all([a, b]);
  assert.equal(h.calls.length, 1); let game = await h.game(); assert.equal(game.state.storyTasks['dm-1'].status, 'failed'); assert.equal(game.state.storyTasks['dm-1'].cultivation.a.status, 'done');
  const savedA = structuredClone(game.state.npcs.a); await h.store.close(); const reopened = await createStore({ dir: h.dir, cultivation: h.cultivation }); h.cultivation.processExternalEvent = original;
  const restored = createGameRuntime({ store: reopened, cultivation: h.cultivation, runStoryReport: async () => assert.fail('saved report must be reused') });
  try {
    await restored.settleNarration('game-1', { retry: true }); await restored.settleNarration('game-1', { retry: true }); game = await reopened.getCampaign(h.campaign.id);
    assert.equal(game.state.storyTasks['dm-1'].status, 'recorded'); assert.deepEqual(game.state.npcs.a, savedA);
    assert.deepEqual(game.state.freeActionItems.map((item) => item.id).sort(), ['old', 'purse']); assert.equal(game.state.npcs.b.processedEventIds.length, 1);
    assert.equal(h.developments.filter((entry) => entry.persona.id === 'a').length, 1);
  } finally { await reopened.close(); }
});

test('unconfirmed or missing cultivation development never reports successful recording', async (t) => {
  for (const mode of ['unconfirmed', 'missing', 'pending']) await t.test(mode, async (t) => {
    const h = await setup(t, { runStoryReport: async () => report({ npcs: [{ npcId: 'a', speech: '', observations: ['目睹付款'] }] }) });
    if (mode === 'unconfirmed') h.cultivation.processExternalEvent = async ({ state }) => ({ state: { ...state, intimacy: 999 } });
    if (mode === 'missing') delete h.cultivation.developExternalState;
    if (mode === 'pending') h.cultivation.developExternalState = async ({ state }) => ({ state, pendingTasks: ['memory'] });
    await h.input(); await h.runtime.recordNarration('game-1', 'dm-1', '已经付款。'); await h.runtime.settleNarration('game-1');
    assert.equal((await h.game()).state.storyTasks['dm-1'].failedStage, 'cultivation'); assert.equal((await h.view()).state.storyRecording.failed, 1);
    if (mode === 'unconfirmed') assert.equal((await h.game()).state.npcs.a.intimacy, 11);
  });
});

test('NPC perception is independent and all latest external memories enter the next narrator prompt', async (t) => {
  const h = await setup(t, { runStoryReport: async () => report({ sceneId: 'hall', npcs: [{ npcId: 'a', speech: '我留下。', observations: ['目送玩家离开'] }, { npcId: 'c', speech: '欢迎。', observations: ['看到玩家抵达大厅'] }] }) });
  await h.input('foyer', 'FOYER_ONLY_暗号'); await h.runtime.recordNarration('game-1', 'dm-1', '队友-a留下；玩家抵达大厅，队友-c迎接。'); await h.runtime.settleNarration('game-1');
  const game = await h.game(), event = h.evaluations.find((entry) => entry.input.persona.id === 'c').event;
  assert.equal(event.playerText, ''); assert.doesNotMatch(JSON.stringify(event.observations), /FOYER_ONLY/);
  await h.input('hall', 'HALL_ONLY_继续'); assert.doesNotMatch(JSON.stringify(visibleHistory(await h.game(), 'a')), /HALL_ONLY/);
  const seen = [];
  makeDmPrompt(game, {}, { renderExternalCard({ persona, state }) { seen.push({ id: persona.id, state }); return ''; } });
  for (const id of ['a', 'c']) { assert.ok(game.state.npcs[id].processedEventIds.length > 0); assert.deepEqual(seen.find((entry) => entry.id === id).state, game.state.npcs[id]); }
});

test('numerical operations are idempotent per real input, including parallel calls and reload', async (t) => {
  let rolls = 0; const h = await setup(t, { random: () => { rolls++; return 0.5; } });
  await h.input(); const [first, duplicate] = await Promise.all([h.runtime.perform('game-1', 'tavern_combat'), h.runtime.perform('game-1', 'tavern_combat')]);
  assert.deepEqual(first, duplicate); assert.equal(rolls, 2); const before = await h.game();
  assert.deepEqual(await h.runtime.perform('game-1', 'tavern_combat'), first); assert.deepEqual((await h.game()).state, before.state);
  assert.deepEqual(await h.runtime.perform('game-1', 'tavern_check', { checkId: 'shared' }), await h.runtime.perform('game-1', 'tavern_check', { checkId: 'shared' }));
  await h.store.close(); const reopened = await createStore({ dir: h.dir, cultivation: h.cultivation });
  try { const restored = createGameRuntime({ store: reopened, cultivation: h.cultivation, random: () => assert.fail('must not reroll') }); assert.deepEqual(await restored.perform('game-1', 'tavern_combat'), first); } finally { await reopened.close(); }
  assert.equal(h.calls.length, 0); assert.equal(h.evaluations.length, 0);
});

test('synthetic resume cannot reuse receipts; takeover blocks old writers', async (t) => {
  const h = await setup(t); await h.input(); await h.runtime.perform('game-1', 'tavern_check', { checkId: 'shared' });
  await h.store.attachCampaign({ campaignId: h.campaign.id, sessionId: 'resumed', takeover: true });
  await assert.rejects(h.runtime.perform('game-1', 'tavern_status'), { code: 'READ_ONLY_SESSION' });
  await assert.rejects(h.input('old'), (error) => ['READ_ONLY', 'READ_ONLY_SESSION'].includes(error.code));
  assert.match(makeDmPrompt(await h.game(), await h.store.getBinding('game-1'), h.cultivation), /只读/);
  await h.runtime.recordInput('resumed', { id: 'synthetic', synthetic: true, content: [{ type: 'text', text: '继续' }] }); const before = await h.game();
  for (const operation of ['tavern_check', 'tavern_combat', 'tavern_rest']) await assert.rejects(h.runtime.perform('resumed', operation, { checkId: 'shared' }), { code: 'NO_PLAYER_INPUT' });
  assert.deepEqual(await h.game(), before); await h.input('new', '检查', 'resumed'); await h.runtime.perform('resumed', 'tavern_check', { checkId: 'shared' });
});

test('cancelled numerical calls are atomic; cancelled recorders commit no ghost inventory', async (t) => {
  const controller = new AbortController();
  const h = await setup(t, { runStoryReport: async () => { controller.abort(); return report({ items: [purse] }); } });
  await h.input(); const before = await h.game(); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(h.runtime.perform('game-1', 'tavern_combat', {}, { signal: aborted.signal }), { code: 'ABORTED' }); assert.deepEqual(await h.game(), before);
  await h.runtime.recordNarration('game-1', 'dm-1', '付款已完成。'); await h.runtime.settleNarration('game-1', { signal: controller.signal });
  assert.deepEqual((await h.view()).state.inventory, []); assert.equal((await h.game()).state.storyTasks['dm-1'].status, 'failed'); assert.equal((await h.view()).state.history.at(-1).text, '付款已完成。');
});


test('committed narration without a preceding player input remains recordable', async (t) => {
  const h = await setup(t); await h.runtime.recordNarration('game-1', 'opening', '门厅灯火摇曳。');
  assert.equal((await h.game()).state.log.at(-1).inputId, undefined);
  assert.equal((await h.game()).state.storyTasks.opening.status, 'pending');
  await h.runtime.settleNarration('game-1'); assert.equal((await h.game()).state.storyTasks.opening.status, 'recorded'); assert.equal(h.calls.length, 1);
});

test('safe rest restores real HP once without changing independent NPC state', async (t) => {
  const h = await setup(t); await h.store.withCampaign('game-1', (game) => { game.state.player.hp = 7; });
  await h.input('rest', '休整'); const before = (await h.game()).state.npcs;
  const first = await h.runtime.perform('game-1', 'tavern_rest'); assert.equal(first.healed, 13); assert.equal(first.hp, 20);
  assert.deepEqual(await h.runtime.perform('game-1', 'tavern_rest'), first); assert.deepEqual((await h.game()).state.npcs, before);
  assert.equal(h.calls.length, 0); assert.equal(h.evaluations.length, 0);
});

// Memory-only transactional store; model outputs are mocks. Hold an input commit
// so cancellation lands after model evaluation but before its queued mutation.
test('queued report and development commits recheck cancellation at mutation execution', { timeout: 2000 }, async (t) => {
  for (const stage of ['report', 'development']) await t.test(stage, async () => {
    const persona = { id: 'a', name: '队友', fields: { name: '队友' } };
    let campaign = {
      id: 'queue-race', ownerSessionId: 'game',
      snapshot: { characters: [persona], adventure: { scenes: [{ id: 'room', place: '房间', cast: ['a'] }] } },
      state: { sceneId: 'room', status: 'active', turnIndex: 0, log: [], visited: ['room'], npcs: { a: createExternalState({ persona }) } }
    };
    const entered = deferred(), modelResult = deferred(), inputHolding = deferred(), releaseInput = deferred();
    let holdNextInput = false;
    const store = {
      async getBinding() { return { campaignId: campaign.id, readOnly: false }; },
      async getCampaign() { return structuredClone(campaign); },
      async withCampaign(_sessionId, callback) {
        const draft = structuredClone(campaign);
        const result = await callback(draft);
        if (holdNextInput) { holdNextInput = false; inputHolding.resolve(); await releaseInput.promise; }
        campaign = draft;
        return result;
      }
    };
    let developmentInput;
    const cultivation = {
      processExternalEvent: (input) => processExternalEvent(input, async () => appraisal),
      async developExternalState(input) {
        assert.equal(stage, 'development');
        developmentInput = structuredClone({ state: input.state });
        entered.resolve();
        return modelResult.promise;
      }
    };
    const runtime = createGameRuntime({ store, cultivation, runStoryReport: async () => {
      if (stage === 'report') { entered.resolve(); return modelResult.promise; }
      return report({ npcs: [{ npcId: 'a', speech: '我信你这次。', observations: ['玩家帮助守门'] }] });
    } });
    const userMessage = (id, text) => ({ id, content: [{ type: 'text', text }] });
    await runtime.recordInput('game', userMessage('first', '我替你守门。'));
    await runtime.recordNarration('game', 'dm-race', '队友接受了帮助，并交出钱袋。');
    const controller = new AbortController();
    const settlement = runtime.settleNarration('game', { signal: controller.signal });
    await entered.promise;
    const before = structuredClone(campaign);
    holdNextInput = true;
    const nextInput = runtime.recordInput('game', userMessage('second', '继续。'));
    await inputHolding.promise;
    if (stage === 'report') modelResult.resolve(report({ items: [purse] }));
    else modelResult.resolve({ state: { ...developmentInput.state,
      growth: [{ trait: '不应提交的迟到成长', note: '模拟模型迟到结果', since: '' }], mood: { text: '不应提交的迟到心情', since: '' },
      development: { ...developmentInput.state.development, growth: 99, mood: 99 }
    }, changes: [{ type: 'development', task: 'growth', progress: 99 }], pendingTasks: [] });
    // Drain promise continuations without releasing the earlier transaction. The
    // model result has passed pre-enqueue checks when the abort below happens.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('cancel while commit is queued'));
    releaseInput.resolve();
    await Promise.all([nextInput, settlement]);
    assert.equal(campaign.state.storyTasks['dm-race'].status, 'failed');
    assert.equal(campaign.state.storyTasks['dm-race'].failedStage, stage === 'report' ? 'record' : 'cultivation');
    assert.equal(campaign.state.log.at(-1).eventId, 'second', 'unrelated input still commits');
    assert.deepEqual(campaign.state.freeActionItems ?? [], [], 'no ghost inventory');
    assert.deepEqual(campaign.state.npcs.a, before.state.npcs.a, 'no late development, mood or progress overwrite');
    if (stage === 'report') assert.equal(campaign.state.storyReports?.['dm-race'], undefined);
    else {
      assert.ok(campaign.state.storyReports['dm-race']);
      assert.equal(campaign.state.npcs.a.processedEventIds.length, 1, 'successful perception remains committed');
      assert.deepEqual(campaign.state.npcs.a.growth, []);
      assert.equal(campaign.state.npcs.a.mood, null);
    }
  });
});
