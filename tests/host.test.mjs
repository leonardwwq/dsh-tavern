import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import plugin, { isBlankAgent } from '../lib/index.js';
import { DM_TOOLS } from '../lib/runtime.js';
import { IMPORT_LIMITS } from '../lib/core.js';
import { createExternalState, renderExternalCard, processExternalEvent } from 'dsh-cultivation/core';

const KEY = 'graystone-mine@1.0.0';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const user = (id, text = '我请求布兰说说他的看法。') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

// Mirrors the actual DSH ABI: agent.ctx contributions are scoped; restrict masks
// inherited tools only; guards are monotonic; startActivation publishes agent/created
// before it returns and caller owns activation disposal. No real provider is used.
async function setup(t, { directory, ids = ['fresh', 'next'], autoApply = true, npcTimeoutMs = 1000 } = {}) {
  const dir = directory ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-host-test-'));
  const routes = new Map(), hooks = new Map(), agents = new Map(), modes = new Map(), events = new Map();
  const effects = [], calls = [], npcCalls = [], decisionCalls = [], children = [];
  let closed = false, rejection, runNpc = async () => report();
  const noop = () => {};
  const globalToolError = () => { throw new Error('Plugin must not modify global tools'); };
  function scopedAgent(id, meta = {}) {
    const definitions = new Map(), restrictions = [], guards = [], presentations = [], sections = [];
    let maintenance = false;
    const agent = {
      id, status: 'idle', session: { meta }, followups: [],
      ctx: {
        tools: {
          register(definition) { assert.equal(typeof definition.execute, 'function'); definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
          restrict(filter) { restrictions.push(filter); return noop; },
          guard(fn) { guards.push(fn); return noop; },
          presentAs(mode) { presentations.push(mode); return noop; }
        },
        systemPrompt: {
          section(section) { sections.push(section); return noop; },
          suppressRuntimeContext() { agent.suppressed = true; return noop; }
        }
      },
      runMaintenance(task) {
        if (agent.status !== 'idle' || maintenance) throw new Error('Agent is not truly idle');
        maintenance = true;
        return Promise.resolve().then(() => task(new AbortController().signal)).finally(() => { maintenance = false; });
      },
      followup(message) { assert.equal(message.source.kind, 'user'); agent.followups.push(message); },
      definitions, restrictions, guards, presentations, sections,
      async execute(name, args = {}, caller = agent, signal = new AbortController().signal) {
        const execution = { name, args, agent: caller, signal };
        for (const guard of guards) { const reason = guard(execution); if (reason) throw new Error(reason); }
        assert.ok(definitions.has(name), `Missing scoped tool ${name}`);
        return definitions.get(name).execute(args, execution);
      }
    };
    agents.set(id, agent); events.set(id, []); return agent;
  }
  ids.forEach((id) => scopedAgent(id));
  async function emit(name, ...args) {
    const terminal = typeof args.at(-1) === 'function' ? args.pop() : async () => ({ kind: 'accept' });
    const handlers = hooks.get(name) ?? [];
    const dispatch = (index) => index === handlers.length ? terminal() : handlers[index](...args, () => dispatch(index + 1));
    return dispatch(0);
  }
  const cultivation = {
    apiVersion: 1, createExternalState, renderExternalCard,
    async developExternalState({ state }) { return { state, changes: [], pendingTasks: [] }; },
    processExternalEvent(input) { return processExternalEvent(input, async () => ({ relevance: 1, valence: 0.5, arousal: 0.3, relationshipRelevance: 1, uncertainty: 0 })); },
    setExternalSessionMode(id, mode) { modes.set(id, mode); }, clearExternalSessionMode(id) { modes.delete(id); }
  };
  const ctx = {
    cultivation,
    agents: { list: () => [...agents.values()], get: (id) => agents.get(id) },
    tools: { register: globalToolError, restrict: globalToolError, guard: globalToolError, presentAs: globalToolError },
    systemPrompt: { section() { throw new Error('No global game prompt'); } },
    sessionQuery: { async readSession(id) { calls.push(['query', id]); return { events: structuredClone(events.get(id) ?? []), session: { id } }; } },
    connection: { requestRejection() { return rejection; } },
    webServer: { register(route) { assert.equal(route.kind, 'exact'); routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    on(name, fn) {
      assert.notEqual(name, 'dispose', 'Cordis has no dispose event: cleanup must be an effect disposer');
      const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list);
      const cleanup = () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
      effects.push(cleanup); return cleanup;
    },
    effect(fn) { const cleanup = fn(); effects.push(cleanup); return cleanup; },
    subagents: {
      async startActivation(spec) {
        assert.equal(spec.provider, 'spawn'); assert.equal(spec.delivery, 'caller');
        assert.match(spec.childId, /^tavern-npc-/); assert.ok(spec.request.parent);
        const child = scopedAgent(spec.childId, { origin: 'subagent', parentSession: spec.request.parent.id });
        children.push(child);
        await emit('agent/created', { agent: child });
        // These must already be installed at publication, not after model startup.
        assert.deepEqual(child.presentations, ['native']);
        assert.deepEqual(child.restrictions, [{ allow: [] }]);
        assert.equal(child.guards.length, 1);
        assert.equal(child.guards[0]({ name: 'structured_output' }), undefined);
        for (const name of ['bash', 'read', 'subagent', 'run_code', 'ask_user_question', ...DM_TOOLS]) assert.equal(typeof child.guards[0]({ name }), 'string');
        assert.equal(child.sections[0].complete, true);
        assert.equal(child.sections[0].interpolate, false);
        assert.equal(child.definitions.size, 0); // structured_output belongs to activation manager.
        const record = { spec, child, prompt: child.sections[0].text(), disposed: false }; (spec.request.outputSchema.properties.kind ? decisionCalls : npcCalls).push(record);
        const result = Promise.resolve().then(() => runNpc(spec, child)).then((structured) => ({ stopReason: 'completed', structured }));
        return { childId: spec.childId, messageId: 'child-message', result, async dispose() { record.disposed = true; await emit('agent/disposed', { agent: child }); } };
      }
    }
  };
  const h = {
    ctx, dir, routes, hooks, agents, modes, events, calls, npcCalls, decisionCalls, children,
    agent: (id = 'fresh') => agents.get(id), scopedAgent, emit,
    async answer({ callId = 'choice-1', agent = agents.get('fresh'), questions = [{ id: 'action', question: '你准备怎么做？' }], value = { answers: [{ id: 'action', selected: ['保护队友'] }] }, signal = new AbortController().signal, result } = {}) {
      const outcome = result ?? { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] };
      const before = structuredClone(outcome);
      let continued = 0;
      const decision = await emit('tools/post-execute', { name: 'ask_user_question', callId, arguments: { questions }, agent, signal }, outcome, async () => { continued++; return { kind: 'accept' }; });
      assert.equal(continued, 1); assert.deepEqual(outcome, before); assert.deepEqual(decision, { kind: 'accept' });
      return outcome;
    },
    setRejection(value) { rejection = value; }, setNpc(fn) { runNpc = fn; },
    store() { return globalThis[Symbol.for('dsh-tavern/stores.v1')].get(path.resolve(dir)).store; },
    async apply() { await plugin.apply(ctx, { dataDir: dir, npcTimeoutMs }); },
    async dispose() {
      if (closed) return; closed = true;
      // Cordis Fiber._unload awaits all effect disposers concurrently; it never emits 'dispose'.
      await Promise.all(effects.splice(0).reverse().map(async (cleanup) => { if (typeof cleanup === 'function') await cleanup(); }));
    },
    async request(name, { method = name === 'state' ? 'GET' : 'POST', body = {}, raw, contentType = 'application/json', sessionId, chunks } = {}) {
      const route = routes.get('/tavern/api/' + name); assert.ok(route, `Missing route ${name}`);
      let consumed = false;
      const req = { method, url: '/tavern/api/' + name + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''), headers: { 'content-type': contentType }, async *[Symbol.asyncIterator]() { consumed = true; for await (const chunk of chunks ?? [raw ?? JSON.stringify(body)]) yield chunk; } };
      const headers = {};
      const res = { statusCode: 200, setHeader(name, value) { headers[name] = value; }, end(value = '') { this.body = value; } };
      await route(req, res);
      return { status: res.statusCode, headers, body: res.body ? JSON.parse(res.body) : null, consumed };
    },
    // Legacy mine remains a rule-test fixture, not the automatically loaded demo.
    async start(sessionId = 'fresh') {
      await h.store().importDirectory(fileURLToPath(new URL('./fixtures/graystone/', import.meta.url)));
      return h.request('start', { body: { sessionId, scriptKey: KEY } });
    }
  };
  t.after(async () => { await h.dispose(); if (!directory) { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dsh-tavern-host-test-')); await rm(dir, { recursive: true, force: true }); } });
  if (autoApply) await h.apply();
  return h;
}


test('isBlankAgent requires idle root and authoritative query events, never deprecated snapshotEvents', () => {
  const agent = { id: 'fresh', status: 'idle', session: { meta: {}, get snapshotEvents() { throw new Error('deprecated ABI'); } } };
  assert.equal(isBlankAgent(agent, []), true);
  assert.equal(isBlankAgent(agent, undefined), false);
  for (const type of ['user/message', 'assistant/message', 'assistant/attempt', 'turn/start', 'step/start']) assert.equal(isBlankAgent(agent, [{ type }]), false, type);
  assert.equal(isBlankAgent(agent, [{ type: 'agent/inbox/spliced', data: { inserted: [user('x')] } }]), false);
  assert.equal(isBlankAgent({ ...agent, status: 'running' }, []), false);
  assert.equal(isBlankAgent({ ...agent, id: 'tavern-npc-restored' }, []), false);
  assert.equal(isBlankAgent({ ...agent, session: { meta: { origin: 'subagent' } } }, []), false);
});

test('boot registers exact routes, imports builtin, and exposes no global tools or private script fields', async (t) => {
  const h = await setup(t);
  assert.deepEqual([...h.routes.keys()].sort(), ['archive', 'attach', 'delete-script', 'import', 'pause', 'retry-recording', 'start', 'state'].map((name) => '/tavern/api/' + name).sort());
  const result = await h.request('state');
  assert.equal(result.status, 200); assert.equal(result.body.canStart, false);
  assert.deepEqual(result.body.scripts.map((script) => script.key), ['curtain-castle@2.1.1']);
  assert.equal(result.body.scripts[0].title, '这帮人脑子好像都有问题');
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|npcGoals|reactions|privateHistory/);
  assert.equal(h.agent().definitions.size, 0);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(plugin.inject.includes('sessionQuery'), true);
});

test('automatically imported curtain-castle starts without importing the legacy fixture', async (t) => {
  const h = await setup(t);
  const started = await h.request('start', { body: { sessionId: 'fresh', scriptKey: 'curtain-castle@2.1.1' } });
  assert.equal(started.status, 200);
  assert.equal(started.body.campaign.scriptKey, 'curtain-castle@2.1.1');
  assert.equal(h.modes.get('fresh'), 'dm');
  assert.equal(h.agent().followups.length, 1);
  const state = await h.request('state', { sessionId: 'fresh' });
  assert.deepEqual(state.body.scripts.map((script) => script.key), ['curtain-castle@2.1.1']);
  assert.doesNotMatch(JSON.stringify(state.body), /PRIVATE_|npcGoals|privateHistory|initialState/);
});

test('HTTP boundary rejects untrusted origin, wrong method/media/JSON and oversized streaming bodies', async (t) => {
  const h = await setup(t);
  h.setRejection(403);
  let result = await h.request('start'); assert.equal(result.status, 403); assert.equal(result.consumed, false);
  h.setRejection(undefined);
  result = await h.request('start', { method: 'GET' }); assert.equal(result.status, 405); assert.equal(result.headers.allow, 'POST');
  for (const contentType of ['text/plain', 'application/json-evil']) {
    result = await h.request('start', { contentType }); assert.equal(result.body.code, 'CONTENT_TYPE', contentType);
  }
  for (const raw of ['{', 'null', '[]']) { result = await h.request('start', { raw }); assert.equal(result.body.code, 'INVALID_JSON'); }
  result = await h.request('import', { chunks: [Buffer.alloc(Math.ceil(IMPORT_LIMITS.archiveBytes * 4 / 3) + 8193)] });
  assert.equal(result.status, 413); assert.equal(result.body.code, 'BODY_TOO_LARGE');
  result = await h.request('import', { body: { base64: '*bad*' } }); assert.equal(result.body.code, 'INVALID_ARCHIVE');
});

test('canStart and start obey real agent/query blank state, never browser claims or missing identities', async (t) => {
  const h = await setup(t, { ids: ['fresh', 'old', 'running', 'child'] });
  h.events.set('old', [{ type: 'assistant/attempt' }]); h.agent('running').status = 'running'; h.agent('child').session.meta.origin = 'subagent';
  for (const id of ['old', 'running', 'child', 'missing']) {
    const state = await h.request('state', { sessionId: id }); assert.equal(state.body.canStart, false, id);
    const start = await h.start(id); assert.equal(start.status, 409); assert.equal(start.body.code, 'NEW_SESSION_REQUIRED');
  }
  assert.equal((await h.request('state', { sessionId: 'fresh' })).body.canStart, true);
  assert.ok(h.calls.some(([kind, id]) => kind === 'query' && id === 'fresh'));
});

test('start permanently binds, bootstraps DM and installs complete native scoped-only game surface', async (t) => {
  const h = await setup(t);
  const result = await h.start(); assert.equal(result.status, 200); assert.ok(result.body.opening);
  const agent = h.agent(); assert.equal(agent.followups.length, 1); assert.match(agent.followups[0].content[0].text, /开始冒险/);
  assert.equal(agent.followups[0].synthetic, true);
  assert.deepEqual(agent.definitions.get('tavern_rest').parameters, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual([...agent.definitions.keys()].sort(), [...DM_TOOLS].sort());
  assert.deepEqual(agent.presentations, ['native']); assert.deepEqual(agent.restrictions, [{ allow: [] }]);
  assert.equal(agent.sections[0].complete, true); assert.equal(agent.sections[0].interpolate, false); assert.equal(agent.suppressed, true);
  assert.match(agent.sections[0].text(), /PRIVATE_DM_SECRET/, 'v1 retains its legacy private DM context'); assert.equal(h.modes.get('fresh'), 'dm');
  for (const name of ['bash', 'read', 'subagent', 'run_code', 'persona_update_memory', 'new_scoped_escape_tool', 'ask_user_question']) assert.equal(typeof agent.guards[0]({ name }), 'string');
  for (const name of DM_TOOLS) assert.equal(agent.guards[0]({ name }), undefined);
  assert.match(agent.sections[0].text(), /玩家自由表达/);
  assert.doesNotMatch(agent.sections[0].text(), /ask_user_question/);
  assert.equal(h.agent('next').restrictions.length, 0);
  await assert.rejects(agent.execute('tavern_status', {}, h.agent('next')), { code: 'WRONG_CALLER' });
  const state = await h.request('state', { sessionId: 'fresh' });
  assert.equal(state.body.canStart, false); assert.equal(state.body.binding.campaignId, result.body.campaign.id);
  assert.equal((await h.start()).body.code, 'NEW_SESSION_REQUIRED');
  assert.doesNotMatch(JSON.stringify(state.body), /PRIVATE_|npcGoals|privateHistory|memoryLog|intimacy|initialState/);
});

test('bootstrap stays synthetic when host drops nonstandard message fields', async (t) => {
  const h = await setup(t); const started = await h.start();
  const agent = h.agent();
  const { synthetic, ...hostMessage } = agent.followups[0];
  await h.emit('agent/pre-step', { agent, messages: [hostMessage], signal: new AbortController().signal });
  const campaign = await h.store().getCampaign(started.body.campaign.id);
  assert.equal(campaign.state.turnIndex, 0);
  assert.equal(campaign.state.log.find((entry) => entry.eventId === hostMessage.id)?.synthetic, true);
  assert.equal(h.decisionCalls.length, 0);
  await assert.rejects(agent.execute('tavern_combat'), { code: 'NO_PLAYER_INPUT' });
  assert.equal(agent.definitions.has('tavern_speak'), false);
  assert.equal(h.npcCalls.length, 0);
});

test('explicit takeover denies running old owner and busy store; atomically leaves old session readonly', async (t) => {
  const h = await setup(t); const started = await h.start(); const campaignId = started.body.campaign.id;
  let result = await h.request('attach', { body: { sessionId: 'next', campaignId, takeover: false } }); assert.equal(result.body.code, 'TAKEOVER_REQUIRED');
  h.agent().status = 'running';
  result = await h.request('attach', { body: { sessionId: 'next', campaignId, takeover: true } }); assert.equal(result.body.code, 'CAMPAIGN_BUSY');
  h.agent().status = 'idle';
  const entered = deferred(), release = deferred();
  const busy = h.store().withCampaign('fresh', async () => { entered.resolve(); await release.promise; }); await entered.promise;
  result = await h.request('attach', { body: { sessionId: 'next', campaignId, takeover: true } }); assert.equal(result.body.code, 'CAMPAIGN_BUSY');
  release.resolve(); await busy;
  result = await h.request('attach', { body: { sessionId: 'next', campaignId, takeover: true } }); assert.equal(result.status, 200);
  const old = (await h.request('state', { sessionId: 'fresh' })).body;
  assert.equal(old.binding.readOnly, true); assert.equal(old.canStart, false); assert.match(h.agent().sections[0].text(), /只读/);
  assert.equal((await h.request('state', { sessionId: 'next' })).body.binding.readOnly, false);
  assert.match(h.agent('next').followups[0].content[0].text, /接续冒险/);
  await assert.rejects(h.agent().execute('tavern_rest'), { code: 'READ_ONLY_SESSION' });
  assert.deepEqual(await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('old-step')] }), { kind: 'reject' });
});

