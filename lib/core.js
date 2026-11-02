import { createHash, randomInt } from 'node:crypto';

/** Import engineering limits, not a content licensing/security guarantee. */
export const IMPORT_LIMITS = Object.freeze({ archiveBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, entryBytes: 5 * 1024 * 1024, entries: 128, jsonDepth: 64 });
export const CAPABILITY = 'cultivation.external.v1';
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function domainError(code, message) {
  return Object.assign(new Error(message), { code });
}
function requireThat(value, message, code = 'INVALID_SCRIPT') {
  if (!value) throw domainError(code, message);
}
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Strict JSON copy: rejects dangerous keys, cycles, accessors and non-JSON values. */
export function cloneJson(value, depth = 0, seen = new Set()) {
  requireThat(depth <= IMPORT_LIMITS.jsonDepth, 'JSON nesting is too deep', 'INVALID_JSON');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value), 'JSON numbers must be finite', 'INVALID_JSON');
    return value;
  }
  requireThat(Array.isArray(value) || isRecord(value), 'Only JSON data is supported', 'INVALID_JSON');
  requireThat(!seen.has(value), 'Circular JSON is not supported', 'INVALID_JSON');
  if (Array.isArray(value)) requireThat(Object.keys(value).length === value.length && Object.keys(value).every((key, index) => key === String(index)), 'Sparse arrays and custom array properties are not JSON', 'INVALID_JSON');
  seen.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    requireThat(!FORBIDDEN_KEYS.has(key), `Unsafe JSON key: ${key}`, 'INVALID_JSON');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireThat(descriptor && 'value' in descriptor, 'JSON accessors are not supported', 'INVALID_JSON');
    result[key] = cloneJson(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}
