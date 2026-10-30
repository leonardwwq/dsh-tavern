import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CULTIVATION_API_VERSION,
  CULTIVATION_RANGE,
  compareParts,
  cultivationProblem,
  parseVersion,
  satisfiesRange,
  serviceCultivationVersion,
  tavernVersion
} from '../lib/version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function service(overrides = {}) {
  return {
    apiVersion: 1,
    version: '0.4.1',
    createExternalState() {},
    renderExternalCard() {},
    processExternalEvent() {},
    setExternalSessionMode() {},
    ...overrides
  };
}

test('the shipped dependency and the runtime guard name the same range', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['dsh-cultivation'], CULTIVATION_RANGE);
  assert.equal(manifest.bundleDependencies ?? manifest.bundledDependencies, undefined, 'tavern must not vendor cultivation');
  assert.equal(typeof tavernVersion, 'string');
  assert.match(tavernVersion, /^\d+\.\d+\.\d+/);
});

test('versions parse into release triples and reject non-SemVer', () => {
  assert.deepEqual(parseVersion('0.4.1').parts, [0, 4, 1]);
  assert.equal(parseVersion('v0.4.1').parts[1], 4);
  assert.equal(parseVersion('0.4.2-beta.1').prerelease, 'beta.1');
  assert.deepEqual(parseVersion('1.2.3+build.5').parts, [1, 2, 3]);
  for (const invalid of ['', '0.4', 'x.y.z', undefined, null, '0.4.1.2']) assert.equal(parseVersion(invalid), undefined, String(invalid));
  assert.equal(compareParts([0, 4, 1], [0, 4, 1]), 0);
  assert.equal(compareParts([0, 4, 2], [0, 4, 1]), 1);
  assert.equal(compareParts([0, 3, 9], [0, 4, 1]), -1);
});

test('caret, tilde, minimum, exact, and wildcard ranges behave as documented', () => {
  assert.equal(satisfiesRange('0.4.1', '^0.4.1'), true);
  assert.equal(satisfiesRange('0.4.9', '^0.4.1'), true);
  assert.equal(satisfiesRange('0.5.0', '^0.4.1'), false);
  assert.equal(satisfiesRange('0.3.9', '^0.4.1'), false);
  assert.equal(satisfiesRange('1.0.0', '^0.4.1'), false);
  // Prerelease numbers count by their release triple, so 0.4.x betas satisfy 0.4.x.
  assert.equal(satisfiesRange('0.4.2-beta.1', '^0.4.1'), true);
  assert.equal(satisfiesRange('0.5.0-beta.1', '^0.4.1'), false);
  assert.equal(satisfiesRange('0.5.0+build', '^0.4.1'), false);
  // ^0.0.x pins the patch.
  assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false);
  assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true);
  assert.equal(satisfiesRange('0.4.9', '~0.4.1'), true);
  assert.equal(satisfiesRange('0.5.0', '~0.4.1'), false);
  assert.equal(satisfiesRange('2.0.0', '>=0.4.1'), true);
  assert.equal(satisfiesRange('0.4.0', '>=0.4.1'), false);
  assert.equal(satisfiesRange('0.4.1', '=0.4.1'), true);
  assert.equal(satisfiesRange('0.4.2', '=0.4.1'), false);
  assert.equal(satisfiesRange('9.9.9', '*'), true);
  // An unrecognised range is a failed guard, never a silent pass.
  assert.equal(satisfiesRange('0.4.1', 'workspace:*'), false);
  assert.equal(satisfiesRange('not-a-version', '*'), false);
});

test('the guard accepts a compatible service and reports the mounted version', () => {
  assert.equal(serviceCultivationVersion(service()), '0.4.1');
  assert.equal(cultivationProblem(service(), undefined), null);
  assert.equal(cultivationProblem(service({ version: undefined }), '0.4.3'), null);
  assert.equal(cultivationProblem(service({ version: undefined }), undefined), null, 'an unknown version cannot be judged');
});

test('the guard refuses a missing, incompatible, or incomplete service with an actionable command', () => {
  const missing = cultivationProblem(undefined, undefined);
  assert.match(missing, /没有检测到 cultivation 服务/);
  assert.match(missing, new RegExp(`dsh plugin --profile <profile> add dsh-cultivation@\\${CULTIVATION_RANGE}`));

  const wrongApi = cultivationProblem(service({ apiVersion: 2 }), undefined);
  assert.match(wrongApi, /external API v1/);

  const incomplete = cultivationProblem(service({ processExternalEvent: undefined }), undefined);
  assert.match(incomplete, /processExternalEvent/);

  const tooOld = cultivationProblem(service({ version: '0.3.0' }), undefined);
  assert.match(tooOld, /当前检测到 0\.3\.0/);
  assert.match(tooOld, /dsh plugin --profile/);

  const tooNew = cultivationProblem(service({ version: '0.5.0' }), undefined);
  assert.match(tooNew, /0\.5\.0/);
});

test('the api version tavern expects is fixed', () => {
  assert.equal(CULTIVATION_API_VERSION, 1);
});
