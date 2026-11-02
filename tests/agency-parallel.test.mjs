import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCampaignState } from '../lib/core.js';
import { agencyKey, decideParty, externalCall } from '../lib/agency.js';

function game() {
  const characters = ['a', 'b'].map(id => ({ id, name: id, role: 'ally', goal: 'travel' }));
  const snapshot = { characters, adventure: { entry: 'room', player: { name: 'Hero', hp: 10 }, scenes: [{ id: 'room', cast: ['a', 'b'], place: 'Inn', exits: [] }] } };
  const state = initialCampaignState(snapshot, { a: {}, b: {} });
  state.log.push({ eventId: 'input', role: 'player', text: 'hello', audience: ['a', 'b'], sceneId: 'room' }, { eventId: 'private', role: 'player', text: 'only a knows', audience: ['a'], sceneId: 'room' });
  return { snapshot, state };
}
const trigger = { id: 'input', kind: 'player', text: 'hello' };
const report = (kind = 'observe', targetId = 'player', evidenceIds = ['input']) => ({ kind, targetId, visibility: 'public', reason: 'reason', evidenceIds, publicText: 'visible', read: 'read', shift: '', next: '' });
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
const received = (state, event) => ({ ...state, processedEventIds: [...(state.processedEventIds ?? []), event.id] });

test('precise routine greeting judges only the unique addressed actor', async () => {
  const campaign = game();
  campaign.state.log[0].text = '向a问好';
  const calls = [];
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, persona, event }) => { calls.push(`appraisal:${persona.id}`); return { state: received(state, event) }; } };
  await decideParty({ campaign, cultivation, trigger: { ...trigger, text: '向a问好' }, runNpc: async ({ npcId }) => { calls.push(`decision:${npcId}`); return report(); } });
  assert.deepEqual(calls.sort(), ['appraisal:a', 'decision:a']);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'observed');
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'b')], undefined);
  assert.equal(campaign.state.npcMeta?.b?.lastRead, undefined);
});

test('safe private routine skips work without writing status or altering existing state', async () => {
  const campaign = game();
  campaign.state.log[0].text = '我喝了一口水。';
  campaign.state.agencyDecisions = { [agencyKey('decision', 'input', 'b')]: { status: 'timeout', npcId: 'b', triggerId: 'input' } };
  const before = structuredClone(campaign);
  await decideParty({ campaign, cultivation: {}, trigger: { ...trigger, text: '我喝了一口水。' }, runNpc: () => assert.fail('not needed') });
  assert.deepEqual(campaign, before);
});

test('important, ambiguous, untrusted or duplicate-name inputs retain all actors', async () => {
  for (const [input, kind, setup] of [
    ['向a问好，然后威胁b', 'player'], ['a，早上好，但是我不信任你', 'player'],
    ['我喝了一口水，然后拔剑', 'player'], ['向a问好', 'combat'],
    ['向a问好', 'player', c => { c.snapshot.characters[1].name = 'a'; }],
    ['向a问好', 'player', c => { c.state.log[0].text = 'different'; }],
    ['向a问好', 'player', c => { c.state.log[0].role = 'world'; }]
  ]) {
    const campaign = game(); campaign.state.log[0].text = input; setup?.(campaign);
    const calls = [];
    const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
    await decideParty({ campaign, cultivation, trigger: { ...trigger, kind, text: input }, runNpc: async ({ npcId }) => { calls.push(npcId); return report(); } });
    assert.deepEqual(calls, ['a', 'b'], `${kind}: ${input}`);
  }
});

test('malformed observation is not recorded as observed', async () => {
  const campaign = game();
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  await decideParty({ campaign, cultivation, trigger, onlyNpcId: 'a', runNpc: async () => ({ ...report(), reason: '' }) });
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'invalid');
  assert.equal(campaign.state.npcMeta?.a?.lastRead, undefined);
});

test('explicit onlyNpcId takes precedence over routine classifier', async () => {
  const campaign = game(); campaign.state.log[0].text = '我整理自己的行囊';
  const calls = [];
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  await decideParty({ campaign, cultivation, trigger: { ...trigger, text: campaign.state.log[0].text }, onlyNpcId: 'b', runNpc: async ({ npcId }) => { calls.push(npcId); return report(); } });
  assert.deepEqual(calls, ['b']);
});

