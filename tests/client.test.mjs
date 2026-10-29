import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const script = { key: 'mist@1', id: 'mist', version: '1', title: '雾门', description: '<img src=x onerror=alert(1)>', author: '作者', characterCount: 4, archived: false };
const base = () => ({ scripts: [{ ...script }], campaigns: [], binding: null, campaign: null, canStart: true, dependencyReady: true });
const campaign = () => ({ id: 'save-1', title: '雾门之旅', scriptId: 'mist', scriptVersion: '1', scene: { id: 'gate', place: '雾门', opening: '你站在门前。' }, player: { name: '旅人', hp: 10, maxHp: 12 }, party: [{ id: 'a', name: '甲', role: '斥候' }, { id: 'b', name: '乙', role: '术士' }, { id: 'c', name: '丙', role: '守卫' }], turnIndex: 2, paused: false, completed: false });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); };
function nodes(tree, predicate) {
  const found = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) found.push(node);
    visit(node.props && node.props.children);
  }
  visit(tree);
  return found;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (!tree || typeof tree !== 'object') return tree == null || tree === false ? '' : String(tree);
  return text(tree.props.children);
}
function named(tree, name) { return nodes(tree, (node) => typeof node.type === 'function' && node.type.name === name)[0]; }
function button(tree, label) { return nodes(tree, (node) => node.type === 'button' && text(node) === label)[0]; }

