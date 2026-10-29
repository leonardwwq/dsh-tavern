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
  requireThat(manifest.formatVersion === 1, 'Unsupported script format version', 'UNSUPPORTED_FORMAT');
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
  return cloneJson({ scriptKey: record.scriptKey ?? `${manifest.id}@${manifest.version}`, id: manifest.id, version: manifest.version, title: manifest.title, description: manifest.description, ...(manifest.author ? { author: manifest.author } : {}), capabilities: manifest.capabilities, characterCount: record.snapshot?.characters?.length ?? record.characters?.length ?? manifest.characters.length, party: (record.snapshot?.characters ?? record.characters ?? []).map(({ id, name, role }) => ({ id, name, role })), archived: Boolean(record.archived), ...(record.importedAt ? { importedAt: record.importedAt } : {}) });
}
function publicPlayer(player) {
  return Object.fromEntries(['id', 'name', 'hp', 'maxHp', 'armorClass', 'attackBonus', 'damage'].filter((key) => player[key] !== undefined).map((key) => [key, player[key]]));
}
/** Allowlist projection: do not return DM, arbitrary logs/flags, NPC runtime state or private persona fields. */
export function publicCampaign(campaign) {
  const { snapshot, state } = campaign;
  const scene = snapshot.adventure.scenes.find((item) => item.id === state.sceneId);
  const encounter = scene?.encounter && state.encounters[scene.id];
  return cloneJson({ id: campaign.id, scriptKey: campaign.scriptKey, scriptId: campaign.scriptId, scriptVersion: campaign.scriptVersion, title: campaign.title, createdAt: campaign.createdAt, updatedAt: campaign.updatedAt, ownerSessionId: campaign.ownerSessionId, script: publicScript({ snapshot, scriptKey: campaign.scriptKey }), state: { sceneId: state.sceneId, turnIndex: state.turnIndex, status: state.status, completed: state.completed, visited: state.visited, player: publicPlayer(state.player), ...(scene ? { scene: { id: scene.id, place: scene.place, opening: scene.opening, cast: scene.cast, allowRest: Boolean(scene.allowRest), ending: Boolean(scene.ending), checks: (scene.checks ?? []).map(({ id, label, dc, bonus = 0, repeatable = false }) => ({ id, label, dc, bonus, repeatable, resolved: Object.hasOwn(state.checks, `${scene.id}:${id}`) })), exits: scene.exits.map((exit) => ({ to: exit.to, label: exit.label, available: canUseExit(exit, state) })) } } : {}), ...(encounter ? { encounter: { id: encounter.id, name: encounter.name, hp: encounter.hp, defeated: encounter.defeated } } : {}), npcs: snapshot.characters.map(({ id, name, role }) => { const meta = state.npcMeta?.[id] ?? {}; const action = (state.autonomy?.actions ?? []).filter((item) => item.npcId === id && item.sceneId === state.sceneId && item.visibility === 'public').at(-1); return { id, name, role, status: meta.publicStatus ?? (meta.offscreen && meta.status !== 'active' ? 'left' : meta.status ?? 'active'), condition: (meta.status ?? 'active') === 'active' && Array.isArray(meta.condition) ? meta.condition.filter((item) => typeof item === 'string').slice(0, 6) : [], ...(action ? { lastAction: { kind: action.kind, text: action.publicText, sceneId: action.sceneId } } : {}) }; }) } });
}
export function initialCampaignState(snapshot, npcStates) {
  const player = snapshot.adventure.player;
  return { sceneId: snapshot.adventure.entry, turnIndex: 0, status: 'active', completed: false, checks: {}, visited: [snapshot.adventure.entry], flags: {}, player: { id: player.id ?? 'player', name: player.name, hp: player.hp, maxHp: player.maxHp ?? player.hp, armorClass: player.armorClass ?? 12, attackBonus: player.attackBonus ?? 2, damage: player.damage ?? 5 }, encounters: {}, log: [], npcs: cloneJson(npcStates), npcMeta: {} };
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
  if (!campaign.state.visited.includes(destination)) campaign.state.visited.push(destination);
  const next = currentScene(campaign);
  if (next.ending === true) { campaign.state.completed = true; campaign.state.status = 'completed'; }
  return cloneJson(next);
}
/** Checks are authored by the script, never free-form flag updates from the DM. */
export function applyCheck(campaign, checkId, { roll, random = Math.random, npcBonus = 0 } = {}) {
  const scene = currentScene(campaign);
  const check = (scene.checks ?? []).find((item) => item.id === checkId);
  if (!check) throw domainError('CHECK_NOT_FOUND', 'This scene has no such check');
  const key = `${scene.id}:${check.id}`;
  if (!check.repeatable && Object.hasOwn(campaign.state.checks, key)) return { ...cloneJson(campaign.state.checks[key]), cached: true };
  const result = { checkId, sceneId: scene.id, label: check.label, ...d20Check({ dc: check.dc, bonus: (check.bonus ?? 0) + boundedNpcEffect(npcBonus, -4, 4), roll, random }), cached: false };
  Object.assign(campaign.state.flags, (result.success ? check.successFlags : check.failureFlags) ?? {});
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
  } else {
    retaliation = d20Check({ dc: campaign.state.player.armorClass, bonus: config.attackBonus ?? 0, roll: enemyRoll, random });
    rawReceived = retaliation.success ? (config.damage ?? 1) * (retaliation.critical ? 2 : 1) : 0;
    received = Math.max(0, rawReceived - boundedNpcEffect(npcEffects?.damageReduction, 0, 4));
    campaign.state.player.hp = Math.max(0, campaign.state.player.hp - received);
  }
  return { attack, damage, retaliation, ...(npcEffects !== undefined ? { rawReceived } : {}), received, enemyHp: enemy.hp, playerHp: campaign.state.player.hp, defeated: enemy.defeated };
}