test('actors decide serially and later actors perceive earlier public actions', async (t) => {
  const campaign = game(), hold = gate(), started = gate(), prompts = {};
  t.after(() => hold.open());
  const cultivation = { renderExternalCard: ({ state }) => JSON.stringify(state), processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  const pending = decideParty({ campaign, cultivation, trigger, runNpc: async ({ npcId, prompt }) => {
    prompts[npcId] = prompt;
    if (npcId === 'a') { started.open(); await hold.promise; }
    return report('refuse');
  } });
  await started.promise;
  assert.equal(prompts.b, undefined);
  assert.equal(campaign.state.agencyDecisions, undefined);
  hold.open(); await pending;
  assert.ok(prompts.a.includes('only a knows'));
  assert.ok(!prompts.b.includes('only a knows'));
  assert.ok(prompts.b.includes('visible'));
  assert.deepEqual(campaign.state.autonomy.actions.map(x => x.npcId), ['a', 'b']);
  const before = structuredClone(campaign);
  await decideParty({ campaign, cultivation, trigger, runNpc: () => assert.fail('replay') });
  assert.deepEqual(campaign, before);
});

test('slow appraisal does not block later decisions and each appraisal sees its own serial context', async (t) => {
  const campaign = game(), hold = gate(), second = gate(), contexts = {};
  t.after(() => hold.open());
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ persona, state, event }) => {
    contexts[persona.id] = event.context;
    if (persona.id === 'a') await hold.promise;
    return { state: received(state, event) };
  } };
  const pending = decideParty({ campaign, cultivation, trigger, runNpc: async ({ npcId }) => {
    if (npcId === 'b') second.open();
    return report('refuse');
  } });
  await second.promise;
  assert.equal(campaign.state.agencyDecisions, undefined);
  assert.ok(contexts.a.some(event => event.text === 'only a knows'));
  assert.ok(!contexts.b.some(event => event.text === 'only a knows'));
  assert.ok(contexts.b.some(event => event.text.includes('visible')));
  hold.open(); await pending;
  assert.deepEqual(campaign.state.autonomy.actions.map(action => action.npcId), ['a', 'b']);
});

test('a later actor may observe an unadjudicated intent without acting', async () => {
  const campaign = game();
  let secondPrompt;
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  await decideParty({ campaign, cultivation, trigger, runNpc: async ({ npcId, prompt }) => {
    if (npcId === 'a') return { ...report('act'), publicText: '我试着打开门' };
    secondPrompt = prompt;
    return report('observe');
  } });
  assert.match(secondPrompt, /尚待裁定/);
  assert.match(secondPrompt, /我试着打开门/);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'b')].status, 'observed');
  assert.deepEqual(campaign.state.autonomy.actions.map(action => action.npcId), ['a']);
});

test('later actor can cite witnessed public event but not secret action', async () => {
  const campaign = game();
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  const publicId = agencyKey('public-action', 'input', 'a', 'refuse');
  await decideParty({ campaign, cultivation, trigger, runNpc: async ({ npcId }) => npcId === 'a' ? report('refuse') : report('confront', 'player', [publicId]) });
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'b')].status, 'committed');
  const secret = game();
  secret.state.log[0].text = 'combat';
  secret.snapshot.adventure.scenes[0].encounter = { name: 'enemy', hp: 10 };
  let promptB;
  await decideParty({ campaign: secret, cultivation, trigger: { ...trigger, kind: 'combat', text: 'combat' }, runNpc: async ({ npcId, prompt }) => {
    if (npcId === 'a') return { ...report('sabotage'), visibility: 'secret', publicText: 'SECRET_MARKER' };
    promptB = prompt; return report();
  } });
  assert.ok(!promptB.includes('SECRET_MARKER'));
  assert.equal(secret.state.log.some(e => e.text?.includes('SECRET_MARKER')), false);
});

test('abort after first actor discards provisional action and retry appraisals are idempotent', async (t) => {
  const campaign = game(), before = structuredClone(campaign), hold = gate(), started = gate(), controller = new AbortController();
  t.after(() => hold.open());
  let evaluations = 0;
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => { evaluations++; return { state: received(state, event) }; } };
  const pending = decideParty({ campaign, cultivation, trigger, signal: controller.signal, runNpc: async ({ npcId }) => {
    if (npcId === 'b') { started.open(); await hold.promise; }
    return report('refuse');
  } });
  await started.promise; controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.deepEqual(campaign, before);
  hold.open();
  await decideParty({ campaign, cultivation, trigger, onlyNpcId: 'a', runNpc: async () => { throw Error('offline'); } });
  const count = evaluations;
  await decideParty({ campaign, cultivation, trigger, onlyNpcId: 'a', runNpc: async () => report('refuse') });
  assert.equal(evaluations, count);
});

test('incomplete appraisal retries without repeating a committed decision', async () => {
  const campaign = game(); let calls = 0, evaluations = 0;
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => {
    evaluations++; return evaluations === 1 ? { state } : { state: received(state, event) };
  } };
  const args = { campaign, cultivation, trigger, onlyNpcId: 'a', runNpc: async () => { calls++; return report('refuse'); } };
  await decideParty(args);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].appraisalIncomplete, true);
  await decideParty(args);
  assert.equal(calls, 1);
  assert.equal(evaluations, 2);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].appraisalIncomplete, undefined);
  await decideParty(args);
  assert.equal(evaluations, 2);
  assert.equal(campaign.state.autonomy.actions.length, 1);
});

