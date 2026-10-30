import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { zipSync } from 'fflate';
import { createStore, parseArchive } from '../lib/store.js';
import { IMPORT_LIMITS } from '../lib/core.js';

const builtin = fileURLToPath(new URL('./fixtures/graystone/', import.meta.url));
const cultivation = { createExternalState: ({ initialState }) => structuredClone(initialState) };
const key = 'graystone-mine@1.0.0';
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-store-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('dsh-tavern-store-test-')); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function storeFor(t, adapter = cultivation) {
  const dir = await temporary(t);
  const store = await createStore({ dir, cultivation: adapter });
  t.after(() => store.close());
  return { store, dir };
}
async function files() {
  return Object.fromEntries(await Promise.all(['manifest.yaml', 'adventure.yaml', 'characters/warrior.yaml', 'characters/ranger.yaml', 'characters/cleric.yaml'].map(async (name) => [name, new Uint8Array(await fs.readFile(path.join(builtin, name)))])));
}
const zip = (entries) => Buffer.from(zipSync(entries));
function deferred() { let resolve; const promise = new Promise((r) => resolve = r); return { promise, resolve }; }

test('builtin and ZIP imports share a stable hash; duplicates harmless; conflicting version rejected atomically', async (t) => {
  const { store } = await storeFor(t);
  const first = await store.importDirectory(builtin);
  assert.equal(first.scriptKey, key);
  assert.equal(first.characterCount, 3);
  assert.deepEqual(await store.importArchive(zip(await files())), first);
  const changed = await files();
  changed['adventure.yaml'] = Buffer.from(Buffer.from(changed['adventure.yaml']).toString().replace('灰石守夜人', '另一个主持人'));
  await assert.rejects(store.importArchive(zip(changed)), { code: 'VERSION_CONFLICT' });
  assert.equal((await store.listScripts()).length, 1);
  assert.equal(JSON.stringify(await store.listScripts()).includes('PRIVATE_'), false);
});

test('bad references, unsupported entries and YAML pollution leave no partial import', async (t) => {
  const { store } = await storeFor(t);
  for (const mutate of [
    (entries) => delete entries['characters/warrior.yaml'],
    (entries) => entries['run.sh'] = Buffer.from('echo bad'),
    (entries) => entries['manifest.yaml'] = Buffer.from('__proto__: { polluted: true }'),
    (entries) => entries['characters/warrior.yaml'] = Buffer.from('id: a\nid: b'),
    (entries) => entries['characters/warrior.yaml'] = Buffer.from('a: &a [*a]'),
  ]) {
    const entries = await files(); mutate(entries);
    await assert.rejects(store.importArchive(zip(entries)));
    assert.deepEqual(await store.listScripts({ includeArchived: true }), []);
  }
  assert.equal({}.polluted, undefined);
});

test('ZIP traversal, absolute paths, duplicates, symlinks and size bombs rejected before import', async () => {
  for (const name of ['../manifest.yaml', '/manifest.yaml', 'C:/manifest.yaml', 'C:\\manifest.yaml']) assert.throws(() => parseArchive(zip({ [name]: Buffer.from('x') })), { code: 'INVALID_ARCHIVE' });
  const duplicate = zip({ 'aa.yaml': Buffer.from('a'), 'bb.yaml': Buffer.from('b') });
  for (let offset = duplicate.indexOf('bb.yaml'); offset !== -1; offset = duplicate.indexOf('bb.yaml', offset + 7)) duplicate.write('aa.yaml', offset);
  assert.throws(() => parseArchive(duplicate), /Duplicate/);
  const symlink = zip({ 'manifest.yaml': Buffer.from('target') });
  const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  symlink.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => parseArchive(symlink), /Symlinks/);
  const bomb = zip({ 'manifest.yaml': Buffer.from('x') });
  const bombCentral = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(IMPORT_LIMITS.entryBytes + 1, bombCentral + 24);
  assert.throws(() => parseArchive(bomb), { code: 'ARCHIVE_LIMIT' });
  assert.throws(() => parseArchive(Buffer.alloc(IMPORT_LIMITS.archiveBytes + 1)), { code: 'ARCHIVE_LIMIT' });
  assert.throws(() => parseArchive(zip(Object.fromEntries(Array.from({ length: IMPORT_LIMITS.entries + 1 }, (_, i) => [`${i}.yaml`, Buffer.from('x')])))), { code: 'ARCHIVE_LIMIT' });
});