async function harness(initial = base()) {
  let current;
  let definition;
  let hostState = initial;
  const records = [];
  const registrations = new Map();
  const cleanups = [];
  const windowEvents = new Map();
  const documentEvents = new Map();
  const intervals = new Map();
  let timerId = 0;
  const styles = [];
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }; },
    useState(value) {
      const owner = current;
      const index = owner.index++;
      if (!(index in owner.state)) owner.state[index] = typeof value === 'function' ? value() : value;
      return [owner.state[index], (next) => { owner.state[index] = typeof next === 'function' ? next(owner.state[index]) : next; }];
    },
    useRef(value) { const [ref] = React.useState(() => ({ current: value })); return ref; },
    useEffect(effect, deps) {
      const owner = current;
      const index = owner.index++;
      const prior = owner.effects[index];
      if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) owner.queue.push(() => { if (prior && prior.cleanup) prior.cleanup(); owner.effects[index] = { deps, cleanup: effect() }; });
    }
  };
  const document = {
    visibilityState: 'visible',
    createElement() { return { setAttribute() {}, remove() { this.removed = true; } }; },
    head: { appendChild(style) { styles.push(style); } },
    addEventListener(name, fn) { documentEvents.set(name, fn); },
    removeEventListener(name) { documentEvents.delete(name); }
  };
  const window = {
    __ModuleLoader__: { load(value) { definition = value; } },
    addEventListener(name, fn) { windowEvents.set(name, fn); },
    removeEventListener(name) { windowEvents.delete(name); }
  };
  const context = vm.createContext({
    window, document, console, AbortController, Uint8Array,
    setTimeout() { return ++timerId; }, clearTimeout() {},
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
    fetch: async (url, options) => {
      records.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
      if (url.startsWith('/tavern/api/state')) return { ok: true, status: 200, json: async () => structuredClone(hostState) };
      if (url.endsWith('/start') || url.endsWith('/attach')) {
        hostState = { ...hostState, canStart: false, binding: { sessionId: 'new', campaignId: 'save-1', readOnly: false }, campaign: campaign() };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(definition.id, 'dsh-tavern-adventure');
  const required = [];
  const plugin = definition.factory((id) => { required.push(id); return id === 'react' ? React : { Modal: 'modal' }; });
  await plugin.apply({ get(name) { assert.equal(name, 'slots'); return { inject(_name, fn) { fn(); }, register(options, component) { registrations.set(options.id, { options, component }); return () => {}; } }; }, effect(fn) { cleanups.push(fn()); } });
  function instance(component, props = {}) {
    const owner = { state: [], effects: [], index: 0, queue: [] };
    return {
      render(next = props) {
        props = next; owner.index = 0; owner.queue = []; current = owner;
        const tree = component(props);
        current = undefined; owner.queue.forEach((fn) => fn());
        return tree;
      },
      unmount() { owner.effects.forEach((effect) => effect.cleanup && effect.cleanup()); }
    };
  }
  return { required, registrations, records, styles, intervals, windowEvents, documentEvents,
    instance, component(id) { return registrations.get(id).component; }, setState(value) { hostState = value; },
    dispose() { cleanups.forEach((fn) => fn && fn()); }
  };
}

async function openPicker(env) {
  const props = { sessionId: 'new', useSession: (selector) => selector({ blank: true, promptAttempted: false }) };
  const chip = env.instance(env.component('dsh-tavern-chip'), props);
  chip.render(); await settle();
  button(chip.render(), '◇地城冒险⌄').props.onClick(); await settle();
  const overlay = env.instance(env.component('dsh-tavern-panel'));
  let panel = overlay.render(); await settle(); panel = overlay.render();
  const pickerNode = named(panel, 'Picker');
  const picker = env.instance(pickerNode.type, pickerNode.props);
  return { chip, props, overlay, picker, pickerNode };
}

test('registers native slots, injects only scoped styles, cleans all lifecycle effects', async () => {
  const env = await harness();
  assert.deepEqual(env.required, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.deepEqual([...env.registrations.values()].map((r) => r.options.name), ['settings.section', 'shell.overlay', 'conversation.input.left', 'conversation.session.header.utilities']);
  assert.equal(env.styles.length, 1);
  assert.equal(env.windowEvents.has('dsh-tavern:changed'), true);
  assert.equal(env.intervals.size, 1);
  env.dispose();
  assert.equal(env.styles[0].removed, true);
  assert.equal(env.windowEvents.size, 0);
  assert.equal(env.documentEvents.size, 0);
  assert.equal(env.intervals.size, 0);
});

test('entry uses actual blank hook, never offers old normal sessions a picker', async () => {
  const env = await harness();
  const chip = env.instance(env.component('dsh-tavern-chip'));
  assert.equal(chip.render({ sessionId: 'old', useSession: (select) => select({ blank: true, promptAttempted: true }) }), null);
  await settle();
  assert.equal(chip.render({ sessionId: 'old', useSession: (select) => select({ blank: false, promptAttempted: false }) }), null);
  assert.equal(chip.render({ sessionId: 'old', session: { blank: true, promptAttempted: false } }).type, 'button');
  env.dispose();
});

test('script must be chosen before save controls; server canStart remains authoritative', async () => {
  const env = await harness({ ...base(), canStart: false });
  const { picker } = await openPicker(env);
  let tree = picker.render();
  assert.equal(button(tree, '创建并永久绑定'), undefined);
  assert.equal(button(tree, '选择此剧本').props.disabled, true);
  assert.equal(button(tree, '下一步：选择存档').props.disabled, true);
  assert.match(text(tree), /宿主状态为最终依据/);
  env.dispose();
});

test('new adventure revalidates live blank before POST and rejects a raced first prompt', async () => {
  const env = await harness();
  const { picker, chip, props } = await openPicker(env);
  let tree = picker.render(); button(tree, '选择此剧本').props.onClick();
  tree = picker.render(); button(tree, '下一步：选择存档').props.onClick();
  tree = picker.render();
  chip.render({ ...props, useSession: (select) => select({ blank: true, promptAttempted: true }) });
  await button(tree, '创建并永久绑定').props.onClick(); await settle();
  assert.equal(env.records.filter((r) => r.options.method === 'POST').length, 0);
  env.dispose();
});

test('takeover requires explicit checkbox and sends one writer takeover request', async () => {
  const state = base();
  state.campaigns = [{ id: 'save-1', scriptId: 'mist', scriptKey: 'mist@1', title: '旧旅程', ownerSessionId: 'old', updatedAt: Date.now(), sceneId: 'gate' }];
  const env = await harness(state);
  const { picker, overlay } = await openPicker(env);
  let tree = picker.render(); button(tree, '选择此剧本').props.onClick();
  tree = picker.render(); button(tree, '下一步：选择存档').props.onClick();
  tree = picker.render(); button(tree, '接续到此会话…').props.onClick();
  tree = picker.render();
  assert.match(text(tree), /原所属会话将永久失去推进权限/);
  assert.equal(button(tree, '确认接管并绑定').props.disabled, true);
  nodes(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
  tree = picker.render(); await button(tree, '确认接管并绑定').props.onClick(); await settle();
  const posts = env.records.filter((r) => r.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/tavern/api/attach');
  assert.deepEqual(posts[0].body, { sessionId: 'new', campaignId: 'save-1', takeover: true });
  assert.ok(named(overlay.render(), 'GamePanel'));
  env.dispose();
});

test('read-only game never offers pause, normal mode, or save switching', async () => {
  const state = { ...base(), canStart: false, binding: { sessionId: 'old', campaignId: 'save-1', readOnly: true }, campaign: campaign() };
  const env = await harness(state);
  const chip = env.instance(env.component('dsh-tavern-chip'), { sessionId: 'old', session: { blank: false } });
  chip.render(); await settle();
  const chipTree = chip.render(); assert.match(text(chipTree), /已在其他会话接续/); chipTree.props.onClick(); await settle();
  const overlay = env.instance(env.component('dsh-tavern-panel')); const tree = overlay.render();
  assert.equal(named(tree, 'Picker'), undefined);
  const gameNode = named(tree, 'GamePanel');
  const game = env.instance(gameNode.type, gameNode.props).render();
  assert.match(text(game), /已在其他会话接续/);
  assert.equal(button(game, '暂停冒险'), undefined);
  assert.equal(nodes(game, (n) => n.type === 'button').length, 0);
  assert.match(text(game), /你站在门前/);
  assert.equal(nodes(game, (n) => n.props.dangerouslySetInnerHTML).length, 0);
  env.dispose();
});

test('manager blocks deleting used versions and requires explicit deletion confirmation', async () => {
  const state = base();
  state.scripts.push({ ...script, id: 'unused', key: 'unused@1', title: '无人之境' });
  state.campaigns.push({ id: 'save-1', scriptId: 'mist', scriptKey: 'mist@1' });
  const env = await harness(state);
  const settings = env.instance(env.component('dsh-tavern')); settings.render(); await settle();
  const node = named(settings.render(), 'ScriptManager');
  const manager = env.instance(node.type, node.props);
  let tree = manager.render();
  const deletes = nodes(tree, (n) => n.type === 'button' && text(n) === '删除');
  assert.equal(deletes[0].props.disabled, true);
  assert.equal(deletes[1].props.disabled, false);
  deletes[1].props.onClick(); tree = manager.render();
  assert.equal(button(tree, '确认永久删除').props.disabled, true);
  const boxes = nodes(tree, (n) => n.type === 'input' && n.props.type === 'checkbox');
  boxes.at(-1).props.onChange({ target: { checked: true } });
  tree = manager.render(); await button(tree, '确认永久删除').props.onClick(); await settle();
  assert.deepEqual(env.records.find((r) => r.url.endsWith('/delete-script')).body, { scriptKey: 'unused@1' });
  env.dispose();
});

test('invalid ZIP import stays local and surfaces a useful error', async () => {
  const env = await harness();
  const settings = env.instance(env.component('dsh-tavern')); settings.render(); await settle();
  const node = named(settings.render(), 'ScriptManager');
  const manager = env.instance(node.type, node.props);
  const tree = manager.render();
  nodes(tree, (n) => n.type === 'input' && n.props.type === 'file')[0].props.onChange({ target: { files: [{ name: 'oops.zip', size: 4, arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer }], value: 'oops.zip' } });
  await settle();
  assert.equal(env.records.some((r) => r.options.method === 'POST'), false);
  const statusNode = named(settings.render(), 'Status');
  assert.match(text(env.instance(statusNode.type, statusNode.props).render()), /不是有效的 ZIP/);
  env.dispose();
});

test('oversized ZIP is rejected before reading bytes or calling import API', async () => {
  const env = await harness();
  const settings = env.instance(env.component('dsh-tavern')); settings.render(); await settle();
  const node = named(settings.render(), 'ScriptManager');
  const manager = env.instance(node.type, node.props);
  let read = false;
  nodes(manager.render(), (n) => n.type === 'input' && n.props.type === 'file')[0].props.onChange({ target: { files: [{ name: 'large.zip', size: 5 * 1024 * 1024 + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } }], value: '' } });
  await settle();
  assert.equal(read, false);
  assert.equal(env.records.some((r) => r.options.method === 'POST'), false);
  const statusNode = named(settings.render(), 'Status');
  assert.match(text(env.instance(statusNode.type, statusNode.props).render()), /5 MiB/);
  env.dispose();
});

test('game projection never renders unexpected DM or NPC secrets and only uses slot sessionId', async () => {
  const publicCampaign = campaign();
  publicCampaign.dm = { secrets: 'DM_HIDDEN_SECRET' };
  publicCampaign.npcs = { a: { memory: 'NPC_PRIVATE_MEMORY' } };
  publicCampaign.party[0].secrets = 'PARTY_PRIVATE_SECRET';
  publicCampaign.party[0].condition = ['受伤'];
  publicCampaign.party[0].lastAction = { sceneId: 'gate', kind: 'risk_rescue', text: '甲冒险掩护旅人。', reason: 'PRIVATE_REASON' };
  publicCampaign.party[1].lastAction = { sceneId: 'old-scene', text: 'STALE_ACTION_TEXT' };
  const state = { ...base(), canStart: false, binding: { sessionId: 'new', campaignId: 'save-1', readOnly: false }, campaign: publicCampaign };
  const env = await harness(state);
  const absentId = env.instance(env.component('dsh-tavern-chip'), { session: { id: 'invented', blank: true } });
  assert.equal(absentId.render(), null);
  assert.equal(env.records.length, 0);
  const chip = env.instance(env.component('dsh-tavern-chip'), { sessionId: 'new', useSession: (select) => select({ blank: false, id: 'ignore-this' }) });
  chip.render(); await settle(); chip.render().props.onClick(); await settle();
  const overlay = env.instance(env.component('dsh-tavern-panel'));
  const gameNode = named(overlay.render(), 'GamePanel');
  const tree = env.instance(gameNode.type, gameNode.props).render();
  assert.doesNotMatch(text(tree), /DM_HIDDEN_SECRET|NPC_PRIVATE_MEMORY|PARTY_PRIVATE_SECRET|PRIVATE_REASON|STALE_ACTION_TEXT/);
  assert.match(text(tree), /旅人/);
  assert.match(text(tree), /自主行动：甲冒险掩护旅人/);
  assert.match(text(tree), /受伤/);
  assert.equal(nodes(tree, (n) => n.props.dangerouslySetInnerHTML).length, 0);
  assert.equal(env.records.every((r) => r.url.startsWith('/tavern/api/')), true);
  assert.equal(env.records.some((r) => r.url.includes('ignore-this') || r.url.includes('invented')), false);
  env.dispose();
});

test('window changes refresh mounted data; interval polls panels only and pauses when unmounted', async () => {
  const env = await harness();
  const chip = env.instance(env.component('dsh-tavern-chip'), { sessionId: 'new', session: { blank: true } });
  chip.render(); await settle();
  const initial = env.records.length;
  [...env.intervals.values()][0](); await settle(); assert.equal(env.records.length, initial);
  env.windowEvents.get('dsh-tavern:changed')(); await settle(); assert.equal(env.records.length, initial + 1);
  chip.unmount();
  env.windowEvents.get('dsh-tavern:changed')(); await settle(); assert.equal(env.records.length, initial + 1);
  env.dispose();
});