test('decision may finish first but awaits isolated appraisal before publication', async (t) => {
  const campaign = game(), before = structuredClone(campaign), appraisalGate = gate(), decisionGate = gate();
  t.after(() => { appraisalGate.open(); decisionGate.open(); });
  const appraisalStarted = gate(), decisionStarted = gate(), decisionFinished = gate();
  let seenPrompt;
  const cultivation = {
    renderExternalCard: ({ state }) => { state.promptOnly = 'decision mutation'; return JSON.stringify(state); },
    processExternalEvent: async ({ state, event }) => {
      assert.equal(state.promptOnly, undefined);
      assert.equal(event.playerText, 'hello');
      state.appraisalOnly = 'new relationship';
      appraisalStarted.open(); await appraisalGate.promise;
      return { state: received(state, event) };
    }
  };
  const pending = decideParty({ campaign, cultivation, trigger: { ...trigger, text: 'unperceived secret' }, onlyNpcId: 'a', runNpc: async ({ prompt }) => {
    seenPrompt = prompt; decisionStarted.open(); await decisionGate.promise; decisionFinished.open(); return report('refuse');
  } });
  await Promise.all([appraisalStarted.promise, decisionStarted.promise]);
  assert.ok(seenPrompt.includes('hello'));
  assert.ok(!seenPrompt.includes('unperceived secret'));
  assert.ok(!seenPrompt.includes('new relationship'));
  assert.ok(seenPrompt.includes('尚不能看到本次事件刚计算的数值亲密度'));
  decisionGate.open(); await decisionFinished.promise;
  assert.deepEqual(campaign, before);
  appraisalGate.open(); await pending;
  assert.equal(campaign.state.npcs.a.appraisalOnly, 'new relationship');
  assert.equal(campaign.state.npcs.a.promptOnly, undefined);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'committed');
});

test('failed appraisal retains old state and failed decision publishes successful appraisal', async (t) => {
  const campaign = game(), hold = gate(), started = gate();
  t.after(() => hold.open());
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state }) => {
    state.shouldNotLeak = true; started.open(); await hold.promise; throw Error('appraisal failed');
  } };
  const pending = decideParty({ campaign, cultivation, trigger, onlyNpcId: 'a', runNpc: async () => report('refuse') });
  await started.promise; assert.equal(campaign.state.agencyDecisions, undefined);
  hold.open(); await pending;
  assert.equal(campaign.state.npcs.a.shouldNotLeak, undefined);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'committed');
  const other = game();
  await decideParty({ campaign: other, cultivation: { ...cultivation, processExternalEvent: async ({ state, event }) => ({ state: received({ ...state, updated: true }, event) }) }, trigger, onlyNpcId: 'a', runNpc: async () => { throw Error('decision failed'); } });
  assert.equal(other.state.npcs.a.updated, true);
  assert.equal(other.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'unavailable');
});

test('incomplete appraisal cannot overwrite existing relationship state', async () => {
  const campaign = game();
  campaign.state.npcs.a = { affinity: 42, processedEventIds: ['older-event'] };
  const before = structuredClone(campaign.state.npcs.a);
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state }) => ({ state: { ...state, affinity: -10 } }) };
  await decideParty({ campaign, cultivation, trigger, onlyNpcId: 'a', runNpc: async () => report('refuse') });
  assert.deepEqual(campaign.state.npcs.a, before);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].appraisalIncomplete, true);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'committed');
});

test('later actors can cite witnessed actions; commits respect departures', async () => {
  const campaign = game();
  const fake = agencyKey('public-action', 'input', 'a', 'leave');
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  await decideParty({ campaign, cultivation, trigger, runNpc: async ({ npcId }) => npcId === 'a' ? report('leave') : report('confront', 'a', [fake]) });
  assert.deepEqual(campaign.state.autonomy.actions.map(x => x.npcId), ['a']);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'b')].status, 'invalid');
  const other = game();
  await decideParty({ campaign: other, cultivation, trigger, runNpc: async ({ npcId }) => npcId === 'a' ? report('leave') : report('confront', 'a') });
  assert.deepEqual(other.state.autonomy.actions.map(x => x.npcId), ['a']);
});

test('abort promptly stops waiting, publishes nothing and permits retry', async (t) => {
  const campaign = game(), before = structuredClone(campaign), hold = gate(), started = gate();
  t.after(() => hold.open());
  let calls = 0;
  const controller = new AbortController();
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  const pending = decideParty({ campaign, cultivation, trigger, signal: controller.signal, runNpc: async () => {
    if (++calls === 1) started.open();
    await hold.promise;
    return report('refuse');
  } });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.deepEqual(campaign, before);
  hold.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(campaign, before);
  await decideParty({ campaign, cultivation, trigger, runNpc: async () => report('refuse') });
  assert.equal(campaign.state.autonomy.actions.length, 2);
});

