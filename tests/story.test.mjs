import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExternalEvent } from 'dsh-cultivation/core';
import { STORY_REPORT_SCHEMA, makeStoryReportPrompt, applyStoryReport } from '../lib/story.js';

function game() {
  return {
    snapshot: { adventure: { scenes: [
      { id: 'hall', place: '大厅', cast: ['a', 'b'], exits: [], timeOfDay: '晚上' },
      { id: 'room', place: '主卧', cast: ['c'], exits: [], ending: true, information: [{ id: 'lamp', text: '灯还亮着' }, { id: 'secret', text: '秘密', requires: { open: true } }] }
    ] }, characters: ['a', 'b', 'c'].map((id) => ({ id, name: id, fields: { secret: `PRIVATE-${id}` } })) },
    state: { sceneId: 'hall', visited: ['hall'], player: { hp: 10 }, flags: { open: false }, checks: {}, encounters: {}, status: 'active', completed: false,
      npcs: { a: {}, b: {}, c: {} }, npcMeta: { a: { lastRead: '保持判断', condition: ['疲惫'] } }, log: [
        { role: 'player', eventId: 'p1', text: '我要定金', sceneId: 'hall', audience: ['a'] }
      ], freeActionItems: [{ id: 'key', name: '旧钥匙', sceneId: 'hall' }, { id: 'gold', name: '金币', quantity: 10, sceneId: 'hall' }] }
  };
}
function narrate(campaign, text = '公爵把30枚金币交给你，你现在共有40枚金币。', options = {}) {
  const narration = { eventId: 'dm:1', text, sceneId: 'hall', audience: ['a', 'b'], inputId: 'p1', ...options };
  campaign.state.log.push({ role: 'dm', ...narration });
  return narration;
}
const report = (changes = {}) => ({ summary: '', sceneId: '', location: '', items: [], npcs: [], events: [], ...changes });
const item = (changes = {}) => ({ id: 'gold', name: '金币', quantity: 40, description: '定金和原有金币', removed: false, ...changes });

test('trade records confirmed totals and preserves unmentioned inventory and rules', () => {
  const campaign = game(), narration = narrate(campaign);
  const rules = structuredClone({ player: campaign.state.player, flags: campaign.state.flags, checks: campaign.state.checks, encounters: campaign.state.encounters });
  const receipt = applyStoryReport(campaign, report({ summary: '收到定金', items: [item()], events: ['公爵交付了定金。'] }), narration);
  assert.equal(receipt.summary, '收到定金');
  assert.equal(campaign.state.freeActionItems.find((i) => i.id === 'gold').quantity, 40);
  assert.deepEqual(campaign.state.freeActionItems.find((i) => i.id === 'key'), { id: 'key', name: '旧钥匙', sceneId: 'hall' });
  assert.deepEqual({ player: campaign.state.player, flags: campaign.state.flags, checks: campaign.state.checks, encounters: campaign.state.encounters }, rules);
  assert.equal(campaign.state.storyFacts[0].text, '公爵交付了定金。');
  assert.equal(campaign.state.log.at(-1).text, narration.text);
});

test('refusal and conditional wishes can record no changes without approving language', () => {
  const campaign = game(), narration = narrate(campaign, '“不，我不会给你钱。如果你完成任务再谈。”');
  const inventory = structuredClone(campaign.state.freeActionItems);
  applyStoryReport(campaign, report({ summary: '公爵拒绝预付。' }), narration);
  assert.deepEqual(campaign.state.freeActionItems, inventory);
  assert.equal(campaign.state.storyFacts, undefined);
  const prompt = makeStoryReportPrompt(campaign, narration);
  for (const phrase of ['不能续写、审核', '绝不能根据玩家想要钱就发钱', '不是增减 delta', 'quantity', '未满足的条件']) assert.ok(prompt.includes(phrase));
  assert.ok(!prompt.includes('PRIVATE-'));
});

