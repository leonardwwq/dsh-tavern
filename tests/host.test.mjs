import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
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
async function setup(t, { directory, ids = ['fresh', 'next'], autoApply = true } = {}) {
  const dir = directory ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-host-test-'));
  const routes = new Map(), hooks = new Map(), agents = new Map(), modes = new Map(), events = new Map();
  const effects = [], calls = [], npcCalls = [], decisionCalls = [], children = [];
  let closed = false, rejection, runNpc = async (spec) => spec.request.outputSchema.properties.kind
    ? { kind: 'observe', targetId: 'player', visibility: 'public', reason: '目前没有需要介入的事', evidenceIds: [], publicText: '', read: '', shift: '', next: '' }
    : { speech: '我会自己判断。', action: '观察营地的脚印。' };
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
        const record = { spec, child, disposed: false }; (spec.request.outputSchema.properties.kind ? decisionCalls : npcCalls).push(record);
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
    async apply() { await plugin.apply(ctx, { dataDir: dir, npcTimeoutMs: 1000 }); },
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
    async start(sessionId = 'fresh') { return h.request('start', { body: { sessionId, scriptKey: KEY } }); }
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
  assert.deepEqual([...h.routes.keys()].sort(), ['archive', 'attach', 'delete-script', 'import', 'pause', 'start', 'state'].map((name) => '/tavern/api/' + name).sort());
  const result = await h.request('state');
  assert.equal(result.status, 200); assert.equal(result.body.canStart, false);
  assert.equal(result.body.scripts[0].key, KEY);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|npcGoals|reactions|privateHistory/);
  assert.equal(h.agent().definitions.size, 0);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(plugin.inject.includes('sessionQuery'), true);
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
  assert.deepEqual([...agent.definitions.keys()], DM_TOOLS);
  assert.deepEqual(agent.presentations, ['native']); assert.deepEqual(agent.restrictions, [{ allow: ['ask_user_question'] }]);
  assert.equal(agent.sections[0].complete, true); assert.equal(agent.sections[0].interpolate, false); assert.equal(agent.suppressed, true);
  assert.match(agent.sections[0].text(), /PRIVATE_DM_SECRET/); assert.equal(h.modes.get('fresh'), 'dm');
  for (const name of ['bash', 'read', 'subagent', 'run_code', 'persona_update_memory', 'new_scoped_escape_tool']) assert.equal(typeof agent.guards[0]({ name }), 'string');
  for (const name of [...DM_TOOLS, 'ask_user_question']) assert.equal(agent.guards[0]({ name }), undefined);
  await assert.rejects(agent.execute('tavern_status', {}, h.agent('next')), { code: 'WRONG_CALLER' });
  const state = await h.request('state', { sessionId: 'fresh' });
  assert.equal(state.body.canStart, false); assert.equal(state.body.binding.campaignId, result.body.campaign.id);
  assert.equal((await h.start()).body.code, 'NEW_SESSION_REQUIRED');
  assert.doesNotMatch(JSON.stringify(state.body), /PRIVATE_|npcGoals|privateHistory|memoryLog|intimacy|initialState/);
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

test('NPC publication is isolated before startup, uses caller delivery, submits only public structured report and disposes', async (t) => {
  const h = await setup(t); await h.start();
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('ask-bran')] });
  const result = await h.agent().execute('tavern_speak', { npcId: 'bran' });
  assert.equal(result.speech, '我会自己判断。'); assert.equal(h.npcCalls.length, 1);
  const call = h.npcCalls[0];
  assert.equal(call.disposed, true); assert.equal(call.spec.request.parent, h.agent());
  assert.deepEqual(call.spec.request.outputSchema.required, ['speech', 'action', 'feltIgnored', 'read', 'shift', 'next']);
  assert.equal(call.spec.request.outputSchema.additionalProperties, false);
  assert.match(call.child.sections[0].text(), /PRIVATE_BRAN/);
  assert.doesNotMatch(call.child.sections[0].text(), /PRIVATE_DM_SECRET|PRIVATE_LYRA|PRIVATE_ELIN/);
  assert.equal(h.modes.has(call.child.id), false);
  assert.equal((await h.agent().execute('tavern_speak', { npcId: 'bran' })).speech, result.speech);
  assert.equal(h.npcCalls.length, 1); // durable per-input idempotence.
  const dormant = h.scopedAgent('tavern-npc-restored', { origin: 'subagent' });
  await h.emit('agent/created', { agent: dormant });
  assert.equal(typeof dormant.guards[0]({ name: 'structured_output' }), 'string');
  assert.deepEqual(await h.emit('agent/pre-step', { agent: dormant, messages: [user('escape')] }), { kind: 'reject' });
});