test('pause and resume preserve binding, reject paused steps, and block readonly/running writers', async (t) => {
  const h = await setup(t); await h.start();
  const binding = (await h.request('state', { sessionId: 'fresh' })).body.binding;
  assert.equal((await h.request('pause', { body: { sessionId: 'fresh', paused: 'yes' } })).body.code, 'INVALID_ARGUMENT');
  h.agent().status = 'running'; assert.equal((await h.request('pause', { body: { sessionId: 'fresh', paused: true } })).body.code, 'CAMPAIGN_BUSY'); h.agent().status = 'idle';
  assert.equal((await h.request('pause', { body: { sessionId: 'fresh', paused: true } })).status, 200);
  assert.equal((await h.request('state', { sessionId: 'fresh' })).body.campaign.paused, true);
  assert.deepEqual(await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('paused-input')] }), { kind: 'reject' });
  assert.equal((await h.request('pause', { body: { sessionId: 'fresh', paused: false } })).status, 200);
  assert.deepEqual((await h.request('state', { sessionId: 'fresh' })).body.binding, binding);
  assert.deepEqual(await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('resumed-input')] }), { kind: 'accept' });
});

test('unload tracks an already-reading HTTP body, waits safely, and prevents its later mutation', async (t) => {
  const h = await setup(t);
  const reading = deferred(), release = deferred();
  async function* chunks() {
    yield '{'; reading.resolve(); await release.promise;
    yield '"sessionId":"fresh","scriptKey":"' + KEY + '"}';
  }
  const request = h.request('start', { chunks: chunks() });
  await reading.promise;
  const unloading = h.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  const storeHeldDuringBodyRead = globalThis[Symbol.for('dsh-tavern/stores.v1')].has(path.resolve(h.dir));
  release.resolve();
  const response = await request; await unloading;
  assert.equal(storeHeldDuringBodyRead, true, 'body parsing must be tracked before store.close');
  assert.equal(response.body.code, 'TAVERN_UNLOADING');
  assert.equal(h.agent().followups.length, 0);
  assert.equal(globalThis[Symbol.for('dsh-tavern/stores.v1')].has(path.resolve(h.dir)), false);
  const reopened = await setup(t, { directory: h.dir });
  assert.equal((await reopened.request('state', { sessionId: 'fresh' })).body.binding, null);
  await reopened.dispose();
});

