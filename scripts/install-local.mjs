#!/usr/bin/env node
// Opt-in local release packaging. Merely invoking this script changes nothing.
//
// tavern 不再把 cultivation 打进归档：`dependencies` 声明 `^0.4.1`，安装时由
// profile 的 pnpm 从 registry 拉取；DSH 会把所选 bundle 的依赖闭包登记进运行时
// 解析表，所以 tavern 自己插入的 `tavern-cultivation` 行照样能解析到它。用户若
// 另外独立安装 cultivation，那行会通过 `!!js` 表达式自动让位，不会双挂载。
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function options(argv) {
  const result = { execute: false, packOnly: false, profile: null, output: resolve(root, 'dist'), dsh: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') result.execute = true;
    else if (arg === '--pack-only') result.packOnly = true;
    else if (['--profile', '--output-dir', '--dsh'].includes(arg)) {
      const value = argv[++i];
      assert(value && !value.startsWith('--'), `${arg} requires a value`);
      result[({ '--profile': 'profile', '--output-dir': 'output', '--dsh': 'dsh' })[arg]] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  assert(!(result.execute && result.packOnly), 'Choose --execute or --pack-only, not both');
  if (result.execute) assert(result.profile && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result.profile), '--execute requires an explicit safe --profile name');
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
export async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  if (!config.execute && !config.packOnly) {
    console.log('DRY RUN: no files, packages, profiles, or running GUI were changed.');
    console.log('This command validates the package, builds the demo, and packs tavern alone.');
    console.log('cultivation stays a normal dependency, installed by the profile from the registry.');
    console.log('Review first. Explicitly run with --pack-only to create an archive, or --execute --profile NAME to install it.');
    console.log(`Archive directory: ${config.output}`);
    return;
  }
  const npm = await executable('npm');
  const dsh = config.execute ? config.dsh || await executable('dsh') : null;
  const { checkPackage } = await import('./check.mjs');
  const pkg = await checkPackage(root);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.bundleDependencies ?? manifest.bundledDependencies, undefined, 'tavern must not vendor cultivation');
  run(process.execPath, [join(root, 'scripts/build-demo.mjs')], root);
  await mkdir(config.output, { recursive: true });
  // The cache lives inside this checkout so packing never writes to the user's
  // global npm cache, the active profile, or the source dependency link.
  const stageRoot = await mkdtemp(join(root, '.install-stage-'));
  try {
    const archive = run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', config.output, '--cache', join(stageRoot, 'npm-cache')], root);
    const rows = JSON.parse(archive);
    assert(rows.length === 1 && rows[0].filename && !rows[0].filename.includes(sep), 'Unexpected npm pack output');
    const packed = resolve(config.output, rows[0].filename);
    console.log(`Created archive: ${packed}`);
    if (config.execute) {
      // dsh plugin owns profile reconciliation. No shell, no hand-written
      // profile patches, no server restart, no publish, no commit.
      const args = ['plugin', '--profile', config.profile, 'add', '--workspace-root', packed];
      console.log(`Installing into explicitly selected profile: ${config.profile}`);
      console.log(run(dsh, args, root));
    } else console.log('Not installed. Review the archive, then invoke DSH plugin add against your chosen profile explicitly.');
    return packed;
  } finally {
    const canonical = stageRoot;
    assert(canonical.startsWith(root + sep + '.install-stage-'), 'Refuse to remove unexpected staging path');
    await rm(canonical, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
