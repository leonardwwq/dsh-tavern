// Replay independently generated model prose/reports through the actual store/runtime.
// This is not an online provider or browser test. No real campaign is opened for writing.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createStore } from '../lib/store.js';
import { createGameRuntime } from '../lib/runtime.js';
import { createExternalState, renderExternalCard, processExternalEvent, developExternalState } from 'dsh-cultivation/core';

const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/replay-narrative.mjs <isolated model-output directory>');
const base = JSON.parse(await fs.readFile(path.join(root, 'campaign.json'), 'utf8'));
const narratives = JSON.parse(await fs.readFile(path.join(root, 'live-narration.json'), 'utf8')).cases;
const reports = JSON.parse(await fs.readFile(path.join(root, 'live-records.json'), 'utf8')).cases;
const { snapshot } = base;
const entries = { 'manifest.json': snapshot.manifest, [snapshot.manifest.adventure]: snapshot.adventure };
snapshot.characters.forEach((persona, index) => { entries[snapshot.manifest.characters[index]] = persona; });
const archive = zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(JSON.stringify(value))])));
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-model-replay-'));
// Cultivation's actual core is exercised, but its evaluator is deliberately a deterministic stub.
const cultivation = {
  createExternalState, renderExternalCard,
  processExternalEvent: input => processExternalEvent(input, async () => ({ relevance: 0, valence: 0, arousal: 0, relationshipRelevance: 0, uncertainty: 0 })),
  developExternalState: input => developExternalState(input, async () => ({ growth: null, mood: null, archive: null, belief: { action: 'none' } }))
};
const results = [];
for (const item of narratives) {
  assert.match(item.id, /^[a-z-]+$/);
  const options = { dir: path.join(fixtureRoot, item.id), cultivation };
  let store = await createStore(options);
  try {
    await store.importArchive(archive);
    const created = await store.createCampaign({ scriptKey: `${snapshot.manifest.id}@${snapshot.manifest.version}`, sessionId: 'isolated' });
    await store.withCampaign('isolated', draft => {
      draft.state.freeActionItems = [{ id: 'old-key', name: '原有钥匙', sceneId: draft.state.sceneId }];
      draft.state.log = structuredClone(base.state.log);
      draft.state.log.push({ role: 'dm', eventId: 'prior-' + item.id, text: item.prior, sceneId: 'commission', audience: ['bran', 'lyra', 'elin', 'duke'] });
    });
    let calls = 0, failing = true;
    const makeRuntime = () => createGameRuntime({ store, cultivation, runStoryReport: async () => {
      calls++;
      if (failing) throw new Error('Injected recording failure');
      return reports.find(report => report.id === item.id).report;
    } });
    let runtime = makeRuntime();
    await runtime.recordInput('isolated', { id: 'input-' + item.id, content: [{ type: 'text', text: item.playerText }] });
    await runtime.recordNarration('isolated', 'dm-' + item.id, item.narration);
    await runtime.settleNarration('isolated');
    let saved = await store.getCampaign(created.id);
    assert.equal(saved.state.storyTasks['dm-' + item.id].status, 'failed');
    assert.equal(saved.state.log.at(-1).text, item.narration);
    assert.equal(saved.state.freeActionItems.length, 1);
    assert.ok((await runtime.makePrompt('isolated')).includes(item.narration));
    await store.close(); store = await createStore(options); runtime = makeRuntime(); failing = false;
    await runtime.settleNarration('isolated', { retry: true });
    saved = await store.getCampaign(created.id);
    assert.equal(saved.state.storyTasks['dm-' + item.id].status, 'recorded');
    const expected = ['refuse', 'player-refuse'].includes(item.id) ? 0 : 30;
    assert.equal(saved.state.freeActionItems.filter(value => value.name === '金币').reduce((total, value) => total + value.quantity, 0), expected);
    assert.ok(saved.state.freeActionItems.some(value => value.id === 'old-key'));
    assert.equal(saved.state.completed, false);
    await store.close(); store = await createStore(options); runtime = makeRuntime();
    await runtime.recordNarration('isolated', 'dm-' + item.id, item.narration);
    await runtime.settleNarration('isolated', { retry: true });
    assert.equal(calls, 2);
    assert.deepEqual((await store.getCampaign(created.id)).state, saved.state);
    results.push({ case: item.id, coins: expected, scene: saved.state.sceneId, location: saved.state.storyLocation?.location ?? '', failedRecordingRetainedProse: true, reloadRetryOnce: true, duplicateReplayUnchanged: true });
  } finally { await store.close(); }
}
console.log(JSON.stringify({ scope: 'Model-generated prose/extraction replay; cultivation evaluator is mocked; not live provider/browser verification', fixtureRoot, results }, null, 2));
