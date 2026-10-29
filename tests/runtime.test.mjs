import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createExternalState, renderExternalCard, processExternalEvent } from 'dsh-cultivation/core';
import { createStore } from '../lib/store.js';
import { createGameRuntime, makeNpcPrompt, makeDmPrompt, visibleHistory } from '../lib/runtime.js';

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
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-tavern-runtime-'));
  const npcCalls = [], decisionCalls = [], evaluations = [];
  let evaluate = options.evaluate ?? (async () => appraisal);
  let respond = options.runNpc ?? (async () => ({ speech: '我会守住这里。', action: '握紧剑柄观察门外。' }));
  const cultivation = {
    apiVersion: 1, createExternalState, renderExternalCard,
    processExternalEvent: (input) => processExternalEvent(input, async (context) => { evaluations.push(structuredClone({ ...context, input })); return evaluate(context); })
  };
  let store;
  try { store = await createStore({ dir, cultivation }); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  t.after(async () => { await store.close(); assert.ok(dir.startsWith(path.resolve(tmpdir()))); await rm(dir, { recursive: true, force: true }); });
  await store.importArchive(archive(script()));
  const campaign = await store.createCampaign({ scriptKey: 'runtime-test@1.0.0', sessionId: 'game-1' });
  const runtime = createGameRuntime({ store, cultivation, random: options.random ?? (() => 0.5), runNpc: async (request) => {
    if (request.phase === 'decision') { decisionCalls.push(request); return options.decide ? options.decide(request) : { kind: 'observe', targetId: 'player', visibility: 'public', reason: '暂时观察', evidenceIds: [], publicText: '', read: '', shift: '', next: '' }; }
    if (request.phase === 'reunion') return options.reunion ? options.reunion(request) : { accept: true, speech: '一起走。' };
    npcCalls.push(request); return respond(request);
  } });
  return { dir, store, runtime, cultivation, campaign, npcCalls, decisionCalls, evaluations,
    setEvaluate(fn) { evaluate = fn; }, setRespond(fn) { respond = fn; },
    input: (id = 'message-1', text = '我愿意替你守门。', sessionId = 'game-1') => runtime.recordInput(sessionId, { id, role: 'user', content: [{ type: 'text', text }] }) };
}

test('runtime uses frozen snapshots and campaign-local external state, not later script versions or sibling saves', async (t) => {
  const h = await setup(t);
  const other = await h.store.createCampaign({ scriptKey: 'runtime-test@1.0.0', sessionId: 'game-2' });
  await h.store.importArchive(archive(script('2.0.0', 60)));
  const fresh = await h.store.createCampaign({ scriptKey: 'runtime-test@2.0.0', sessionId: 'game-3' });
  await h.input();
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  const first = await h.store.getCampaign(h.campaign.id);
  assert.equal(first.scriptVersion, '1.0.0');
  assert.equal(first.snapshot.characters[0].initialState.intimacy, 11);
  assert.equal(first.state.npcs.a.intimacy, 13);
  assert.equal((await h.store.getCampaign(other.id)).state.npcs.a.intimacy, 11);
  assert.equal((await h.store.getCampaign(fresh.id)).state.npcs.a.intimacy, 60);
  first.snapshot.characters[0].fields.name = '外部改写';
  first.state.npcs.a.intimacy = 99;
  assert.notEqual((await h.store.getCampaign(h.campaign.id)).snapshot.characters[0].fields.name, '外部改写');
  assert.equal((await h.store.getCampaign(h.campaign.id)).state.npcs.a.intimacy, 13);
});

