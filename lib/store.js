import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inflate } from 'fflate';
import { parseDocument } from 'yaml';
import { IMPORT_LIMITS, cloneJson, canonicalJson, contentHash, domainError, initialCampaignState, isRecord, publicCampaign, publicScript, validateContentPath, validateId, validateScript } from './core.js';

const MANIFEST_NAMES = ['manifest.yaml', 'manifest.yml', 'manifest.json'];
const TEXT_EXTENSION = /\.(ya?ml|json)$/i;
const ASSET_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const time = () => new Date().toISOString();
function assert(condition, code, message) { if (!condition) throw domainError(code, message); }
function owned(map, key) { return Object.hasOwn(map, key) ? map[key] : undefined; }
function validSessionId(id) { assert(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id), 'INVALID_SESSION', 'A safe, nonempty session id is required'); }
function parseText(bytes, filename) {
  assert(bytes.byteLength <= IMPORT_LIMITS.entryBytes, 'ARCHIVE_LIMIT', 'Content entry is too large');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw domainError('INVALID_SCRIPT', `${filename} is not UTF-8`); }
  try {
    if (/\.json$/i.test(filename)) return cloneJson(JSON.parse(text));
    const document = parseDocument(text, { uniqueKeys: true, schema: 'core', customTags: [] });
    assert(document.errors.length === 0, 'INVALID_SCRIPT', `Invalid YAML in ${filename}: ${document.errors[0]?.message ?? ''}`);
    return cloneJson(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (error.code) throw error;
    throw domainError('INVALID_SCRIPT', `Could not parse ${filename}: ${error.message}`);
  }
}
function filesToSnapshot(files) {
  const manifests = MANIFEST_NAMES.filter((name) => files.has(name));
  assert(manifests.length === 1, 'INVALID_SCRIPT', 'Provide exactly one root manifest.yaml, manifest.yml or manifest.json');
  const manifest = parseText(files.get(manifests[0]), manifests[0]);
  assert(isRecord(manifest), 'INVALID_SCRIPT', 'Manifest must be an object');
  assert(typeof manifest.adventure === 'string' && Array.isArray(manifest.characters), 'INVALID_SCRIPT', 'Manifest must reference adventure and character files');
  const sourcePaths = [manifest.adventure, ...manifest.characters];
  const documents = sourcePaths.map((name) => {
    validateContentPath(name);
    assert(TEXT_EXTENSION.test(name) && !MANIFEST_NAMES.includes(name), 'INVALID_SCRIPT', 'Definitions must reference YAML or JSON content files');
    assert(files.has(name), 'INVALID_SCRIPT', `Missing referenced file: ${name}`);
    return parseText(files.get(name), name);
  });
  assert(new Set(sourcePaths).size === sourcePaths.length, 'INVALID_SCRIPT', 'Definition source paths must be distinct');
  const used = new Set([manifests[0], ...sourcePaths]);
  const assets = {};
  for (const [name, bytes] of files) {
    if (used.has(name)) continue;
    const extension = name.split('.').at(-1).toLowerCase();
    assert(name.startsWith('assets/') && ASSET_TYPES[extension], 'UNSUPPORTED_CONTENT', `Unsupported or unreferenced content: ${name}`);
    assets[name] = { mediaType: ASSET_TYPES[extension], data: Buffer.from(bytes).toString('base64') };
  }
  return validateScript({ manifest, adventure: documents[0], characters: documents.slice(1), assets });
}
/** Check the ZIP central directory before fflate can allocate or collapse duplicate names. */
function inspectZip(input) {
  assert(Buffer.isBuffer(input) || input instanceof Uint8Array, 'INVALID_ARCHIVE', 'Archive must be a Buffer or Uint8Array');
  const bytes = Buffer.from(input);
  assert(bytes.length <= IMPORT_LIMITS.archiveBytes, 'ARCHIVE_LIMIT', 'Compressed archive exceeds limit');
  assert(bytes.length >= 22, 'INVALID_ARCHIVE', 'ZIP is truncated');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  assert(end >= 0, 'INVALID_ARCHIVE', 'ZIP end record is missing');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  assert(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count, 'INVALID_ARCHIVE', 'Multi-disk ZIP archives are unsupported');
  assert(count > 0 && count <= IMPORT_LIMITS.entries, 'ARCHIVE_LIMIT', 'Too many archive entries');
  assert(directoryOffset + directorySize === end, 'INVALID_ARCHIVE', 'Invalid or unsupported ZIP directory');
  const names = new Set();
  const entries = [];
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    assert(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, 'INVALID_ARCHIVE', 'Invalid ZIP central entry');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    assert(next <= end, 'INVALID_ARCHIVE', 'ZIP entry is truncated');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength)); } catch { throw domainError('INVALID_ARCHIVE', 'ZIP entry paths must be UTF-8'); }
    validateContentPath(name);
    const canonicalName = name.endsWith('/') ? name.slice(0, -1) : name;
    assert(!names.has(canonicalName), 'INVALID_ARCHIVE', 'Duplicate ZIP entry path');
    names.add(canonicalName);
    assert((flags & ~0x080e) === 0 && (method === 0 || method === 8), 'INVALID_ARCHIVE', 'Encrypted or unsupported ZIP compression/flags');
    const type = (attributes >>> 16) & 0xf000;
    assert(type !== 0xa000 && (type === 0 || type === 0x8000 || type === 0x4000), 'INVALID_ARCHIVE', 'Symlinks and special archive entries are unsupported');
    assert(size <= IMPORT_LIMITS.entryBytes && compressedSize <= IMPORT_LIMITS.archiveBytes, 'ARCHIVE_LIMIT', 'Archive entry exceeds limit');
    total += size;
    assert(total <= IMPORT_LIMITS.totalBytes, 'ARCHIVE_LIMIT', 'Expanded archive exceeds limit');
    assert(localOffset + 30 <= directoryOffset && bytes.readUInt32LE(localOffset) === 0x04034b50, 'INVALID_ARCHIVE', 'Invalid local ZIP entry');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assert(dataOffset + compressedSize <= directoryOffset, 'INVALID_ARCHIVE', 'ZIP data overlaps directory');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    assert(rawName.equals(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) && bytes.readUInt16LE(localOffset + 8) === method && bytes.readUInt16LE(localOffset + 6) === flags, 'INVALID_ARCHIVE', 'ZIP local and central entries disagree');
    assert(!name.endsWith('/') || size === 0, 'INVALID_ARCHIVE', 'Directory entry contains data');
    entries.push({ name, size, checksum, method, localOffset, dataOffset, dataEnd: dataOffset + compressedSize });
    offset = next;
  }
  assert(offset === end, 'INVALID_ARCHIVE', 'ZIP directory size is inconsistent');
  const ranges = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < ranges.length; index++) assert(ranges[index].localOffset >= ranges[index - 1].dataEnd, 'INVALID_ARCHIVE', 'Overlapping ZIP entries');
  return { bytes, entries };
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function parseArchive(input) {
  const { bytes, entries } = inspectZip(input);
  const files = new Map();
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.dataOffset, entry.dataEnd);
    let expanded;
    try {
      if (entry.method === 0) expanded = compressed;
      else {
        // Stream small chunks so a forged expanded-size header cannot cause an
        // unbounded inflate allocation or CPU expansion before checking limits.
        const chunks = [];
        let size = 0;
        const inflater = new Inflate((chunk) => {
          size += chunk.length;
          assert(size <= entry.size && size <= IMPORT_LIMITS.entryBytes, 'ARCHIVE_LIMIT', 'Actual expanded entry exceeds declared size or limit');
          chunks.push(chunk);
        });
        for (let offset = 0; offset < compressed.length; offset += 1024) inflater.push(compressed.subarray(offset, offset + 1024), offset + 1024 >= compressed.length);
        expanded = Buffer.concat(chunks, size);
      }
    } catch (error) {
      if (error.code === 'ARCHIVE_LIMIT') throw error;
      throw domainError('INVALID_ARCHIVE', `Could not decompress ZIP: ${error.message}`);
    }
    assert(expanded.length === entry.size, 'INVALID_ARCHIVE', 'ZIP expanded size does not match directory');
    assert(crc32(expanded) === entry.checksum, 'INVALID_ARCHIVE', 'ZIP CRC checksum mismatch');
    if (!entry.name.endsWith('/')) files.set(entry.name, expanded);
  }
  return filesToSnapshot(files);
}
async function readDirectory(root) {
  const files = new Map();
  let count = 0;
  let total = 0;
  async function visit(relative = '') {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      validateContentPath(name);
      assert(!entry.isSymbolicLink(), 'INVALID_ARCHIVE', 'Builtin directories cannot contain symlinks');
      if (entry.isDirectory()) { await visit(name); continue; }
      assert(entry.isFile(), 'INVALID_ARCHIVE', 'Unsupported builtin filesystem entry');
      count++;
      assert(count <= IMPORT_LIMITS.entries, 'ARCHIVE_LIMIT', 'Too many builtin files');
      const absolute = path.join(root, name);
      const metadata = await fs.lstat(absolute);
      assert(metadata.isFile() && !metadata.isSymbolicLink(), 'INVALID_ARCHIVE', 'Builtin content changed while reading');
      assert(metadata.size <= IMPORT_LIMITS.entryBytes, 'ARCHIVE_LIMIT', 'Builtin entry exceeds limit');
      total += metadata.size;
      assert(total <= IMPORT_LIMITS.totalBytes, 'ARCHIVE_LIMIT', 'Builtin content exceeds limit');
      const bytes = await fs.readFile(absolute);
      assert(bytes.length === metadata.size, 'INVALID_ARCHIVE', 'Builtin content changed while reading');
      files.set(name, bytes);
    }
  }
  const metadata = await fs.lstat(root);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), 'INVALID_ARCHIVE', 'Builtin root must be a real directory');
  await visit();
  return filesToSnapshot(files);
}
function validateRuntime(campaign) {
  const state = campaign.state;
  assert(isRecord(state) && typeof state.sceneId === 'string' && campaign.snapshot.adventure.scenes.some((scene) => scene.id === state.sceneId), 'INVALID_CAMPAIGN', 'Campaign has an invalid current scene');
  assert(Number.isSafeInteger(state.turnIndex) && state.turnIndex >= 0 && ['active', 'paused', 'completed'].includes(state.status) && typeof state.completed === 'boolean' && isRecord(state.checks), 'INVALID_CAMPAIGN', 'Campaign turn index, checks or status is invalid');
  assert(Array.isArray(state.visited) && state.visited.every((id) => campaign.snapshot.adventure.scenes.some((scene) => scene.id === id)), 'INVALID_CAMPAIGN', 'Campaign has invalid visited scenes');
  assert(isRecord(state.flags) && isRecord(state.player) && isRecord(state.encounters) && Array.isArray(state.log) && isRecord(state.npcs), 'INVALID_CAMPAIGN', 'Campaign runtime state is malformed');
  assert(Number.isSafeInteger(state.player.hp) && state.player.hp >= 0 && Number.isSafeInteger(state.player.maxHp) && state.player.maxHp > 0 && state.player.hp <= state.player.maxHp, 'INVALID_CAMPAIGN', 'Campaign player HP is invalid');
  assert(Number.isSafeInteger(state.player.armorClass) && Number.isSafeInteger(state.player.attackBonus) && Number.isSafeInteger(state.player.damage) && state.player.damage > 0, 'INVALID_CAMPAIGN', 'Campaign combat statistics are invalid');
  assert(typeof state.player.id === 'string' && typeof state.player.name === 'string', 'INVALID_CAMPAIGN', 'Campaign player identity is invalid');
  for (const value of Object.values(state.flags)) assert(['string', 'boolean', 'number'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value)), 'INVALID_CAMPAIGN', 'Campaign flags must be primitive values');
  for (const [sceneId, enemy] of Object.entries(state.encounters)) {
    const config = campaign.snapshot.adventure.scenes.find((scene) => scene.id === sceneId)?.encounter;
    assert(config && isRecord(enemy) && enemy.id === config.id && enemy.name === config.name && Number.isSafeInteger(enemy.hp) && enemy.hp >= 0 && enemy.hp <= config.hp && enemy.defeated === (enemy.hp === 0), 'INVALID_CAMPAIGN', 'Campaign encounter state is invalid');
  }
  for (const [key, result] of Object.entries(state.checks)) {
    const scene = campaign.snapshot.adventure.scenes.find((item) => item.id === result?.sceneId);
    assert(isRecord(result) && scene?.checks?.some((check) => check.id === result.checkId) && key === `${result.sceneId}:${result.checkId}` && typeof result.success === 'boolean' && Number.isSafeInteger(result.roll) && result.roll >= 1 && result.roll <= 20, 'INVALID_CAMPAIGN', 'Campaign check state is invalid');
  }
  assert(Object.keys(state.npcs).length === campaign.snapshot.characters.length, 'INVALID_CAMPAIGN', 'Campaign has unexpected local NPC states');
  for (const character of campaign.snapshot.characters) assert(Object.hasOwn(state.npcs, character.id) && isRecord(state.npcs[character.id]), 'INVALID_CAMPAIGN', 'Campaign is missing local NPC state');
}
function validateDisk(input) {
  const state = cloneJson(input);
  assert(state.schemaVersion === 1 && isRecord(state.scripts) && isRecord(state.campaigns) && isRecord(state.bindings), 'STATE_CORRUPT', 'Unsupported or corrupt local state');
  for (const [key, record] of Object.entries(state.scripts)) {
    assert(isRecord(record) && typeof record.archived === 'boolean' && typeof record.importedAt === 'string', 'STATE_CORRUPT', 'Invalid script record');
    record.snapshot = validateScript(record.snapshot);
    assert(key === `${record.snapshot.manifest.id}@${record.snapshot.manifest.version}` && record.scriptKey === key && record.hash === contentHash(record.snapshot), 'STATE_CORRUPT', 'Script identity or hash mismatch');
  }
  for (const [id, campaign] of Object.entries(state.campaigns)) {
    validateId(id, 'campaign id');
    assert(isRecord(campaign) && campaign.id === id && typeof campaign.title === 'string' && typeof campaign.createdAt === 'string' && typeof campaign.updatedAt === 'string', 'STATE_CORRUPT', 'Invalid campaign record');
    campaign.snapshot = validateScript(campaign.snapshot);
    const manifest = campaign.snapshot.manifest;
    assert(campaign.scriptId === manifest.id && campaign.scriptVersion === manifest.version && campaign.scriptKey === `${manifest.id}@${manifest.version}` && owned(state.scripts, campaign.scriptKey), 'STATE_CORRUPT', 'Campaign script reference is invalid');
    assert(contentHash(campaign.snapshot) === state.scripts[campaign.scriptKey].hash, 'STATE_CORRUPT', 'Campaign snapshot differs from its imported version');
    validateRuntime(campaign);
    const binding = owned(state.bindings, campaign.ownerSessionId);
    assert(binding && binding.campaignId === id && binding.readOnly === false, 'STATE_CORRUPT', 'Campaign owner binding is invalid');
  }
  for (const [sessionId, binding] of Object.entries(state.bindings)) {
    validSessionId(sessionId);
    assert(isRecord(binding) && binding.sessionId === sessionId && typeof binding.readOnly === 'boolean' && typeof binding.boundAt === 'string', 'STATE_CORRUPT', 'Invalid session binding');
    const campaign = owned(state.campaigns, binding.campaignId);
    assert(campaign && (binding.readOnly || campaign.ownerSessionId === sessionId), 'STATE_CORRUPT', 'Binding references an invalid campaign or owner');
    assert(!binding.readOnly || campaign.ownerSessionId !== sessionId, 'STATE_CORRUPT', 'Read-only binding cannot own a campaign');
  }
  return state;
}

