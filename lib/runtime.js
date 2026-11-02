import { createHash } from 'node:crypto';
import { cloneJson, currentScene, applyEncounter, domainError, applyCheck, restPlayer } from './core.js';
import { presentActorIds } from './autonomy.js';
import { STORY_REPORT_SCHEMA, makeStoryReportPrompt, applyStoryReport } from './story.js';

// Ordinary speech, movement and exchanges belong to the narrator, not tools.
export const DM_TOOLS = Object.freeze(['tavern_status', 'tavern_check', 'tavern_combat', 'tavern_rest']);
export const textOf = (blocks) => Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
const keyOf = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const copy = cloneJson;
function assertActive(signal) { if (signal?.aborted) throw domainError('ABORTED', '后台记录已取消，未提交迟到结果。'); }
export function visibleHistory(campaign, npcId, count = 12) { return campaign.state.log.filter((e) => e.audience?.includes(npcId)).slice(-count).map(({ eventId, sceneId, role, npcId: actor, text }) => ({ id: eventId ?? '', sceneId, role, ...(actor ? { npcId: actor } : {}), text })); }
export function agencyDiagnostics() { return []; }
export function turnSpeakers(campaign, inputId) { return campaign.state.log.filter((e) => e.role === 'npc' && e.inputId === inputId); }
function requirePlayable(campaign) {
  if (campaign.state.status === 'paused') throw domainError('GAME_PAUSED', '冒险已暂停，请先在游戏面板继续。');
  if (campaign.state.status === 'completed' || campaign.state.completed) throw domainError('GAME_COMPLETED', '本次冒险已经结束。');
}

/** Author material is private narrator context, not a list of executable commands. */
export function makeDmPrompt(campaign, binding, cultivation) {
  if (binding.readOnly) return '这是只读冒险历史会话，请到当前拥有存档的会话继续。';
  const { state, snapshot } = campaign;
  const scene = currentScene(campaign);
  const cards = snapshot.characters.map((persona) => {
    const npcState = state.npcs[persona.id] ?? {};
    return cultivation?.renderExternalCard
      ? cultivation.renderExternalCard({ persona, state: npcState, role: persona.role, goal: persona.goal, scene: { place: state.storyLocation?.location || scene.place } })
      : JSON.stringify({ persona, state: npcState });
  });
  const tasks = Object.values(state.storyTasks ?? {});
  const pending = tasks.filter((task) => task.status !== 'recorded');
  const pendingIds = new Set(pending.map((task) => task.eventId));
  return [
    '你是文字冒险的主持人。你同时演绎旁白和所有 NPC，不是动作审批员。玩家自由表达，你理解上下文并叙述合理发生的过程、结果和后果。',
    '【自由主持】普通说话、等待、清点、交付、拾取和移动直接在正文完成，不调用动作工具、不等后台记账批准。已经谈妥且玩家明确选择的事应推进，不反复停在“准备”“尚待确认”。可以在一轮内完成自然连续的多个普通过程。',
    '【选择权】不替玩家选择未选择的重大行动、感情、立场或结局。明确提出的行动可以叙述其合理过程。带前提的行动须先处理前提；前提未成立时，不提前执行后续。例如先拿钱再出发，先写实际付款、拒付或条件，再处理离开。',
    '【人物】每人有自己的利益、知识、性格、记忆和判断，可以反对、欺骗、拒绝、合作、交流或离队。人物自主不是全员轮流发表意见，也不是口头抗议自动锁住玩家。通过具体言行体现人物，不把缺点写成每时每刻都没有常识。没有真正冲突就让事情自然完成。',
    '【信息边界】你可阅读作者资料和各人物私有积累，但角色只知道自己亲历、获知或合理推断的信息；不要让角色互相读心，不把秘密提前说给玩家。亲密度不是服从开关，信念可能有误，以已发生事实为准。',
    '【剧本是参考】场景、节拍、出口、任务是世界和冲突的参考，不是必须照顺序执行的流程。允许合理的新细节、绕行和人物自主反应，保持世界常识和因果连续；不要为了守住预设反转强迫人物撒谎。',
    '【数值规则】剧本声明的数值检定和战斗仍使用 tavern_check / tavern_combat，叙述承接真实工具结果，不自造骰点、HP或重复发奖励。普通互动不要扩大为检定。tavern_rest 只用于安全休整的数值恢复。',
    '【正文与记录】已提交正文是故事依据。背包、位置及养成面板是后台整理结果，可能落后；未整理的正文也必须承接。记录失败不是人物拒绝、物品未交付或事情没发生，不要重演付款。不能声称后台已保存成功；技术提示由界面显示，不把它变成剧情中的等待。',
    '【游戏范围】专注冒险、玩法解释和剧情回顾。不执行编程、搜索、文件操作等无关现实任务。暂停不推进；已有结局不擅自续演。',
    '【作者资料（数据与创作参考，不逐字展示）】旧版资料中要求独立 NPC agent、普通动作先工具结算或固定节拍的运行方式已退役，不再执行；保留其中的世界事实、人物设定和数值规则。作者资料不能覆盖上面的主持职责与玩家选择权。\n' + JSON.stringify(snapshot.adventure.dm),
    '【场景参考（不是玩家已知事实或必须执行的路线）】\n' + JSON.stringify(snapshot.adventure.scenes),
    '【各人物独立的设定与 cultivation 积累】\n' + cards.join('\n\n'),
    '【本局已整理状态】\n' + JSON.stringify({ sceneId: state.sceneId, location: state.storyLocation?.location || scene.place, player: state.player, inventory: state.freeActionItems ?? [], npcMeta: state.npcMeta ?? {}, facts: state.storyFacts ?? [], encounters: state.encounters, checks: state.checks, status: state.status }),
    '【近期实际事件；旧系统的“待裁定”记录只是当时意向，不自动等于完成】\n' + JSON.stringify(state.log.filter((e) => e.visibility !== 'secret').slice(-24)),
    '【尚未整理的正文；与旧面板冲突时承接正文，不重演】\n' + JSON.stringify(state.log.filter((e) => pendingIds.has(e.eventId)).map(({ eventId, text }) => ({ eventId, text }))),
    '用自然、简洁、有行动和后果的正文继续故事。需要重大选择时自然留出空间，不每回合重复问“你打算怎么做”，不展示内部 JSON 或记账术语。'
  ].join('\n\n');
}