test('NPC prompt includes only own secret and perceived history, never global persona tool directives or DM secrets', async (t) => {
  const h = await setup(t);
  await h.input('at-foyer', 'FOYER_ONLY_暗号');
  await h.runtime.recordNarration('game-1', 'narration-foyer', 'FOYER_NARRATION');
  const before = await h.store.getCampaign(h.campaign.id);
  const promptA = makeNpcPrompt(h.cultivation, before, 'a');
  assert.ok(promptA.includes(NPC_A_SECRET));
  assert.ok(promptA.includes('FOYER_ONLY_暗号'));
  assert.ok(promptA.includes('不像会议纪要'));
  assert.ok(promptA.includes('眼前有威胁'));
  for (const value of [NPC_C_SECRET, DM_SECRET, 'persona_update_memory', 'persona_adjust_intimacy', 'persona_memory_log', 'persona_growth']) assert.ok(!promptA.includes(value), value);
  assert.throws(() => makeNpcPrompt(h.cultivation, before, 'c'), { code: 'NPC_NOT_PRESENT' });
  await h.runtime.perform('game-1', 'tavern_scene', { sceneId: 'hall' });
  await h.input('at-hall', 'HALL_ONLY_我看见远处的烛火');
  await h.runtime.recordNarration('game-1', 'narration-hall', 'HALL_NARRATION');
  const after = await h.store.getCampaign(h.campaign.id);
  const promptC = makeNpcPrompt(h.cultivation, after, 'c');
  assert.ok(promptC.includes(NPC_C_SECRET));
  assert.ok(promptC.includes('HALL_ONLY_'));
  assert.ok(!promptC.includes('FOYER_ONLY_'));
  assert.ok(!promptC.includes('FOYER_NARRATION'));
  assert.ok(!promptC.includes(NPC_A_SECRET));
  assert.deepEqual(visibleHistory(after, 'a').map((entry) => entry.text), ['FOYER_ONLY_暗号', 'FOYER_NARRATION']);
  assert.ok(visibleHistory(after, 'b').some((entry) => entry.text.includes('FOYER_ONLY_')));
  assert.ok(visibleHistory(after, 'b').some((entry) => entry.text.includes('HALL_ONLY_')));
});

test('moving before new NPC speaks does not leak unseen player input into appraisal', async (t) => {
  const h = await setup(t);
  await h.input('before-move', 'UNSEEN_PLAYER_SECRET_埋在旧门厅的宝箱');
  await h.runtime.perform('game-1', 'tavern_scene', { sceneId: 'hall' });
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'c' });
  assert.equal(h.evaluations.length, 1);
  assert.equal(h.evaluations[0].event.playerText, '');
  assert.ok(!JSON.stringify(h.evaluations[0].event.observations).includes('UNSEEN_PLAYER_SECRET_'));
  assert.ok(!h.npcCalls[0].prompt.includes('UNSEEN_PLAYER_SECRET_'));
});

