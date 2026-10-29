import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePatch } from '../scripts/check.mjs';
import { options } from '../scripts/install-local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
const patches = parsePatch(text);
const fallback = patches.flatMap(patch => patch.insert || []).find(row => row.id === 'tavern-cultivation');
const entryKey = Symbol.for('cordis.entry');
function disabled(rows) {
  const ctx = { [entryKey]: { parent: { data: rows } } };
  return new Function('ctx', `return (${fallback.disabled.__jsExpr})`)(ctx);
}

test('bundle condition activates exactly one standard cultivation row', () => {
  assert.equal(fallback.name, 'dsh-cultivation');
  assert.equal(disabled([fallback]), false);
  assert.equal(disabled([fallback, { id: 'persona-studio', name: 'dsh-cultivation' }]), true);
  assert.equal(disabled([{ id: 'persona-studio', name: 'dsh-cultivation' }, fallback]), true);
  assert.equal(disabled([fallback, { id: 'persona-studio', name: 'dsh-cultivation', disabled: true }]), false);
  assert.equal(disabled([fallback, { id: 'different-plugin', name: 'something-else' }]), false);
  assert.equal(new Set(patches.flatMap(row => row.insert || []).map(row => row.id)).size, 2);
});

test('local installer never installs without explicit profile and execution flag', () => {
  assert.equal(options([]).execute, false);
  assert.equal(options(['--pack-only']).execute, false);
  assert.throws(() => options(['--execute']), /explicit safe --profile/);
  assert.throws(() => options(['--execute', '--profile', '../web']), /explicit safe --profile/);
  assert.throws(() => options(['--execute', '--pack-only', '--profile', 'web']), /not both/);
  assert.throws(() => options(['--dsh', 'dsh']), /absolute executable/);
  const command = spawnSync(process.execPath, [join(root, 'scripts/install-local.mjs')], { encoding: 'utf8', shell: false });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /DRY RUN: no files/);
});