test('removals are explicit, quantities are totals, old one-unit items and exact aliases reuse identity', () => {
  const campaign = game(), narration = narrate(campaign, '你交出了旧钥匙，用金币换到了银钥匙。');
  applyStoryReport(campaign, report({ items: [
    item({ id: 'key', name: '旧钥匙', quantity: 0, removed: true }),
    item({ id: 'different-id', name: '金币', quantity: 5 }),
    item({ id: '', name: '银钥匙', quantity: 1 })
  ] }), narration);
  assert.equal(campaign.state.freeActionItems.length, 2);
  assert.equal(campaign.state.freeActionItems.find((i) => i.name === '金币').id, 'gold');
  assert.equal(campaign.state.freeActionItems.find((i) => i.name === '金币').quantity, 5);
  assert.match(campaign.state.freeActionItems.find((i) => i.name === '银钥匙').id, /^story-/);
  const other = game(), second = narrate(other, '旧钥匙被称为铜钥匙。');
  applyStoryReport(other, report({ items: [item({ id: 'key', name: '铜钥匙', quantity: 1 })] }), second);
  assert.equal(other.state.freeActionItems.find((i) => i.id === 'key').quantity, 1);
  assert.equal(other.state.freeActionItems.find((i) => i.id === 'key').name, '铜钥匙');
  assert.ok(makeStoryReportPrompt(gameWithNarration(), narration).includes('"quantity":1'));
});
function gameWithNarration() { const campaign = game(); narrate(campaign, '你交出了旧钥匙，用金币换到了银钥匙。'); return campaign; }

test('replay returns detached receipt even with a different malformed report; no duplicate totals, facts or NPC events', () => {
  const campaign = game(), narration = narrate(campaign);
  const data = report({ items: [item()], events: ['已付款'], npcs: [{ npcId: 'a', speech: '收好。', observations: ['我把定金交给玩家。'] }] });
  const first = applyStoryReport(campaign, data, narration), saved = structuredClone(campaign);
  assert.deepEqual(applyStoryReport(campaign, null, narration), first);
  assert.deepEqual(campaign, saved);
  first.npcEvents[0].event.observations.push('篡改');
  assert.equal(applyStoryReport(campaign, {}, narration).npcEvents[0].event.observations.length, 1);
  const restored = JSON.parse(JSON.stringify(campaign));
  assert.deepEqual(applyStoryReport(restored, data, narration), campaign.state.storyReports[narration.eventId]);
});

test('late invalid report fields fail atomically and never modify committed narration', () => {
  const invalid = [
    report({ items: [item()], npcs: [{ npcId: 'c', speech: '', observations: ['不在场的经历'] }] }),
    report({ items: [item()], events: [7] }), report({ items: [item({ quantity: -1 })] }),
    report({ items: [item({ removed: true })] }), report({ items: [item(), item()] }),
    report({ sceneId: 'new-scene' }), report({ items: [item()], hp: 100 }),
    report({ summary: 'x'.repeat(2001) }), report({ items: Array.from({ length: 65 }, () => item()) }),
    report({ npcs: [{ npcId: 'a', speech: '', observations: [], status: 'dead' }] }),
    JSON.parse('{"summary":"","sceneId":"","location":"","items":[],"npcs":[],"events":[],"__proto__":{"polluted":true}}'),
    report({ items: [item({ id: '__proto__' })] }), report({ completed: 'true' })
  ];
  for (const data of invalid) {
    const campaign = game(), narration = narrate(campaign), before = structuredClone(campaign);
    assert.throws(() => applyStoryReport(campaign, data, narration));
    assert.deepEqual(campaign, before);
  }
  assert.equal({}.polluted, undefined);
});

test('narration must match an existing committed DM source and safe audience', () => {
  for (const mutate of [
    (c, n) => c.state.log.pop(), (c, n) => { n.text = '伪造正文'; },
    (c, n) => { n.audience = ['a', 'c']; }, (c, n) => { n.audience = ['a', 'a']; },
    (c, n) => { n.eventId = '__proto__'; }, (c, n) => { c.state.log.at(-1).role = 'npc'; },
    (c, n) => c.state.log.push({ ...c.state.log.at(-1) })
  ]) {
    const campaign = game(), narration = narrate(campaign); mutate(campaign, narration);
    const before = structuredClone(campaign);
    assert.throws(() => applyStoryReport(campaign, report(), narration));
    assert.deepEqual(campaign, before);
  }
});

