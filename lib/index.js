import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.js';
import { createGameRuntime, DM_TOOLS, NPC_REPORT_SCHEMA, makeDmPrompt, textOf } from './runtime.js';
import { IMPORT_LIMITS, currentScene, domainError } from './core.js';
import { presentNpcIds } from './autonomy.js';
import { cultivationProblem, dependencyCultivationVersion, serviceCultivationVersion } from './version.js';

const STORES = Symbol.for('dsh-tavern/stores.v1');
const NPC_PREFIX = 'tavern-npc-';
// The host's clickable-choice tool is inherited, not a tavern-scoped tool. Keep
// it available only when the profile actually exposes it; otherwise the game
// still runs with plain narration.
const DM_INHERITED_TOOLS = Object.freeze(['ask_user_question']);
const BODY_LIMIT = Math.ceil(IMPORT_LIMITS.archiveBytes * 4 / 3) + 8192;
const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const message = (text) => ({ id: 'tavern-' + randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(value));
}
async function bodyOf(req) {
  if (String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw domainError('CONTENT_TYPE', '需要 application/json 请求。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > BODY_LIMIT) throw domainError('BODY_TOO_LARGE', '导入文件超过允许的大小。');
    chunks.push(Buffer.from(chunk));
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw domainError('INVALID_JSON', '请求内容不是有效 JSON。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw domainError('INVALID_JSON', '请求内容必须是对象。');
  return body;
}
export function isBlankAgent(agent, events) {
  if (!agent || agent.status !== 'idle' || !Array.isArray(events)) return false;
  const meta = agent.session.meta ?? agent.session.header ?? {};
  if (meta.origin === 'subagent' || meta.parentSession || agent.id.startsWith(NPC_PREFIX)) return false;
  return !events.some((event) => ['user/message', 'assistant/message', 'assistant/attempt', 'turn/start', 'step/start'].includes(event.type) || (event.type === 'agent/inbox/spliced' && (event.data?.inserted?.length ?? 0) > 0));
}
function uiCampaign(view) {
  if (!view) return null;
  return { id: view.id, title: view.title, scriptId: view.scriptId, scriptKey: view.scriptKey, scriptVersion: view.scriptVersion, updatedAt: view.updatedAt, ownerSessionId: view.ownerSessionId, sceneId: view.state.sceneId, scene: view.state.scene, player: view.state.player, party: view.state.npcs, turnIndex: view.state.turnIndex ?? 0, status: view.state.status ?? 'active', paused: view.state.status === 'paused', completed: Boolean(view.state.completed), ...(view.state.encounter ? { encounter: view.state.encounter } : {}) };
}
function toolDefinition(name, description, properties, required, execute) {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } }, execute };
}
/** Host adapter: all game writes are scoped to the calling Agent, never selected browser tab. */
export default {
  inject: ['cultivation', 'agents', 'subagents', 'tools', 'systemPrompt', 'webServer', 'connection', 'sessionQuery'],
  async apply(ctx, config = {}) {
    const cultivation = ctx.cultivation;
    const incompatible = cultivationProblem(cultivation);
    if (incompatible !== null) throw new Error(incompatible);
    // Two cultivation copies (tavern's dependency plus a separately installed
    // profile bundle) are legal but worth naming: the mounted one is whichever
    // DSH routed to, and it may not be the version tavern declares.
    const mounted = serviceCultivationVersion(cultivation);
    const declared = dependencyCultivationVersion();
    if (mounted !== undefined && declared !== undefined && mounted !== declared) {
      ctx.logger?.('dsh-tavern')?.warn?.(`运行中的 dsh-cultivation 是 ${mounted}，tavern 依赖的是 ${declared}；两份副本并存时以加载的那份为准。`);
    }
    const directory = path.resolve(config.dataDir ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'tavern'));
    const registry = globalThis[STORES] ??= new Map();
    let entry = registry.get(directory);
    if (entry?.closing) { await entry.closing; entry = registry.get(directory); }
    if (!entry) {
      entry = { refs: 0, store: null, loading: null };
      registry.set(directory, entry);
      entry.loading = createStore({ dir: directory, cultivation }).then((store) => (entry.store = store)).catch((error) => { if (registry.get(directory) === entry) registry.delete(directory); throw error; });
    }
    entry.refs++;
    let store;
    try { store = await entry.loading; } catch (error) { entry.refs--; throw error; }
    const inFlight = new Set();
    const track = (promise) => { inFlight.add(promise); promise.finally(() => inFlight.delete(promise)).catch(() => {}); return promise; };
    const pendingNpcs = new Map();
    const npcScopes = new Map();
    const promptText = new Map();
    const loadedCampaigns = new Map();
    const narrationCaptures = new Map();
    const installed = new WeakSet();
    let disposed = false;
    const activeControllers = new Set();
    ctx.effect(() => async () => {
      disposed = true;
      for (const controller of activeControllers) controller.abort(new Error('酒馆插件正在卸载。'));
      await Promise.allSettled([...inFlight]);
      loadedCampaigns.clear();
      narrationCaptures.clear();
      entry.refs--;
      if (entry.refs === 0 && registry.get(directory) === entry) {
        entry.closing = store.close().finally(() => { if (registry.get(directory) === entry) registry.delete(directory); });
        await entry.closing;
      }
    });
    await store.importDirectory(path.join(packageDir, 'demo', 'curtain-castle'));
    if (typeof store.listBindings === 'function') for (const binding of await store.listBindings()) cultivation.setExternalSessionMode(binding.sessionId, 'dm');

    const register = (callback) => ctx.effect(callback);
    function sealNpc(agent, prompt, active) {
      cultivation.setExternalSessionMode(agent.id, 'npc');
      npcScopes.set(agent.id, { active, prompt });
      if (installed.has(agent)) return;
      installed.add(agent);
      register(() => agent.ctx.tools.presentAs('native'));
      register(() => agent.ctx.tools.restrict({ allow: [] }));
      register(() => agent.ctx.tools.guard((execution) => active && execution.name === 'structured_output' ? undefined : 'NPC 只能向 DM 提交本场报告。'));
      register(() => agent.ctx.systemPrompt.section({ name: 'tavern:npc', order: 0, complete: true, interpolate: false, text: () => prompt }));
      if (agent.ctx.systemPrompt.suppressRuntimeContext) register(() => agent.ctx.systemPrompt.suppressRuntimeContext());
    }
    async function runNpc({ parent, prompt, npcId, name, signal, outputSchema = NPC_REPORT_SCHEMA }) {
      if (!parent || disposed) throw domainError('NPC_UNAVAILABLE', '无法启动 NPC。');
      const childId = NPC_PREFIX + randomUUID();
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(new Error('NPC 响应超时')), Math.max(1000, Number(config.npcTimeoutMs) || 90000));
      const forwardAbort = () => controller.abort(signal.reason);
      if (signal?.aborted) forwardAbort();
      else signal?.addEventListener('abort', forwardAbort, { once: true });
      pendingNpcs.set(childId, { prompt, npcId });
      cultivation.setExternalSessionMode(childId, 'npc');
      let activation;
      try {
        activation = await ctx.subagents.startActivation({ provider: 'spawn', childId, label: `${name} · NPC`, delivery: 'caller', signal: controller.signal, request: { parent, prompt: [{ type: 'text', text: '按你的身份、立场与当前所见独立决定自己的行动；可以支持、反对、拒绝、保持沉默或采取其他合适的行动。根据本次任务与给定结构，用 structured_output 提交结果，不必强行公开发言。' }], outputSchema } });
        if (!npcScopes.get(childId)?.active) throw domainError('NPC_ISOLATION_FAILED', 'NPC 隔离初始化未完成，已取消本次调用。');
        let abortListener;
        const aborted = new Promise((_, reject) => {
          abortListener = () => reject(domainError('NPC_CANCELLED', 'NPC 调用已取消或超时。'));
          if (controller.signal.aborted) abortListener();
          else controller.signal.addEventListener('abort', abortListener, { once: true });
        });
        let result;
        try { result = await Promise.race([activation.result, aborted]); } finally { controller.signal.removeEventListener('abort', abortListener); }
        if (result.stopReason !== 'completed' || !result.structured) throw domainError('NPC_FAILED', 'NPC 没有完成结构化报告。');
        return result.structured;
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
        signal?.removeEventListener('abort', forwardAbort);
        pendingNpcs.delete(childId);
        try { await activation?.dispose(); } finally { npcScopes.delete(childId); cultivation.clearExternalSessionMode?.(childId); }
      }
    }
    const runtime = createGameRuntime({ store, cultivation, runNpc });
    function hookWork(signal, task) {
      return track((async () => {
        if (disposed) throw domainError('TAVERN_UNLOADING', '酒馆插件正在卸载。');
        const controller = new AbortController();
        const forward = () => controller.abort(signal.reason);
        if (signal?.aborted) forward();
        else signal?.addEventListener('abort', forward, { once: true });
        activeControllers.add(controller);
        try {
          if (controller.signal.aborted) throw domainError('ABORTED', '游戏操作已取消。');
          return await task(controller.signal);
        } finally {
          activeControllers.delete(controller);
          signal?.removeEventListener('abort', forward);
        }
      })());
    }
    const playable = (loaded, agent) => loaded && !loaded.binding.readOnly && loaded.campaign.ownerSessionId === agent.id && !loaded.campaign.state.completed && !['paused', 'completed'].includes(loaded.campaign.state.status);
    async function recordAndReact(agent, messages, loaded, signal) {
      const known = new Set(loaded.campaign.state.log.filter((item) => item.role === 'player').map((item) => item.eventId));
      let recorded = false;
      for (const item of messages) {
        if (signal.aborted) throw domainError('ABORTED', '游戏操作已取消。');
        if (item.source?.kind !== 'user' || !item.id || !textOf(item.content).trim() || known.has(item.id)) continue;
        const committed = await runtime.recordInput(agent.id, item);
        known.add(item.id);
        if (committed !== false) {
          recorded = true;
          // Each real message matters even when several inbox items enter one step.
          await runtime.react(agent.id, { signal, parent: agent, inputId: item.id });
        }
      }
      // A cancelled decision transaction leaves a pending input, not a silently
      // forgotten player action. Retry its decisions without duplicating the input.
      if (!recorded && loaded.campaign.state.agencyPendingInputId) await runtime.react(agent.id, { signal, parent: agent });
      await refreshPrompt(agent.id);
    }
    async function refreshPrompt(sessionId) {
      const binding = await store.getBinding(sessionId);
      if (!binding) { loadedCampaigns.delete(sessionId); return null; }
      const campaign = await store.getCampaign(binding.campaignId);
      loadedCampaigns.set(sessionId, { binding, campaign });
      promptText.set(sessionId, makeDmPrompt(campaign, binding));
      return { binding, campaign };
    }
    async function drainNarration(agent, { archiveTurn } = {}) {
      const captures = narrationCaptures.get(agent.id);
      if (!captures?.pending.size && archiveTurn === undefined) return;
      const { events } = await ctx.sessionQuery.readSession(agent.id);
      const tailStart = archiveTurn === undefined ? events.length : Math.max(0, events.findLastIndex((event) => event.type === 'turn/start'));
      for (const [index, event] of events.entries()) {
        if (event.type !== 'assistant/message') continue;
        const scope = captures?.pending.get(event.seq);
        if (!scope && index < tailStart) continue;
        const text = textOf(event.data?.message?.content ?? event.data?.content);
        if (!text.trim()) { captures?.pending.delete(event.seq); continue; }
        // Uncaptured/legacy narration is archive-only: never infer its audience
        // from whoever happens to be present at a later drain boundary.
        const eventId = event.seq === undefined ? `${agent.id}:turn:${archiveTurn}:message:${index}` : `${agent.id}:message:${event.seq}`;
        await runtime.recordNarration(agent.id, eventId, text, scope ?? { sceneId: loadedCampaigns.get(agent.id)?.campaign.state.sceneId, audience: [] });
        captures?.pending.delete(event.seq);
      }
    }
    async function configureDm(agent) {
      const loaded = await refreshPrompt(agent.id);
      if (!loaded) return null;
      cultivation.setExternalSessionMode(agent.id, 'dm');
      if (installed.has(agent)) return loaded;
      installed.add(agent);
      register(() => agent.ctx.tools.presentAs('native'));
      register(() => {
        try { return agent.ctx.tools.restrict({ allow: [...DM_INHERITED_TOOLS] }); }
        catch { return agent.ctx.tools.restrict({ allow: [] }); }
      });
      register(() => agent.ctx.tools.guard((execution) => DM_TOOLS.includes(execution.name) || DM_INHERITED_TOOLS.includes(execution.name) ? undefined : '本会话是冒险游戏，只能执行游戏操作。'));
      register(() => agent.ctx.systemPrompt.section({ name: 'tavern:dm', order: 0, complete: true, interpolate: false, text: () => promptText.get(agent.id) ?? '冒险状态未加载，请勿推进。' }));
      if (agent.ctx.systemPrompt.suppressRuntimeContext) register(() => agent.ctx.systemPrompt.suppressRuntimeContext());
      const execute = (name) => async (args, execution) => track((async () => {
        if (execution.agent?.id !== agent.id) throw domainError('WRONG_CALLER', '游戏操作的会话身份不匹配。');
        if (disposed) throw domainError('TAVERN_UNLOADING', '酒馆插件正在卸载。');
        const controller = new AbortController();
        const forward = () => controller.abort(execution.signal.reason);
        if (execution.signal?.aborted) forward();
        else execution.signal?.addEventListener('abort', forward, { once: true });
        activeControllers.add(controller);
        try {
          const result = await runtime.perform(agent.id, name, args, { signal: controller.signal, parent: agent });
          await refreshPrompt(agent.id);
          return result;
        } finally {
          activeControllers.delete(controller);
          execution.signal?.removeEventListener('abort', forward);
        }
      })());
      const definitions = [
        toolDefinition('tavern_status', '查看当前冒险公开状态，不推进剧情。', {}, [], execute('tavern_status')),
        toolDefinition('tavern_speak', '请一位在场 NPC 子 agent 独立回应。默认只让最该接话的一位发言；若本轮已有队友发言，传 reactTo=上一位 npcId、focus=他具体回应哪句话/哪个动作，让对话有先后接力，而不是多人同时回答同一个问题。玩家的实际回答会由宿主自动记录并触发 NPC 独立决定，无需用 newBeat 标记新的玩家输入。只返回该 NPC 公开台词和动作意向，不代它编对白。', { npcId: { type: 'string' }, reactTo: { type: 'string' }, focus: { type: 'string' }, newBeat: { type: 'boolean' } }, ['npcId'], execute('tavern_speak')),
        toolDefinition('tavern_scene', '按剧本合法出口移动场景。仅在玩家选择该方向后使用。', { sceneId: { type: 'string' } }, ['sceneId'], execute('tavern_scene')),
        toolDefinition('tavern_check', '执行当前场景预定义的一项 d20 检定，使用剧本 checkId，不能自造结果。', { checkId: { type: 'string' } }, ['checkId'], execute('tavern_check')),
        toolDefinition('tavern_combat', '玩家选择攻击时结算一次攻击及敌方反击。每次玩家输入至多结算一次。', {}, [], execute('tavern_combat')),
        toolDefinition('tavern_rest', '仅在剧本允许的安全地点休整恢复生命。', {}, [], execute('tavern_rest')),
        toolDefinition('tavern_leave', '请求队友根据自身立场独立决定是否离队，不代表 DM 可以强迫离队。请说明当前冲突或缘由，以 NPC 的决定与工具结算为准。', { npcId: { type: 'string' }, reason: { type: 'string' } }, ['npcId', 'reason'], execute('tavern_leave')),
        toolDefinition('tavern_offscreen', '结算一位离队队友独自行动的结果（受伤、重伤、失踪、奇遇、线索或被俘）。以工具返回的结果为准，再由 DM 叙述。', { npcId: { type: 'string' } }, ['npcId'], execute('tavern_offscreen')),
        toolDefinition('tavern_return', '请求离队队友独立决定是否同意重聚，不代表 DM 可以强迫归队。以 NPC 的同意与工具结算为准，保留伤势、奇遇和态度变化。', { npcId: { type: 'string' }, reason: { type: 'string' } }, ['npcId'], execute('tavern_return'))
      ];
      for (const definition of definitions) register(() => agent.ctx.tools.register(definition));
      return loaded;
    }
    ctx.on('agent/created', async ({ agent }) => {
      const pending = pendingNpcs.get(agent.id);
      if (pending) sealNpc(agent, pending.prompt, true);
      else if (agent.id.startsWith(NPC_PREFIX)) sealNpc(agent, '这是已结束的临时 NPC 会话，不接受新任务。请回到 DM 会话继续冒险。', false);
      else await configureDm(agent);
    });
    ctx.on('agent/disposed', ({ agent }) => { promptText.delete(agent.id); npcScopes.delete(agent.id); loadedCampaigns.delete(agent.id); narrationCaptures.delete(agent.id); });
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (disposed || agent.id.startsWith(NPC_PREFIX)) return;
      const loaded = loadedCampaigns.get(agent.id);
      if (!loaded || loaded.binding.readOnly || loaded.campaign.ownerSessionId !== agent.id) return;
      let captures = narrationCaptures.get(agent.id);
      if (frame.type === 'start') {
        if (!playable(loaded, agent)) return;
        if (!captures) narrationCaptures.set(agent.id, captures = { attempts: new Map(), pending: new Map() });
        captures.attempts.set(frame.attemptId, { sceneId: loaded.campaign.state.sceneId, audience: [...presentNpcIds(loaded.campaign)] });
      } else if (frame.type === 'end' && captures) {
        const scope = captures.attempts.get(frame.attemptId);
        captures.attempts.delete(frame.attemptId);
        if (scope && frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') captures.pending.set(frame.outcome.seq, scope);
      }
    });
    ctx.on('agent/pre-step', async (payload, next) => {
      const { agent, messages, signal } = payload;
      if (agent.id.startsWith(NPC_PREFIX)) return npcScopes.get(agent.id)?.active ? next() : { kind: 'reject' };
      return hookWork(signal, async (hookSignal) => {
        const loaded = await configureDm(agent);
        if (!loaded) return next();
        if (loaded.binding.readOnly || loaded.campaign.ownerSessionId !== agent.id || loaded.campaign.state.status === 'paused') return { kind: 'reject' };
        await drainNarration(agent);
        if (playable(loaded, agent)) await recordAndReact(agent, messages, loaded, hookSignal);
        return next();
      });
    });
    ctx.on('tools/post-execute', async (execution, result, next) => {
      const agent = execution.agent;
      if (execution.name !== 'ask_user_question' || !agent || agent.id.startsWith(NPC_PREFIX) || result.isError !== false || result.error || result.value?.pending === true || !Array.isArray(result.value?.answers) || !execution.callId) return next();
      const questions = execution.arguments?.questions;
      if (!Array.isArray(questions)) return next();
      const answers = result.value.answers.flatMap((answer) => {
        const question = questions.find((item) => item.id === answer?.id);
        if (typeof question?.question !== 'string' || !Array.isArray(answer.selected) || !answer.selected.every((item) => typeof item === 'string') || (answer.custom !== undefined && typeof answer.custom !== 'string')) return [];
        const selected = [...answer.selected, answer.custom ?? ''].map((item) => item.trim()).filter(Boolean);
        return selected.length ? [`问题：${question.question}\n玩家回答：${selected.join('；')}`] : [];
      });
      if (!answers.length) return next();
      return hookWork(execution.signal, async (signal) => {
        const loaded = await refreshPrompt(agent.id);
        if (playable(loaded, agent)) {
          await drainNarration(agent);
          // The host's canonical answer is real input, not model-authored newBeat.
          // Keep it out of the tool result and do not inject a second user turn.
          await recordAndReact(agent, [{ ...message(answers.join('\n')), id: `tavern-choice:${execution.callId}` }], loaded, signal);
        }
        return next();
      });
    });
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      if (agent.id.startsWith(NPC_PREFIX)) return;
      return track((async () => {
        if (disposed) return;
        const binding = await store.getBinding(agent.id);
        if (!binding || binding.readOnly) return;
        await drainNarration(agent, { archiveTurn: turn });
        await refreshPrompt(agent.id);
      })());
    });
    for (const agent of ctx.agents.list()) await configureDm(agent);

    async function blankAgent(agent) {
      if (!agent) return false;
      const snapshot = await ctx.sessionQuery.readSession(agent.id);
      return isBlankAgent(agent, snapshot.events);
    }
    async function stateFor(sessionId) {
      const scripts = (await store.listScripts({ includeArchived: true })).map((script) => ({ ...script, key: script.scriptKey }));
      const campaigns = (await store.listCampaigns()).map(uiCampaign);
      const binding = sessionId ? await store.getBinding(sessionId) : null;
      const campaign = binding ? uiCampaign(await store.getPublicCampaign(binding.campaignId)) : null;
      return { scripts, campaigns, binding, campaign, canStart: !!sessionId && !binding && await blankAgent(ctx.agents.get(sessionId)), dependencyReady: true };
    }
    async function withBlank(sessionId, callback) {
      const agent = ctx.agents.get(sessionId);
      if (!await blankAgent(agent) || await store.getBinding(sessionId)) throw domainError('NEW_SESSION_REQUIRED', '只能在尚未开始聊天的新会话选择冒险。');
      if (typeof agent.runMaintenance !== 'function') throw domainError('HOST_TOO_OLD', '当前 DSH 缺少安全的会话维护接口，请升级 DSH。');
      return agent.runMaintenance(async () => {
        // runMaintenance holds input admission; its public status remains idle.
        if (!await blankAgent(agent) || await store.getBinding(sessionId)) throw domainError('NEW_SESSION_REQUIRED', '会话已经开始，请另开新会话。');
        const value = await callback(agent);
        await configureDm(agent);
        return value;
      });
    }
    const routes = {
      state: { method: 'GET', run: async (_body, url) => stateFor(url.searchParams.get('sessionId') || undefined) },
      import: { method: 'POST', run: async (body) => {
        if (typeof body.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) throw domainError('INVALID_ARCHIVE', '需要有效的 ZIP 文件内容。');
        const script = await store.importArchive(Buffer.from(body.base64, 'base64'));
        return { ok: true, script };
      } },
      archive: { method: 'POST', run: async (body) => ({ ok: true, script: await store.setArchived(body.scriptKey, body.archived) }) },
      'delete-script': { method: 'POST', run: async (body) => ({ ok: true, ...await store.deleteScript(body.scriptKey) }) },
      start: { method: 'POST', run: async (body) => {
        const campaign = await withBlank(body.sessionId, () => store.createCampaign({ sessionId: body.sessionId, scriptKey: body.scriptKey, title: body.title }));
        ctx.agents.get(body.sessionId).followup(message('【开始冒险】请以本剧本 DM 的身份介绍当前场景与队友，留下我的行动选择。'));
        return { ok: true, campaign: uiCampaign(campaign), opening: campaign.state.scene.opening };
      } },
      attach: { method: 'POST', run: async (body) => {
        const current = await store.getCampaign(body.campaignId);
        const oldAgent = ctx.agents.get(current.ownerSessionId);
        if (oldAgent && oldAgent.status !== 'idle') throw domainError('CAMPAIGN_BUSY', '原会话仍在处理回合，请等待完成或先取消该回合。');
        const transfer = () => withBlank(body.sessionId, () => store.attachCampaign({ campaignId: body.campaignId, sessionId: body.sessionId, takeover: body.takeover }));
        const campaign = oldAgent ? await oldAgent.runMaintenance(transfer) : await transfer();
        if (oldAgent) await refreshPrompt(oldAgent.id);
        ctx.agents.get(body.sessionId).followup(message('【接续冒险】请按存档简要回顾已经发生的事与当前处境，不要重置进度或重新开场。'));
        return { ok: true, campaign: uiCampaign(campaign), opening: campaign.state.scene.opening };
      } },
      pause: { method: 'POST', run: async (body) => {
        if (typeof body.paused !== 'boolean') throw domainError('INVALID_ARGUMENT', 'paused 必须是布尔值。');
        const agent = ctx.agents.get(body.sessionId);
        if (!agent || agent.status !== 'idle') throw domainError('CAMPAIGN_BUSY', '请等待当前回合结束后暂停或继续。');
        await agent.runMaintenance(() => store.withCampaign(body.sessionId, async (campaign) => {
          if (campaign.state.completed) throw domainError('GAME_COMPLETED', '冒险已经结束。');
          campaign.state.status = body.paused ? 'paused' : 'active';
        }));
        await refreshPrompt(body.sessionId);
        return { ok: true };
      } }
    };
    for (const [name, route] of Object.entries(routes)) register(() => ctx.webServer.register({ kind: 'exact', path: `/tavern/api/${name}`, handler: (req, res) => track((async () => {
      if (disposed) { json(res, 503, { error: '酒馆插件正在卸载，请稍后重试。', code: 'TAVERN_UNLOADING' }); return; }
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }
      if (req.method !== route.method) { res.setHeader('allow', route.method); json(res, 405, { error: '请求方法不支持。', code: 'METHOD_NOT_ALLOWED' }); return; }
      try {
        const body = route.method === 'POST' ? await bodyOf(req) : null;
        if (disposed) throw domainError('TAVERN_UNLOADING', '酒馆插件正在卸载，请稍后重试。');
        const result = await route.run(body, new URL(req.url, 'http://localhost'));
        json(res, 200, result);
      } catch (error) {
        const status = ['CAMPAIGN_BUSY', 'READ_ONLY', 'SESSION_ALREADY_BOUND', 'VERSION_CONFLICT', 'NEW_SESSION_REQUIRED'].includes(error.code) ? 409 : error.code === 'BODY_TOO_LARGE' ? 413 : 400;
        json(res, status, { error: String(error.message || error), code: error.code || 'TAVERN_ERROR' });
      }
    })()) }));
  }
};