test('forged expanded sizes and CRC corruption are rejected before content parsing', () => {
  const forged = zip({ 'manifest.yaml': Buffer.alloc(300000, 65) });
  const directory = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  forged.writeUInt32LE(1, directory + 24);
  assert.throws(() => parseArchive(forged), { code: 'ARCHIVE_LIMIT' });
  const corrupted = zip({ 'manifest.yaml': Buffer.from('hello') });
  const central = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupted.writeUInt32LE(0, central + 16);
  assert.throws(() => parseArchive(corrupted), /CRC/);
});

test('builtin import rejects symlink content and never follows it', async (t) => {
  const { store } = await storeFor(t);
  const directory = await temporary(t);
  await fs.symlink(path.join(builtin, 'manifest.yaml'), path.join(directory, 'manifest.yaml'));
  await assert.rejects(store.importDirectory(directory), /symlinks/);
});

test('campaign snapshot and local NPC states are independent and publicly redacted', async (t) => {
  const { store } = await storeFor(t);
  await store.importDirectory(builtin);
  const first = await store.createCampaign({ scriptKey: key, sessionId: 's1', title: 'First' });
  const second = await store.createCampaign({ scriptKey: key, sessionId: 's2' });
  await store.withCampaign('s1', (game) => { game.state.npcs.bran.intimacy = 70; game.state.npcs.bran.memory.push('NEW_PRIVATE_MEMORY'); game.state.turnIndex++; });
  assert.equal((await store.getCampaign(first.id)).state.npcs.bran.intimacy, 70);
  assert.equal((await store.getCampaign(second.id)).state.npcs.bran.intimacy, 12);
  const internal = await store.getCampaign(first.id);
  internal.state.player.hp = 0; internal.snapshot.adventure.dm.name = 'changed';
  assert.equal((await store.getCampaign(first.id)).state.player.hp, 24);
  assert.equal((await store.getCampaign(first.id)).snapshot.adventure.dm.name, '灰石守夜人');
  for (const view of [await store.getPublicCampaign(first.id), await store.listCampaigns(), await store.listScripts()]) {
    const serialized = JSON.stringify(view);
    for (const secret of ['PRIVATE_', 'initialState', 'privateHistory', 'intimacy', 'npcKnowledge']) assert.equal(serialized.includes(secret), false, secret);
  }
  const v2 = await files();
  v2['manifest.yaml'] = Buffer.from(Buffer.from(v2['manifest.yaml']).toString().replace('version: 1.0.0', 'version: 1.1.0'));
  v2['adventure.yaml'] = Buffer.from(Buffer.from(v2['adventure.yaml']).toString().replace('灰石守夜人', '新版主持人'));
  await store.importArchive(zip(v2));
  assert.equal((await store.getCampaign(first.id)).snapshot.adventure.dm.name, '灰石守夜人');
});

test('takeover is explicit, single-owner and makes every old binding permanently read-only', async (t) => {
  const { store } = await storeFor(t);
  await store.importDirectory(builtin);
  const game = await store.createCampaign({ scriptKey: key, sessionId: 'old' });
  await assert.rejects(store.attachCampaign({ campaignId: game.id, sessionId: 'new' }), { code: 'TAKEOVER_REQUIRED' });
  await store.attachCampaign({ campaignId: game.id, sessionId: 'new', takeover: true });
  assert.equal((await store.getBinding('old')).readOnly, true);
  await assert.rejects(store.withCampaign('old', () => {}), { code: 'READ_ONLY' });
  await assert.rejects(store.createCampaign({ scriptKey: key, sessionId: 'old' }), { code: 'SESSION_ALREADY_BOUND' });
  await store.attachCampaign({ campaignId: game.id, sessionId: 'third', takeover: true });
  await assert.rejects(store.attachCampaign({ campaignId: game.id, sessionId: 'old', takeover: true }), { code: 'SESSION_ALREADY_BOUND' });
  const bindings = await store.listBindings();
  assert.equal(bindings.length, 3);
  assert.equal(bindings.filter((binding) => !binding.readOnly).length, 1);
  bindings[0].readOnly = false;
  assert.equal((await store.getBinding('old')).readOnly, true);
});

test('busy reservation precedes awaits: reject competing turns, takeover, and close', async (t) => {
  const { store } = await storeFor(t);
  await store.importDirectory(builtin);
  const game = await store.createCampaign({ scriptKey: key, sessionId: 's1' });
  const gate = deferred();
  const turn = store.withCampaign('s1', async (campaign) => { await gate.promise; campaign.state.player.hp = 20; return { ok: true }; });
  assert.equal(store.isBusy(game.id), true);
  await assert.rejects(store.withCampaign('s1', () => {}), { code: 'CAMPAIGN_BUSY' });
  await assert.rejects(store.attachCampaign({ campaignId: game.id, sessionId: 's2', takeover: true }), { code: 'CAMPAIGN_BUSY' });
  await assert.rejects(store.close(), { code: 'STORE_BUSY' });
  gate.resolve();
  assert.deepEqual(await turn, { ok: true });
  assert.equal(store.isBusy(game.id), false);
  await store.attachCampaign({ campaignId: game.id, sessionId: 's2', takeover: true });
});