export function canonicalJson(value) {
  const clean = cloneJson(value);
  const serialize = (item) => Array.isArray(item) ? `[${item.map(serialize).join(',')}]` : isRecord(item) ? `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${serialize(item[key])}`).join(',')}}` : JSON.stringify(item);
  return serialize(clean);
}
export function contentHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function validateId(value, name = 'id') {
  requireThat(typeof value === 'string' && SAFE_ID.test(value), `Invalid ${name}`);
  requireThat(!FORBIDDEN_KEYS.has(value), `Unsafe ${name}`);
  return value;
}
export function validateContentPath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 240, 'Invalid archive path', 'INVALID_ARCHIVE');
  requireThat(!value.includes('\\') && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value) && !/[\x00-\x1f\x7f]/.test(value), 'Unsafe archive path', 'INVALID_ARCHIVE');
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  requireThat(path.split('/').every((part) => part && part !== '.' && part !== '..' && !FORBIDDEN_KEYS.has(part)), 'Unsafe archive path', 'INVALID_ARCHIVE');
  return value;
}
function text(value, label, max = 10000) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
}
function integer(value, label, min = 0, max = 1000000) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${label}`);
}
function validateRequires(requires) {
  if (requires === undefined) return;
  requireThat(isRecord(requires), 'Exit requires must be a flag/value object');
  for (const [key, value] of Object.entries(requires)) {
    validateId(key, 'flag');
    requireThat(['string', 'boolean', 'number'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value)), 'Invalid exit requirement');
  }
}
/** Returns an independent canonical script snapshot. No source paths are ever filesystem paths. */
export function validateScript(input) {
  const script = cloneJson(input);
  const { manifest, adventure, characters, assets = {} } = script;
  requireThat(isRecord(manifest), 'A manifest is required');
  requireThat(manifest.formatVersion === 1 || manifest.formatVersion === 2, 'Unsupported script format version', 'UNSUPPORTED_FORMAT');
  validateId(manifest.id, 'script id');
  validateId(manifest.version, 'script version');
  text(manifest.title, 'script title', 200);
  text(manifest.description, 'script description', 10000);
  if (manifest.author !== undefined) text(manifest.author, 'author', 200);
  requireThat(Array.isArray(manifest.capabilities) && manifest.capabilities.length === 1 && manifest.capabilities[0] === CAPABILITY, `Only ${CAPABILITY} is supported`, 'UNSUPPORTED_CAPABILITY');
  validateContentPath(manifest.adventure);
  requireThat(Array.isArray(manifest.characters) && manifest.characters.length > 0 && manifest.characters.length <= 16, 'Provide 1–16 NPC character definitions');
  manifest.characters.forEach(validateContentPath);
  requireThat(new Set(manifest.characters).size === manifest.characters.length, 'Duplicate character paths');
  requireThat(isRecord(adventure) && isRecord(adventure.dm), 'An adventure DM configuration is required');
  requireThat(isRecord(adventure.player), 'A player definition is required');
  text(adventure.player.name, 'player name', 100);
  if (adventure.player.id !== undefined) validateId(adventure.player.id, 'player id');
  integer(adventure.player.hp, 'player hp', 1);
  if (adventure.player.maxHp !== undefined) integer(adventure.player.maxHp, 'player maxHp', adventure.player.hp);
  if (adventure.player.armorClass !== undefined) integer(adventure.player.armorClass, 'player armorClass', 1, 40);
  if (adventure.player.attackBonus !== undefined) integer(adventure.player.attackBonus, 'player attackBonus', -20, 20);
  if (adventure.player.damage !== undefined) integer(adventure.player.damage, 'player damage', 1, 1000);
  requireThat(Array.isArray(characters) && characters.length === manifest.characters.length, 'Character definitions do not match manifest');
  const ids = new Set();
  for (const character of characters) {
    requireThat(isRecord(character), 'Invalid character definition');
    validateId(character.id, 'NPC id');
    requireThat(!ids.has(character.id), 'Duplicate NPC id');
    ids.add(character.id);
    if (character.kind !== undefined) requireThat(manifest.formatVersion === 2 && ['party', 'world'].includes(character.kind), 'Invalid NPC kind');
    text(character.name, 'NPC name', 100);
    text(character.role, 'NPC role', 100);
    text(character.goal, 'NPC goal');
    requireThat(isRecord(character.fields), 'NPC fields must be an object');
    if (character.initialState !== undefined) requireThat(isRecord(character.initialState), 'NPC initialState must be an object');
  }
  requireThat(Array.isArray(adventure.scenes) && adventure.scenes.length > 0 && adventure.scenes.length <= 100, 'Provide 1–100 scenes');
  const sceneIds = new Set();
  for (const scene of adventure.scenes) {
    requireThat(isRecord(scene), 'Invalid scene');
    validateId(scene.id, 'scene id');
    requireThat(!sceneIds.has(scene.id), 'Duplicate scene id');
    sceneIds.add(scene.id);
    text(scene.place, 'scene place', 200);
    text(scene.opening, 'scene opening');
    requireThat(Array.isArray(scene.cast) && scene.cast.every((id) => ids.has(id)) && new Set(scene.cast).size === scene.cast.length, 'Scene cast references an unknown or duplicate NPC');
    requireThat(Array.isArray(scene.exits), 'Scene exits must be an array');
    const destinations = new Set();
    for (const exit of scene.exits) {
      requireThat(isRecord(exit), 'Invalid exit');
      validateId(exit.to, 'exit destination');
      requireThat(!destinations.has(exit.to), 'Duplicate exit destination');
      destinations.add(exit.to);
      text(exit.label, 'exit label', 200);
      validateRequires(exit.requires);
    }
    if (scene.beats !== undefined) {
      requireThat(manifest.formatVersion === 2 && Array.isArray(scene.beats) && scene.beats.length > 0 && scene.beats.length <= 100, 'Scene beats require format v2 and 1–100 entries');
      const beatIds = new Set();
      for (const beat of scene.beats) {
        requireThat(isRecord(beat), 'Invalid scene beat');
        validateId(beat.id, 'beat id');
        requireThat(!beatIds.has(beat.id), 'Duplicate beat id'); beatIds.add(beat.id);
        text(beat.text, 'beat text');
        if (beat.cue !== undefined) requireThat(scene.cast.includes(beat.cue), 'Beat cue must reference a cast NPC');
      }
    }
    if (scene.information !== undefined) {
      requireThat(manifest.formatVersion === 2 && Array.isArray(scene.information) && scene.information.length <= 100, 'Scene information requires format v2 and at most 100 entries');
      const informationIds = new Set();
      for (const item of scene.information) {
        requireThat(isRecord(item), 'Invalid scene information');
        validateId(item.id, 'information id');
        requireThat(!informationIds.has(item.id), 'Duplicate scene information id');
        informationIds.add(item.id);
        text(item.text, 'scene information');
        validateRequires(item.requires);
      }
    }
    if (scene.allowRest !== undefined) requireThat(typeof scene.allowRest === 'boolean', 'Scene allowRest must be boolean');
    if (scene.ending !== undefined) requireThat(typeof scene.ending === 'boolean', 'Scene ending must be boolean');
    if (scene.npcGoals !== undefined) {
      requireThat(isRecord(scene.npcGoals), 'Scene npcGoals must be an object');
      for (const [id, goal] of Object.entries(scene.npcGoals)) { requireThat(ids.has(id), 'Scene goal references an unknown NPC'); text(goal, 'scene NPC goal'); }
    }
    if (scene.checks !== undefined) {
      requireThat(Array.isArray(scene.checks) && scene.checks.length <= 30, 'Scene checks must be an array of at most 30 checks');
      const checks = new Set();
      for (const check of scene.checks) {
        requireThat(isRecord(check), 'Invalid scene check');
        validateId(check.id, 'check id');
        requireThat(!checks.has(check.id), 'Duplicate check id'); checks.add(check.id);
        text(check.label, 'check label', 200);
        integer(check.dc, 'check difficulty', 1, 40);
        integer(check.bonus ?? 0, 'check bonus', -20, 20);
        validateRequires(check.successFlags); validateRequires(check.failureFlags);
        if (check.requires !== undefined) { requireThat(manifest.formatVersion === 2, 'Check requirements require format v2'); validateRequires(check.requires); }
        if (check.repeatable !== undefined) requireThat(typeof check.repeatable === 'boolean', 'Check repeatable must be boolean');
      }
    }
    if (scene.encounter !== undefined) {
      const enemy = scene.encounter;
      requireThat(isRecord(enemy), 'Invalid encounter');
      validateId(enemy.id, 'encounter id');
      text(enemy.name, 'encounter name', 100);
      integer(enemy.hp, 'encounter hp', 1);
      integer(enemy.armorClass, 'encounter armorClass', 1, 40);
      integer(enemy.attackBonus ?? 0, 'encounter attackBonus', -20, 20);
      integer(enemy.damage ?? 1, 'encounter damage', 1, 1000);
      if (enemy.rewardFlags !== undefined) validateRequires(enemy.rewardFlags);
      if (enemy.materials !== undefined) {
        requireThat(Array.isArray(enemy.materials) && enemy.materials.length <= 20, 'Invalid encounter materials');
        const materialIds = new Set();
        for (const material of enemy.materials) {
          requireThat(isRecord(material), 'Invalid encounter material');
          validateId(material.id, 'material id');
          requireThat(!materialIds.has(material.id), 'Duplicate material id'); materialIds.add(material.id);
          text(material.name, 'material name', 100);
          requireThat(material.collectible === true, 'Encounter material must explicitly permit collection');
        }
      }
    }
  }
  requireThat(sceneIds.has(adventure.entry), 'Adventure entry references an unknown scene');
  for (const scene of adventure.scenes) for (const exit of scene.exits) requireThat(sceneIds.has(exit.to), 'Exit references an unknown scene');
  requireThat(isRecord(assets), 'Assets must be an object');
  for (const [path, asset] of Object.entries(assets)) {
    validateContentPath(path);
    requireThat(path.startsWith('assets/') && /\.(png|jpe?g|webp|gif)$/i.test(path), 'Unsupported asset type');
    requireThat(isRecord(asset) && typeof asset.data === 'string' && typeof asset.mediaType === 'string', 'Invalid asset');
    requireThat(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data), 'Invalid base64 asset');
  }
  return { manifest, adventure, characters, assets };
}
export function publicScript(record) {
  const manifest = record.snapshot?.manifest ?? record.manifest;
  const characters = record.snapshot?.characters ?? record.characters;
  const party = characters?.filter(({ kind }) => kind !== 'world');
  return cloneJson({ scriptKey: record.scriptKey ?? `${manifest.id}@${manifest.version}`, id: manifest.id, version: manifest.version, title: manifest.title, description: manifest.description, ...(manifest.author ? { author: manifest.author } : {}), capabilities: manifest.capabilities, characterCount: party?.length ?? manifest.characters.length, party: (party ?? []).map(({ id, name, role }) => ({ id, name, role })), archived: Boolean(record.archived), ...(record.importedAt ? { importedAt: record.importedAt } : {}) });
}
function publicPlayer(player) {
  return Object.fromEntries(['id', 'name', 'hp', 'maxHp', 'armorClass', 'attackBonus', 'damage'].filter((key) => player[key] !== undefined).map((key) => [key, player[key]]));
}
/** Allowlist projection: do not return DM, arbitrary logs/flags, NPC runtime state or private persona fields. */
export function publicCampaign(campaign) {
  const { snapshot, state } = campaign;
  const scene = snapshot.adventure.scenes.find((item) => item.id === state.sceneId);
  const encounter = scene?.encounter && state.encounters[scene.id];
  const input = [...(state.log ?? [])].reverse().find((entry) => entry.role === 'player' && !entry.synthetic);
  // Old autonomous-decision diagnostics are archival, not current narrator prerequisites.
  const decisions = [];
  const recordingTasks = Object.values(state.storyTasks ?? {});
  const storyRecording = { pending: recordingTasks.filter((task) => task.status === 'pending').length, failed: recordingTasks.filter((task) => task.status === 'failed').length, errors: [...new Set(recordingTasks.filter((task) => task.status === 'failed').map((task) => task.failedStage === 'record' ? '本轮状态整理未完成；正文保留，物品和位置面板可能落后，可重试。' : '本轮人物养成未完成；正文与已记录物品保留，可重试。'))] };
  const incompleteJudgments = decisions.filter((entry) => ['timeout', 'capacity', 'unavailable'].includes(entry.status)).length;
  const incompleteAppraisals = decisions.filter((entry) => entry.appraisalIncomplete === true && !['timeout', 'capacity', 'unavailable'].includes(entry.status)).length;
  return cloneJson({ id: campaign.id, scriptKey: campaign.scriptKey, scriptId: campaign.scriptId, scriptVersion: campaign.scriptVersion, title: campaign.title, createdAt: campaign.createdAt, updatedAt: campaign.updatedAt, ownerSessionId: campaign.ownerSessionId, script: publicScript({ snapshot, scriptKey: campaign.scriptKey }), state: { storyRecording, ...(state.storyLocation ? { storyLocation: state.storyLocation } : {}), freeActionResults: state.freeActionResults ?? [], inventory: state.freeActionItems ?? [], ...(state.playerPosition?.sceneId === state.sceneId ? { playerPosition: state.playerPosition } : {}), incompleteJudgments, incompleteAppraisals, history: (state.log ?? []).filter((entry) => ['player', 'dm'].includes(entry.role) && !entry.synthetic && typeof entry.text === 'string').map((entry) => ({ role: entry.role, text: entry.text, ...(entry.eventId ? { id: entry.eventId } : {}) })), sceneId: state.sceneId, turnIndex: state.turnIndex, status: state.status, completed: state.completed, visited: state.visited, player: publicPlayer(state.player), ...(scene ? { scene: publicScene(campaign) } : {}), ...(encounter ? { encounter: { id: encounter.id, name: encounter.name, hp: encounter.hp, defeated: encounter.defeated } } : {}), npcs: snapshot.characters.filter(({ kind }) => kind !== 'world').map(({ id, name, role }) => { const meta = state.npcMeta?.[id] ?? {}; const action = undefined; // Legacy agency proposals are not current actions.
 return { id, name, role, status: meta.publicStatus ?? (meta.offscreen && meta.status !== 'active' ? 'left' : meta.status ?? 'active'), condition: (meta.status ?? 'active') === 'active' && Array.isArray(meta.condition) ? meta.condition.filter((item) => typeof item === 'string').slice(0, 6) : [], ...(action ? { lastAction: { kind: action.kind, text: action.kind === 'act' ? `【行动意向，尚待 DM 裁定】${action.publicText}` : action.publicText, sceneId: action.sceneId } } : {}) }; }) } });
}
/** A narrow, deterministic action: only public observations and authored materials. */
export function applyFreeAction(campaign, { kind, target }, playerText) {
  const scene = currentScene(campaign), state = campaign.state;
  if (!['explore', 'loot'].includes(kind)) throw domainError('ACTION_UNSUPPORTED', '不支持这种自由行动。');
  if (typeof target !== 'string' || !target.trim() || target.length > 100 || target !== target.trim() || typeof playerText !== 'string' || !playerText.trim()) throw domainError('ACTION_NOT_EXPLICIT', '请由玩家明确说明行动。');
  // A direct address followed by an explicit first-person action is still the
  // player's action, not an instruction for the named NPC to perform it.
  const rawCommand = playerText.trim();
  const addressed = campaign.snapshot.characters.find((npc) => typeof npc.name === 'string' && npc.name && (rawCommand.startsWith(npc.name + '，我') || rawCommand.startsWith(npc.name + ',我')));
  const input = addressed ? rawCommand.slice(addressed.name.length + 1) : rawCommand;
  // The DM proposes the semantic action and target. These guards are deliberately
  // conservative, not a natural-language parser or proof of player consent.
  if (/[“”‘’"'「」『』。！？!?；;：:\n\r\0]/u.test(target) || /(?:不要|不能|别|如果|假如|假设|是否|然后|接着|并且|同时|[，,]\s*(?:我|你|他|她|不|没|请|去|进|看|拔|查看|检查|观察|搜索|搜查))/u.test(target)) throw domainError('ACTION_NOT_EXPLICIT', '行动目标不能包含指令或转述。');
  const guarded = input.replace(target, ''); // Names may themselves contain action words.
  const unsafe = /[?？“”‘’"「」『』]|(?:不要|不想|不去|不再|不能|不会|不必|不打算|没打算|没有|别|勿|如果|假如|假设|倘若|要是|是否|能否|可否|是不是|怎么办|会不会|吗[。！!\s]*$|让(?:他|她|你|他们|大家)|请(?:他|她|你|他们)|叫(?:他|她|你|他们)|(?:他|她|你|他们|大家|所有人)(?:去|来|先|要|看看|查看|搜索|进入)|(?:他说|她说|听说)|先休息[，,])/u;
  const reported = /(?:队友|同伴|伙伴|有人|别人|路人|众人|大家|他|她|你)(?:刚才|之前|曾经|当时|又|还)?(?:说|讲|表示|提到|建议|要求|命令|告诉我|认为|想要|打算)/u.test(guarded);
  const namedActor = campaign.snapshot.characters.some((npc) => npc.name && guarded.includes(npc.name));
  if (unsafe.test(guarded) || reported || /(?:不|没)(?:会|要|去|想|打算|准备|曾|再|予以|进行|搜索|查看|观察|调查|检查|拿|捡|取|收|采|拔|进|靠近|走)/u.test(guarded) || /(?:所有人|大家|他们)(?:都|一起)/u.test(guarded) || namedActor) throw domainError('ACTION_NOT_EXPLICIT', '疑问、假设、否定和代行不会自动执行。');
  const movement = kind === 'explore' && /(?:走进|进入|进去|进到|进)/u.test(guarded) ? '进入' : kind === 'explore' && /(?:走近|靠近|走到|前往|过去|去)/u.test(guarded) ? '去' : null;
  const examined = kind === 'explore' && /(?:搜索|搜查|搜寻|搜一搜|检查|查看|看看|看一看|观察|探索|探查|打量|瞧|调查|研究|翻找|找找|查看看)/u.test(guarded);
  // Do not authorize an arbitrary DM proposal from speech with no action signal.
  if (!(examined || movement || (kind === 'loot' && /(?:拾|捡|拿|取|收|采|拔|带走|装进|放进)/u.test(guarded)))) throw domainError('ACTION_NOT_EXPLICIT', '请明确说明本人行动。');
  if (state.player.hp <= 0) throw domainError('PLAYER_DOWN', '玩家无法行动。');
  let result;
  if (kind === 'explore') {
    const visible = publicScene(campaign);
    const sources = [visible.place, visible.opening, ...(visible.information ?? []).map((item) => item.text), visible.beat?.text].filter(Boolean);
    // Chinese descriptions often add a diminutive before a structure suffix
    // (维修小亭 vs 维修亭). Accept only that narrow, unambiguous variant;
    // the target still has to appear verbatim in the player's own input.
    const variants = [target];
    if (target.length >= 2 && /[亭屋房室洞]$/u.test(target) && target.at(-2) !== '小') variants.push(target.slice(0, -1) + '小' + target.at(-1));
    const visibleVariants = variants.filter((candidate) => sources.some((source) => source.includes(candidate)));
    if (visibleVariants.length > 1) throw domainError('ACTION_TARGET_NOT_PUBLIC', '场景中有多个相似目标，请先确认。');
    const visibleTarget = visibleVariants[0];
    // A semantic target may be a paraphrase or a part of the scene. Exploration
    // remains informational; physical relocation needs an anchored public target.
    // A movement verb elsewhere in a compound sentence does not authorize moving
    // to the DM's proposed target. Require the verb to govern this literal target;
    // ambiguous paraphrases can still be narrated or clarified without a state write.
    const escapedMoveTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directedMovement = new RegExp(`(?:走进|进入|进去|进到|进|走近|靠近|走到|前往|过去|去)\\s*(?:到|向|往)?\\s*(?:那(?:个|座|间|处)?|这(?:个|座|间|处)?)?\\s*${escapedMoveTarget}`, 'u');
    if (movement && (!visibleTarget || !directedMovement.test(input))) throw domainError('ACTION_UNCERTAIN', '无法确认玩家是否要移动到该目标，请先确认。');
    if (movement === '进入') {
      if (target.length < 2 || !/(?:亭|屋|房|室|洞|帐篷|房间|走廊|通道|地窖|车厢|门厅)$/.test(target)) throw domainError('ACTION_UNCERTAIN', '这个目标是否可以进入尚不明确，请先确认。');
      if (sources.some((source) => /锁|封闭|封住|堵住|阻挡|无法进入|不能进入|深渊|断崖|陷阱/.test(source) || source.includes('挡住' + visibleTarget))) throw domainError('ACTION_UNCERTAIN', '附近可能有已知阻碍，请先处理或确认是否可进入。');
      const localStructure = visibleTarget === visible.place || /(?:门边|旁边|附近|面前|眼前)有(?:一间|一座|一处|个)?[^。！？]{0,20}/u.exec(visible.opening ?? '')?.[0].includes(visibleTarget);
      if (!localStructure) throw domainError('ACTION_UNCERTAIN', '目前不能确认该位置可以进入，请先查看入口或询问。');
    }
    const previous = examined && state.freeActionResults?.find((entry) => entry.kind === kind && entry.sceneId === scene.id && entry.target === target && entry.examined !== false);
    if (movement) state.playerPosition = { sceneId: scene.id, target, relation: ['走进', '进入', '进'].includes(movement) ? 'inside' : 'near' };
    if (previous) {
      const { position: _oldPosition, ...past } = cloneJson(previous);
      return { ...past, ...(movement ? { position: cloneJson(state.playerPosition) } : {}), alreadyExplored: true };
    }
    result = { kind, sceneId: scene.id, target, examined, outcome: examined ? (visibleTarget ? '已查看该处，目前没有可以确定的新增发现。' : '已尝试查看；尚不能确认目标或任何新增发现。') : state.playerPosition?.relation === 'inside' && movement ? '已进入指定位置，当前场景中的威胁没有因此消失。' : '已移动到指定位置附近，当前场景中的威胁没有因此消失。', ...(movement ? { position: cloneJson(state.playerPosition) } : {}), items: [] };
  } else if (kind === 'loot') {
    // Material grants require a literal authored name in the player input; unlike
    // observation, a guessed referent here would create an irreversible item.
    if (!input.includes(target)) throw domainError('MATERIAL_UNAVAILABLE', '请明确指出要拾取的授权素材。');
    // Collection changes inventory: require a single direct command with the
    // collection verb immediately governing the literal material name.
    const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const collection = new RegExp(`^(?:我[，,\\s]*)?(?:要|想要|打算|准备)?\\s*(?:拾取|拾起|捡起|捡|拿起|拿|取走|取|收集|收起|采集|采摘|拔下|拔|带走)\\s*(?:这(?:个|些|块|片|枚|颗|根|只|条)?)?\\s*${escapedTarget}\\s*(?:吧|了|一下)?[。！!\\s]*$`, 'u');
    if (!collection.test(input)) throw domainError('ACTION_NOT_EXPLICIT', '请明确直接说明要拾取的素材。');
    if (scene.encounter && !state.encounters?.[scene.id]?.defeated) throw domainError('ACTION_DURING_COMBAT', '眼前威胁尚未解决，不能拾取敌人素材。');
    const material = scene.encounter?.materials?.find((item) => item.name === target && item.collectible === true);
    if (!material || !state.encounters?.[scene.id]?.defeated) throw domainError('MATERIAL_UNAVAILABLE', '没有已授权且可拾取的敌人素材；未执行。');
    state.freeActionItems ??= [];
    const existing = state.freeActionItems.find((item) => item.sceneId === scene.id && item.id === material.id);
    if (existing) return { kind, sceneId: scene.id, target, outcome: '该素材已经拾取。', items: [cloneJson(existing)], alreadyCollected: true };
    const item = { id: material.id, name: material.name, sceneId: scene.id };
    state.freeActionItems.push(item);
    result = { kind, sceneId: scene.id, target, outcome: '已拾取剧本授权的素材。', items: [cloneJson(item)], alreadyCollected: false };
  } else throw domainError('ACTION_UNSUPPORTED', '不支持这种自由行动。');
  state.freeActionResults ??= [];
  state.freeActionResults.push(cloneJson(result));
  return result;
}
/**
 * Settle one NPC-to-player delivery, based only on persisted dialogue and player
 * input, never on a DM assertion. Call inside store.withCampaign(). This is a
 * deliberately conservative recognizer, not a general natural-language parser.
 */
export function applyNpcDelivery(campaign, { offerEventId, inputId, itemName }) {
  const state = campaign.state, log = state.log ?? [];
  if (typeof offerEventId !== 'string' || !offerEventId || typeof inputId !== 'string' || !inputId || typeof itemName !== 'string' || !itemName.trim() || itemName !== itemName.trim() || itemName.length > 60 || /[，,。！？!?；;：:\n\r\0“”"「」『』]/u.test(itemName)) throw domainError('DELIVERY_INVALID', '交付参数无效。');
  const old = state.npcDeliveries?.find((entry) => entry.offerEventId === offerEventId);
  if (old) {
    if (old.inputId !== inputId || old.item.name !== itemName) throw domainError('DELIVERY_ALREADY_SETTLED', '该交付已经结算。');
    return { ...cloneJson(old), alreadyDelivered: true };
  }
  const offerIndex = log.findIndex((entry) => entry.eventId === offerEventId && entry.role === 'npc');
  const inputIndex = log.findIndex((entry) => entry.eventId === inputId && entry.role === 'player' && !entry.synthetic);
  const offer = log[offerIndex], input = log[inputIndex];
  if (!offer || !input || offer.sceneId !== state.sceneId || input.sceneId !== state.sceneId || !campaign.snapshot.characters.some((npc) => npc.id === offer.npcId) || Math.abs(inputIndex - offerIndex) > 12) throw domainError('DELIVERY_UNAVAILABLE', '没有同场、近期的有效交付和玩家请求。');
  // A later player utterance supersedes earlier consent, including withdrawals.
  if (log.slice(inputIndex + 1).some((entry) => entry.role === 'player' && !entry.synthetic)) throw domainError('DELIVERY_NOT_CONSENTED', '请按玩家最新意愿确认。');
  if (typeof offer.text !== 'string' || typeof input.text !== 'string') throw domainError('DELIVERY_UNAVAILABLE', '交付证据无效。');
  const escaped = itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const item = `${escaped}(?=$|[，,。！？!；;：:\\s]|作为|当作)`;
  // Match a concrete action and its recipient in the same clause. A deposit is
  // not interchangeable with an arbitrary amount: the exact item must occur.
  const recipient = '(?:你们|你|玩家|冒险者)';
  const offerPatterns = [
    new RegExp(`(?:把|将)\\s*(?:[^，,。！？!；;：:\\d零一二两三四五六七八九十百千万亿]{1,12}的)?${escaped}(?![\\d零一二两三四五六七八九十百千万亿])\\s*(?:递给|递向|交给|交到|给了)\\s*${recipient}(?=$|[^\\p{Script=Han}]|作为|当作)`, 'u'),
    new RegExp(`(?:递给|递向|交给|交到|给了)\\s*${recipient}\\s*(?:一(?:个|袋|份|枚|把|张|包))?\\s*${item}`, 'u')
  ];
  const conditional = /(?:如果|假如|假设|倘若|要是|除非|只要|等到|等你|待你|前提|之后|以后|之前|(?:完成|办完|成功|找到|支付|签署|办妥).{0,20}(?:后|才)|才(?:能|会|给)|是否|能否|可否|[？?])/u;
  const negative = /(?:不|没|别|勿|未|拒绝|无法|不能|不会|尚未|还没|将会|会|打算|准备|将要|想要|可能)/u;
  // Sentence boundaries isolate unrelated later instructions. Commas do not:
  // conditions or retractions often precede/follow the action across a comma.
  const sentences = offer.text.split(/[。！？!；;\n\r]/u);
  const actionSentences = sentences.filter((sentence) => sentence.split(/[，,：:]/u).some((clause) => offerPatterns.some((pattern) => pattern.test(clause))));
  const offered = actionSentences.some((sentence) => {
    if (conditional.test(sentence)) return false;
    const clauses = sentence.split(/[，,：:]/u);
    return clauses.some((clause) => offerPatterns.some((pattern) => pattern.test(clause)) && !negative.test(clause) && !/(?:他|她|别人|其他人|同伴|队友|让|叫|请|说|听说|[“”‘’"「」『』])/u.test(clause)) &&
      !clauses.some((clause) => negative.test(clause) && /(?:递|交|给|支付|收下|接收|交付|定金)/u.test(clause));
  });
  const contradictory = sentences.some((sentence) => {
    const relevant = /(?:递|交|给|支付|收下|接收|交付)/u.test(sentence) && (sentence.includes(itemName) || /(?:定金|收下|接收)/u.test(sentence));
    return relevant && (conditional.test(sentence) || sentence.split(/[，,：:]/u).some((clause) => negative.test(clause) && /(?:递|交|给|支付|收下|接收|交付)/u.test(clause)));
  });
  if (!offered || contradictory) throw domainError('DELIVERY_UNAVAILABLE', 'NPC 未明确无条件交付该物品。');
  const request = input.text.trim();
  const money = /(?:金币|钱币|银币|铜币|钱)/u.test(itemName);
  const deposit = money && /定金/u.test(offer.text);
  const requestedItem = deposit ? `(?:${escaped}|定金|钱)` : escaped;
  // Permit only a direct acceptance and an optional departure, not a quoted,
  // conditional, partial-quantity, delegated or compound request.
  const consent = new RegExp(`^(?:我[，,\\s]*)?(?:(?:要|想要|收下|接过|接受|领取|拿|取|收|先拿|先收|先领|请给我|给我)\\s*${requestedItem}|(?:回去|回城堡|回书房)(?:拿|要|领取)${requestedItem})(?:走人|离开)?[。！!\\s]*$`, 'u');
  if (!consent.test(request)) throw domainError('DELIVERY_NOT_CONSENTED', '玩家未明确同意接收该物品。');
  if (state.player.hp <= 0) throw domainError('PLAYER_DOWN', '玩家无法行动。');
  const deliveredItem = { id: `delivery-${createHash('sha256').update(offerEventId).digest('hex').slice(0, 24)}`, name: itemName, sceneId: state.sceneId };
  const delivery = { offerEventId, inputId, npcId: offer.npcId, item: deliveredItem };
  state.freeActionItems ??= [];
  state.npcDeliveries ??= [];
  state.freeActionItems.push(cloneJson(deliveredItem));
  state.npcDeliveries.push(cloneJson(delivery));
  return { ...cloneJson(delivery), alreadyDelivered: false };
}
export function initialCampaignState(snapshot, npcStates) {
  const player = snapshot.adventure.player;
  const state = { sceneId: snapshot.adventure.entry, turnIndex: 0, status: 'active', completed: false, checks: {}, visited: [snapshot.adventure.entry], flags: {}, player: { id: player.id ?? 'player', name: player.name, hp: player.hp, maxHp: player.maxHp ?? player.hp, armorClass: player.armorClass ?? 12, attackBonus: player.attackBonus ?? 2, damage: player.damage ?? 5 }, encounters: {}, log: [], npcs: cloneJson(npcStates), npcMeta: {} };
  revealInformation({ snapshot, state });
  return state;
}
/** Only the current scene can reveal information; once observed it stays observed. */
export function revealInformation(campaign) {
  const scene = currentScene(campaign);
  campaign.state.revealedInformation ??= {};
  const revealed = campaign.state.revealedInformation[scene.id] ??= [];
  for (const item of scene.information ?? []) if (canUseExit(item, campaign.state) && !revealed.includes(item.id)) revealed.push(item.id);
}
export function visibleInformation(campaign) {
  const scene = currentScene(campaign);
  const revealed = campaign.state.revealedInformation?.[scene.id] ?? [];
  return (scene.information ?? []).filter((item) => revealed.includes(item.id) || canUseExit(item, campaign.state)).map(({ id, text }) => ({ id, text }));
}
/** Projection is deliberately an allowlist; never return raw scene or requirements. */
export function publicScene(campaign) {
  const scene = currentScene(campaign), state = campaign.state;
  const v2 = campaign.snapshot.manifest.formatVersion === 2;
  const beat = scene.beats?.[Math.min(state.sceneBeatIndexes?.[scene.id] ?? 0, scene.beats.length - 1)];
  return { id: scene.id, place: scene.place, opening: scene.opening, cast: scene.cast, ...(state.encounters?.[scene.id]?.defeated ? { materials: (scene.encounter?.materials ?? []).filter((item) => item.collectible === true).map(({ id, name }) => ({ id, name })) } : {}), allowRest: Boolean(scene.allowRest), ending: Boolean(scene.ending), ...(scene.timeOfDay ? { timeOfDay: scene.timeOfDay } : {}), ...(beat ? { beat: { id: beat.id, text: beat.text, ...(beat.cue ? { cue: beat.cue } : {}) } } : {}), ...(v2 ? { information: visibleInformation(campaign) } : {}), checks: (scene.checks ?? []).filter((check) => !v2 || canUseExit(check, state)).map(({ id, label, dc, bonus = 0, repeatable = false }) => ({ id, label, dc, bonus, repeatable, resolved: Object.hasOwn(state.checks ?? {}, `${scene.id}:${id}`) })), exits: scene.exits.filter((exit) => !v2 || canUseExit(exit, state)).map((exit) => ({ to: exit.to, label: exit.label, available: canUseExit(exit, state) })) };
}
export function rollD20(random = Math.random) {
  if (random === null) return randomInt(1, 21);
  const value = random();
  requireThat(Number.isFinite(value) && value >= 0 && value < 1, 'Random source must return [0,1)', 'INVALID_ROLL');
  return 1 + Math.floor(value * 20);
}
export function d20Check({ dc, bonus = 0, roll, random = Math.random }) {
  integer(dc, 'difficulty', 1, 1000);
  integer(bonus, 'bonus', -1000, 1000);
  const die = roll ?? rollD20(random);
  integer(die, 'd20 roll', 1, 20);
  return { roll: die, bonus, total: die + bonus, dc, success: die === 20 || (die !== 1 && die + bonus >= dc), critical: die === 20, fumble: die === 1 };
}
const OFFSCREEN_OUTCOMES = Object.freeze([
  { id: 'wounded', label: '受伤', condition: '受伤', status: 'left', min: 1, max: 4, summary: '独自行动时被落石擦伤，捂着肋侧回来了，动作明显比之前慢。' },
  { id: 'badly_hurt', label: '重伤', condition: '重伤', status: 'left', min: 5, max: 8, summary: '独自撞上了矿井里的东西，拖着一条伤腿回来，脸色很差。' },
  { id: 'lost', label: '失踪', condition: '失踪', status: 'missing', min: 9, max: 11, summary: '走得太深，暂时失去了踪迹；没人知道他/她现在在哪。' },
  { id: 'boon', label: '奇遇', condition: '奇遇', status: 'left', min: 12, max: 15, summary: '在废弃支洞里找到了一件有用的东西，回来时神情复杂但手里多了一样东西。' },
  { id: 'clue', label: '线索', condition: '线索', status: 'left', min: 16, max: 18, summary: '带回了关于矿井深处的线索，但不太愿意解释自己是怎么找到的。' },
  { id: 'captured', label: '被俘', condition: '被俘', status: 'missing', min: 19, max: 20, summary: '被矿井里的敌人抓住了；没有回来，只在远处留下了一点动静。' }
]);
/** Off-screen result for a party member who left. Authored table, not DM invention. */
export function resolveOffscreen(random = Math.random) {
  const roll = rollD20(random);
  const outcome = OFFSCREEN_OUTCOMES.find((item) => roll >= item.min && roll <= item.max);
  return { roll, ...outcome, condition: [outcome.condition] };
}
export function currentScene(campaign) {
  const scene = campaign.snapshot.adventure.scenes.find((item) => item.id === campaign.state.sceneId);
  if (!scene) throw domainError('INVALID_CAMPAIGN', 'Current scene is missing');
  return scene;
}
export function canUseExit(exit, state) {
  return Object.entries(exit.requires ?? {}).every(([key, value]) => state.flags[key] === value);
}
/** Domain mutations are only durable when called inside store.withCampaign(). */
export function moveScene(campaign, destination) {
  const scene = currentScene(campaign);
  const exit = scene.exits.find((item) => item.to === destination);
  if (!exit) throw domainError('INVALID_EXIT', 'This scene has no such exit');
  if (!canUseExit(exit, campaign.state)) throw domainError('EXIT_LOCKED', 'Exit requirements have not been met');
  // Authored exits permit retreat; encounter HP persists if the party returns.
  campaign.state.sceneId = destination;
  delete campaign.state.playerPosition;
  if (!campaign.state.visited.includes(destination)) campaign.state.visited.push(destination);
  const next = currentScene(campaign);
  revealInformation(campaign);
  if (next.ending === true) { campaign.state.completed = true; campaign.state.status = 'completed'; }
  return cloneJson(next);
}
/** Checks are authored by the script, never free-form flag updates from the DM. */
export function applyCheck(campaign, checkId, { roll, random = Math.random, npcBonus = 0 } = {}) {
  const scene = currentScene(campaign);
  const check = (scene.checks ?? []).find((item) => item.id === checkId);
  if (!check || (campaign.snapshot.manifest.formatVersion === 2 && !canUseExit(check, campaign.state))) throw domainError('CHECK_NOT_FOUND', 'This scene has no such check');
  const key = `${scene.id}:${check.id}`;
  if (!check.repeatable && Object.hasOwn(campaign.state.checks, key)) return { ...cloneJson(campaign.state.checks[key]), cached: true };
  const result = { checkId, sceneId: scene.id, label: check.label, ...d20Check({ dc: check.dc, bonus: (check.bonus ?? 0) + boundedNpcEffect(npcBonus, -4, 4), roll, random }), cached: false };
  Object.assign(campaign.state.flags, (result.success ? check.successFlags : check.failureFlags) ?? {});
  revealInformation(campaign);
  campaign.state.checks[key] = cloneJson(result);
  return result;
}
export function restPlayer(campaign) {
  if (!currentScene(campaign).allowRest) throw domainError('REST_NOT_ALLOWED', 'Rest is not allowed in this scene');
  const before = campaign.state.player.hp;
  campaign.state.player.hp = campaign.state.player.maxHp;
  return { healed: campaign.state.player.hp - before, hp: campaign.state.player.hp, maxHp: campaign.state.player.maxHp };
}
// NPC effects are a small rules capability, never arbitrary DM stat mutations.
function boundedNpcEffect(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : 0;
}
/** One player attack and (if alive) one enemy retaliation; caller supplies rolls for deterministic tests. */
export function applyEncounter(campaign, { playerRoll, enemyRoll, random = Math.random, npcEffects } = {}) {
  const scene = currentScene(campaign);
  if (!scene.encounter) throw domainError('NO_ENCOUNTER', 'There is no encounter in this scene');
  if (campaign.state.player.hp <= 0) throw domainError('PLAYER_DOWN', 'The player must recover before fighting');
  const config = scene.encounter;
  const enemy = campaign.state.encounters[scene.id] ??= { id: config.id, name: config.name, hp: config.hp, defeated: false };
  if (enemy.defeated) throw domainError('ENCOUNTER_DEFEATED', 'This encounter has already been resolved');
  const attack = d20Check({ dc: config.armorClass, bonus: campaign.state.player.attackBonus + boundedNpcEffect(npcEffects?.attackBonus, -4, 4), roll: playerRoll, random });
  const damage = attack.success ? campaign.state.player.damage * (attack.critical ? 2 : 1) : 0;
  enemy.hp = Math.max(0, enemy.hp - damage);
  let retaliation = null;
  let received = 0;
  let rawReceived = 0;
  if (enemy.hp === 0) {
    enemy.defeated = true;
    Object.assign(campaign.state.flags, config.rewardFlags ?? {});
    revealInformation(campaign);
  } else {
    retaliation = d20Check({ dc: campaign.state.player.armorClass, bonus: config.attackBonus ?? 0, roll: enemyRoll, random });
    rawReceived = retaliation.success ? (config.damage ?? 1) * (retaliation.critical ? 2 : 1) : 0;
    received = Math.max(0, rawReceived - boundedNpcEffect(npcEffects?.damageReduction, 0, 4));
    campaign.state.player.hp = Math.max(0, campaign.state.player.hp - received);
  }
  return { attack, damage, retaliation, ...(npcEffects !== undefined ? { rawReceived } : {}), received, enemyHp: enemy.hp, playerHp: campaign.state.player.hp, defeated: enemy.defeated };
}
