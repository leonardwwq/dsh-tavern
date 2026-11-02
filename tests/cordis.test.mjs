import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function runtimeRoot() {
  const candidates = [process.env.DSH_RUNTIME_DIR, process.env.DSH_CHECKOUT_DIR && join(process.env.DSH_CHECKOUT_DIR, 'node_modules/@deepseek-ai')].filter(Boolean);
  try { candidates.unshift(dirname(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json')))); } catch {}
  for (const candidate of candidates) {
    try { await access(join(candidate, 'dsh-tools/lib/index.js')); return candidate; } catch {}
  }
}
const runtime = await runtimeRoot();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Real Cordis owns all service injection, scope layers, policy execution, prompt
// assembly, and concurrent teardown. Only the application seams are fake: no
// listener, model, browser, active profile, or replacement server is started.
test('real Cordis boots tavern, seals narrator/recorder scopes, drains concurrent unload, and reopens storage', {
  skip: !runtime && 'Set DSH_RUNTIME_DIR to the installed @deepseek-ai directory', timeout: 15000
}, async () => {
  const load = name => import(pathToFileURL(join(runtime, name, 'lib/index.js')));
  const [{ Context }, { default: SystemPrompt, renderPrompt }, { default: ToolRuntime }, { createScope, scopeTarget }, { default: tavern }, { DM_TOOLS }, { createStore }, external] = await Promise.all([
    load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-scope'),
    import('../lib/index.js'), import('../lib/runtime.js'), import('../lib/store.js'), import('dsh-cultivation/core')
  ]);
  const directory = await mkdtemp(join(root, '.test-cordis-'));
  const ctx = new Context();
  const providers = [], scopes = [], agents = new Map(), routes = new Map(), events = new Map(), modes = new Map(), activations = [];
  let game, serviceContext, blockNextRecording = false, published = deferred();
  let sequence = 0, startedCampaignId;
  const store = () => globalThis[Symbol.for('dsh-tavern/stores.v1')].get(directory).store;
  async function until(predicate) {
    for (let i = 0; i < 1000; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
    assert.fail('Timed out waiting for background recorder');
  }
  async function commit(agent, seq, text) {
    const stream = frame => ctx.serial(scopeTarget(agent, agent), 'agent/assistant-stream', { agent, frame });
    await stream({ type: 'start', attemptId: `attempt-${seq}`, turn: 1, step: 1 });
    events.set(agent.id, [{ seq: 1, type: 'turn/start' }, { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }]);
    await stream({ type: 'end', attemptId: `attempt-${seq}`, outcome: { kind: 'committed', eventType: 'assistant/message', seq } });
    await ctx.serial(scopeTarget(agent, agent), 'agent/turn-stopping', { agent, turn: 1, signal: signal() });
  }
  const signal = () => new AbortController().signal;
  const schemas = agent => ctx.tools.schemas(agent).map(tool => tool.name).sort();
  const execute = (agent, name, args = {}) => ctx.tools.execute({ callId: `cordis-test-${++sequence}`, name, arguments: args, agent, signal: signal() });
  const emitCreated = agent => ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' });
  const preStep = async (agent, id) => {
    const messages = [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我请求布兰独立判断营地的线索。' }] }];
    return ctx.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, messages, turn: 1, step: 1, signal: signal() }, async () => ({ kind: 'enter', messages }));
  };
  const definition = (name, run = async () => ({}), parameters = { type: 'object', properties: {}, additionalProperties: false }) => ({
    name, description: name, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: run
  });
  const cultivation = {
    apiVersion: 1, createExternalState: external.createExternalState, renderExternalCard: external.renderExternalCard,
    async developExternalState({ state }) { return { state, changes: [], pendingTasks: [] }; },
    processExternalEvent: input => external.processExternalEvent(input, async () => ({ relevance: 1, valence: 0.5, arousal: 0.3, relationshipRelevance: 1, uncertainty: 0 })),
    setExternalSessionMode(id, mode) { modes.set(id, mode); }, clearExternalSessionMode(id) { modes.delete(id); }
  };
  function newAgent(id, meta = {}) {
    const agent = { id, status: 'idle', session: { header: meta }, followups: [], followup(message) { this.followups.push(message); }, async runMaintenance(task) { return task(signal()); } };
    const scope = createScope(serviceContext, agent);
    agent.ctx = scope.ctx;
    agent.scope = scope;
    scopes.push(scope); agents.set(id, agent); events.set(id, []);
    return agent;
  }
  async function request(name, body) {
    const handler = routes.get(`/tavern/api/${name}`);
    assert(handler, `Missing ${name} route`);
    const req = { method: 'POST', url: `/tavern/api/${name}`, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } };
    await handler(req, res);
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body);
  }
  try {
    // Start before dependencies exist: real injection must keep apply pending.
    game = ctx.plugin(tavern, { dataDir: directory, npcTimeoutMs: 5000 });
    assert.equal(routes.size, 0);
    assert.notEqual(game.state, 2);
    providers.push(await ctx.plugin(SystemPrompt, {}));
    providers.push(await ctx.plugin(ToolRuntime, {}));
    providers.push(await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(c) {
      serviceContext = c;
      c.tools.register(definition('bash'));
      c.tools.register(definition('read'));
      c.tools.register(definition('ask_user_question', async () => ({ answers: [{ id: 'action', selected: ['保护队友'], custom: '我挡在布兰身前' }] }), { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', additionalProperties: true } } }, additionalProperties: false }));
      c.systemPrompt.section({ name: 'test:ordinary', order: 50, text: 'ORDINARY_ASSISTANT' });
      // Deliberately direct ctx.provide, not effect-wrapped: actual Cordis
      // visibility/injection must release the pending tavern fiber.
      c.provide('cultivation', cultivation);
      c.provide('agents', { list: () => [...agents.values()], get: id => agents.get(id) });
      c.provide('connection', { requestRejection: () => undefined });
      c.provide('sessionQuery', { readSession: async id => ({ events: structuredClone(events.get(id) || []) }) });
      c.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } });
      c.provide('subagents', { async startActivation(spec) {
        assert.equal(spec.provider, 'spawn'); assert.equal(spec.delivery, 'caller');
        assert.match(spec.childId, /^tavern-npc-/);
        const child = newAgent(spec.childId, { origin: 'subagent', parentSession: spec.request.parent.id });
        let report;
        child.ctx.tools.register(definition('structured_output', async args => { report = args; return { accepted: true }; }, spec.request.outputSchema));
        assert.deepEqual(schemas(child), ['ask_user_question', 'bash', 'read', 'structured_output']);
        await emitCreated(child);
        assert.deepEqual(schemas(child), ['structured_output']);
        const assembly = await ctx.systemPrompt.assemble({ scope: child, agent: child });
        assert.deepEqual(assembly.sections.map(section => section.name), ['tavern:npc']);
        const prompt = renderPrompt(assembly);
        assert.ok(spec.request.outputSchema.properties.items);
        assert.equal(spec.request.outputSchema.properties.kind, undefined);
        assert.match(prompt, /RECORD_PROSE/);
        assert.doesNotMatch(prompt, /PRIVATE_DM_SECRET|PRIVATE_BRAN|PRIVATE_LYRA|PRIVATE_ELIN|ORDINARY_ASSISTANT/);
        const committed = await globalThis[Symbol.for('dsh-tavern/stores.v1')].get(directory).store.getCampaign(startedCampaignId);
        assert(committed.state.log.some(entry => entry.role === 'dm' && entry.text.includes('RECORD_PROSE')));
        assert(Object.values(committed.state.storyTasks).some(task => task.status === 'pending'));
        const forbidden = await execute(child, 'bash');
        assert.equal(forbidden.isError, true);
        assert.equal((await execute(child, 'ask_user_question')).isError, true);
        // Own registrations bypass restrict() visibility, but never its guard.
        let escaped = false;
        const escape = child.ctx.tools.register(definition('escape', async () => { escaped = true; return {}; }));
        try { assert.equal((await execute(child, 'escape')).isError, true); assert.equal(escaped, false); } finally { escape(); }
        const submitted = await execute(child, 'structured_output', {
          summary: '已交付钱袋', sceneId: '', location: '营地',
          items: [{ id: `item-${activations.length + 1}`, name: '钱袋', quantity: 1, description: '已交付', removed: false }],
          npcs: [{ npcId: 'bran', speech: '我看见了。', observations: ['布兰看见玩家收到钱袋'] }], events: []
        });
        assert.equal(submitted.isError, false);
        assert.equal(report.summary, '已交付钱袋');
        const record = { child, prompt, disposed: false, spec };
        activations.push(record);
        let result;
        if (blockNextRecording) {
          blockNextRecording = false;
          result = new Promise(resolve => {
            const aborted = () => resolve({ stopReason: 'aborted', output: [] });
            if (spec.signal.aborted) aborted(); else spec.signal.addEventListener('abort', aborted, { once: true });
          });
        } else result = Promise.resolve({ stopReason: 'completed', structured: report, output: [] });
        published.resolve(record);
        return { childId: child.id, messageId: 'test-child-input', result, async dispose() {
          if (record.disposed) return;
          record.disposed = true;
          await child.scope.dispose();
          agents.delete(child.id);
          await ctx.emit(scopeTarget(child, child), 'agent/disposed', { agent: child });
        } };
      } });
    } }));
    await game;
    assert.equal(game.state, 2);
    assert.equal(routes.size, 8);
    assert(routes.has('/tavern/api/retry-recording'));
    // Retain the original mine as an explicit ABI/rule-test fixture only.
    await globalThis[Symbol.for('dsh-tavern/stores.v1')].get(directory).store.importDirectory(join(root, 'tests/fixtures/graystone'));
    const dm = newAgent('cordis-dm');
    const ordinary = newAgent('cordis-ordinary');
    await emitCreated(dm); await emitCreated(ordinary);
    assert.deepEqual(schemas(dm), ['ask_user_question', 'bash', 'read']);
    const started = await request('start', { sessionId: dm.id, scriptKey: 'graystone-mine@1.0.0' });
    assert(started.campaign.id); startedCampaignId = started.campaign.id;
    assert.deepEqual(DM_TOOLS, ['tavern_status', 'tavern_check', 'tavern_combat', 'tavern_rest']);
    assert.deepEqual(schemas(dm), [...DM_TOOLS].sort());
    assert.deepEqual(schemas(ordinary), ['ask_user_question', 'bash', 'read']);
    assert.equal(dm.followups.length, 1);
    assert.equal(dm.followups[0].synthetic, true);
    const assembly = await ctx.systemPrompt.assemble({ scope: dm, agent: dm });
    assert.deepEqual(assembly.sections.map(section => section.name), ['tavern:dm']);
    assert.match(renderPrompt(assembly), /PRIVATE_DM_SECRET/, 'v1 retains its legacy private DM context');
    assert.doesNotMatch(renderPrompt(assembly), /ORDINARY_ASSISTANT/);
    assert.equal((await execute(dm, 'bash')).isError, true);
    assert.equal((await execute(dm, 'tavern_status')).isError, false);
    assert.equal((await preStep(dm, 'first-player-action')).kind, 'enter');
    assert.equal(activations.length, 0, 'pre-step must not launch per-NPC approval');
    assert.equal((await execute(dm, 'tavern_speak', { npcId: 'bran' })).isError, true);
    assert.equal(activations.length, 0);
    await commit(dm, 2, 'RECORD_PROSE：钱袋已经交付，布兰看见了。');
    await published.promise;
    await until(async () => (await store().getCampaign(startedCampaignId)).state.storyTasks[`${dm.id}:message:2`].status === 'recorded');
    assert.equal(activations.length, 1, 'exactly one record task, not one task per NPC');
    assert(activations.every(record => record.disposed && !modes.has(record.child.id)));
    let saved = await store().getCampaign(startedCampaignId);
    assert.equal(saved.state.freeActionItems.length, 1);
    assert.equal(saved.state.npcs.bran.processedEventIds.length, 1);
    await ctx.serial(scopeTarget(dm, dm), 'agent/turn-stopping', { agent: dm, turn: 1, signal: signal() });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(activations.length, 1);
    const beforeChoice = activations.length;
    const answer = await execute(dm, 'ask_user_question', { questions: [{ id: 'action', question: '你准备怎么做？' }] });
    assert.equal(answer.isError, true);
    assert.equal(activations.length, beforeChoice, 'blocked game question must not trigger decisions');
    assert.equal((await execute(ordinary, 'ask_user_question', { questions: [{ id: 'action', question: '你准备怎么做？' }] })).isError, false);
    assert.equal(dm.followups.length, 1, 'no duplicate synthetic user turn');

    // A cold/reopened NPC prefix is fail-closed, even with its own report tool.
    const dormant = newAgent('tavern-npc-dormant', { origin: 'subagent' });
    dormant.ctx.tools.register(definition('structured_output'));
    await emitCreated(dormant);
    assert.equal((await execute(dormant, 'structured_output')).isError, true);
    assert.equal((await preStep(dormant, 'unrelated-task')).kind, 'reject');

    // Unload during the plugin-owned background recording task.
    // Cordis unwinds all independent effects concurrently, not a hand-ordered
    // fake cleanup list; the host must abort, drain, and close storage itself.
    await preStep(dm, 'second-player-action');
    published = deferred(); blockNextRecording = true;
    await commit(dm, 3, 'RECORD_PROSE：第二轮正文仍须保留。');
    const blocked = await published.promise;
    saved = await store().getCampaign(startedCampaignId);
    assert.equal(saved.state.log.find(entry => entry.eventId === `${dm.id}:message:3`).text, 'RECORD_PROSE：第二轮正文仍须保留。');
    assert.equal(saved.state.storyTasks[`${dm.id}:message:3`].status, 'pending');
    await game.dispose();
    game = null;
    assert.equal(blocked.spec.signal.aborted, true);
    assert(activations.every(record => record.disposed));
    assert.equal(routes.size, 0);
    assert.deepEqual(schemas(dm), ['ask_user_question', 'bash', 'read']);
    const restored = await ctx.systemPrompt.assemble({ scope: dm, agent: dm });
    assert.match(renderPrompt(restored), /ORDINARY_ASSISTANT/);
    assert(!restored.sections.some(section => section.name.startsWith('tavern:')));
    assert.equal(globalThis[Symbol.for('dsh-tavern/stores.v1')].has(directory), false);
    const reopened = await createStore({ dir: directory, cultivation });
    try {
      assert.equal((await reopened.getBinding(dm.id)).campaignId, started.campaign.id);
      const persisted = await reopened.getCampaign(startedCampaignId);
      assert.equal(persisted.state.freeActionItems.length, 1, 'cancelled record cannot commit ghost items');
      assert.equal(persisted.state.storyTasks[`${dm.id}:message:2`].status, 'recorded');
      assert.equal(persisted.state.storyTasks[`${dm.id}:message:3`].status, 'failed');
      assert(persisted.state.log.some(entry => entry.text === 'RECORD_PROSE：第二轮正文仍须保留。'));
    } finally { await reopened.close(); }
    // Reload must reinstall cleanly: no duplicate mode declarations/sections.
    game = await ctx.plugin(tavern, { dataDir: directory });
    assert.deepEqual(schemas(dm), [...DM_TOOLS].sort());
    assert.equal((await execute(dm, 'tavern_status')).isError, false);
    await game.dispose(); game = null;
    assert.deepEqual(schemas(dm), ['ask_user_question', 'bash', 'read']);
  } finally {
    if (game) await game.dispose();
    for (const scope of scopes.reverse()) await scope.dispose();
    for (const provider of providers.reverse()) await provider.dispose();
    const target = await realpath(directory);
    assert(target.startsWith(root + sep + '.test-cordis-'), 'Refuse unexpected integration fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
