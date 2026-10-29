#!/usr/bin/env node
// Opt-in local release packaging. Merely invoking this script changes nothing.
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function options(argv) {
  const result = { execute: false, packOnly: false, profile: null, cultivation: resolve(root, '../dsh-cultivation'), output: resolve(root, 'dist'), dsh: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') result.execute = true;
    else if (arg === '--pack-only') result.packOnly = true;
    else if (['--profile', '--cultivation-dir', '--output-dir', '--dsh'].includes(arg)) {
      const value = argv[++i];
      assert(value && !value.startsWith('--'), `${arg} requires a value`);
      result[({ '--profile': 'profile', '--cultivation-dir': 'cultivation', '--output-dir': 'output', '--dsh': 'dsh' })[arg]] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  assert(!(result.execute && result.packOnly), 'Choose --execute or --pack-only, not both');
  if (result.execute) assert(result.profile && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result.profile), '--execute requires an explicit safe --profile name');
  result.cultivation = resolve(result.cultivation);
  result.output = resolve(result.output);
  if (result.dsh) { assert(isAbsolute(result.dsh), '--dsh must name an absolute executable'); result.dsh = resolve(result.dsh); }
  return result;
}
async function executable(name) {
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(dir, process.platform === 'win32' ? `${name}.cmd` : name);
    try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error(`${name} is not on PATH`);
}
export function run(program, args, cwd, extra = {}) {
  assert(isAbsolute(program) && isAbsolute(cwd), 'Executables and cwd must be absolute');
  const result = spawnSync(program, args, { cwd, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...extra });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}
async function pack(npm, source, destination, cache) {
  const output = run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', destination, '--cache', cache], source);
  const rows = JSON.parse(output);
  assert(rows.length === 1 && rows[0].filename && !rows[0].filename.includes(sep), 'Unexpected npm pack output');
  return resolve(destination, rows[0].filename);
}
export async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  if (!config.execute && !config.packOnly) {
    console.log('DRY RUN: no files, packages, profiles, or running GUI were changed.');
    console.log('This command will validate and pack cultivation, materialize it inside a staged tavern package, then pack tavern.');
    console.log('Review first. Explicitly run with --pack-only to create an archive, or --execute --profile NAME to install it.');
    console.log(`Cultivation source: ${config.cultivation}\nArchive directory: ${config.output}`);
    return;
  }
  const npm = await executable('npm');
  const dsh = config.execute ? config.dsh || await executable('dsh') : null;
  const { checkPackage } = await import('./check.mjs');
  const pkg = await checkPackage(root);
  const cult = JSON.parse(await readFile(join(config.cultivation, 'package.json'), 'utf8'));
  assert.equal(cult.name, 'dsh-cultivation');
  assert(/^0\.4\.\d+$/.test(cult.version) && Number(cult.version.split('.')[2]) >= 1, 'Local cultivation must satisfy ^0.4.1 (stable 0.4.x)');
  if (cult.scripts?.check) run(npm, ['run', 'check'], config.cultivation);
  run(process.execPath, [join(root, 'scripts/build-demo.mjs')], root);
  await mkdir(config.output, { recursive: true });
  // Staging is deliberately inside this checkout; never mutates the source
  // dependency symlink, package manifest, lockfile, or active DSH profile.
  const stageRoot = await mkdtemp(join(root, '.install-stage-'));
  const stage = join(stageRoot, 'package');
  const cache = join(stageRoot, 'npm-cache');
  await mkdir(stage);
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist') continue;
      await cp(join(root, entry.name), join(stage, entry.name), { recursive: true, dereference: true });
    }
    const cultivationArchive = await pack(npm, config.cultivation, stageRoot, cache);
    // A real tarball install, not a development link: npm pack excludes linked
    // bundle dependencies. Add the bundle declaration only to the staged copy.
    const stagedManifest = { ...pkg, bundleDependencies: [...new Set([...(pkg.bundleDependencies || pkg.bundledDependencies || []), 'dsh-cultivation'])] };
    delete stagedManifest.bundledDependencies;
    await writeFile(join(stage, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');
    run(npm, ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--omit=dev', '--cache', cache, cultivationArchive], stage);
    const installed = JSON.parse(await readFile(join(stage, 'node_modules/dsh-cultivation/package.json'), 'utf8'));
    assert.equal(installed.version, cult.version);
    assert((await realpath(join(stage, 'node_modules/dsh-cultivation'))).startsWith(stage + sep), 'Bundled cultivation must be materialized, not externally linked');
    const archive = await pack(npm, stage, config.output, cache);
    console.log(`Created self-contained local archive: ${archive}`);
    if (config.execute) {
      // dsh plugin owns profile reconciliation. No shell, no hand-written
      // profile patches, no server restart, no publish, no commit.
      const args = ['plugin', '--profile', config.profile, 'add', '--workspace-root', archive];
      console.log(`Installing into explicitly selected profile: ${config.profile}`);
      console.log(run(dsh, args, root));
    } else console.log('Not installed. Review the archive, then invoke DSH plugin add against your chosen profile explicitly.');
    return archive;
  } finally {
    const canonical = await realpath(stageRoot);
    assert(canonical.startsWith(root + sep + '.install-stage-'), 'Refuse to remove unexpected staging path');
    await rm(canonical, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