test('store refcount survives one unload and last effect unload releases lock for reopen', async (t) => {
  const first = await setup(t);
  const second = await setup(t, { directory: first.dir });
  const registry = globalThis[Symbol.for('dsh-tavern/stores.v1')];
  assert.equal(registry.get(path.resolve(first.dir)).refs, 2);
  const sharedStore = first.store();
  await first.dispose();
  assert.equal(registry.get(path.resolve(first.dir)).refs, 1);
  assert.equal(second.store(), sharedStore);
  assert.equal((await second.request('state')).status, 200);
  await second.dispose();
  assert.equal(registry.has(path.resolve(first.dir)), false);
  const reopened = await setup(t, { directory: first.dir });
  assert.notEqual(reopened.store(), sharedStore);
  assert.equal((await reopened.request('state')).status, 200);
  await reopened.dispose();
});

test('restored bindings regain DM isolation before any step and routes/effects dispose without global changes', async (t) => {
  const h = await setup(t); const started = await h.start();
  await h.dispose(); assert.equal(h.routes.size, 0);
  const restored = await setup(t, { directory: h.dir });
  assert.deepEqual([...restored.agent().definitions.keys()].sort(), [...DM_TOOLS].sort());
  assert.equal(restored.agent().sections[0].complete, true);
  assert.equal(restored.agent().suppressed, true);
  assert.equal(restored.modes.get('fresh'), 'dm');
  const state = await restored.request('state', { sessionId: 'fresh' });
  assert.equal(state.body.binding.campaignId, started.body.campaign.id);
  assert.equal(state.body.canStart, false);
  await restored.dispose();
});

