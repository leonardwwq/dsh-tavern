// cultivation 兼容性守卫。
//
// tavern 对 cultivation 是硬依赖：没有 cultivation 服务，或者服务版本落在
// 兼容范围之外，tavern 必须拒绝启动并给出一条能直接复制执行的修复命令，
// 而不是在运行期以 undefined 崩溃。
//
// 版本判定刻意只看 major.minor.patch，忽略 prerelease/build 段：本地开发常用
// `0.4.2-beta.1` 这种预发布号，按 npm 的严格语义它不会满足 `^0.4.1`，会让
// 开发循环莫名其妙地起不来；按数字段判定则「0.4.x 的 beta 能用、0.5.0 不行」，
// 与人对「兼容」的直觉一致。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** cultivation 服务必须声明的 external API 版本。 */
export const CULTIVATION_API_VERSION = 1;
/** tavern 声明并强制校验的 cultivation 版本范围，必须与 package.json 的依赖一致。 */
export const CULTIVATION_RANGE = '^0.4.1';
/** cultivation 必须提供的能力，缺一个都无法工作。 */
export const CULTIVATION_METHODS = Object.freeze(['createExternalState', 'renderExternalCard', 'processExternalEvent', 'setExternalSessionMode']);

/** The version of this tavern build, read from its own manifest. */
export const tavernVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE = /^(\^|~|>=|=)?\s*v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a version string into its release triple, or undefined when it is not SemVer. */
export function parseVersion(value) {
  const match = SEMVER.exec(String(value ?? '').trim());
  if (match === null) return undefined;
  return Object.freeze({
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] === undefined ? '' : `-${match[4]}`}`,
    parts: Object.freeze([Number(match[1]), Number(match[2]), Number(match[3])]),
    prerelease: match[4] === undefined ? undefined : match[4]
  });
}

/** Compare release triples, ignoring prerelease and build metadata. Returns -1, 0, or 1. */
export function compareParts(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] === right[index]) continue;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Upper bound of a range, exclusive: the first version the range no longer admits. */
function upperBound(operator, [major, minor, patch]) {
  if (operator === '^') {
    if (major > 0) return [major + 1, 0, 0];
    if (minor > 0) return [0, minor + 1, 0];
    return [0, 0, patch + 1];
  }
  if (operator === '~') return [major, minor + 1, 0];
  return undefined;
}

/**
 * Whether `version` satisfies `range`.
 * Supported forms: `*`, exact `1.2.3`, `=1.2.3`, `>=1.2.3`, `~1.2.3`, `^1.2.3`.
 * Unknown or malformed ranges return false: an unrecognised guard must fail loudly.
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (parsed === undefined) return false;
  const spec = String(range ?? '').trim();
  if (spec === '' || spec === '*' || spec === 'latest') return true;
  const match = RANGE.exec(spec);
  if (match === null) return false;
  const operator = match[1] ?? '=';
  const base = [Number(match[2]), Number(match[3]), Number(match[4])];
  if (operator === '>=') return compareParts(parsed.parts, base) >= 0;
  if (compareParts(parsed.parts, base) < 0) return false;
  const upper = upperBound(operator, base);
  if (upper === undefined) return compareParts(parsed.parts, base) === 0;
  return compareParts(parsed.parts, upper) < 0;
}

/** Path of the cultivation manifest tavern's own dependency tree resolves to, if any. */
function cultivationManifest() {
  try {
    return require.resolve('dsh-cultivation/package.json');
  } catch {
    return undefined;
  }
}

/**
 * The version of the cultivation copy tavern itself depends on.
 * A missing dependency tree yields undefined; the service's own `version` wins when present.
 */
export function dependencyCultivationVersion() {
  const file = cultivationManifest();
  if (file === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version;
  } catch {
    return undefined;
  }
}

/** The version the running cultivation service reports, if it reports one at all. */
export function serviceCultivationVersion(service) {
  return typeof service?.version === 'string' ? service.version : undefined;
}

/**
 * Validate a mounted cultivation service.
 * @param service The `cultivation` service tavern injected.
 * @param fallbackVersion Version known from tavern's dependency tree, used when the service reports none.
 * @returns null when compatible, otherwise the message to throw.
 */
export function cultivationProblem(service, fallbackVersion = dependencyCultivationVersion()) {
  const install = `dsh plugin --profile <profile> add dsh-cultivation@${CULTIVATION_RANGE}`;
  if (service === undefined || service === null) {
    return `dsh-tavern ${tavernVersion} 需要 dsh-cultivation ${CULTIVATION_RANGE}（external API v${CULTIVATION_API_VERSION}），但没有检测到 cultivation 服务。\n请安装后重启：${install}`;
  }
  const missing = CULTIVATION_METHODS.filter((key) => typeof service[key] !== 'function');
  if (service.apiVersion !== CULTIVATION_API_VERSION || missing.length > 0) {
    return `dsh-tavern ${tavernVersion} 需要 dsh-cultivation ${CULTIVATION_RANGE}（external API v${CULTIVATION_API_VERSION}），当前服务不匹配${missing.length === 0 ? '' : `，缺少 ${missing.join('、')}`}。\n请升级后重启：${install}`;
  }
  const version = serviceCultivationVersion(service) ?? fallbackVersion;
  if (version === undefined || version === null) return null;
  if (satisfiesRange(version, CULTIVATION_RANGE)) return null;
  return `dsh-tavern ${tavernVersion} 需要 dsh-cultivation ${CULTIVATION_RANGE}，当前检测到 ${version}。\n请升级后重启：${install}`;
}
