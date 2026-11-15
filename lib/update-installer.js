import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPDATE_REPOSITORY = 'https://github.com/KimBrine/dsh-tongji-usage-widget.git';
const PACKAGE_NAME = 'dsh-tongji-usage-widget';
const runFile = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const messages = {
  NOT_GIT: '当前安装方式不支持直接覆盖，请下载 Release 安装包更新。',
  WRONG_ROOT: '当前目录不是插件仓库根目录，请下载 Release 安装包更新。',
  WRONG_SOURCE: '当前仓库来源不匹配，已停止更新，请使用本项目 Release。',
  WRONG_BRANCH: '当前未处于 main 分支，已保留现有文件，请手动处理后重试。',
  DIRTY: '插件目录有本机修改或未提交文件，已停止更新；请先保存并处理这些改动。',
  INVALID_PACKAGE: '插件包信息不匹配，已停止更新。',
  INVALID_RELEASE: '正式发布信息无效，未执行更新，请稍后检查更新。',
  DIVERGED: '本机与新版历史无法直接合并，已停止更新；请手动处理或下载 Release。',
  CHANGED: '安装期间仓库状态已变化，已停止更新；请处理本机改动后重试。',
  DEPENDENCIES: '新版运行依赖发生变化，需要手动安装；请下载 Release 并查看安装说明。',
  RUNTIME: '新版需要不同的 Node.js 运行环境，请先查看 Release 安装说明。',
  GIT_FAILED: '下载或安装未完成，请检查网络与 Git 后重试；本机改动不会被强制覆盖。',
  DISPOSED: '更新操作已停止。',
};

function problem(code) { return Object.assign(new Error(code), { code }); }
function validVersion(value) { return typeof value === 'string' && value.length <= 80 && stableVersion.test(value); }
function newer(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
function samePath(left, right) {
  const a = resolve(left), b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function expectedSource(value) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:)KimBrine\/dsh-tongji-usage-widget(?:\.git)?\/?$/i.test(value);
}
function packageDocument(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw problem('INVALID_PACKAGE'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== PACKAGE_NAME
    || !validVersion(value.version) || value.main !== 'lib/index.js') throw problem('INVALID_PACKAGE');
  return value;
}
function dependencies(value) {
  return JSON.stringify(['dependencies', 'optionalDependencies', 'peerDependencies'].map(field => {
    const entries = value[field];
    if (entries === undefined) return [];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw problem('INVALID_PACKAGE');
    return Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  }));
}