test('ZIP route accepts actual demo archive and archive/delete APIs enforce referenced-save safety', async (t) => {
  const h = await setup(t);
  const zip = await readFile(new URL('../demo/curtain-castle.zip', import.meta.url));
  const imported = await h.request('import', { body: { name: 'curtain-castle.zip', base64: zip.toString('base64') } });
  assert.equal(imported.status, 200);
  assert.match(imported.body.script.scriptKey, /^curtain-castle@\d+\.\d+\.\d+$/); // Archive may intentionally retain an older published version.
  await h.start();
  assert.equal((await h.request('archive', { body: { scriptKey: KEY, archived: true } })).status, 200);
  const blocked = await h.start('next'); assert.notEqual(blocked.status, 200);
  assert.notEqual((await h.request('delete-script', { body: { scriptKey: KEY } })).status, 200);
  const state = await h.request('state', { sessionId: 'fresh' });
  assert.equal(state.body.scripts.find((script) => script.key === KEY).archived, true); assert.equal(state.body.binding.readOnly, false);
  assert.doesNotMatch(JSON.stringify(state.body), /PRIVATE_/);
});


const report = (extra = {}) => ({ summary: '本轮事实', sceneId: '', location: '', items: [], npcs: [], events: [], ...extra });
async function until(predicate, label = 'background recording') {
  for (let i = 0; i < 1000; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function commit(h, text = '公爵把钱袋交给玩家，玩家离开了。', seq = 2) {
  const stream = (frame) => h.emit('agent/assistant-stream', { agent: h.agent(), frame });
  await stream({ type: 'start', attemptId: `attempt-${seq}`, turn: 1, step: 1 });
  h.events.set('fresh', [{ seq: 1, type: 'turn/start' }, { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }]);
  await stream({ type: 'end', attemptId: `attempt-${seq}`, outcome: { kind: 'committed', eventType: 'assistant/message', seq } });
  await h.emit('agent/turn-stopping', { agent: h.agent(), turn: 1 });
}
const campaign = async (h) => h.store().getCampaign((await h.store().getBinding('fresh')).campaignId);

test('pre-step records actual inputs but never starts per-NPC approval, including batches and overlap', async (t) => {
  const h = await setup(t); await h.start();
  h.setNpc(async () => assert.fail('pre-step must not run models'));
  const first = user('first', '拿钱走人'), second = user('second', '等一会儿');
  await Promise.all([h.emit('agent/pre-step', { agent: h.agent(), messages: [first] }), h.emit('agent/pre-step', { agent: h.agent(), messages: [first, second] })]);
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [first, second] });
  assert.deepEqual((await campaign(h)).state.log.filter((entry) => entry.role === 'player').map((entry) => entry.eventId), ['first', 'second']);
  assert.equal(h.children.length, 0); assert.equal(h.decisionCalls.length, 0);
  await h.dispose(); const restored = await setup(t, { directory: h.dir }); assert.equal(restored.children.length, 0); await restored.dispose();
});