async function runtimeRoot() {
  const candidates = [
    process.env.DSH_RUNTIME_DIR,
    process.env.DSH_CHECKOUT_DIR && join(process.env.DSH_CHECKOUT_DIR, 'node_modules/@deepseek-ai')
  ].filter(Boolean);
  try { candidates.unshift(dirname(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json')))); } catch {}
  for (const candidate of candidates) {
    try { await access(join(candidate, 'dsh-app-boot/lib/index.js')); return candidate; } catch {}
  }
}
const runtime = await runtimeRoot();

test('actual DSH YAML schema and live Loader elect one cultivation activation', { skip: !runtime && 'Set DSH_RUNTIME_DIR to installed @deepseek-ai directory' }, async () => {
  const boot = await import(pathToFileURL(join(runtime, 'dsh-app-boot/lib/index.js')));
  const actualRows = boot.loadOverlayPatches('tavern-test', join(root, 'cordis.patch.yml'));
  assert.equal(actualRows[0].insert[0].disabled.__jsExpr, fallback.disabled.__jsExpr);
  const { Context } = await import(pathToFileURL(join(runtime, 'cordis/lib/index.js')));
  const { Loader } = await import(pathToFileURL(join(runtime, 'cordis-plugin-loader/lib/index.js')));
  for (const existing of [false, true]) {
    const ctx = new Context();
    let loader;
    const activations = [];
    const owner = await ctx.plugin({ apply(scope) { loader = new Loader(scope); } });
    try {
      loader.import = () => ({ apply(scope) { activations.push(scope[entryKey].options.id); } });
      const rows = [structuredClone(actualRows[0].insert[0]), ...(existing ? [{ id: 'persona-studio', name: 'dsh-cultivation' }] : [])];
      await loader.root.update(rows);
      await loader.await();
      assert.deepEqual(activations, [existing ? 'persona-studio' : 'tavern-cultivation']);
      assert.equal(loader.store['tavern-cultivation'].disabled, existing);
      // Live recomposition hands ownership to the fallback when the other row
      // disappears; no service-availability race is involved.
      if (existing) {
        await loader.root.update([structuredClone(actualRows[0].insert[0])]);
        await loader.await();
        assert.deepEqual(activations, ['persona-studio', 'tavern-cultivation']);
      }
    } finally { await owner.dispose(); }
  }
});

async function json(file, value) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${program} ${args.join(' ')}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}

test('packed dependency resolves through actual DSH selected-bundle closure in an isolated fixture profile', { skip: !runtime && 'Set DSH_RUNTIME_DIR to installed @deepseek-ai directory' }, async () => {
  const fixture = await mkdtemp(join(root, '.test-bundle-'));
  try {
    const source = join(fixture, 'source');
    const nested = join(source, 'node_modules/dsh-cultivation');
    await json(join(source, 'package.json'), {
      name: 'dsh-tavern-adventure', version: '0.1.0', type: 'module', main: './lib/index.js',
      files: ['lib', 'cordis.patch.yml'], dependencies: { 'dsh-cultivation': '^0.4.0' },
      bundleDependencies: ['dsh-cultivation'], dsh: { bundle: { patch: './cordis.patch.yml' } }
    });
    await mkdir(join(source, 'lib'), { recursive: true });
    await writeFile(join(source, 'lib/index.js'), 'export const fixture = true;\n');
    await cp(join(root, 'cordis.patch.yml'), join(source, 'cordis.patch.yml'));
    await json(join(nested, 'package.json'), { name: 'dsh-cultivation', version: '0.4.0', type: 'module', main: './index.js' });
    await writeFile(join(nested, 'index.js'), 'export const nestedFixture = true;\n');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const cache = join(fixture, 'cache');
    const packed = JSON.parse(command(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture, '--cache', cache], source));
    assert(packed[0].bundled.includes('dsh-cultivation'));
    assert(packed[0].files.some(file => file.path === 'node_modules/dsh-cultivation/index.js'));
    const profileDir = join(fixture, 'home/profiles/fixture');
    await json(join(profileDir, 'package.json'), { name: 'fixture-profile', private: true, dsh: { profile: { bundles: ['dsh-tavern-adventure'] } } });
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n');
    command(npm, ['install', '--offline', '--ignore-scripts', '--package-lock=false', '--cache', cache, join(fixture, packed[0].filename)], profileDir);
    const nestedInstalled = join(profileDir, 'node_modules/dsh-tavern-adventure/node_modules/dsh-cultivation');
    assert.equal(JSON.parse(await readFile(join(nestedInstalled, 'package.json'), 'utf8')).version, '0.4.0');
    const installAnchor = join(fixture, 'installation/package.json');
    await json(installAnchor, { name: 'fixture-dsh-installation', version: '1.0.0' });
    const boot = await import(pathToFileURL(join(runtime, 'dsh-app-boot/lib/index.js')));
    const profile = boot.loadProfileDirectory('fixture', profileDir, installAnchor);
    assert.deepEqual(profile.skippedBundles, []);
    assert.equal(profile.layers.length, 1);
    const resolution = await boot.createRuntimeResolution({ installAnchor, profile, home: join(fixture, 'home') });
    const cultivation = resolution.entries.find(entry => entry.name === 'dsh-cultivation');
    assert(cultivation, 'Selected tavern bundle must project its nested dependency into DSH package routing');
    assert.equal(await realpath(cultivation.packageDir), await realpath(nestedInstalled));
    assert.equal(cultivation.scope, 'profile');
    const { Context } = await import(pathToFileURL(join(runtime, 'cordis/lib/index.js')));
    const context = new Context();
    const owner = await context.plugin({ apply(scope) { new boot.PluginPackages(scope, { resolution }); } });
    try {
      const selected = context.get('pluginPackages').packageOf('dsh-cultivation', pathToFileURL(join(profileDir, 'entry.js')).href);
      assert.equal(await realpath(selected.dir), await realpath(nestedInstalled));
    } finally { await owner.dispose(); }
  } finally {
    const target = await realpath(fixture);
    assert(target.startsWith(root + sep + '.test-bundle-'), 'Refuse unexpected fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