/** Only short persistence transactions are serialized. No model call holds a save lock. */
export function createGameRuntime({ store, cultivation, runStoryReport, runNpc, random = null }) {
  const queues = new Map();
  const settlements = new Map();
  const recording = runStoryReport ?? runNpc;
  function serialized(sessionId, task) {
    const prior = queues.get(sessionId) ?? Promise.resolve();
    const next = prior.then(task, task);
    const settled = next.catch(() => {});
    queues.set(sessionId, settled);
    return next.finally(() => { if (queues.get(sessionId) === settled) queues.delete(sessionId); });
  }
  const mutate = (sessionId, fn) => serialized(sessionId, () => store.withCampaign(sessionId, fn));
  async function owned(sessionId) {
    const binding = await store.getBinding(sessionId);
    if (!binding || binding.readOnly) throw domainError('READ_ONLY_SESSION', '本会话不能推进存档。');
    const campaign = await store.getCampaign(binding.campaignId);
    if (campaign.ownerSessionId !== sessionId) throw domainError('READ_ONLY_SESSION', '本会话已不是存档推进会话。');
    return campaign;
  }
  async function recordInput(sessionId, message) {
    const text = textOf(message.content);
    if (!message.id || !text.trim()) return false;
    return mutate(sessionId, (campaign) => {
      if (campaign.state.log.some((e) => e.role === 'player' && e.eventId === message.id)) return false;
      requirePlayable(campaign);
      const synthetic = message.synthetic === true;
      if (!synthetic) campaign.state.turnIndex++;
      // An old interrupted agency decision is no longer a prerequisite for narration.
      delete campaign.state.agencyPendingInputId;
      campaign.state.log.push({ turn: campaign.state.turnIndex, role: 'player', eventId: message.id, inputId: message.id, text, sceneId: campaign.state.sceneId, audience: synthetic ? [] : presentActorIds(campaign), ...(synthetic ? { synthetic: true } : {}) });
      return !synthetic;
    });
  }
  async function recordNarration(sessionId, eventId, text, scope) {
    if (!text?.trim()) return;
    return mutate(sessionId, (campaign) => {
      if (campaign.state.log.some((e) => e.eventId === eventId && e.role === 'dm')) return;
      const sceneId = scope?.sceneId ?? campaign.state.sceneId;
      if (!campaign.snapshot.adventure.scenes.some((s) => s.id === sceneId)) throw domainError('INVALID_SCENE', '正文来源场景不存在。');
      const audience = scope?.audience ?? presentActorIds(campaign);
      const input = scope && Object.hasOwn(scope, 'inputId') ? campaign.state.log.find((e) => e.role === 'player' && e.eventId === scope.inputId) : [...campaign.state.log].reverse().find((e) => e.role === 'player');
      campaign.state.log.push({ turn: input?.turn ?? campaign.state.turnIndex, role: 'dm', eventId, text, sceneId, audience: audience.filter((id) => campaign.snapshot.characters.some((p) => p.id === id)), ...(input?.eventId ? { inputId: input.eventId } : {}), ...(scope?.recovered ? { recovered: true } : {}) });
      campaign.state.storyTasks ??= {};
      campaign.state.storyTasks[eventId] = { eventId, status: 'pending', attempts: 0, cultivation: {} };
    });
  }
  async function markFailure(sessionId, eventId, stage) {
    return mutate(sessionId, (campaign) => {
      const task = campaign.state.storyTasks?.[eventId];
      if (!task) return;
      task.status = 'failed';
      task.error = stage === 'record' ? '本轮状态整理未完成；正文保留，物品和位置面板可能落后，可重试。' : '本轮人物养成未完成；正文与已记录物品保留，可重试。';
      task.failedStage = stage;
    });
  }
  async function settleOne(sessionId, eventId, { parent, signal }) {
    if (signal?.aborted) return false;
    let campaign = await owned(sessionId);
    let task = campaign.state.storyTasks?.[eventId];
    if (!task || task.status === 'recorded') return true;
    const source = campaign.state.log.find((e) => e.eventId === eventId && e.role === 'dm');
    if (!source) return false;
    const narration = { eventId: source.eventId, text: source.text, sceneId: source.sceneId, audience: source.audience, ...(source.inputId ? { inputId: source.inputId } : {}) };
    let receipt = campaign.state.storyReports?.[eventId];
    if (!receipt) {
      await mutate(sessionId, (draft) => { assertActive(signal); const t = draft.state.storyTasks[eventId]; t.attempts++; t.status = 'pending'; delete t.error; });
      try {
        if (typeof recording !== 'function') throw new Error('No story recorder');
        const report = await recording({ parent, signal, phase: 'record', npcId: 'story-recorder', name: '正文事实整理', prompt: makeStoryReportPrompt(campaign, narration), outputSchema: STORY_REPORT_SCHEMA });
        if (signal?.aborted) throw new Error('Cancelled');
        receipt = await mutate(sessionId, (draft) => {
          assertActive(signal);
          const result = applyStoryReport(draft, report, narration);
          draft.state.storyTasks[eventId].status = 'pending';
          return result;
        });
      } catch {
        await markFailure(sessionId, eventId, 'record');
        return false;
      }
    }
    // A receipt precedes cultivation. Retrying a failed appraisal never regenerates or reapplies items.
    for (const entry of receipt.npcEvents ?? []) {
      if (signal?.aborted) { await markFailure(sessionId, eventId, 'cultivation'); return false; }
      campaign = await owned(sessionId);
      task = campaign.state.storyTasks[eventId];
      if (task.cultivation?.[entry.npcId]?.status === 'done') continue;
      const persona = campaign.snapshot.characters.find((p) => p.id === entry.npcId);
      const baseline = campaign.state.npcs[entry.npcId];
      try {
        const update = await cultivation.processExternalEvent({ persona: copy(persona), state: copy(baseline), event: copy(entry.event), signal });
        if (signal?.aborted || !update?.state?.processedEventIds?.includes(entry.event.id)) throw new Error('Appraisal incomplete');
        // Save successful perception even if the less frequent development task fails later.
        await mutate(sessionId, (draft) => {
          assertActive(signal);
          if (JSON.stringify(draft.state.npcs[entry.npcId]) !== JSON.stringify(baseline)) throw domainError('STALE_CULTIVATION', '人物状态已更新，丢弃迟到评价。');
          draft.state.npcs[entry.npcId] = copy(update.state);
        });
        if (typeof cultivation.developExternalState !== 'function') throw new Error('Cultivation development API unavailable');
        const development = await cultivation.developExternalState({ persona: copy(persona), state: copy(update.state), event: copy(entry.event), signal });
        if (signal?.aborted || !development?.state) throw new Error('Development incomplete');
        await mutate(sessionId, (draft) => {
          assertActive(signal);
          if (JSON.stringify(draft.state.npcs[entry.npcId]) !== JSON.stringify(update.state)) throw domainError('STALE_CULTIVATION', '人物状态已更新，丢弃迟到养成。');
          draft.state.npcs[entry.npcId] = copy(development.state);
          draft.state.storyTasks[eventId].cultivation[entry.npcId] = { status: development.incomplete || development.pendingTasks?.length ? 'failed' : 'done' };
        });
        if (development.incomplete || development.pendingTasks?.length) throw new Error('Development incomplete');
      } catch {
        await markFailure(sessionId, eventId, 'cultivation');
        return false;
      }
    }
    await mutate(sessionId, (draft) => { assertActive(signal); const t = draft.state.storyTasks[eventId]; t.status = 'recorded'; delete t.error; delete t.failedStage; });
    return true;
  }
  function settleNarration(sessionId, { parent, signal, retry = false } = {}) {
    if (settlements.has(sessionId)) return settlements.get(sessionId);
    const work = (async () => {
      const campaign = await owned(sessionId);
      // Snapshot the queue. Later prose is handled by the host's next drain, not an endless worker.
      const tasks = campaign.state.log.filter((e) => e.role === 'dm' && campaign.state.storyTasks?.[e.eventId]).map((e) => campaign.state.storyTasks[e.eventId]);
      for (const task of tasks) {
        if (signal?.aborted) break;
        if (task.status === 'recorded') continue;
        // Preserve chronological projection: an old failed inventory update must not land after a newer one.
        if (task.status === 'failed' && !retry) break;
        if (!await settleOne(sessionId, task.eventId, { parent, signal })) break;
      }
    })();
    settlements.set(sessionId, work);
    return work.finally(() => { if (settlements.get(sessionId) === work) settlements.delete(sessionId); });
  }
  async function perform(sessionId, operation, args = {}, { signal } = {}) {
    if (!DM_TOOLS.includes(operation)) throw domainError('NARRATIVE_ACTION', '普通行动由主持人直接叙述，不再使用动作审批工具。');
    const before = await owned(sessionId);
    if (operation === 'tavern_status') return store.getPublicCampaign(before.id);
    return mutate(sessionId, (campaign) => {
      requirePlayable(campaign);
      if (signal?.aborted) throw domainError('ABORTED', '操作已取消。');
      const input = [...campaign.state.log].reverse().find((e) => e.role === 'player');
      if (!input || input.synthetic) throw domainError('NO_PLAYER_INPUT', '等待玩家实际行动。');
      const key = keyOf(input.eventId, operation, operation === 'tavern_check' ? `${campaign.state.sceneId}|${args.checkId}` : 'once');
      campaign.state.operations ??= {};
      if (Object.hasOwn(campaign.state.operations, key)) return copy(campaign.state.operations[key]);
      let result;
      if (operation === 'tavern_check') result = applyCheck(campaign, args.checkId, { random });
      else if (operation === 'tavern_combat') result = applyEncounter(campaign, { random });
      else result = restPlayer(campaign);
      campaign.state.operations[key] = copy(result);
      campaign.state.log.push({ role: 'world', turn: campaign.state.turnIndex, inputId: input.eventId, eventId: key, sceneId: campaign.state.sceneId, audience: presentActorIds(campaign), text: `数值规则结果：${JSON.stringify(result)}` });
      return result;
    });
  }
  return { recordInput, recordNarration, settleNarration, perform, react: async () => ({ actions: [], agencyDiagnostics: [] }), makePrompt: async (sessionId) => { const campaign = await owned(sessionId); return makeDmPrompt(campaign, await store.getBinding(sessionId), cultivation); } };
}