test('turn progress is session scoped and contains no player, provider or prose details', async (t) => {
  const h = await setup(t); await h.start();
  const state = async (sessionId = 'fresh') => (await h.request('state', { sessionId })).body.turnProgress;
  const controller = new AbortController();
  await h.emit('agent/inbox/inserted', { agent: h.agent(), message: user('private-id', 'PRIVATE_PLAYER') });
  assert.equal((await state()).phase, 'starting');
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('private-id', 'PRIVATE_PLAYER')], signal: controller.signal });
  assert.equal(h.children.length, 0); assert.equal((await state()).phase, 'waiting_dm'); assert.equal(await state('next'), null);
  await h.emit('agent/request-error', { agent: h.agent(), failure: { code: 'TRANSPORT', message: 'PRIVATE_PROVIDER' } });
  await h.emit('agent/assistant-stream', { agent: h.agent(), frame: { type: 'chunk', attemptId: 'attempt', chunk: { type: 'text-delta', text: 'PRIVATE_DM' } } });
  assert.equal((await state()).phase, 'output');
  controller.abort(); assert.equal((await state()).phase, 'cancelled');
  assert.doesNotMatch(JSON.stringify(await state()), /PRIVATE_|private-id/);
});

test('one sealed recorder starts only after prose persistence and cannot block the foreground turn', async (t) => {
  const h = await setup(t); await h.start(); const entered = deferred(), release = deferred();
  h.setNpc(async () => { const game = await campaign(h); assert.equal(game.state.log.at(-1).text, '已付款正文'); assert.equal(game.state.storyTasks['fresh:message:2'].status, 'pending'); entered.resolve(); return release.promise; });
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('take-money')] }); assert.equal(h.children.length, 0);
  await commit(h, '已付款正文'); await entered.promise; // turn-stopping returned before recorder completed.
  assert.equal(h.npcCalls.length, 1); const call = h.npcCalls[0];
  assert.equal(call.spec.request.parent, h.agent()); assert.ok(call.spec.request.outputSchema.properties.items); assert.equal(call.spec.request.outputSchema.properties.kind, undefined);
  assert.match(call.prompt, /已付款正文/); assert.doesNotMatch(call.prompt, /PRIVATE_DM_SECRET|PRIVATE_BRAN|PRIVATE_LYRA|PRIVATE_ELIN/);
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('continue', '继续走')] }); assert.equal(h.npcCalls.length, 1);
  release.resolve(report()); await until(async () => (await campaign(h)).state.storyTasks['fresh:message:2'].status === 'recorded');
  assert.equal(call.disposed, true); assert.equal(h.modes.has(call.child.id), false);
  await h.emit('agent/turn-stopping', { agent: h.agent(), turn: 1 });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(h.npcCalls.length, 1);
  const dormant = h.scopedAgent('tavern-npc-restored', { origin: 'subagent' }); await h.emit('agent/created', { agent: dormant });
  assert.equal(typeof dormant.guards[0]({ name: 'structured_output' }), 'string');
  assert.deepEqual(await h.emit('agent/pre-step', { agent: dormant, messages: [user('escape')] }), { kind: 'reject' });
});

