import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNpcDelivery } from '../lib/core.js';
import { createStore } from '../lib/store.js';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fixture(player = '我先拿定金。', npc = '我把50枚金币递给你，作为定金。', reverse = false) {
  const playerEvent = { role: 'player', eventId: 'p1', sceneId: 'hall', text: player };
  const npcEvent = { role: 'npc', eventId: 'n1', sceneId: 'hall', npcId: 'merchant', text: npc };
  return { snapshot: { characters: [{ id: 'merchant' }] }, state: { sceneId: 'hall', player: { hp: 10 }, log: reverse ? [npcEvent, playerEvent] : [playerEvent, npcEvent] } };
}
const args = { offerEventId: 'n1', inputId: 'p1', itemName: '50枚金币' };
test('deposit is settled from player request followed by actual NPC delivery, idempotently', () => {
  const campaign = fixture();
  assert.equal(applyNpcDelivery(campaign, args).alreadyDelivered, false);
  assert.equal(applyNpcDelivery(campaign, args).alreadyDelivered, true);
  assert.equal(campaign.state.freeActionItems.length, 1);
  assert.equal(campaign.state.freeActionItems[0].name, '50枚金币');
  assert.throws(() => applyNpcDelivery(campaign, { ...args, itemName: '金币' }), { code: 'DELIVERY_ALREADY_SETTLED' });
});
test('NPC offer followed by explicit acceptance works', () => {
  const campaign = fixture('我收下50枚金币。', '我递给你50枚金币。', true);
  assert.equal(applyNpcDelivery(campaign, args).item.name, '50枚金币');
});
test('refusal, uncertainty, conditions, promises and wrong quantities never create items', () => {
  const cases = [
    fixture('我不要定金。'), fixture('我先拿定金，如果你同意。'),
    fixture('我先拿定金。', '如果你完成任务，我把50枚金币递给你作为定金。'),
    fixture('我先拿定金。', '我不会把50枚金币递给你作为定金。'),
    fixture('我先拿定金。', '我会给你50枚金币作为定金。'),
    fixture('我先拿定金。', '我把50枚金币递给你作为定金，完成任务后才能收下。'),
    fixture('我先拿定金。', '我把150枚金币递给你，作为定金。'),
    fixture('我先拿定金。', '我把50枚金币递给他，作为定金。')
  ];
  for (const campaign of cases) {
    assert.throws(() => applyNpcDelivery(campaign, args));
    assert.equal(campaign.state.freeActionItems, undefined);
  }
});
test('real dialogue separates deposit delivery from unrelated instructions and negation', () => {
  const campaign = fixture('拿钱走人', '定金依约付给你们。事情办妥后，再来见我。\n行动意向（尚待 DM 裁定）：将装好的钱袋递向冒险者，没有阻拦他们离开。');
  assert.equal(applyNpcDelivery(campaign, { ...args, itemName: '钱袋' }).item.name, '钱袋');
});

test('other natural item descriptions and unrelated negation remain independent', () => {
  for (const [player, npc] of [
    ['我收下定金。', '我将沉甸甸的钱袋递给你，作为定金，没有阻拦你离开。'],
    ['我拿钱离开。', '我把装满金币的钱袋交给你作为定金。门没有锁。'],
    ['接过钱袋', '我将皮制的钱袋递向冒险者。']
  ]) {
    const campaign = fixture(player, npc);
    assert.equal(applyNpcDelivery(campaign, { ...args, itemName: '钱袋' }).item.name, '钱袋');
  }
});

test('delivery recognition fails closed on related negation, conditions and ambiguous actors', () => {
  const cases = [
    ['拿钱走人', '我没有将钱袋递向冒险者，转身离开。'],
    ['拿钱走人', '如果你办妥事情，将钱袋递向冒险者。'],
    ['拿钱走人', '将钱袋递向冒险者，完成任务后才能收下。'],
    ['拿钱走人', '将钱袋递向冒险者。你不能收下定金。'],
    ['拿钱走人', '我将会把钱袋递给你，作为定金。'],
    ['拿钱走人', '我把钱袋递给他，作为定金。'],
    ['拿钱走人', '他把钱袋递给你，作为定金。'],
    ['拿钱走人', '我让他把钱袋递给你，作为定金。'],
    ['拿钱走人', '我把钱袋递给你们的同伴，作为定金。'],
    ['拿钱走人', '我把钱袋递给你，作为定金。我没有把钱袋交给你。'],
    ['拿钱走人', '我把两袋的钱袋递给你，作为定金。'],
    ['拿钱走人', '我把两个钱袋递给你，作为定金。'],
    ['不拿钱走人', '我把钱袋递给你，作为定金。'],
    ['拿钱走人如果你同意', '我把钱袋递给你，作为定金。'],
    ['让他拿钱走人', '我把钱袋递给你，作为定金。'],
    ['拿50枚金币走人', '我把钱袋递给你，作为定金。'],
    ['拿钱走人', '没有给你定金，我把钥匙递给你。']
  ];
  for (const [player, npc] of cases) {
    const campaign = fixture(player, npc);
    assert.throws(() => applyNpcDelivery(campaign, { ...args, itemName: '钱袋' }), `${player} / ${npc}`);
    assert.equal(campaign.state.freeActionItems, undefined);
  }
});

test('generic non-money item also works', () => {
  const campaign = fixture('我收下钥匙。', '我把钥匙交给你。', true);
  assert.equal(applyNpcDelivery(campaign, { ...args, itemName: '钥匙' }).item.name, '钥匙');
});
test('store persists the item and idempotency across reloads', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-delivery-'));
  t.after(async () => { if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('tavern-delivery-')) await fs.rm(dir, { recursive: true, force: true }); });
  const options = { dir, cultivation: { createExternalState: ({ initialState }) => structuredClone(initialState) } };
  let store = await createStore(options);
  await store.importDirectory(fileURLToPath(new URL('./fixtures/graystone/', import.meta.url)));
  const created = await store.createCampaign({ scriptKey: 'graystone-mine@1.0.0', sessionId: 's1' });
  await store.withCampaign('s1', (campaign) => {
    const sceneId = campaign.state.sceneId;
    campaign.state.log.push({ role: 'player', eventId: 'p1', sceneId, text: '我先拿定金。' }, { role: 'npc', eventId: 'n1', npcId: campaign.snapshot.characters[0].id, sceneId, text: '我把50枚金币递给你，作为定金。' });
    applyNpcDelivery(campaign, args);
  });
  await store.close();
  store = await createStore(options);
  t.after(() => store.close());
  assert.equal((await store.getPublicCampaign(created.id)).state.inventory[0].name, '50枚金币');
  assert.equal((await store.withCampaign('s1', (campaign) => applyNpcDelivery(campaign, args))).alreadyDelivered, true);
});
test('synthetic input, superseded consent, different scene, and invented NPC are rejected', () => {
  const cases = [fixture(), fixture(), fixture(), fixture()];
  cases[0].state.log[0].synthetic = true;
  cases[1].state.log.push({ role: 'player', eventId: 'p2', text: '我不要了', sceneId: 'hall' });
  cases[2].state.log[1].sceneId = 'other';
  cases[3].state.log[1].npcId = 'fake';
  for (const campaign of cases) assert.throws(() => applyNpcDelivery(campaign, args));
});