function pidDefinitelyDead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
async function acquireLock(lockPath, owner) {
  const create = async () => {
    const handle = await fs.open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(owner, 'utf8'); await handle.sync(); return handle; } catch (error) { await handle.close(); throw error; }
  };
  try { return await create(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const guardPath = `${lockPath}-recovery`;
  let guard;
  try { guard = await fs.open(guardPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw domainError('STORE_LOCKED', 'Store lock recovery is already in progress or was interrupted; inspect .lock-recovery');
    throw error;
  }
  try {
    await guard.writeFile(owner, 'utf8');
    const metadata = await fs.lstat(lockPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (metadata) {
      assert(metadata.isFile() && !metadata.isSymbolicLink(), 'STORE_LOCKED', 'Store lock is not a regular file');
      let previous;
      try { previous = JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch { throw domainError('STORE_LOCKED', 'Store lock owner is unknown; inspect .lock before recovery'); }
      assert(isRecord(previous) && typeof previous.nonce === 'string' && pidDefinitelyDead(previous.pid), 'STORE_LOCKED', 'This store is already open or its lock owner cannot be confirmed dead');
      // The recovery guard serializes stale-lock removals. New normal owners can only
      // acquire after this unlink; wx below then fails rather than displacing them.
      await fs.unlink(lockPath);
    }
    try { return await create(); } catch (error) { if (error.code === 'EEXIST') throw domainError('STORE_LOCKED', 'Another process acquired this store'); throw error; }
  } finally {
    await guard.close();
    await fs.unlink(guardPath);
  }
}

/** One exclusive store handle per directory. Confirmed dead PID locks recover without resetting state. */
export async function createStore({ dir, cultivation } = {}) {
  assert(typeof dir === 'string' && dir.trim(), 'INVALID_STORE', 'A storage directory is required');
  assert(cultivation && typeof cultivation.createExternalState === 'function', 'INVALID_CULTIVATION', 'cultivation.createExternalState is required');
  const root = path.resolve(dir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const statePath = path.join(root, 'state.json');
  const markerPath = path.join(root, '.initialized');
  const lockPath = path.join(root, '.lock');
  const lockOwner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const lock = await acquireLock(lockPath, lockOwner);
  let state;
  let closed = false;
  let queue = Promise.resolve();
  const busy = new Set();
  const reservedSessions = new Set();
  async function unlock() {
    await lock.close();
    const current = await fs.readFile(lockPath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (current === lockOwner) await fs.unlink(lockPath);
  }
  async function writeAtomic(next) {
    const temporary = path.join(root, `.state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, statePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw domainError('STATE_WRITE_FAILED', `Could not persist local state: ${error.message}`);
    }
  }
  try {
    let raw;
    try {
      const metadata = await fs.lstat(statePath);
      assert(metadata.isFile() && !metadata.isSymbolicLink(), 'STATE_CORRUPT', 'Local state.json must be a regular file, not a symlink');
      raw = await fs.readFile(statePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const existing = (await fs.readdir(root)).filter((name) => name !== '.lock' && name !== '.lock-recovery');
      assert(existing.length === 0, 'STATE_MISSING', 'Local state.json is missing from an initialized or nonempty storage directory');
    }
    if (raw !== undefined) {
      try { state = validateDisk(JSON.parse(raw)); } catch (error) { throw domainError('STATE_CORRUPT', `Local state.json is corrupt: ${error.message}`); }
    } else {
      state = { schemaVersion: 1, scripts: {}, campaigns: {}, bindings: {} };
      await writeAtomic(state);
    }
    try { await fs.writeFile(markerPath, 'dsh-tavern state schema 1\n', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } catch (error) { await unlock(); throw error; }
  function ensureOpen() { assert(!closed, 'STORE_CLOSED', 'Store has been closed'); }
  function getCampaignRecord(id) { const campaign = owned(state.campaigns, id); assert(campaign, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found'); return campaign; }
  function requireOwner(sessionId) {
    validSessionId(sessionId);
    const binding = owned(state.bindings, sessionId);
    assert(binding, 'SESSION_UNBOUND', 'This session has no campaign binding');
    const campaign = getCampaignRecord(binding.campaignId);
    assert(!binding.readOnly && campaign.ownerSessionId === sessionId, 'READ_ONLY', 'This session binding is permanently read-only');
    return campaign;
  }
  function reserveSession(sessionId) {
    validSessionId(sessionId);
    assert(!owned(state.bindings, sessionId) && !reservedSessions.has(sessionId), 'SESSION_ALREADY_BOUND', 'A bound session can never be rebound; use a new blank session');
    reservedSessions.add(sessionId);
  }
  function commit(change) {
    const task = queue.then(async () => {
      const next = cloneJson(state);
      const result = change(next);
      await writeAtomic(next);
      state = next;
      return result === undefined ? undefined : cloneJson(result);
    });
    queue = task.catch(() => {});
    return task;
  }
  async function importSnapshot(snapshot) {
    ensureOpen();
    const scriptKey = `${snapshot.manifest.id}@${snapshot.manifest.version}`;
    const hash = contentHash(snapshot);
    return commit((next) => {
      const existing = owned(next.scripts, scriptKey);
      if (existing) { assert(existing.hash === hash, 'VERSION_CONFLICT', 'This script id/version already has different content'); return publicScript(existing); }
      const record = { scriptKey, hash, importedAt: time(), archived: false, snapshot: cloneJson(snapshot) };
      next.scripts[scriptKey] = record;
      return publicScript(record);
    });
  }
  return {
    async listScripts({ includeArchived = false } = {}) { ensureOpen(); return Object.values(state.scripts).filter((script) => includeArchived || !script.archived).map(publicScript).sort((a, b) => a.scriptKey.localeCompare(b.scriptKey)); },
    async importArchive(buffer) { ensureOpen(); return importSnapshot(parseArchive(buffer)); },
    /** Trusted builtin initialization only; never expose this filesystem-path API to remote callers. */
    async importDirectory(directory) { ensureOpen(); return importSnapshot(await readDirectory(path.resolve(directory))); },
    async setArchived(scriptKey, archived) {
      ensureOpen(); assert(typeof archived === 'boolean', 'INVALID_ARGUMENT', 'archived must be boolean');
      return commit((next) => { const record = owned(next.scripts, scriptKey); assert(record, 'SCRIPT_NOT_FOUND', 'Script was not found'); record.archived = archived; return publicScript(record); });
    },
    async deleteScript(scriptKey) {
      ensureOpen();
      return commit((next) => {
        assert(owned(next.scripts, scriptKey), 'SCRIPT_NOT_FOUND', 'Script was not found');
        assert(!Object.values(next.campaigns).some((campaign) => campaign.scriptKey === scriptKey), 'SCRIPT_REFERENCED', 'A campaign references this script version');
        delete next.scripts[scriptKey];
        return { deleted: true, scriptKey };
      });
    },
    async listCampaigns(scriptId) { ensureOpen(); return Object.values(state.campaigns).filter((campaign) => !scriptId || campaign.scriptId === scriptId).map(publicCampaign).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    async createCampaign({ scriptKey, sessionId, title } = {}) {
      ensureOpen(); reserveSession(sessionId);
      try {
        const script = owned(state.scripts, scriptKey);
        assert(script, 'SCRIPT_NOT_FOUND', 'Script was not found');
        assert(!script.archived, 'SCRIPT_ARCHIVED', 'Archived scripts cannot start new campaigns');
        assert(title === undefined || (typeof title === 'string' && title.trim() && title.length <= 200), 'INVALID_ARGUMENT', 'Campaign title must be 1–200 characters');
        const snapshot = cloneJson(script.snapshot);
        const npcStates = {};
        for (const character of snapshot.characters) {
          npcStates[character.id] = cloneJson(await cultivation.createExternalState({ persona: cloneJson(character), initialState: cloneJson(character.initialState ?? {}) }));
        }
        const id = randomUUID();
        const now = time();
        const campaign = { id, scriptKey, scriptId: snapshot.manifest.id, scriptVersion: snapshot.manifest.version, title: title ?? snapshot.manifest.title, createdAt: now, updatedAt: now, ownerSessionId: sessionId, snapshot, state: initialCampaignState(snapshot, npcStates) };
        validateRuntime(campaign);
        return await commit((next) => {
          assert(!owned(next.bindings, sessionId), 'SESSION_ALREADY_BOUND', 'Session became bound while starting a campaign');
          const latest = owned(next.scripts, scriptKey);
          assert(latest && !latest.archived && latest.hash === script.hash, 'SCRIPT_UNAVAILABLE', 'Script became unavailable while starting a campaign');
          next.campaigns[id] = cloneJson(campaign);
          next.bindings[sessionId] = { sessionId, campaignId: id, readOnly: false, boundAt: now };
          return publicCampaign(campaign);
        });
      } finally { reservedSessions.delete(sessionId); }
    },
    async attachCampaign({ campaignId, sessionId, takeover = false } = {}) {
      ensureOpen(); reserveSession(sessionId);
      let reserved = false;
      try {
        const campaign = getCampaignRecord(campaignId);
        assert(takeover === true, 'TAKEOVER_REQUIRED', 'Explicit takeover confirmation is required to resume a save in a new session');
        assert(!busy.has(campaign.id), 'CAMPAIGN_BUSY', 'The current owner is processing a turn');
        busy.add(campaign.id); reserved = true;
        return await commit((next) => {
          const current = next.campaigns[campaignId];
          assert(!owned(next.bindings, sessionId), 'SESSION_ALREADY_BOUND', 'Session is already bound');
          const old = next.bindings[current.ownerSessionId];
          old.readOnly = true;
          old.takenOverAt = time();
          current.ownerSessionId = sessionId;
          current.updatedAt = time();
          next.bindings[sessionId] = { sessionId, campaignId, readOnly: false, boundAt: time() };
          return publicCampaign(current);
        });
      } finally { if (reserved) busy.delete(campaignId); reservedSessions.delete(sessionId); }
    },
    async listBindings() { ensureOpen(); return Object.values(state.bindings).map((binding) => cloneJson(binding)); },
    async getBinding(sessionId) { ensureOpen(); validSessionId(sessionId); const value = owned(state.bindings, sessionId); return value ? cloneJson(value) : null; },
    async getCampaign(id) { ensureOpen(); return cloneJson(getCampaignRecord(id)); },
    async getPublicCampaign(id) { ensureOpen(); return publicCampaign(getCampaignRecord(id)); },
    isBusy(campaignId) { ensureOpen(); return busy.has(campaignId); },
    async withCampaign(sessionId, callback) {
      ensureOpen(); assert(typeof callback === 'function', 'INVALID_ARGUMENT', 'A transaction callback is required');
      const original = requireOwner(sessionId);
      assert(!busy.has(original.id), 'CAMPAIGN_BUSY', 'A turn is already processing');
      busy.add(original.id);
      try {
        const draft = cloneJson(original);
        const result = await callback(draft);
        const safeResult = result === undefined ? undefined : cloneJson(result);
        const clean = cloneJson(draft);
        for (const key of ['id', 'scriptKey', 'scriptId', 'scriptVersion', 'ownerSessionId', 'createdAt', 'snapshot']) assert(canonicalJson(clean[key]) === canonicalJson(original[key]), 'IMMUTABLE_CAMPAIGN', `Cannot change campaign ${key} in a turn`);
        assert(typeof clean.title === 'string' && clean.title.trim() && clean.title.length <= 200, 'INVALID_CAMPAIGN', 'Invalid campaign title');
        validateRuntime(clean);
        clean.updatedAt = time();
        await commit((next) => {
          assert(!next.bindings[sessionId].readOnly && next.campaigns[original.id].ownerSessionId === sessionId, 'READ_ONLY', 'Campaign ownership changed');
          next.campaigns[original.id] = cloneJson(clean);
        });
        return safeResult;
      } finally { busy.delete(original.id); }
    },
    async close() {
      if (closed) return;
      assert(busy.size === 0 && reservedSessions.size === 0, 'STORE_BUSY', 'Cannot close while a turn or session operation is active');
      closed = true;
      await queue;
      await unlock();
    },
  };
}