test('cancelling a pending NPC call disposes exact activation and does not commit a ghost report', async (t) => {
  const h = await setup(t); await h.start();
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('cancel-npc')] });
  const published = deferred();
  h.setNpc(async () => { published.resolve(); return new Promise(() => {}); });
  const controller = new AbortController();
  const operation = h.agent().execute('tavern_speak', { npcId: 'bran' }, h.agent(), controller.signal);
  await published.promise;
  controller.abort(new Error('cancel test'));
  await assert.rejects(operation, { code: 'ABORTED' });
  assert.equal(h.npcCalls.length, 1);
  assert.equal(h.npcCalls[0].disposed, true);
  assert.equal(h.modes.has(h.npcCalls[0].child.id), false);
  const game = await h.store().getCampaign((await h.store().getBinding('fresh')).campaignId);
  assert.equal(game.state.log.filter((entry) => entry.role === 'npc').length, 0);
});

test('effect unload aborts in-flight NPC before timeout, disposes activation, and releases final store ref', async (t) => {
  const h = await setup(t); await h.start();
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('unload-npc')] });
  const published = deferred(), release = deferred();
  h.setNpc(async () => { published.resolve(); return release.promise; });
  const operation = h.agent().execute('tavern_speak', { npcId: 'bran' }).catch((error) => error);
  await published.promise;
  const call = h.npcCalls[0];
  const unloading = h.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  const abortedDuringUnload = call.spec.signal.aborted;
  // Always release the fake provider even on regression, so cleanup cannot hang the suite.
  release.resolve({ speech: '', action: '取消后不再行动。' });
  await operation; await unloading;
  assert.equal(abortedDuringUnload, true, 'effect disposer must abort active NPC immediately, not wait for timeout');
  assert.equal(call.disposed, true);
  assert.equal(h.routes.size, 0);
  assert.equal(globalThis[Symbol.for('dsh-tavern/stores.v1')].has(path.resolve(h.dir)), false);
  const reopened = await setup(t, { directory: h.dir });
  assert.equal((await reopened.request('state', { sessionId: 'fresh' })).body.binding.readOnly, false);
  await reopened.dispose();
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
  assert.deepEqual([...restored.agent().definitions.keys()], DM_TOOLS);
  assert.equal(restored.agent().sections[0].complete, true);
  assert.equal(restored.agent().suppressed, true);
  assert.equal(restored.modes.get('fresh'), 'dm');
  const state = await restored.request('state', { sessionId: 'fresh' });
  assert.equal(state.body.binding.campaignId, started.body.campaign.id);
  assert.equal(state.body.canStart, false);
  await restored.dispose();
});

test('pre-step automatically decides once per actual input before continuation and never launches on restore', async (t) => {
  const h = await setup(t); await h.start();
  assert.equal(h.decisionCalls.length, 0);
  const input = user('automatic-input');
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [input], signal: new AbortController().signal }, async () => {
    assert.ok(h.decisionCalls.length > 0);
    assert.ok(h.decisionCalls.every((call) => call.disposed));
    return { kind: 'accept' };
  });
  const count = h.decisionCalls.length;
  for (const call of h.decisionCalls) {
    assert.ok(call.spec.request.outputSchema.properties.kind);
    assert.doesNotMatch(call.spec.request.prompt[0].text, /公开台词 speech/);
    assert.match(call.spec.request.prompt[0].text, /独立决定/);
  }
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [input] });
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [] });
  assert.equal(h.decisionCalls.length, count);
  await h.dispose();
  const restored = await setup(t, { directory: h.dir });
  assert.equal(restored.decisionCalls.length, 0);
});

test('one pre-step batch independently reacts to each actual player message in order', async (t) => {
  const h = await setup(t); await h.start();
  const batch = [user('batch-first', '我先向队友道歉。'), user('batch-second', '随后请大家检查矿道。')];
  await h.emit('agent/pre-step', { agent: h.agent(), messages: batch });
  const triggers = h.decisionCalls.map((call) => JSON.parse(call.child.sections[0].text().split('【当前机会】')[1].split('\n')[0]).id);
  assert.deepEqual([...new Set(triggers)], ['batch-first', 'batch-second']);
  assert.equal(triggers.filter((id) => id === 'batch-first').length, triggers.filter((id) => id === 'batch-second').length);
  assert.ok(triggers.filter((id) => id === 'batch-first').length > 0);
  const count = h.decisionCalls.length;
  await h.emit('agent/pre-step', { agent: h.agent(), messages: batch });
  assert.equal(h.decisionCalls.length, count);
  const game = await h.store().getCampaign((await h.store().getBinding('fresh')).campaignId);
  assert.equal(game.state.log.filter((entry) => entry.role === 'player').length, 2);
});