test('callback failures, invalid changes and retained drafts do not mutate durable state', async (t) => {
  const { store } = await storeFor(t);
  await store.importDirectory(builtin);
  const game = await store.createCampaign({ scriptKey: key, sessionId: 's1' });
  await assert.rejects(store.withCampaign('s1', (campaign) => { campaign.state.player.hp = 1; throw new Error('failed turn'); }), /failed turn/);
  await assert.rejects(store.withCampaign('s1', (campaign) => { campaign.ownerSessionId = 'attacker'; }), { code: 'IMMUTABLE_CAMPAIGN' });
  await assert.rejects(store.withCampaign('s1', (campaign) => { campaign.state.player.hp = -1; }), { code: 'INVALID_CAMPAIGN' });
  assert.equal((await store.getCampaign(game.id)).state.player.hp, 24);
  let retained;
  const result = await store.withCampaign('s1', (campaign) => { retained = campaign; return campaign.state.player; });
  retained.state.player.hp = 0; result.hp = 0;
  assert.equal((await store.getCampaign(game.id)).state.player.hp, 24);
});

test('failed disk commit rolls back live state and clears turn busy flag', async (t) => {
  const { store, dir } = await storeFor(t);
  await store.importDirectory(builtin);
  const game = await store.createCampaign({ scriptKey: key, sessionId: 's1' });
  const target = path.join(dir, 'state.json');
  const backup = path.join(dir, 'saved-state.json');
  assert.equal(path.dirname(target), dir); assert.equal(path.dirname(backup), dir);
  await fs.rename(target, backup);
  await fs.mkdir(target);
  try { await assert.rejects(store.withCampaign('s1', (campaign) => { campaign.state.player.hp = 2; }), { code: 'STATE_WRITE_FAILED' }); }
  finally { await fs.rmdir(target); await fs.rename(backup, target); }
  assert.equal((await store.getCampaign(game.id)).state.player.hp, 24);
  assert.equal(store.isBusy(game.id), false);
  await store.withCampaign('s1', (campaign) => { campaign.state.player.hp = 23; });
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).campaigns[game.id].state.player.hp, 23);
});

test('concurrent independent commits serialize without lost updates', async (t) => {
  const { store } = await storeFor(t);
  await store.importDirectory(builtin);
  const [a, b] = await Promise.all(['s1', 's2'].map((sessionId) => store.createCampaign({ scriptKey: key, sessionId })));
  await Promise.all(['s1', 's2'].map((sessionId) => store.withCampaign(sessionId, async (campaign) => { campaign.state.player.hp = 17; })));
  assert.equal((await store.getCampaign(a.id)).state.player.hp, 17);
  assert.equal((await store.getCampaign(b.id)).state.player.hp, 17);
});

test('session reservation and failing cultivation initialize no partial campaign or binding', async (t) => {
  const gate = deferred();
  let calls = 0;
  const { store } = await storeFor(t, { createExternalState: async ({ initialState }) => { calls++; if (calls === 1) await gate.promise; return initialState; } });
  await store.importDirectory(builtin);
  const pending = store.createCampaign({ scriptKey: key, sessionId: 's1' });
  await assert.rejects(store.createCampaign({ scriptKey: key, sessionId: 's1' }), { code: 'SESSION_ALREADY_BOUND' });
  gate.resolve(); await pending;
  const broken = await storeFor(t, { createExternalState: () => { throw new Error('service unavailable'); } });
  await broken.store.importDirectory(builtin);
  await assert.rejects(broken.store.createCampaign({ scriptKey: key, sessionId: 's1' }), /service unavailable/);
  assert.deepEqual(await broken.store.listCampaigns(), []);
  assert.equal(await broken.store.getBinding('s1'), null);
});