test('duplicate speak and combat operations are idempotent per player input', async (t) => {
  let rolls = 0;
  const h = await setup(t, { random: () => { rolls++; return 0.5; } });
  await h.input();
  const speech = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  assert.deepEqual(await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' }), speech);
  assert.equal(h.npcCalls.length, 1);
  assert.equal(h.evaluations.length, 1);
  const combat = await h.runtime.perform('game-1', 'tavern_combat');
  const after = await h.store.getCampaign(h.campaign.id);
  assert.deepEqual(await h.runtime.perform('game-1', 'tavern_combat'), combat);
  const replayed = await h.store.getCampaign(h.campaign.id);
  assert.equal(rolls, 2);
  assert.equal(replayed.state.player.hp, after.state.player.hp);
  assert.deepEqual(replayed.state.encounters, after.state.encounters);
  assert.equal(replayed.state.log.filter((entry) => entry.role === 'npc').length, 1);
  assert.equal(replayed.state.npcs.a.intimacy, 13);
  assert.equal(replayed.state.npcs.a.processedEventIds.length, 1);
  await h.input('message-2', '我再次请求帮助。');
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  assert.equal(h.npcCalls.length, 2);
  assert.equal((await h.store.getCampaign(h.campaign.id)).state.npcs.a.intimacy, 15);
});

test('NPC speakers are serialized into a chain and never answer the same question in parallel', async (t) => {
  const h = await setup(t);
  await h.input();
  const [first, second] = await Promise.all([
    h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' }),
    h.runtime.perform('game-1', 'tavern_speak', { npcId: 'b' })
  ]);
  assert.equal(first.order, 1);
  assert.equal(second.order, 2);
  assert.equal(h.npcCalls.length, 2);
  assert.ok(h.npcCalls[1].prompt.includes('队友-a'));
  assert.ok(h.npcCalls[1].prompt.includes('第 2 位发言者'));
  assert.ok(h.npcCalls[1].prompt.includes('回应队友-a刚才说的话'));
  assert.ok(h.npcCalls[1].prompt.includes('不要重新回答玩家已经问过的问题'));
  assert.deepEqual(h.evaluations[0].event.observations, []);
  const campaign = await h.store.getCampaign(h.campaign.id);
  const prompt = makeNpcPrompt(h.cultivation, campaign, 'b', { previous: [{ npcId: 'a', text: '我会守住这里。' }], focus: '他的守门计划' });
  assert.ok(prompt.includes('第 2 位发言者'));
  assert.ok(prompt.includes('他的守门计划'));
  assert.ok(!prompt.includes('门厅灯火摇曳'), 'static scene opening must not be replayed every turn');
  const promptAgain = makeNpcPrompt(h.cultivation, campaign, 'a');
  assert.ok(promptAgain.includes('已经表达过立场'));
  assert.ok(promptAgain.includes('结合当前场景的新情况接话'));
  assert.ok(promptAgain.includes('推进，而不是复述'));
  assert.ok(promptAgain.includes('本轮不要重复'));
  assert.ok(!promptAgain.includes('门厅灯火摇曳'));
  campaign.state.log.push({ role: 'npc', npcId: 'a', inputId: 'older', sceneId: 'foyer', text: '旧话', audience: ['a', 'b'] });
  const promptThird = makeNpcPrompt(h.cultivation, campaign, 'a');
  assert.ok(!promptThird.includes('别再劝了，做'));
  assert.ok(promptThird.includes('不要因为发言次数增加就机械地更强硬'));
});

test('no two-speaker ceiling and model newBeat cannot bypass actual-input idempotence', async (t) => {
  const h = await setup(t);
  await h.input();
  await h.store.withCampaign('game-1', async (campaign) => {
    campaign.state.log.push({ role: 'npc', npcId: 'a', inputId: 'message-1', sceneId: 'foyer', text: '一', audience: ['a', 'b'] });
    campaign.state.log.push({ role: 'npc', npcId: 'b', inputId: 'message-1', sceneId: 'foyer', text: '二', audience: ['a', 'b'] });
  });
  const third = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  assert.equal(third.order, 3);
  assert.equal(third.speech, '我会守住这里。');
  assert.deepEqual(await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a', newBeat: true }), third);
  assert.equal(h.npcCalls.length, 1);
});

test('an ignored NPC accumulates resentment and reports a personality-driven stance', async (t) => {
  const h = await setup(t, { runNpc: async () => ({ speech: '你们不听就算了。', action: '把弓背到肩上，往矿口外退了一步。', feltIgnored: true, stance: 'annoyed', intent: 'leave' }) });
  await h.input('m1', '先别管风道，说说别的。');
  const first = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  assert.equal(first.feltIgnored, true);
  assert.equal(first.stance, 'annoyed');
  assert.equal(first.intent, 'leave');
  assert.equal(first.ignoredCount, 1);
  await h.input('m2', '我们还是先查正井。');
  const second = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  assert.equal(second.ignoredCount, 2);
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.equal(campaign.state.npcMeta.a.ignoredCount, 2);
  const prompt = makeNpcPrompt(h.cultivation, campaign, 'a');
  assert.ok(prompt.includes('已经被忽视 2 次'));
  assert.ok(prompt.includes('按你的性格反应'));
  assert.ok(prompt.includes('离队'));
});

test('player behavior changes the NPC attitude and its next action across turns', async (t) => {
  let call = 0;
  const h = await setup(t, { runNpc: async () => call++ === 0
    ? { speech: '你把盾让给我？', action: '愣了一下，才伸手接过。', feltIgnored: false, stance: 'calm', intent: 'suggest', read: '玩家把唯一的盾让给了我', shift: '更信任玩家', next: '愿意在下一场替玩家挡一次攻击' }
    : { speech: '这次我走前面。', action: '把盾举到玩家身前。', feltIgnored: false, stance: 'calm', intent: 'act', read: '玩家继续把后背交给我', shift: '信任继续上升', next: '主动挡在前面' } });
  await h.input('m1', '我把盾让给你。');
  const first = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  assert.equal(first.read, undefined);
  assert.equal(first.next, undefined); // Internal attitude must not leak in visible tool output.
  const afterFirst = await h.store.getCampaign(h.campaign.id);
  assert.equal(afterFirst.state.npcMeta.a.lastRead, '玩家把唯一的盾让给了我');
  assert.equal(afterFirst.state.npcMeta.a.lastNext, '愿意在下一场替玩家挡一次攻击');
  const prompt = makeNpcPrompt(h.cultivation, afterFirst, 'a');
  assert.ok(prompt.includes('玩家把唯一的盾让给了我'));
  assert.ok(prompt.includes('愿意在下一场替玩家挡一次攻击'));
  await h.input('m2', '我们继续走。');
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  const afterSecond = await h.store.getCampaign(h.campaign.id);
  assert.equal(afterSecond.state.npcMeta.a.lastRead, '玩家继续把后背交给我');
  assert.equal(afterSecond.state.npcMeta.a.lastNext, '主动挡在前面');
});

test('a teammate can leave autonomously, keep private offscreen experience, and consent to return changed', async (t) => {
  const h = await setup(t, { random: () => 0.1, decide: async () => ({ kind: 'leave', targetId: 'player', visibility: 'public', reason: '违背了救援承诺', evidenceIds: ['m1'], publicText: '我自己走。', read: '玩家违背承诺', shift: '不愿合作', next: '独自行动' }) });
  await h.input('m1', '我们走正井，不管风道。');
  const left = await h.runtime.perform('game-1', 'tavern_leave', { npcId: 'a', reason: '不满玩家无视风道' });
  assert.equal(left.status, 'left');
  await assert.rejects(h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' }), { code: 'NPC_UNAVAILABLE' });
  const offscreen = await h.runtime.perform('game-1', 'tavern_offscreen', { npcId: 'a' });
  assert.equal(offscreen.known, false);
  assert.equal(offscreen.summary, undefined);
  const away = await h.store.getCampaign(h.campaign.id);
  assert.equal(away.state.npcMeta.a.status, 'left');
  assert.equal(away.state.npcMeta.a.offscreen.id, 'wounded');
  assert.deepEqual((await h.store.getPublicCampaign(h.campaign.id)).state.npcs.find((npc) => npc.id === 'a').condition, []);
  assert.ok(!makeDmPrompt(away, { readOnly: false }).includes(away.state.npcMeta.a.offscreen.summary));
  await h.input('m2', '我找到你，邀请你一起走，你愿意吗？');
  const returned = await h.runtime.perform('game-1', 'tavern_return', { npcId: 'a', reason: '玩家在矿道里找到了他' });
  assert.equal(returned.status, 'active');
  const back = await h.store.getCampaign(h.campaign.id);
  assert.deepEqual(back.state.npcMeta.a.condition, ['受伤']);
  const publicBack = await h.store.getPublicCampaign(h.campaign.id);
  assert.deepEqual(publicBack.state.npcs.find((npc) => npc.id === 'a').condition, ['受伤']);
  const prompt = makeNpcPrompt(h.cultivation, back, 'a');
  assert.ok(prompt.includes('你离队期间经历的事'));
  assert.ok(prompt.includes(away.state.npcMeta.a.offscreen.summary));
});

test('NPCs form opinions of each other and can answer an ally instead of the player', async (t) => {
  let call = 0;
  const h = await setup(t, { runNpc: async () => {
    call++;
    if (call === 1) return { speech: '我同意布兰。', action: '看向布兰。', feltIgnored: false, read: '玩家让布兰先走', shift: '信任略升', next: '跟布兰配合', allyId: 'b', allyRead: '布兰把风险揽到自己身上', allyShift: '更尊重布兰', allyNext: '愿意把后背交给布兰' };
    return { speech: '那我就走前面。', action: '站到布兰侧后。', feltIgnored: false, read: '玩家没有反对', shift: '信任稳定', next: '配合布兰' };
  } });
  await h.input('m1', '布兰先走，你跟着。');
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.equal(campaign.state.npcMeta.a.opinions.b.read, '布兰把风险揽到自己身上');
  assert.equal(campaign.state.npcMeta.a.opinions.b.next, '愿意把后背交给布兰');
  const prompt = makeNpcPrompt(h.cultivation, campaign, 'a');
  assert.ok(prompt.includes('你对其他队友的看法'));
  assert.ok(prompt.includes('队友-b：布兰把风险揽到自己身上'));
});

test('unknown reactTo falls back to the actual conversation instead of blocking it', async (t) => {
  const h = await setup(t);
  await h.input();
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  const response = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'b', reactTo: 'c', focus: '另一个人' });
  assert.equal(response.order, 2);
  assert.ok(h.npcCalls[1].prompt.includes('接在 队友-a 之后'));
});

test('NPC generation and appraisal failures never create relationship changes', async (t) => {
  const h = await setup(t, { runNpc: async () => { throw new Error('NPC unavailable'); } });
  await h.input();
  const before = (await h.store.getCampaign(h.campaign.id)).state.npcs.a;
  const failed = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  assert.equal(failed.degraded, true);
  assert.deepEqual((await h.store.getCampaign(h.campaign.id)).state.npcs.a, before);
  assert.equal(h.evaluations.length, 0);
  h.setRespond(async () => ({ speech: '我听到了。', action: '留在原地。' }));
  for (const [index, evaluate] of [async () => { throw Error('appraisal unavailable'); }, async () => ({})].entries()) {
    h.setEvaluate(evaluate);
    await h.input('appraisal-failure-' + index);
    const result = await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
    assert.equal(result.degraded, false);
    assert.deepEqual((await h.store.getCampaign(h.campaign.id)).state.npcs.a, before);
  }
});

test('takeover denies all operations from old session while new owner can continue', async (t) => {
  const h = await setup(t);
  await h.input();
  await h.store.attachCampaign({ campaignId: h.campaign.id, sessionId: 'resumed-game', takeover: true });
  await assert.rejects(h.runtime.getOwned('game-1'), { code: 'READ_ONLY_SESSION' });
  await assert.rejects(h.runtime.perform('game-1', 'tavern_status'), { code: 'READ_ONLY_SESSION' });
  await assert.rejects(h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' }), { code: 'READ_ONLY_SESSION' });
  await assert.rejects(h.input('old-owner-action'), (error) => ['READ_ONLY', 'READ_ONLY_SESSION'].includes(error.code));
  const oldBinding = await h.store.getBinding('game-1');
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.ok(makeDmPrompt(campaign, oldBinding).includes('只读'));
  assert.ok(!makeDmPrompt(campaign, oldBinding).includes(DM_SECRET));
  await h.input('new-owner-action', '我接着守门。', 'resumed-game');
  await h.runtime.perform('resumed-game', 'tavern_speak', { npcId: 'a' });
  assert.equal((await h.store.getCampaign(h.campaign.id)).state.npcs.a.intimacy, 13);
});

test('cancellation before NPC completion rolls back log, receipts and relationship; retry is possible', async (t) => {
  const controller = new AbortController();
  const h = await setup(t, { runNpc: async () => { controller.abort(); return { speech: '不应保存', action: '不应保存' }; } });
  await h.input();
  const before = await h.store.getCampaign(h.campaign.id);
  await assert.rejects(h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.deepEqual(await h.store.getCampaign(h.campaign.id), before);
  assert.equal(h.evaluations.length, 0);
  h.setRespond(async () => ({ speech: '重新回应', action: '重新站稳' }));
  assert.equal((await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' })).speech, '重新回应');
});

test('cancellation after local appraisal rolls back its provisional intimacy and receipt', async (t) => {
  const controller = new AbortController();
  const h = await setup(t, { evaluate: async () => { controller.abort(); return appraisal; } });
  await h.input();
  const before = await h.store.getCampaign(h.campaign.id);
  await assert.rejects(h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(h.evaluations.length, 1);
  assert.deepEqual(await h.store.getCampaign(h.campaign.id), before);
});

test('public views and safe tool outputs omit script secrets, private fields and external relationship state', async (t) => {
  const h = await setup(t);
  await h.input();
  const campaign = await h.store.getCampaign(h.campaign.id);
  const binding = await h.store.getBinding('game-1');
  const dmPrompt = makeDmPrompt(campaign, binding);
  assert.ok(dmPrompt.includes(DM_SECRET));
  assert.ok(dmPrompt.includes('tavern_speak'));
  assert.ok(dmPrompt.includes('不能替玩家'));
  assert.ok(dmPrompt.includes('叙事连续性'));
  const results = [h.campaign, await h.store.listScripts(), await h.store.listCampaigns(), await h.store.getPublicCampaign(h.campaign.id), await h.runtime.perform('game-1', 'tavern_status'), await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' }), await h.runtime.perform('game-1', 'tavern_combat')];
  const serialized = JSON.stringify(results);
  for (const secret of [DM_SECRET, NPC_A_SECRET, NPC_C_SECRET, 'initialState', 'processedEventIds', 'memoryLog', 'intimacy']) assert.ok(!serialized.includes(secret), secret);
  await h.runtime.perform('game-1', 'tavern_scene', { sceneId: 'hall' });
  assert.ok(!JSON.stringify(await h.runtime.perform('game-1', 'tavern_status')).includes('snapshot'));
});

const opportunityOf = (request) => JSON.parse(request.prompt.split('【当前机会】')[1].split('\n\n')[0]);
function decisionFor(request, kind, extra = {}) {
  const trigger = opportunityOf(request);
  return { kind, targetId: 'player', visibility: 'public', reason: '根据我亲历的事与自己的底线决定', evidenceIds: [trigger.id], publicText: '我自行采取了行动。', read: '保留自己的判断', shift: '态度不会被一句话抹掉', next: '按自己的判断选择帮助或拒绝', ...extra };
}

test('silent NPCs appraise actual inputs and independently decide without DM speech calls', async (t) => {
  const h = await setup(t, { decide: async (request) => decisionFor(request, 'observe') });
  await h.input('kindness', '我替你挡住落石，自己受伤。');
  assert.equal(h.npcCalls.length, 0);
  await h.runtime.react('game-1');
  assert.deepEqual(h.decisionCalls.map(({ npcId }) => npcId), ['a', 'b']);
  let campaign = await h.store.getCampaign(h.campaign.id);
  assert.equal(campaign.state.npcs.a.intimacy, 13);
  assert.equal(campaign.state.npcs.b.intimacy, 13);
  assert.equal(campaign.state.npcs.c.intimacy, 11); // absent
  assert.equal(campaign.state.npcMeta.a.lastRead, '保留自己的判断');
  await h.runtime.react('game-1');
  assert.equal(h.decisionCalls.length, 2);
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a' });
  campaign = await h.store.getCampaign(h.campaign.id);
  assert.equal(campaign.state.npcs.a.intimacy, 13); // no double reward for speaking
  assert.ok(campaign.state.npcs.a.said.includes('我会守住这里。'));
  assert.ok(h.evaluations[0].event.context.some((entry) => entry.id === 'kindness'));
});

test('autonomous risk rescue changes real HP, costs injury, persists and never repeats on replay/reload', async (t) => {
  let rolls = [0.5, 0.5, 0];
  const h = await setup(t, { random: () => rolls.shift() ?? 0.5, decide: async (request) => decisionFor(request, request.npcId === 'a' && opportunityOf(request).kind === 'combat' ? 'risk_rescue' : 'observe') });
  await h.input('battle', '我扑向守卫的裂缝。');
  const result = await h.runtime.perform('game-1', 'tavern_combat');
  assert.equal(result.rawReceived, 3);
  assert.equal(result.received, 0);
  assert.equal(result.playerHp, 20);
  assert.equal(result.npcActions[0].kind, 'risk_rescue');
  assert.deepEqual(result.npcActions[0].condition, ['重伤']);
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.deepEqual(campaign.state.npcMeta.a.condition, ['重伤']);
  assert.equal(campaign.state.autonomy.actions[0].consumed, true);
  assert.equal(h.npcCalls.length, 0);
  assert.deepEqual(await h.runtime.perform('game-1', 'tavern_combat'), result);
  assert.equal(h.decisionCalls.length, 2);
  await h.store.close();
  const reopened = await createStore({ dir: h.dir, cultivation: h.cultivation });
  try {
    const restored = createGameRuntime({ store: reopened, cultivation: h.cultivation, runNpc: async () => { throw Error('must not rerun'); } });
    assert.deepEqual(await restored.perform('game-1', 'tavern_combat'), result);
    assert.deepEqual((await reopened.getCampaign(h.campaign.id)).state.npcMeta.a.condition, ['重伤']);
  } finally { await reopened.close(); }
});

test('ally independently guards a rescuing companion and shares actual injury cost', async (t) => {
  const h = await setup(t, { decide: async (request) => decisionFor(request, request.npcId === 'a' ? 'risk_rescue' : 'protect', request.npcId === 'b' ? { targetId: 'a' } : {}) });
  await h.input('battle', '我攻击守卫。');
  const result = await h.runtime.perform('game-1', 'tavern_combat');
  assert.equal(result.received, 0);
  assert.equal(result.npcActions.length, 2);
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.deepEqual(campaign.state.npcMeta.a.condition, ['受伤']);
  assert.deepEqual(campaign.state.npcMeta.b.condition, ['受伤']);
  assert.equal(campaign.state.autonomy.actions.reduce((sum, action) => sum + (action.interceptedDamage ?? 0), 0), 3);
});

test('concealed sabotage changes the attack but no hidden identity or motives reach DM or public outputs', async (t) => {
  const secret = 'PRIVATE_GRUDGE_曾经殴打我';
  const h = await setup(t, { random: () => 0.3, decide: async (request) => decisionFor(request, request.npcId === 'a' ? 'sabotage' : 'observe', request.npcId === 'a' ? { visibility: 'secret', reason: secret, publicText: secret, read: secret, next: secret } : {}) });
  await h.input('attack', '我攻击守卫。');
  const result = await h.runtime.perform('game-1', 'tavern_combat');
  assert.equal(result.attack.total, 8); // base would be 10 and hit
  assert.equal(result.attack.success, false);
  assert.deepEqual(result.npcActions, []);
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.equal(campaign.state.autonomy.actions[0].visibility, 'secret');
  assert.equal(campaign.state.autonomy.actions[0].reason, secret);
  const promptB = makeNpcPrompt(h.cultivation, campaign, 'b');
  const dm = makeDmPrompt(campaign, await h.store.getBinding('game-1'));
  assert.ok(!JSON.stringify([result, campaign.state.log, await h.store.getPublicCampaign(campaign.id), dm, promptB]).includes(secret));
  assert.ok(makeNpcPrompt(h.cultivation, campaign, 'a').includes(secret)); // only own mind
});

test('cancelled autonomous intervention rolls back trigger, decisions, injuries and HP atomically', async (t) => {
  const controller = new AbortController();
  const h = await setup(t, { decide: async (request) => {
    if (request.npcId === 'b') controller.abort();
    return decisionFor(request, 'risk_rescue');
  } });
  await h.input('battle', '我攻击。');
  const before = await h.store.getCampaign(h.campaign.id);
  await assert.rejects(h.runtime.perform('game-1', 'tavern_combat', {}, { signal: controller.signal }), { code: 'ABORTED' });
  assert.deepEqual(await h.store.getCampaign(h.campaign.id), before);
});

test('DM cannot force departure/reunion and departed NPCs cannot perceive subsequent party events', async (t) => {
  const h = await setup(t, { reunion: async () => ({ accept: false, speech: '我还不愿意回去。' }) });
  await h.input('m1', '离开队伍！');
  const refused = await h.runtime.perform('game-1', 'tavern_leave', { npcId: 'a', reason: 'DM想让他走' });
  assert.equal(refused.departed, false);
  await h.store.withCampaign('game-1', async (campaign) => { campaign.state.npcMeta.a = { status: 'left', lastRead: '旧怨还在' }; });
  await h.input('m2', 'PARTY_ONLY_SECRET');
  await h.runtime.recordNarration('game-1', 'n2', 'PARTY_ONLY_SECRET_旁白');
  await h.runtime.react('game-1');
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.ok(!JSON.stringify(visibleHistory(campaign, 'a')).includes('PARTY_ONLY_SECRET'));
  assert.ok(!h.decisionCalls.filter((request) => request.npcId === 'a').some((request) => request.prompt.includes('PARTY_ONLY_SECRET')));
  const declined = await h.runtime.perform('game-1', 'tavern_return', { npcId: 'a', reason: 'DM命令回来' });
  assert.equal(declined.returned, false);
  assert.equal((await h.store.getCampaign(h.campaign.id)).state.npcMeta.a.status, 'left');
});

test('safe rest heals NPC injury in stages without changing affection or fetching absent companions', async (t) => {
  const h = await setup(t);
  await h.store.withCampaign('game-1', async (campaign) => {
    campaign.state.npcMeta.a = { status: 'active', condition: ['重伤'] };
    campaign.state.npcMeta.b = { status: 'left', condition: ['受伤'] };
  });
  await h.input('rest1', '在营地休整。');
  await h.runtime.perform('game-1', 'tavern_rest');
  let campaign = await h.store.getCampaign(h.campaign.id);
  assert.deepEqual(campaign.state.npcMeta.a.condition, ['受伤']);
  assert.deepEqual(campaign.state.npcMeta.b.condition, ['受伤']);
  await h.input('rest2', '再休整一段时间。');
  await h.runtime.perform('game-1', 'tavern_rest');
  campaign = await h.store.getCampaign(h.campaign.id);
  assert.deepEqual(campaign.state.npcMeta.a.condition, []);
  assert.equal(campaign.state.npcs.a.intimacy, 11);
});

test('offscreen opportunities never silently heal a previously injured companion', async (t) => {
  const h = await setup(t, { random: () => 0.65 });
  await h.store.withCampaign('game-1', async (campaign) => { campaign.state.npcMeta.a = { status: 'left', condition: ['受伤'] }; });
  await h.input('away', '我们等他。');
  const outcome = await h.runtime.perform('game-1', 'tavern_offscreen', { npcId: 'a' });
  assert.equal(outcome.known, false);
  assert.equal(outcome.status, 'away');
  await h.input('reunion', '愿意回来吗？');
  await h.runtime.perform('game-1', 'tavern_return', { npcId: 'a' });
  const campaign = await h.store.getCampaign(h.campaign.id);
  assert.deepEqual(campaign.state.npcMeta.a.condition, ['受伤', '奇遇']);
});

test('returning in the same input never exposes a teammate speech from before arrival', async (t) => {
  const secret = 'ALLY_SPEECH_BEFORE_ARRIVAL';
  const h = await setup(t, { runNpc: async ({ npcId }) => ({ speech: npcId === 'b' ? secret : '我回来了。', action: '看向门口。' }) });
  await h.store.withCampaign('game-1', async (campaign) => { campaign.state.npcMeta.a = { status: 'left' }; });
  await h.input('invite', '邀请她回来。');
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'b' });
  await h.runtime.perform('game-1', 'tavern_return', { npcId: 'a' });
  await h.runtime.perform('game-1', 'tavern_speak', { npcId: 'a', reactTo: 'b', focus: secret });
  assert.ok(!h.npcCalls.find((request) => request.npcId === 'a').prompt.includes(secret));
});

test('check receipts are scene-local and movement is once per actual player input', async (t) => {
  const h = await setup(t);
  await h.input('routes', '检查门厅，再前往大厅。');
  const first = await h.runtime.perform('game-1', 'tavern_check', { checkId: 'shared' });
  assert.equal(first.sceneId, 'foyer');
  await h.runtime.perform('game-1', 'tavern_scene', { sceneId: 'hall' });
  const second = await h.runtime.perform('game-1', 'tavern_check', { checkId: 'shared' });
  assert.equal(second.sceneId, 'hall');
  await h.runtime.perform('game-1', 'tavern_scene', { sceneId: 'foyer' });
  assert.equal((await h.store.getCampaign(h.campaign.id)).state.sceneId, 'hall');
  await h.input('return', '返回门厅。');
  await h.runtime.perform('game-1', 'tavern_scene', { sceneId: 'foyer' });
  assert.equal((await h.store.getCampaign(h.campaign.id)).state.sceneId, 'foyer');
});

test('missing companions cannot be teleported back by a DM reunion request', async (t) => {
  const h = await setup(t);
  await h.store.withCampaign('game-1', async (campaign) => { campaign.state.npcMeta.a = { status: 'missing', condition: ['被俘'], offscreen: { summary: 'SECRET_CAPTOR' } }; });
  await h.input('reunion', '大家回来吧。');
  const result = await h.runtime.perform('game-1', 'tavern_return', { npcId: 'a', reason: 'DM宣称已经救出' });
  assert.equal(result.returned, false);
  assert.equal((await h.store.getCampaign(h.campaign.id)).state.npcMeta.a.status, 'missing');
  assert.ok(!JSON.stringify([result, await h.store.getPublicCampaign(h.campaign.id)]).includes('SECRET_CAPTOR'));
});