test('canonical clickable selected and custom answers become real idempotent inputs without synthetic followups', async (t) => {
  const h = await setup(t); await h.start();
  const followups = h.agent().followups.length;
  const value = { answers: [{ id: 'action', selected: ['保护队友'], custom: '我挡在布兰面前' }] };
  await h.answer({ value });
  assert.ok(h.decisionCalls.length > 0);
  const count = h.decisionCalls.length;
  const game = await h.store().getCampaign((await h.store().getBinding('fresh')).campaignId);
  const input = game.state.log.find((entry) => entry.eventId === 'tavern-choice:choice-1');
  assert.equal(input.role, 'player');
  assert.match(input.text, /你准备怎么做？/); assert.match(input.text, /保护队友/); assert.match(input.text, /我挡在布兰面前/);
  assert.equal(h.agent().followups.length, followups);
  await h.answer({ value }); assert.equal(h.decisionCalls.length, count);
  await h.answer({ callId: 'custom-only', value: { answers: [{ id: 'action', selected: [], custom: '先检查伤势' }] } });
  assert.ok(h.decisionCalls.length > count);
});

test('failed pending skipped malformed ordinary and readonly clickable outcomes never create input or decisions', async (t) => {
  const h = await setup(t); const started = await h.start();
  for (const value of [{ pending: true, callId: 'pending' }, { answers: [] }, { answers: [{ id: 'action', selected: [], custom: '  ' }] }, { answers: [{ id: 'missing', selected: ['攻击'] }] }, { answers: [{ id: 'action', selected: '攻击' }] }]) await h.answer({ value });
  await h.answer({ result: { isError: true, error: { message: 'cancelled' }, content: [] } });
  await h.answer({ agent: h.agent('next') });
  assert.equal(h.decisionCalls.length, 0);
  await h.request('pause', { body: { sessionId: 'fresh', paused: true } });
  await h.answer(); assert.equal(h.decisionCalls.length, 0);
  await h.request('pause', { body: { sessionId: 'fresh', paused: false } });
  await h.request('attach', { body: { sessionId: 'next', campaignId: started.body.campaign.id, takeover: true } });
  await h.answer(); assert.equal(h.decisionCalls.length, 0);
  await h.store().withCampaign('next', async (campaign) => { campaign.state.completed = true; campaign.state.status = 'completed'; });
  await h.answer({ agent: h.agent('next') });
  await h.emit('agent/pre-step', { agent: h.agent('next'), messages: [user('completed-input')] });
  assert.equal(h.decisionCalls.length, 0);
});

test('pre-step forwards actual payload cancellation and unload drains autonomous hook work', async (t) => {
  const h = await setup(t); await h.start();
  const published = deferred();
  h.setNpc(async () => { published.resolve(); return new Promise(() => {}); });
  const controller = new AbortController();
  const operation = h.emit('agent/pre-step', { agent: h.agent(), messages: [user('cancel-automatic')], signal: controller.signal }).catch((error) => error);
  await published.promise;
  controller.abort(new Error('host cancellation'));
  const error = await operation;
  assert.equal(error.code, 'ABORTED');
  assert.ok(h.decisionCalls.every((call) => call.spec.signal.aborted && call.disposed));
  const secondPublished = deferred();
  h.setNpc(async () => { secondPublished.resolve(); return new Promise(() => {}); });
  const second = h.answer({ callId: 'unload-choice' }).catch((error) => error);
  await secondPublished.promise;
  await h.dispose(); await second;
  assert.ok(h.decisionCalls.every((call) => call.spec.signal.aborted && call.disposed));
  assert.equal(globalThis[Symbol.for('dsh-tavern/stores.v1')].has(path.resolve(h.dir)), false);
});

