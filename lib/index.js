import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.js';
import { createGameRuntime, DM_TOOLS, makeDmPrompt, textOf } from './runtime.js';
import { STORY_REPORT_SCHEMA } from './story.js';
import { IMPORT_LIMITS, currentScene, domainError } from './core.js';
import { presentActorIds } from './autonomy.js';
import { cultivationProblem, dependencyCultivationVersion, serviceCultivationVersion } from './version.js';

const STORES = Symbol.for('dsh-tavern/stores.v1');
const NPC_PREFIX = 'tavern-npc-';
const BODY_LIMIT = Math.ceil(IMPORT_LIMITS.archiveBytes * 4 / 3) + 8192;
const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const message = (text) => ({ id: 'tavern-bootstrap:' + randomUUID(), role: 'user', source: { kind: 'user' }, synthetic: true, content: [{ type: 'text', text }] });
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
  return { id: view.id, title: view.title, scriptId: view.scriptId, scriptKey: view.scriptKey, scriptVersion: view.scriptVersion, updatedAt: view.updatedAt, ownerSessionId: view.ownerSessionId, sceneId: view.state.sceneId, scene: view.state.scene, player: view.state.player, party: view.state.npcs, history: view.state.history ?? [], inventory: view.state.inventory ?? [], freeActionResults: view.state.freeActionResults ?? [], storyRecording: view.state.storyRecording, ...(view.state.storyLocation ? { storyLocation: view.state.storyLocation } : {}), ...(view.state.playerPosition ? { playerPosition: view.state.playerPosition } : {}), incompleteJudgments: view.state.incompleteJudgments ?? 0, incompleteAppraisals: view.state.incompleteAppraisals ?? 0, turnIndex: view.state.turnIndex ?? 0, status: view.state.status ?? 'active', paused: view.state.status === 'paused', completed: Boolean(view.state.completed), ...(view.state.encounter ? { encounter: view.state.encounter } : {}) };
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
    // A slot remains occupied until startup and disposal actually settle. This
    // bounds abandoned provider work even when it ignores cancellation forever.
    const slotKey = Symbol.for('dsh-tavern/npc-slots.v1');
    const npcSlots = globalThis[slotKey] ??= new Set();
    const npcScopes = new Map();
    const promptText = new Map();
    const loadedCampaigns = new Map();
    const narrationCaptures = new Map();
    // Process-local, deliberately excludes input, output, tool arguments and errors.
    const turnProgress = new Map();
    function phase(sessionId, value, expected) {
      const progress = turnProgress.get(sessionId);
      if (!progress || (expected && progress !== expected) || ['completed', 'cancelled', 'stopped'].includes(progress.phase)) return;
      progress.phase = value;
      progress.updatedAt = Date.now();
    }
    function beginProgress(sessionId, signal) {
      const previous = turnProgress.get(sessionId);
      if (previous && !['completed', 'cancelled', 'stopped'].includes(previous.phase)) {
        if (signal && !previous.hasSignal) {
          const abort = () => phase(sessionId, 'cancelled', previous);
          previous.hasSignal = true;
          previous.detach = () => signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }
        return previous;
      }
      previous?.detach?.();
      const now = Date.now();
      const progress = { phase: 'starting', startedAt: now, updatedAt: now, hasSignal: Boolean(signal) };
      const abort = () => phase(sessionId, 'cancelled', progress);
      progress.detach = () => signal?.removeEventListener('abort', abort);
      turnProgress.set(sessionId, progress);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      return progress;
    }
    const installed = new WeakSet();
    let disposed = false;
    const activeControllers = new Set();
    ctx.effect(() => async () => {
      disposed = true;
      for (const controller of activeControllers) controller.abort(new Error('酒馆插件正在卸载。'));
      // Startup can settle late and schedule child disposal. Keep hooks alive
      // until both the original work and any such cleanup have quiesced.
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      loadedCampaigns.clear();
      narrationCaptures.clear();
      for (const progress of turnProgress.values()) progress.detach?.();
      turnProgress.clear();
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
      // Keep restored/late children in NPC mode as well; their tools remain sealed.
      cultivation.setExternalSessionMode(agent.id, 'npc');
      if (active) npcScopes.set(agent.id, { active, prompt });
      if (installed.has(agent)) return;
      installed.add(agent);
      // These contributions belong to the child agent's own scope, not the
      // plugin scope: retaining their disposers would accumulate per call.
      agent.ctx.tools.presentAs('native');
      agent.ctx.tools.restrict({ allow: [] });
      agent.ctx.tools.guard((execution) => npcScopes.get(agent.id)?.active && execution.name === 'structured_output' ? undefined : 'NPC 只能向 DM 提交本场报告。');
      agent.ctx.systemPrompt.section({ name: 'tavern:npc', order: 0, complete: true, interpolate: false, text: () => npcScopes.get(agent.id)?.prompt ?? '临时 NPC 会话已结束。' });
      if (agent.ctx.systemPrompt.suppressRuntimeContext) agent.ctx.systemPrompt.suppressRuntimeContext();
    }
    async function runNpc({ parent, prompt, npcId, name, signal, outputSchema = STORY_REPORT_SCHEMA }) {
      if (!parent || disposed || npcSlots.size >= 8) throw domainError('NPC_UNAVAILABLE', '无法启动 NPC。');
      if (signal?.aborted) throw domainError('NPC_CANCELLED', 'NPC 调用已取消或超时。');
      const slot = {}; npcSlots.add(slot);
      const childId = NPC_PREFIX + randomUUID();
      const controller = new AbortController();
      activeControllers.add(controller);
      const configured = Number(config.recordingTimeoutMs ?? config.npcTimeoutMs);
      const timeoutMs = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 60000) : 20000;
      const timeout = setTimeout(() => controller.abort(new Error('NPC 响应超时')), timeoutMs);
      const forwardAbort = () => controller.abort(signal.reason);
      if (signal?.aborted) forwardAbort();
      else signal?.addEventListener('abort', forwardAbort, { once: true });
      let abortListener;
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(domainError('NPC_CANCELLED', 'NPC 调用已取消或超时。'));
        if (controller.signal.aborted) abortListener();
        else controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      // Observe every late rejection, including a result rejected before startup returns.
      aborted.catch(() => {});
      pendingNpcs.set(childId, { prompt, npcId });
      cultivation.setExternalSessionMode(childId, 'npc');
      let activation, cleanup;
      const disposeActivation = (value) => {
        if (!cleanup) cleanup = track(Promise.resolve().then(() => value.dispose()).then(() => {
          cultivation.clearExternalSessionMode?.(childId);
          npcSlots.delete(slot);
        }));
        cleanup.catch(() => {});
        return cleanup;
      };
      const startup = track(Promise.resolve().then(() => ctx.subagents.startActivation({ provider: 'spawn', childId, label: `${name} · 记录`, delivery: 'caller', signal: controller.signal, request: { parent, prompt: [{ type: 'text', text: '只整理系统上下文中已提交的冒险正文，用 structured_output 提交记录。不续写故事，不批准或否决人物行动，不生成现场 NPC 决策。' }], outputSchema } })).then((value) => {
        // Attach immediately: a late activation can already have a rejected result.
        Promise.resolve(value.result).catch(() => {});
        if (controller.signal.aborted) disposeActivation(value);
        return value;
      }, (error) => { cultivation.clearExternalSessionMode?.(childId); npcSlots.delete(slot); throw error; }));
      startup.catch(() => {});
      try {
        activation = await Promise.race([startup, aborted]);
        if (!npcScopes.get(childId)?.active) throw domainError('NPC_ISOLATION_FAILED', 'NPC 隔离初始化未完成，已取消本次调用。');
        const result = await Promise.race([activation.result, aborted]);
        if (result.stopReason !== 'completed' || !result.structured) throw domainError('NPC_FAILED', 'NPC 没有完成结构化报告。');
        return result.structured;
      } finally {
        // Revoke the child synchronously before allowing any uncooperative dispose
        // to run. Never stop a parent or unrelated agent as a fallback.
        pendingNpcs.delete(childId);
        npcScopes.delete(childId);
        try {
          if (activation) await Promise.race([disposeActivation(activation), aborted]);
        } finally {
          clearTimeout(timeout);
          activeControllers.delete(controller);
          signal?.removeEventListener('abort', forwardAbort);
          controller.signal.removeEventListener('abort', abortListener);
        }
      }
    }
    const runtime = createGameRuntime({ store, cultivation, runStoryReport: runNpc });
    const recordingJobs = new Map();
    const narrationErrors = new Map();
    // Owned by the plugin, not by the foreground turn's cancellation/lifetime.
    function queueRecording(agent, { retry = false } = {}) {
      const existing = recordingJobs.get(agent.id);
      if (existing) { existing.rerun = true; existing.retry ||= retry; return existing.promise; }
      const job = { rerun: false, retry, promise: null };
      recordingJobs.set(agent.id, job);
      job.promise = track((async () => {
        do {
          job.rerun = false;
          const requestedRetry = job.retry; job.retry = false;
          const controller = new AbortController();
          activeControllers.add(controller);
          const timeout = setTimeout(() => controller.abort(), 60000);
          try {
            if (disposed) break;
            await runtime.settleNarration(agent.id, { parent: agent, signal: controller.signal, retry: requestedRetry });
            await refreshPrompt(agent.id);
          } catch (error) {
            narrationErrors.set(agent.id, '后台记录未完成；正文保留，状态面板可能落后，请重试。');
            ctx.logger?.('dsh-tavern')?.warn?.('冒险后台记录未完成：' + (error.code || 'recording-failed'));
          } finally { clearTimeout(timeout); activeControllers.delete(controller); }
        } while (job.rerun && !disposed);
      })().finally(() => recordingJobs.delete(agent.id)));
      job.promise.catch(() => {});
      return job.promise;
    }
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
    const inputQueues = new Map();
    async function recordAndReact(agent, messages, loaded, signal) {
      const prior = inputQueues.get(agent.id) ?? Promise.resolve();
      const work = prior.catch(() => {}).then(async () => {
        if (signal.aborted) throw domainError('ABORTED', '游戏操作已取消。');
        // A queued hook must not use the campaign snapshot from before the
        // previous hook committed or was cancelled.
        const binding = await store.getBinding(agent.id);
        if (!binding || binding.readOnly) throw domainError('READ_ONLY_SESSION', '当前会话已不能推进存档。');
        const campaign = await store.getCampaign(binding.campaignId);
        return recordAndReactNow(agent, messages, { binding, campaign }, signal);
      });
      const settled = work.catch(() => {});
      inputQueues.set(agent.id, settled);
      try { return await work; } finally { if (inputQueues.get(agent.id) === settled) inputQueues.delete(agent.id); }
    }
    async function recordAndReactNow(agent, messages, loaded, signal) {
      const known = new Set(loaded.campaign.state.log.filter((item) => item.role === 'player').map((item) => item.eventId));
      for (const item of messages) {
        if (signal.aborted) throw domainError('ABORTED', '游戏操作已取消。');
        if (item.source?.kind !== 'user' || !item.id || !textOf(item.content).trim() || known.has(item.id)) continue;
        // The host preserves message identity across inbox/persistence boundaries;
        // arbitrary extension fields such as synthetic may not survive projection.
        await runtime.recordInput(agent.id, item.id.startsWith('tavern-bootstrap:') ? { ...item, synthetic: true } : item);
        known.add(item.id);
      }
      await refreshPrompt(agent.id);
    }
    async function refreshPrompt(sessionId) {
      const binding = await store.getBinding(sessionId);
      if (!binding) { loadedCampaigns.delete(sessionId); return null; }
      const campaign = await store.getCampaign(binding.campaignId);
      loadedCampaigns.set(sessionId, { binding, campaign });
      promptText.set(sessionId, makeDmPrompt(campaign, binding, cultivation));
      return { binding, campaign };
    }
    const recoveryInitializations = new Map();
    async function ensureRecoveryBoundary(agent, loaded) {
      if (loaded.binding.readOnly || Number.isInteger(loaded.campaign.state.narrationRecoveryFloor)) return;
      if (recoveryInitializations.has(agent.id)) return recoveryInitializations.get(agent.id);
      const work = (async () => {
        // Establish before generation. Never replay pre-upgrade prose against an old inventory.
        const { events } = await ctx.sessionQuery.readSession(agent.id);
        const floor = events.reduce((max, event) => Number.isInteger(event.seq) ? Math.max(max, event.seq) : max, -1);
        await store.withCampaign(agent.id, (campaign) => { campaign.state.narrationRecoveryFloor ??= floor; });
      })();
      recoveryInitializations.set(agent.id, work);
      try { await work; } finally { recoveryInitializations.delete(agent.id); }
    }
    async function drainNarration(agent) {
      const captures = narrationCaptures.get(agent.id);
      const loaded = await refreshPrompt(agent.id);
      if (!loaded || loaded.binding.readOnly) return;
      const { events } = await ctx.sessionQuery.readSession(agent.id);
      const floor = loaded.campaign.state.narrationRecoveryFloor;
      const known = new Set(loaded.campaign.state.log.filter((entry) => entry.role === 'dm').map((entry) => entry.eventId));
      let inputId = null;
      for (const [index, event] of events.entries()) {
        if (event.type === 'user/message') inputId = event.data?.message?.id ?? event.data?.id ?? inputId;
        if (event.type !== 'assistant/message') continue;
        const scope = captures?.pending.get(event.seq);
        if (!scope && (!Number.isInteger(event.seq) || !Number.isInteger(floor) || event.seq <= floor)) continue;
        const eventId = event.seq === undefined ? `${agent.id}:message-index:${index}` : `${agent.id}:message:${event.seq}`;
        if (known.has(eventId)) { captures?.pending.delete(event.seq); continue; }
        const text = textOf(event.data?.message?.content ?? event.data?.content);
        if (!text.trim()) { captures?.pending.delete(event.seq); continue; }
        const player = loaded.campaign.state.log.find((entry) => entry.role === 'player' && entry.eventId === inputId);
        try {
          // Lost source scope must not become an invented memory for whoever is present now.
          await runtime.recordNarration(agent.id, eventId, text, scope ?? { sceneId: player?.sceneId ?? loaded.campaign.state.sceneId, audience: [], inputId, recovered: true });
          known.add(eventId);
          captures?.pending.delete(event.seq);
          narrationErrors.delete(agent.id);
        } catch (error) {
          narrationErrors.set(agent.id, '正文已显示，但冒险存档写入失败；不能确认已保存，请重试保存。');
          // The committed DSH message and persisted boundary survive capture loss/restart.
          throw error;
        }
      }
    }
    async function configureDm(agent) {
      let loaded = await refreshPrompt(agent.id);
      if (!loaded) return null;
      cultivation.setExternalSessionMode(agent.id, 'dm');
      await ensureRecoveryBoundary(agent, loaded);
      loaded = await refreshPrompt(agent.id);
      if (installed.has(agent)) return loaded;
      installed.add(agent);
      register(() => agent.ctx.tools.presentAs('native'));
      register(() => agent.ctx.tools.restrict({ allow: [] }));
      register(() => agent.ctx.tools.guard((execution) => DM_TOOLS.includes(execution.name) ? undefined : '本会话是冒险游戏，只能执行游戏操作。'));
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
        const progress = turnProgress.get(agent.id);
        phase(agent.id, 'tools', progress);
        try {
          const result = await runtime.perform(agent.id, name, args, { signal: controller.signal, parent: agent });
          await refreshPrompt(agent.id);
          return result;
        } finally {
          activeControllers.delete(controller);
          execution.signal?.removeEventListener('abort', forward);
          if (progress?.phase === 'tools') phase(agent.id, 'waiting_dm', progress);
        }
      })());
      const definitions = [
        toolDefinition('tavern_status', '查看当前冒险公开状态，不推进剧情。', {}, [], execute('tavern_status')),
        toolDefinition('tavern_check', '执行当前场景预定义的一项 d20 检定，使用剧本 checkId，不能自造结果。', { checkId: { type: 'string' } }, ['checkId'], execute('tavern_check')),
        toolDefinition('tavern_combat', '玩家选择攻击时结算一次攻击及敌方反击。每次玩家输入至多结算一次。', {}, [], execute('tavern_combat')),
        toolDefinition('tavern_rest', '仅在剧本允许的安全地点休整恢复生命。', {}, [], execute('tavern_rest')),

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
    ctx.on('agent/disposed', ({ agent }) => { promptText.delete(agent.id); npcScopes.delete(agent.id); loadedCampaigns.delete(agent.id); narrationCaptures.delete(agent.id); turnProgress.get(agent.id)?.detach?.(); turnProgress.delete(agent.id); });
    ctx.on('agent/inbox/inserted', ({ agent, message: input }) => {
      const loaded = loadedCampaigns.get(agent.id);
      if (playable(loaded, agent) && input?.source?.kind === 'user' && input.id && textOf(input.content).trim()) {
        const progress = beginProgress(agent.id);
        progress.inputRevision = (progress.inputRevision ?? 0) + 1;
      }
    });
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') { phase(agent.id, 'stopped'); turnProgress.get(agent.id)?.detach?.(); }
    });
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (disposed || agent.id.startsWith(NPC_PREFIX)) return;
      const loaded = loadedCampaigns.get(agent.id);
      if (!loaded || loaded.binding.readOnly || loaded.campaign.ownerSessionId !== agent.id) return;
      let captures = narrationCaptures.get(agent.id);
      if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string' && frame.chunk.text.trim()) phase(agent.id, 'output');
      if (frame.type === 'start') {
        phase(agent.id, 'waiting_dm');
        if (!playable(loaded, agent)) return;
        if (!captures) narrationCaptures.set(agent.id, captures = { attempts: new Map(), pending: new Map() });
        captures.attempts.set(frame.attemptId, { sceneId: loaded.campaign.state.sceneId, audience: [...presentActorIds(loaded.campaign)] });
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
        const progress = playable(loaded, agent) && messages.some((item) => item.source?.kind === 'user' && item.id && textOf(item.content).trim()) ? beginProgress(agent.id, signal) : turnProgress.get(agent.id);
        await drainNarration(agent);
        if (playable(loaded, agent)) {
          await recordAndReact(agent, messages, loaded, hookSignal);
          const latest = loadedCampaigns.get(agent.id)?.campaign;
          if (Object.values(latest?.state.storyTasks ?? {}).some((task) => task.status === 'pending')) queueRecording(agent);
          phase(agent.id, 'waiting_dm', progress);
        }
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
          await recordAndReact(agent, [{ ...message(answers.join('\n')), synthetic: false, id: `tavern-choice:${execution.callId}` }], loaded, signal);
        }
        return next();
      });
    });
    // A model failure is evidence of the failing layer, not proof of its root
    // cause. Do not retain provider messages, request ids, input, or output.
    ctx.on('agent/request-error', async ({ agent, failure }, next) => {
      const progress = turnProgress.get(agent?.id);
      if (progress && !agent.id.startsWith(NPC_PREFIX)) {
        const code = String(failure?.code ?? '');
        const kind = code === 'TRANSPORT' ? 'transport' : code === 'TIMEOUT' ? 'timeout' : code === 'RATE_LIMIT' ? 'rate_limit' : 'other';
        progress.lastFailure = { kind, at: Date.now() };
        progress.updatedAt = Date.now();
      }
      return next();
    });
    ctx.on('agent/error', ({ agent }) => { phase(agent.id, 'stopped'); turnProgress.get(agent.id)?.detach?.(); });
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (agent.id.startsWith(NPC_PREFIX)) return;
      const progress = turnProgress.get(agent.id);
      const inputRevision = progress?.inputRevision;
      return track((async () => {
        if (disposed) return;
        const binding = await store.getBinding(agent.id);
        if (!binding || binding.readOnly) return;
        try { await drainNarration(agent, { archiveTurn: turn }); }
        catch { /* The DSH body remains readable; stateFor exposes an honest save warning. */ }
        await refreshPrompt(agent.id);
        if (!narrationErrors.has(agent.id) && !signal?.aborted) queueRecording(agent);
        if (progress && progress.inputRevision === inputRevision) {
          phase(agent.id, signal?.aborted ? 'cancelled' : 'completed', progress);
          progress.detach?.();
        }
      })());
    });
    for (const agent of ctx.agents.list()) {
      let loaded = await configureDm(agent);
      if (loaded && !loaded.binding.readOnly) {
        try { await drainNarration(agent); } catch { /* Keep the recovery warning; never claim saved. */ }
        loaded = await refreshPrompt(agent.id);
        if (Object.values(loaded.campaign.state.storyTasks ?? {}).some((task) => task.status === 'pending')) queueRecording(agent);
      }
    }

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
      if (campaign && narrationErrors.has(sessionId)) campaign.storyRecording = { ...campaign.storyRecording, saveError: narrationErrors.get(sessionId) };
      const progress = binding && !binding.readOnly && campaign?.ownerSessionId === sessionId ? turnProgress.get(sessionId) : null;
      return { scripts, campaigns, binding, campaign, turnProgress: progress ? { phase: progress.phase, startedAt: progress.startedAt, updatedAt: progress.updatedAt, ...(progress.lastFailure ? { lastFailure: progress.lastFailure } : {}) } : null, canStart: !!sessionId && !binding && await blankAgent(ctx.agents.get(sessionId)), dependencyReady: true };
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
      'retry-recording': { method: 'POST', run: async (body) => {
        const binding = await store.getBinding(body.sessionId);
        const agent = ctx.agents.get(body.sessionId);
        if (!binding || binding.readOnly || !agent) throw domainError('READ_ONLY', '仅存档当前会话可以重试记录。');
        // Never replay a player action or generate another story: recover committed messages only.
        await drainNarration(agent, { archiveTurn: 'recovery' });
        narrationErrors.delete(agent.id);
        queueRecording(agent, { retry: true });
        return { ok: true, queued: true };
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