test('archived scripts cannot create games but saves remain resumable; referenced delete refused', async (t) => {
  const { store } = await storeFor(t);
  await store.importDirectory(builtin);
  const game = await store.createCampaign({ scriptKey: key, sessionId: 's1' });
  await store.setArchived(key, true);
  assert.deepEqual(await store.listScripts(), []);
  assert.equal((await store.listScripts({ includeArchived: true }))[0].archived, true);
  await assert.rejects(store.createCampaign({ scriptKey: key, sessionId: 's2' }), { code: 'SCRIPT_ARCHIVED' });
  await store.attachCampaign({ campaignId: game.id, sessionId: 's2', takeover: true });
  await assert.rejects(store.deleteScript(key), { code: 'SCRIPT_REFERENCED' });
  await store.setArchived(key, false);
  const other = await files();
  other['manifest.yaml'] = Buffer.from(Buffer.from(other['manifest.yaml']).toString().replace('version: 1.0.0', 'version: 2.0.0'));
  await store.importArchive(zip(other));
  await store.deleteScript('graystone-mine@2.0.0');
  assert.equal((await store.listScripts()).length, 1);
});

test('reopening restores exact runtime, snapshot and permanent binding history', async (t) => {
  const { store, dir } = await storeFor(t);
  await store.importDirectory(builtin);
  const game = await store.createCampaign({ scriptKey: key, sessionId: 's1' });
  await store.withCampaign('s1', (campaign) => { campaign.state.npcs.lyra.knows.playerTrustworthy = true; campaign.state.turnIndex = 4; campaign.state.status = 'paused'; });
  await store.attachCampaign({ campaignId: game.id, sessionId: 's2', takeover: true });
  const before = await store.getCampaign(game.id);
  await store.close();
  const reopened = await createStore({ dir, cultivation });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.getCampaign(game.id), before);
  assert.equal((await reopened.getBinding('s1')).readOnly, true);
  assert.equal((await reopened.getBinding('s2')).readOnly, false);
});

test('missing or corrupt state is surfaced without overwriting it', async (t) => {
  const { store, dir } = await storeFor(t);
  await store.close();
  const target = path.join(dir, 'state.json');
  await fs.writeFile(target, '{broken-json');
  await assert.rejects(createStore({ dir, cultivation }), { code: 'STATE_CORRUPT' });
  assert.equal(await fs.readFile(target, 'utf8'), '{broken-json');
  assert.equal(path.dirname(target), dir);
  await fs.unlink(target);
  await assert.rejects(createStore({ dir, cultivation }), { code: 'STATE_MISSING' });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('state symlinks are rejected, live process locks cannot be stolen', async (t) => {
  const { store, dir } = await storeFor(t);
  await assert.rejects(createStore({ dir, cultivation }), { code: 'STORE_LOCKED' });
  await store.close();
  const target = path.join(dir, 'state.json');
  const backup = path.join(dir, 'saved.json');
  assert.equal(path.dirname(target), dir); assert.equal(path.dirname(backup), dir);
  await fs.rename(target, backup);
  await fs.symlink(backup, target);
  await assert.rejects(createStore({ dir, cultivation }), { code: 'STATE_CORRUPT' });
});

test('killed process lock recovers automatically without losing campaign data', { timeout: 15000 }, async (t) => {
  const dir = await temporary(t);
  const storeUrl = new URL('../lib/store.js', import.meta.url).href;
  const code = `import {createStore} from ${JSON.stringify(storeUrl)}; const s=await createStore({dir:${JSON.stringify(dir)}, cultivation:{createExternalState:({initialState})=>initialState}}); await s.importDirectory(${JSON.stringify(builtin)}); const c=await s.createCampaign({scriptKey:${JSON.stringify(key)},sessionId:'crashed'}); await s.withCampaign('crashed',c=>{c.state.player.hp=11;c.state.turnIndex=7}); console.log('READY:'+c.id); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (data) => stderr += data);
  const campaignId = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (data) => { output += data; const match = /READY:([^\s]+)/.exec(output); if (match) resolve(match[1]); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Child exited before ready (${code}): ${stderr}`)));
  });
  child.kill('SIGKILL');
  await once(child, 'exit');
  const contenders = await Promise.allSettled([createStore({ dir, cultivation }), createStore({ dir, cultivation })]);
  assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
  for (const rejected of contenders.filter((result) => result.status === 'rejected')) assert.equal(rejected.reason.code, 'STORE_LOCKED');
  const store = contenders.find((result) => result.status === 'fulfilled').value;
  t.after(() => store.close());
  const restored = await store.getCampaign(campaignId);
  assert.equal(restored.state.player.hp, 11);
  assert.equal(restored.state.turnIndex, 7);
  assert.equal((await store.getBinding('crashed')).readOnly, false);
  await store.attachCampaign({ campaignId, sessionId: 'resumed', takeover: true });
  assert.equal((await store.getBinding('crashed')).readOnly, true);
});