test('DM narration captures source-scene audience per committed message before later NPC decisions', async (t) => {
  const h = await setup(t); await h.start();
  await h.store().withCampaign('fresh', async (campaign) => {
    campaign.state.npcMeta ??= {};
    campaign.state.npcMeta.lyra = { status: 'left' };
    campaign.state.npcMeta.elin = { status: 'left' };
  });
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('before-move')] });
  const stream = (frame) => h.emit('agent/assistant-stream', { agent: h.agent(), frame });
  const assistant = (seq, text, type = 'assistant/message') => ({ seq, type, data: { message: { content: [{ type: 'text', text }] } } });
  h.events.set('fresh', [{ seq: 1, type: 'turn/start' }]);
  await stream({ type: 'start', attemptId: 'before-arrival', turn: 1, step: 1 });
  h.events.get('fresh').push(assistant(2, 'PREARRIVAL_NARRATION：布兰低声说出营地的暗号。'));
  await stream({ type: 'end', attemptId: 'before-arrival', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } });
  await h.store().withCampaign('fresh', async (campaign) => {
    campaign.state.npcMeta.bran = { status: 'left' };
    campaign.state.npcMeta.lyra = { status: 'active', returnedAtScene: 'fork' };
  });
  await h.agent().execute('tavern_scene', { sceneId: 'fork' });
  const before = h.decisionCalls.length;
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('after-move', '我看向莱拉。')] });
  assert.ok(h.decisionCalls.length > before);
  for (const call of h.decisionCalls.slice(before)) assert.doesNotMatch(call.child.sections[0].text(), /PREARRIVAL_NARRATION/);
  let game = await h.store().getCampaign((await h.store().getBinding('fresh')).campaignId);
  const first = game.state.log.find((entry) => entry.eventId === 'fresh:message:2');
  assert.equal(first.sceneId, 'camp'); assert.deepEqual(first.audience, ['bran']);
  await stream({ type: 'start', attemptId: 'after-arrival', turn: 1, step: 2 });
  h.events.get('fresh').push(assistant(3, 'POSTARRIVAL_NARRATION：莱拉指出岔道的风声。'));
  await stream({ type: 'end', attemptId: 'after-arrival', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } });
  await stream({ type: 'start', attemptId: 'failed-attempt', turn: 1, step: 3 });
  h.events.get('fresh').push(assistant(4, 'FAILED_ATTEMPT_MUST_NOT_BE_HEARD', 'assistant/attempt'));
  await stream({ type: 'end', attemptId: 'failed-attempt', outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 4 } });
  h.events.get('fresh').push(assistant(5, 'LEGACY_UNSCOPED_NARRATION'));
  await h.emit('agent/turn-stopping', { agent: h.agent(), turn: 1 });
  await h.emit('agent/turn-stopping', { agent: h.agent(), turn: 1 });
  game = await h.store().getCampaign((await h.store().getBinding('fresh')).campaignId);
  assert.equal(game.state.log.filter((entry) => entry.eventId === 'fresh:message:2').length, 1);
  assert.deepEqual(game.state.log.find((entry) => entry.eventId === 'fresh:message:3').audience, ['lyra']);
  assert.equal(game.state.log.find((entry) => entry.eventId === 'fresh:message:3').sceneId, 'fork');
  assert.deepEqual(game.state.log.find((entry) => entry.eventId === 'fresh:message:5').audience, []);
  assert.ok(!game.state.log.some((entry) => entry.text.includes('FAILED_ATTEMPT_MUST_NOT_BE_HEARD')));
  const after = h.decisionCalls.length;
  await h.emit('agent/pre-step', { agent: h.agent(), messages: [user('after-narration', '接下来呢？')] });
  const prompts = h.decisionCalls.slice(after).map((call) => call.child.sections[0].text()).join('\n');
  assert.match(prompts, /POSTARRIVAL_NARRATION/);
  assert.doesNotMatch(prompts, /PREARRIVAL_NARRATION|LEGACY_UNSCOPED_NARRATION/);
});

test('ZIP route accepts actual demo archive and archive/delete APIs enforce referenced-save safety', async (t) => {
  const h = await setup(t);
  const zip = await readFile(new URL('../demo/graystone.zip', import.meta.url));
  assert.equal((await h.request('import', { body: { name: 'graystone.zip', base64: zip.toString('base64') } })).status, 200);
  await h.start();
  assert.equal((await h.request('archive', { body: { scriptKey: KEY, archived: true } })).status, 200);
  const blocked = await h.start('next'); assert.notEqual(blocked.status, 200);
  assert.notEqual((await h.request('delete-script', { body: { scriptKey: KEY } })).status, 200);
  const state = await h.request('state', { sessionId: 'fresh' });
  assert.equal(state.body.scripts[0].archived, true); assert.equal(state.body.binding.readOnly, false);
  assert.doesNotMatch(JSON.stringify(state.body), /PRIVATE_/);
});
