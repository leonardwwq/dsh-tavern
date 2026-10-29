import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) };
export function parsePatch(text) { return parse(text, { customTags: [jsTag] }); }

async function regularFile(base, name) {
  const target = resolve(base, name);
  assert(target.startsWith(base + sep), `Package path escapes root: ${name}`);
  assert((await stat(target)).isFile(), `Missing regular file: ${name}`);
  return target;
}
function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}
async function scriptsIn(base) {
  const found = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const target = resolve(base, entry.name);
    if (entry.isDirectory()) found.push(...await scriptsIn(target));
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(target);
  }
  return found;
}

export async function checkPackage(base = root) {
  base = resolve(base);
  const pkg = JSON.parse(await readFile(resolve(base, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-tavern-adventure');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.dependencies?.['dsh-cultivation'], '^0.4.1');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  const patches = [pkg.dsh?.bundle?.patch].flat();
  assert(patches.length && patches.every(p => typeof p === 'string'), 'Bundle patch declaration required');
  assert(Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('scripts'), 'Publish lib and scripts');
  assert((await readFile(resolve(base, 'lib/client.js'), 'utf8')).includes(`id: "${pkg.name}"`), 'Client module id must match the npm package name');
  assert(pkg.files.includes('docs'), 'Publish linked documentation');
  for (const required of ['lib/index.js', 'lib/client.js', 'lib/core.js', 'README.md', 'LICENSE', 'scripts/build-demo.mjs', 'docs/adventure-format.md', 'docs/npc-autonomy.md', 'docs/development-and-recovery.md']) {
    await regularFile(base, required);
  }
  assert(pkg.exports && typeof pkg.exports === 'object', 'Explicit exports required');
  for (const entry of ['.', './client', './core', './package.json']) assert(pkg.exports[entry], `Missing export ${entry}`);
  for (const target of exportTargets(pkg.exports)) {
    assert(target.startsWith('./'), `Export must be package-relative: ${target}`);
    if (!target.includes('*')) await regularFile(base, target);
  }
  for (const patch of patches) {
    await regularFile(base, patch);
    assert(pkg.files.includes(patch.replace(/^\.\//, '')), `Publish ${patch}`);
    const rows = parsePatch(await readFile(resolve(base, patch), 'utf8'));
    assert(Array.isArray(rows), 'Patch must be an entry list');
    const inserted = rows.flatMap(row => row.insert || []);
    assert.equal(inserted.filter(row => row.name === 'dsh-tavern-adventure').length, 1);
    const fallback = inserted.find(row => row.id === 'tavern-cultivation');
    assert.equal(fallback?.name, 'dsh-cultivation');
    assert.equal(typeof fallback.disabled?.__jsExpr, 'string', 'Cultivation fallback needs a loader expression');
    // Syntax-check only; evaluating this expression needs a real Loader entry.
    new Function('ctx', `return (${fallback.disabled.__jsExpr})`);
  }
  let count = 0;
  for (const directory of ['lib', 'scripts', 'tests']) {
    try { await stat(resolve(base, directory)); } catch { continue; }
    for (const file of await scriptsIn(resolve(base, directory))) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', shell: false });
      assert.equal(result.status, 0, `${relative(base, file)}: ${result.stderr || result.error || 'Syntax check failed'}`);
      count++;
    }
  }
  console.log(`Checked metadata, publish targets, bundle activation, and ${count} JavaScript files.`);
  return pkg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkPackage();
}
