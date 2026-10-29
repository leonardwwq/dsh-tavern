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
test('real Cordis boots tavern, seals DM/NPC scopes, drains concurrent unload, and reopens storage', {
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
  let game, serviceContext, blockNextNpc = false, published = deferred();
  let sequence = 0;
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
        const decision = Boolean(spec.request.outputSchema.properties.kind);
        assert.match(prompt, /PRIVATE_(BRAN|LYRA|ELIN)/);
        assert.equal((prompt.match(/PRIVATE_(?:BRAN|LYRA|ELIN)/g) ?? []).length, 1);
        assert.doesNotMatch(prompt, /PRIVATE_DM_SECRET|ORDINARY_ASSISTANT/);
        const forbidden = await execute(child, 'bash');
        assert.equal(forbidden.isError, true);
        assert.equal((await execute(child, 'ask_user_question')).isError, true);
        // Own registrations bypass restrict() visibility, but never its guard.
        let escaped = false;
        const escape = child.ctx.tools.register(definition('escape', async () => { escaped = true; return {}; }));
        try { assert.equal((await execute(child, 'escape')).isError, true); assert.equal(escaped, false); } finally { escape(); }
        const submitted = await execute(child, 'structured_output', decision
          ? { kind: 'observe', targetId: 'player', visibility: 'public', reason: '目前没有需要介入的事', evidenceIds: [], publicText: '', read: '', shift: '', next: '' }
          : { speech: '我会自己判断。', action: '检查营地脚印。' });
        assert.equal(submitted.isError, false);
        assert.equal(decision ? report.kind : report.speech, decision ? 'observe' : '我会自己判断。');
        const record = { child, prompt, disposed: false, spec };
        activations.push(record);
        let result;
        if (blockNextNpc) {
          blockNextNpc = false;
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
    assert.equal(routes.size, 7);
    const dm = newAgent('cordis-dm');
    const ordinary = newAgent('cordis-ordinary');
    await emitCreated(dm); await emitCreated(ordinary);
    assert.deepEqual(schemas(dm), ['ask_user_question', 'bash', 'read']);
    const started = await request('start', { sessionId: dm.id, scriptKey: 'graystone-mine@1.0.0' });
    assert(started.campaign.id);
    assert.deepEqual(schemas(dm), [...DM_TOOLS, 'ask_user_question'].sort());
    assert.deepEqual(schemas(ordinary), ['ask_user_question', 'bash', 'read']);
    assert.equal(dm.followups.length, 1);
    const assembly = await ctx.systemPrompt.assemble({ scope: dm, agent: dm });
    assert.deepEqual(assembly.sections.map(section => section.name), ['tavern:dm']);
    assert.match(renderPrompt(assembly), /PRIVATE_DM_SECRET/);
    assert.doesNotMatch(renderPrompt(assembly), /ORDINARY_ASSISTANT/);
    assert.equal((await execute(dm, 'bash')).isError, true);
    assert.equal((await execute(dm, 'tavern_status')).isError, false);
    assert.equal((await preStep(dm, 'first-player-action')).kind, 'enter');
    const spoken = await execute(dm, 'tavern_speak', { npcId: 'bran' });
    assert.equal(spoken.isError, false, JSON.stringify(spoken));
    assert.equal(spoken.value.speech, '我会自己判断。');
    assert.equal(activations.filter(record => !record.spec.request.outputSchema.properties.kind).length, 1);
    assert(activations.some(record => record.spec.request.outputSchema.properties.kind));
    assert(activations.every(record => record.disposed && !modes.has(record.child.id)));
    const beforeChoice = activations.length;
    const answer = await execute(dm, 'ask_user_question', { questions: [{ id: 'action', question: '你准备怎么做？' }] });
    assert.equal(answer.isError, false);
    assert.deepEqual(answer.value, { answers: [{ id: 'action', selected: ['保护队友'], custom: '我挡在布兰身前' }] });
    assert(activations.length > beforeChoice, 'real ToolRuntime canonical answer triggers autonomous decisions');
    assert.equal(dm.followups.length, 1, 'no duplicate synthetic user turn');

    // A cold/reopened NPC prefix is fail-closed, even with its own report tool.
    const dormant = newAgent('tavern-npc-dormant', { origin: 'subagent' });
    dormant.ctx.tools.register(definition('structured_output'));
    await emitCreated(dormant);
    assert.equal((await execute(dormant, 'structured_output')).isError, true);
    assert.equal((await preStep(dormant, 'unrelated-task')).kind, 'reject');

    // Unload while a registered real ToolRuntime dispatch owns an NPC call.
    // Cordis unwinds all independent effects concurrently, not a hand-ordered
    // fake cleanup list; the host must abort, drain, and close storage itself.
    await preStep(dm, 'second-player-action');
    published = deferred(); blockNextNpc = true;
    const pending = execute(dm, 'tavern_speak', { npcId: 'bran' });
    await published.promise;
    await game.dispose();
    game = null;
    const cancelled = await pending;
    assert.equal(cancelled.isError, true);
    assert(activations.every(record => record.disposed));
    assert.equal(routes.size, 0);
    assert.deepEqual(schemas(dm), ['ask_user_question', 'bash', 'read']);
    const restored = await ctx.systemPrompt.assemble({ scope: dm, agent: dm });
    assert.match(renderPrompt(restored), /ORDINARY_ASSISTANT/);
    assert(!restored.sections.some(section => section.name.startsWith('tavern:')));
    assert.equal(globalThis[Symbol.for('dsh-tavern/stores.v1')].has(directory), false);
    const reopened = await createStore({ dir: directory, cultivation });
    try { assert.equal((await reopened.getBinding(dm.id)).campaignId, started.campaign.id); } finally { await reopened.close(); }
    // Reload must reinstall cleanly: no duplicate mode declarations/sections.
    game = await ctx.plugin(tavern, { dataDir: directory });
    assert.deepEqual(schemas(dm), [...DM_TOOLS, 'ask_user_question'].sort());
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