test('failed extraction keeps prose across unload/reload and explicit retry route is idempotent', async (t) => {
  const h = await setup(t); const started = await h.start();
  h.setNpc(async () => { throw Error('PRIVATE_PROVIDER'); }); await commit(h, '公爵确已交付钱袋。');
  await until(async () => (await campaign(h)).state.storyTasks['fresh:message:2'].status === 'failed');
  let state = (await h.request('state', { sessionId: 'fresh' })).body;
  assert.equal(state.campaign.storyRecording.failed, 1); assert.match(JSON.stringify(state.campaign.history), /公爵确已交付钱袋/); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_PROVIDER/);
  await h.dispose(); const restored = await setup(t, { directory: h.dir }); assert.equal(restored.children.length, 0);
  restored.setNpc(async () => report({ items: [{ id: 'purse', name: '钱袋', quantity: 1, description: '定金', removed: false }] }));
  const response = await restored.request('retry-recording', { body: { sessionId: 'fresh' } }); assert.equal(response.status, 200); assert.deepEqual(response.body, { ok: true, queued: true });
  await until(async () => (await campaign(restored)).state.storyTasks['fresh:message:2'].status === 'recorded');
  await restored.request('retry-recording', { body: { sessionId: 'fresh' } });
  await new Promise((resolve) => setImmediate(resolve));
  const game = await campaign(restored); assert.equal(restored.npcCalls.length, 1); assert.equal(game.state.freeActionItems.length, 1); assert.equal(game.state.log.filter((entry) => entry.role === 'dm').length, 1);
  await restored.request('attach', { body: { sessionId: 'next', campaignId: started.body.campaign.id, takeover: true } });
  assert.notEqual((await restored.request('retry-recording', { body: { sessionId: 'fresh' } })).status, 200); await restored.dispose();
});

test('effect unload aborts pending recording and disposes exact activation without ghost state', async (t) => {
  const h = await setup(t); await h.start(); const entered = deferred(), release = deferred();
  h.setNpc(async () => { entered.resolve(); return release.promise; }); await commit(h); await entered.promise;
  const call = h.npcCalls[0]; const unloading = h.dispose();
  await new Promise((resolve) => setImmediate(resolve)); const wasAborted = call.spec.signal.aborted;
  release.resolve(report({ items: [{ id: 'ghost', name: '幽灵物品', quantity: 1, description: '', removed: false }] })); await unloading;
  assert.equal(wasAborted, true); assert.equal(call.disposed, true); assert.equal(h.routes.size, 0);
  assert.equal(globalThis[Symbol.for('dsh-tavern/stores.v1')].has(path.resolve(h.dir)), false);
  const reopened = await setup(t, { directory: h.dir }); assert.deepEqual((await campaign(reopened)).state.freeActionItems ?? [], []);
  assert.ok((await campaign(reopened)).state.log.some((entry) => entry.role === 'dm')); await reopened.dispose();
});