test('NPC events isolate speech and observations, and only witnessed player input is included', () => {
  const campaign = game(), narration = narrate(campaign);
  narration.playerText = '伪造玩家行为';
  const receipt = applyStoryReport(campaign, report({ npcs: [
    { npcId: 'a', speech: '我交钱。', observations: ['我亲自交付定金。'], status: 'left', condition: ['擦伤'] },
    { npcId: 'b', speech: '我看到了。', observations: ['我看见钱袋。'] }
  ] }), narration);
  const [a, b] = receipt.npcEvents;
  assert.equal(a.event.playerText, '我要定金'); assert.equal(b.event.playerText, '');
  assert.equal(a.event.npcText, '我交钱。'); assert.equal(b.event.npcText, '我看到了。');
  assert.deepEqual(a.event.observations, ['我亲自交付定金。']);
  assert.deepEqual(b.event.observations, ['我看见钱袋。']);
  assert.notEqual(a.event.id, b.event.id);
  assert.equal(a.event.time, '晚上');
  assert.deepEqual(campaign.state.npcMeta.a, { lastRead: '保持判断', condition: ['擦伤'], status: 'left' });
  assert.deepEqual(campaign.state.npcs, { a: {}, b: {}, c: {} });
});

test('narrated scenes bypass exits without creating scenes or invoking rules; destination cast can experience arrival', () => {
  const campaign = game(), narration = narrate(campaign, '你走进主卧，c向你问好。');
  const snapshot = structuredClone(campaign.snapshot);
  const receipt = applyStoryReport(campaign, report({ sceneId: 'room', location: '窗边', npcs: [{ npcId: 'c', speech: '你好。', observations: ['玩家来到主卧。'] }] }), narration);
  assert.equal(campaign.state.sceneId, 'room');
  assert.deepEqual(campaign.state.visited, ['hall', 'room']);
  assert.deepEqual(campaign.state.revealedInformation.room, ['lamp']);
  assert.deepEqual(campaign.state.storyLocation, { sceneId: 'room', location: '窗边' });
  assert.equal(campaign.state.playerPosition.target, '窗边');
  assert.equal(campaign.state.completed, false);
  assert.equal(receipt.npcEvents[0].event.playerText, '');
  assert.deepEqual(campaign.snapshot, snapshot);
});

test('real cultivation normalization preserves bounded per-NPC context without sharing narration', () => {
  const campaign = game(), narration = narrate(campaign, '整篇正文含有未向任何角色透露的幕后秘密。');
  const aObservations = Array.from({ length: 20 }, (_, index) => `a亲历${index}：${'甲'.repeat(900)}`);
  const receipt = applyStoryReport(campaign, report({ npcs: [
    { npcId: 'a', speech: '这是我的经历。', observations: aObservations },
    { npcId: 'b', speech: '我只看见门。', observations: ['b亲眼看到门开了。'] }
  ] }), narration);
  const [a, b] = receipt.npcEvents.map(({ event }) => normalizeExternalEvent(event));
  assert.ok(a); assert.ok(b);
  assert.equal(a.context.length, 12);
  assert.ok(a.context.every((entry) => entry.text.length <= 800 && entry.sceneId === 'hall' && entry.role === 'dm'));
  assert.deepEqual(a.context.map((entry) => entry.text), aObservations.slice(-12).map((text) => text.slice(0, 800)));
  assert.deepEqual(b.context.map((entry) => entry.text), ['b亲眼看到门开了。']);
  assert.ok(!JSON.stringify(a).includes('b亲眼'));
  assert.ok(!JSON.stringify(b).includes('a亲历'));
  assert.ok(!JSON.stringify([a, b]).includes('幕后秘密'));
});

test('long committed narration remains complete in prompt, provenance and saved log', () => {
  const campaign = game(), body = '正文完整保留。'.repeat(10000) + '最后才真正交付了定金。';
  const narration = narrate(campaign, body);
  assert.ok(body.length > 32000);
  assert.ok(makeStoryReportPrompt(campaign, narration).includes(body));
  applyStoryReport(campaign, report({ items: [item()] }), narration);
  assert.equal(campaign.state.log.at(-1).text, body);
  assert.equal(campaign.state.freeActionItems.find((entry) => entry.id === 'gold').quantity, 40);
});

test('new textual locations retain authored scene and explicit ending is optional', () => {
  const campaign = game(), narration = narrate(campaign, '你来到地下暗室，本次冒险到此结束。');
  applyStoryReport(campaign, report({ location: '地下暗室', completed: true }), narration);
  assert.equal(campaign.state.sceneId, 'hall');
  assert.equal(campaign.snapshot.adventure.scenes.length, 2);
  assert.equal(campaign.state.storyLocation.location, '地下暗室');
  assert.equal(campaign.state.completed, true);
  assert.equal(campaign.state.status, 'completed');
  assert.equal(STORY_REPORT_SCHEMA.additionalProperties, false);
  assert.ok(!STORY_REPORT_SCHEMA.required.includes('completed'));
});