/** Explicit updates for a clean, linked checkout; archives are offered as a manual fallback. */
export function createUpdateInstaller({ root = fileURLToPath(new URL('../', import.meta.url)),
  execFileImpl = runFile, environment = process.env, currentVersion } = {}) {
  const packageRoot = resolve(root);
  const hooksPath = join(tmpdir(), `tongji-update-no-hooks-${randomUUID()}`);
  const childEnvironment = { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  delete childEnvironment.TONGJI_AI_ACCESS_TOKEN;
  delete childEnvironment.TONGJI_AI_COOKIE;
  let disposed = false, pending = null, probing = null, controller = null;
  let state = { state: 'idle', message: '正在检查本机安装方式…', canInstall: false, restartRequired: false };
  const status = () => ({ ...state });
  const active = () => { if (disposed) throw problem('DISPOSED'); };
  const pendingRestart = version => validVersion(currentVersion) && newer(version, currentVersion);
  const installedState = version => ({ state: 'installed',
    message: `v${version} 已安装，请完全退出并重新打开 DSH。浏览器助手如有更新，请在扩展管理页重新加载。`,
    canInstall: false, restartRequired: true, version });
  const flags = ['--no-optional-locks', '-c', `core.hooksPath=${hooksPath}`, '-c', 'core.fsmonitor=false',
    '-c', 'submodule.recurse=false', '-c', 'credential.helper=', '-c', 'credential.interactive=never',
    '-c', 'http.extraHeader=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-C', packageRoot];

  async function git(args, { signal = controller?.signal, timeout = 30000 } = {}) {
    active();
    try {
      const result = await execFileImpl('git', [...flags, ...args], {
        cwd: packageRoot, env: childEnvironment, windowsHide: true, shell: false,
        encoding: 'utf8', maxBuffer: 262144, timeout, ...(signal ? { signal } : {}),
      });
      return String(result?.stdout ?? '').trim();
    } catch (error) {
      if (disposed) throw problem('DISPOSED');
      // Keep exit status only for the ancestry predicate; never expose stderr, paths or credentials.
      throw Object.assign(problem('GIT_FAILED'), { exitCode: error?.code });
    }
  }

  async function localPackage() {
    let size, text;
    try { size = (await stat(join(packageRoot, 'package.json'))).size; }
    catch { throw problem('INVALID_PACKAGE'); }
    if (size > 262144) throw problem('INVALID_PACKAGE');
    try { text = await readFile(join(packageRoot, 'package.json'), 'utf8'); }
    catch { throw problem('INVALID_PACKAGE'); }
    return packageDocument(text);
  }

  async function inspect() {
    active();
    try { await stat(join(packageRoot, '.git')); } catch { throw problem('NOT_GIT'); }
    const repositoryRoot = await git(['rev-parse', '--show-toplevel']);
    let normalizedRoot;
    try { normalizedRoot = await realpath(repositoryRoot); } catch { throw problem('WRONG_ROOT'); }
    if (!samePath(normalizedRoot, await realpath(packageRoot))) throw problem('WRONG_ROOT');
    let branch;
    try { branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']); }
    catch { throw problem('WRONG_BRANCH'); }
    if (branch !== 'main') throw problem('WRONG_BRANCH');
    const remotes = (await git(['remote', 'get-url', '--all', 'origin'])).split(/\r?\n/);
    if (remotes.length !== 1 || !expectedSource(remotes[0])) throw problem('WRONG_SOURCE');
    if (await git(['status', '--porcelain=v1', '--untracked-files=all'])) throw problem('DIRTY');
    const head = await git(['rev-parse', '--verify', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/i.test(head)) throw problem('GIT_FAILED');
    return { head, package: await localPackage() };
  }

  function failed(error, { duringInstall = false, mutationAttempted = false } = {}) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'GIT_FAILED';
    state = { ...state, state: duringInstall ? 'error' : 'unsupported', message: messages[code],
      canInstall: duringInstall && ['GIT_FAILED', 'INVALID_RELEASE'].includes(code),
      restartRequired: mutationAttempted };
    return status();
  }

  function probe() {
    if (disposed || pending || state.state === 'installed') return Promise.resolve(status());
    if (probing) return probing;
    const task = Promise.resolve().then(async () => {
      try {
        const local = await inspect();
        active();
        state = pendingRestart(local.package.version) ? installedState(local.package.version)
          : { state: 'idle', message: '支持一键更新；安装完成后重启 DSH 生效。',
            canInstall: true, restartRequired: false, version: local.package.version };
        return status();
      } catch (error) { return failed(error); }
    }).finally(() => { if (probing === task) probing = null; });
    probing = task;
    return task;
  }

  function install(release) {
    if (pending) return pending;
    if (disposed || state.state === 'installed') return Promise.resolve(status());
    const task = Promise.resolve().then(async () => {
      if (probing) await probing;
      if (disposed) return status();
      let mutationAttempted = false;
      state = { ...state, state: 'installing', message: '正在下载并校验正式发布版本…', canInstall: false, restartRequired: false };
      controller = new AbortController();
      try {
        if (!release || !validVersion(release.version) || release.tagName !== `v${release.version}`) throw problem('INVALID_RELEASE');
        const before = await inspect();
        if (!newer(release.version, before.package.version)) {
          state = pendingRestart(before.package.version) ? installedState(before.package.version)
            : { state: 'idle', message: '本机文件已是该发布版本或更新，无需重复安装。', canInstall: true,
              restartRequired: false, version: before.package.version };
          return status();
        }
        await git(['fetch', '--no-tags', '--no-recurse-submodules', UPDATE_REPOSITORY, `refs/tags/${release.tagName}`], { timeout: 120000 });
        const commit = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
        if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw problem('INVALID_RELEASE');
        const target = packageDocument(await git(['show', `${commit}:package.json`]));
        if (target.version !== release.version) throw problem('INVALID_RELEASE');
        if (dependencies(before.package) !== dependencies(target)) throw problem('DEPENDENCIES');
        const engine = target.engines?.node;
        if (engine !== before.package.engines?.node) throw problem('RUNTIME');
        try { await git(['merge-base', '--is-ancestor', before.head, commit]); }
        catch (error) { if (error.exitCode === 1) throw problem('DIVERGED'); throw error; }
        const immediatelyBefore = await inspect();
        if (immediatelyBefore.head !== before.head || immediatelyBefore.package.version !== before.package.version) throw problem('CHANGED');
        active();
        state = { ...state, message: '正在安装已校验的版本，请稍候…' };
        mutationAttempted = true;
        // Once checkout begins, do not abort it halfway through plugin shutdown.
        await git(['merge', '--ff-only', '--no-overwrite-ignore', '--no-stat', '--no-edit', commit], { signal: null, timeout: 120000 });
        const installed = await localPackage();
        if (installed.version !== release.version) throw problem('INVALID_PACKAGE');
        state = installedState(release.version);
        return status();
      } catch (error) { return failed(error, { duringInstall: true, mutationAttempted }); }
      finally { controller = null; }
    }).finally(() => { if (pending === task) pending = null; });
    pending = task;
    return task;
  }

  return { status, probe, install, dispose() { disposed = true; controller?.abort(); } };
}