test('hung appraisal preserves a completed decision without publishing late relationship state', async (t) => {
  const campaign = game(), late = gate(), signals = [], before = structuredClone(campaign.state.npcs.a);
  t.after(() => late.open());
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, persona, signal, event }) => {
    if (persona.id === 'a') { signals.push(signal); await late.promise; state.late = true; }
    else state.ok = true;
    return { state: received(state, event) };
  } };
  const actions = await decideParty({ campaign, cultivation, trigger, timeoutMs: 30, runNpc: async () => report('refuse') });
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')], { status: 'committed', triggerId: 'input', npcId: 'a', appraisalIncomplete: true });
  assert.deepEqual(campaign.state.npcs.a, before);
  assert.equal(campaign.state.npcs.b.ok, true);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'b')].status, 'committed');
  assert.deepEqual(actions.map(x => x.npcId), ['a', 'b']);
  const after = structuredClone(campaign);
  late.open(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(campaign, after);
  await decideParty({ campaign, cultivation: { ...cultivation, processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) }, trigger, runNpc: async () => report('refuse') });
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'committed');
  assert.equal(campaign.state.autonomy.actions.length, 2);
});

test('appraisal budget expires independently without aborting a slower decision', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const campaign = game(), late = gate(), decisionGate = gate(), appraisalStarted = gate();
  t.after(() => { late.open(); decisionGate.open(); });
  let decisionSignal;
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, signal }) => {
    appraisalStarted.open(); await late.promise; assert.equal(signal.aborted, true); state.late = true; return { state };
  } };
  const pending = decideParty({ campaign, cultivation, trigger, onlyNpcId: 'a', timeoutMs: 8000, runNpc: async ({ signal }) => {
    decisionSignal = signal; await decisionGate.promise; return report('refuse');
  } });
  await appraisalStarted.promise;
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decisionSignal.aborted, false);
  decisionGate.open(); await pending;
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'committed');
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].appraisalIncomplete, true);
  const after = structuredClone(campaign);
  late.open(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(campaign, after);
});

test('hung decision reports timeout but retains completed appraisal', async (t) => {
  const campaign = game(), late = gate(), signals = [], before = structuredClone(campaign.state.npcs.a);
  t.after(() => late.open());
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => { state.changed = true; return { state: received(state, event) }; } };
  await decideParty({ campaign, cultivation, trigger, timeoutMs: 30, runNpc: async ({ npcId, signal }) => {
    if (npcId === 'a') { signals.push(signal); await late.promise; }
    return report('refuse');
  } });
  assert.equal(signals[0].aborted, true);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'timeout');
  assert.deepEqual(campaign.state.npcs.a, { ...before, changed: true, processedEventIds: [agencyKey('input', 'perception', 'a')] });
  const after = structuredClone(campaign);
  late.open(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(campaign, after);
});

test('non-cooperative calls have a bounded capacity and release on settlement', async (t) => {
  const hold = gate(); let started = 0;
  t.after(() => hold.open());
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async () => { started++; await hold.promise; return {}; } };
  const occupied = Array.from({ length: 32 }, () => externalCall(() => hold.promise));
  const campaign = game();
  await decideParty({ campaign, cultivation, trigger, timeoutMs: 100, runNpc: async () => report() });
  assert.equal(started, 0);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'capacity');
  hold.open(); await Promise.all(occupied);
  await decideParty({ campaign, cultivation: { ...cultivation, processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) }, trigger, runNpc: async () => report('refuse') });
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'committed');
});

test('failed decision does not publish until other work settles', async (t) => {
  const campaign = game(), hold = gate(), started = gate();
  t.after(() => hold.open());
  const cultivation = { renderExternalCard: () => '', processExternalEvent: async ({ state, event }) => ({ state: received(state, event) }) };
  const pending = decideParty({ campaign, cultivation, trigger, runNpc: async ({ npcId }) => {
    if (npcId === 'a') throw Error('offline');
    started.open(); await hold.promise; return report('refuse');
  } });
  await started.promise;
  assert.equal(campaign.state.agencyDecisions, undefined);
  hold.open(); await pending;
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'unavailable');
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'b')].status, 'committed');
  const retried = [];
  await decideParty({ campaign, cultivation, trigger, runNpc: async ({ npcId }) => { retried.push(npcId); return report('refuse'); } });
  assert.deepEqual(retried, ['a']);
  assert.equal(campaign.state.agencyDecisions[agencyKey('decision', 'input', 'a')].status, 'committed');
});