test('hung recording startup times out and late activation is disposed while unload retains isolation', async (t) => {
  const h = await setup(t, { npcTimeoutMs: 30 }); await h.start(); const gate = deferred(), entered = deferred(); const original = h.ctx.subagents.startActivation;
  h.ctx.subagents.startActivation = async (spec) => { const activation = await original(spec); entered.resolve(); await gate.promise; return activation; };
  await commit(h); await entered.promise; const call = h.npcCalls[0];
  await until(() => call.spec.signal.aborted);
  assert.equal(typeof call.child.guards[0]({ name: 'structured_output' }), 'string');
  let unloaded = false; const unloading = h.dispose().then(() => { unloaded = true; }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(unloaded, false);
  gate.resolve(); await unloading; assert.equal(call.disposed, true); assert.equal(h.modes.has(call.child.id), false);
});

test('hung recording dispose stays bounded and isolated without stopping unrelated agents', async (t) => {
  const h = await setup(t, { npcTimeoutMs: 30 }); await h.start(); const gate = deferred(); const original = h.ctx.subagents.startActivation;
  h.ctx.subagents.startActivation = async (spec) => { const activation = await original(spec), dispose = activation.dispose; activation.dispose = async () => { await gate.promise; await dispose(); }; return activation; };
  await commit(h); await until(() => h.npcCalls.length === 1 && h.npcCalls[0].spec.signal.aborted); const call = h.npcCalls[0];
  assert.equal(typeof call.child.guards[0]({ name: 'structured_output' }), 'string'); assert.equal(h.agent('next').status, 'idle');
  let unloaded = false; const unloading = h.dispose().then(() => { unloaded = true; }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(unloaded, false);
  gate.resolve(); await unloading; assert.equal(call.disposed, true); assert.equal(h.modes.has(call.child.id), false);
});


// Scripted narrator/report fixtures test the host-to-save chain, not provider language quality.
test('demo narrative end-to-end accepts ordinary language without old approval tools', async (t) => {
  const scenarios = [
    { name: '拿钱走人', input: '拿钱走人', prose: '公爵依约把钱袋递到你手里。你收好钱袋，走到城堡外门。', sceneId: 'gate', money: true },
    { name: '同义表达', input: '收下定金，然后动身去城堡', prose: '公爵把约定的酬金装入钱袋交给你。你收妥后动身，来到城堡外门。', sceneId: 'gate', money: true },
    { name: '拒付且前提未满足', input: '先付定金，不付我就不走', prose: '公爵摇头说：“没有签字就不给定金。”钱袋仍在桌上，你没有出发。', sceneId: '', money: false },
    { name: '等待不是拾取', input: '我等公爵把话说完', prose: '你留在书房等候。公爵补充了要求，桌上的钱袋没有移动。', sceneId: '', money: false },
    { name: '拒绝并离开', input: '这活我不接，我走了', prose: '你拒绝委托，没有拿钱，转身走出书房来到归途。', sceneId: 'withdrawal', money: false }
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async (t) => {
    const h = await setup(t);
    const started = await h.request('start', { body: { sessionId: 'fresh', scriptKey: 'curtain-castle@2.1.1' } }); assert.equal(started.status, 200);
    await h.store().withCampaign('fresh', (game) => { game.state.freeActionItems = [{ id: 'old-key', name: '旧钥匙', quantity: 1 }]; });
    let inputCount = 0;
    h.setNpc(async (spec) => {
      inputCount++; assert.ok(spec.request.outputSchema.properties.items);
      return report({ sceneId: scenario.sceneId, location: scenario.sceneId === 'gate' ? '城堡外门' : scenario.sceneId === 'withdrawal' ? '归途' : '公爵书房',
        items: scenario.money ? [{ id: 'deposit', name: '钱袋', quantity: 1, description: '公爵已付款', removed: false }] : [],
        npcs: [
          { npcId: 'bran', speech: '', observations: ['布兰亲眼见到本轮的实际结果'] },
          { npcId: 'duke', speech: '', observations: ['公爵记得玩家本轮的选择'] }
        ] });
    });
    await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('choice', scenario.input)] });
    assert.equal(inputCount, 0); assert.equal(h.children.length, 0);
    await commit(h, scenario.prose);
    await until(async () => (await campaign(h)).state.storyTasks?.['fresh:message:2']?.status === 'recorded');
    const game = await campaign(h), state = (await h.request('state', { sessionId: 'fresh' })).body;
    assert.equal(inputCount, 1); assert.equal(game.state.sceneId, scenario.sceneId || 'commission');
    assert.ok(state.campaign.inventory.some((item) => item.id === 'old-key'));
    assert.equal(state.campaign.inventory.some((item) => item.id === 'deposit'), scenario.money);
    assert.equal(state.campaign.history.find((entry) => entry.role === 'dm').text, scenario.prose);
    assert.equal(state.campaign.storyRecording.pending, 0); assert.equal(state.campaign.storyRecording.failed, 0);
    for (const npcId of ['bran', 'duke']) assert.equal(game.state.npcs[npcId].processedEventIds.length, 1);
    await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('next-choice', '继续')] });
    const prompt = h.agent().sections[0].text();
    assert.match(prompt, /布兰亲眼见到本轮的实际结果/); assert.match(prompt, /公爵记得玩家本轮的选择/);
    assert.equal(h.npcCalls.length, 1); assert.deepEqual([...h.agent().definitions.keys()].sort(), [...DM_TOOLS].sort());
  });
});


const assistantEvent = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
function failNextNarrationWrite(h) {
  const store = h.store(), original = store.withCampaign;
  let failures = 0;
  store.withCampaign = async function (...args) {
    if (!failures++) throw Error('TEST_TRANSIENT_DISK_FAILURE');
    return original.apply(this, args);
  };
  return { restore() { store.withCampaign = original; }, failures: () => failures };
}

test('a transient narration write failure survives a later turn and records once without replay', async (t) => {
  const h = await setup(t); await h.start();
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('first-turn', '拿钱走人')] });
  const failure = failNextNarrationWrite(h);
  await commit(h, 'FIRST_TURN_PROSE：公爵已经把钱袋交给你。');
  failure.restore(); assert.equal(failure.failures(), 1);
  assert.ok(!(await campaign(h)).state.log.some(entry => entry.role === 'dm'));
  assert.equal(h.npcCalls.length, 0);
  assert.match((await h.request('state', { sessionId: 'fresh' })).body.campaign.storyRecording.saveError, /不能确认已保存/);
  h.events.get('fresh').push({ seq: 3, type: 'turn/start' });
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('second-turn', '接着走')] });
  h.setNpc(async () => report({ items: [{ id: 'purse', name: '钱袋', quantity: 1, description: '第一回合已付款', removed: false }] }));
  await h.emit('agent/turn-stopping', { agent: h.agent(), turn: 2 });
  await until(async () => (await campaign(h)).state.storyTasks?.['fresh:message:2']?.status === 'recorded');
  const saved = await campaign(h), prose = saved.state.log.find(entry => entry.eventId === 'fresh:message:2');
  assert.equal(prose.text, 'FIRST_TURN_PROSE：公爵已经把钱袋交给你。');
  assert.deepEqual(prose.audience, ['bran', 'lyra', 'elin']); assert.equal(prose.inputId, 'first-turn');
  assert.equal(saved.state.storyTasks['fresh:message:2'].attempts, 1);
  assert.equal(saved.state.freeActionItems.length, 1); assert.equal(h.npcCalls.length, 1);
  await h.request('retry-recording', { body: { sessionId: 'fresh' } });
  await h.emit('agent/turn-stopping', { agent: h.agent(), turn: 2 });
  assert.equal((await campaign(h)).state.log.filter(entry => entry.eventId === prose.eventId).length, 1);
  assert.equal(h.npcCalls.length, 1); assert.equal((await campaign(h)).state.freeActionItems.length, 1);
});

test('boot recovers post-boundary prose after lost scope without giving later NPCs old memories or latest input', async (t) => {
  const h = await setup(t); await h.start();
  const failure = failNextNarrationWrite(h);
  await commit(h, 'LOST_SCOPE_PROSE：旧地点的一次付款已经完成。'); failure.restore();
  assert.equal(failure.failures(), 1); assert.equal(h.npcCalls.length, 0);
  await h.store().withCampaign('fresh', game => {
    game.state.sceneId = 'fork';
    game.state.npcMeta = { bran: { status: 'left' }, lyra: { status: 'active' }, elin: { status: 'active' } };
    game.state.log.push({ role: 'player', eventId: 'latest-input', inputId: 'latest-input', text: 'LATER_PLAYER_SECRET', sceneId: 'fork', audience: ['lyra', 'elin'], turn: 1 });
  });
  const before = (await campaign(h)).state.npcs;
  const events = structuredClone(h.events.get('fresh'));
  events.push({ seq: 3, type: 'turn/start' }, { seq: 4, type: 'user/message', data: { message: user('latest-input', 'LATER_PLAYER_SECRET') } });
  await h.dispose();
  const restored = await setup(t, { directory: h.dir, autoApply: false });
  restored.events.set('fresh', events);
  restored.setNpc(async () => { throw Error('temporary recorder outage after archive recovery'); });
  await restored.apply();
  await until(async () => (await campaign(restored)).state.storyTasks?.['fresh:message:2']?.status === 'failed');
  let saved = await campaign(restored), prose = saved.state.log.find(entry => entry.eventId === 'fresh:message:2');
  assert.equal(prose.recovered, true); assert.deepEqual(prose.audience, []); assert.equal(prose.inputId, undefined);
  assert.equal(prose.text, 'LOST_SCOPE_PROSE：旧地点的一次付款已经完成。');
  assert.match(restored.npcCalls[0].prompt, /"perceptionUnavailable":true/);
  assert.match(restored.npcCalls[0].prompt, /"playerInput":null/);
  restored.setNpc(async () => report({ items: [{ id: 'old-payment', name: '钱袋', quantity: 1, description: '旧正文的付款', removed: false }] }));
  await restored.request('retry-recording', { body: { sessionId: 'fresh' } });
  await until(async () => (await campaign(restored)).state.storyTasks['fresh:message:2'].status === 'recorded');
  saved = await campaign(restored);
  assert.deepEqual(saved.state.npcs, before); assert.deepEqual(saved.state.storyReports['fresh:message:2'].npcEvents, []);
  assert.equal(saved.state.freeActionItems.length, 1); assert.equal(saved.state.storyTasks['fresh:message:2'].attempts, 2);
  await restored.request('retry-recording', { body: { sessionId: 'fresh' } });
  await restored.emit('agent/turn-stopping', { agent: restored.agent(), turn: 2 });
  assert.equal(restored.npcCalls.length, 2); assert.equal((await campaign(restored)).state.log.filter(entry => entry.eventId === prose.eventId).length, 1);
  await restored.dispose();
});

test('first upgrade establishes a persisted recovery floor and never replays old pre-boundary prose', async (t) => {
  const h = await setup(t); await h.start();
  await h.store().withCampaign('fresh', game => {
    delete game.state.narrationRecoveryFloor;
    game.state.freeActionItems = [{ id: 'existing', name: '旧存档物品', quantity: 3 }];
  });
  const before = (await campaign(h)).state.npcs; await h.dispose();
  const restored = await setup(t, { directory: h.dir, autoApply: false });
  restored.events.set('fresh', [{ seq: 39, type: 'turn/start' }, assistantEvent(40, 'PRE_UPGRADE_PROSE：这段早已处理过的旧付款不能重放。')]);
  await restored.apply();
  let saved = await campaign(restored);
  assert.equal(saved.state.narrationRecoveryFloor, 40); assert.equal(restored.npcCalls.length, 0);
  assert.ok(!saved.state.log.some(entry => entry.text.includes('PRE_UPGRADE_PROSE')));
  assert.deepEqual(saved.state.freeActionItems, [{ id: 'existing', name: '旧存档物品', quantity: 3 }]);
  restored.events.get('fresh').push({ seq: 41, type: 'turn/start' }, assistantEvent(42, 'POST_UPGRADE_PROSE：你在当前地点等了一会儿。'));
  await restored.emit('agent/turn-stopping', { agent: restored.agent(), turn: 2 });
  await until(async () => (await campaign(restored)).state.storyTasks?.['fresh:message:42']?.status === 'recorded');
  saved = await campaign(restored);
  assert.equal(restored.npcCalls.length, 1); assert.ok(!saved.state.storyTasks['fresh:message:40']);
  assert.equal(saved.state.log.find(entry => entry.eventId === 'fresh:message:42').recovered, true);
  assert.deepEqual(saved.state.npcs, before); assert.deepEqual(saved.state.freeActionItems, [{ id: 'existing', name: '旧存档物品', quantity: 3 }]);
  await restored.dispose();
});
