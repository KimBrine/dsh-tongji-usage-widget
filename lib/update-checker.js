import { readFileSync } from 'node:fs';

const PACKAGE_NAME = 'dsh-tongji-usage-widget';
export const UPDATE_URL = 'https://github.com/KimBrine/dsh-tongji-usage-widget';
export const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/KimBrine/dsh-tongji-usage-widget/main/package.json';
const MAX_RESPONSE_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 8000;

function problem(code) {
  return Object.assign(new Error(code), { code });
}

function localVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    throw new Error('无法读取插件版本信息。');
  }
}

function semver(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { release: match.slice(1, 4), pre };
}

function compareNumber(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) {
    const value = compareNumber(a.release[index], b.release[index]);
    if (value) return value;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const left = a.pre[index], right = b.pre[index];
    if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left), rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return compareNumber(left, right);
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function cancelBody(response) {
  try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
}

async function readManifest(response, signal) {
  if (signal.aborted) { cancelBody(response); throw signal.reason || problem('ABORTED'); }
  if (!response.ok || response.status !== 200) { cancelBody(response); throw problem('NETWORK'); }
  // A mock or non-conforming fetch implementation must not bypass redirect restrictions.
  if (response.redirected || (response.url && response.url !== UPDATE_MANIFEST_URL)) {
    cancelBody(response);
    throw problem('INVALID_RESPONSE');
  }
  const declaredLength = response.headers?.get('content-length');
  if (declaredLength !== null && declaredLength !== undefined && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw problem('INVALID_RESPONSE');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw problem('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ } };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason || problem('ABORTED');
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { cancel(); throw problem('INVALID_RESPONSE'); }
      chunks.push(value);
    }
    let document;
    try {
      const bytes = Buffer.concat(chunks, size);
      document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { throw problem('INVALID_RESPONSE'); }
    if (!document || typeof document !== 'object' || Array.isArray(document) || document.name !== PACKAGE_NAME || !semver(document.version)) {
      throw problem('INVALID_RESPONSE');
    }
    return document.version;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function duration(value, fallback, minimum = 1) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= 2_147_483_647 ? value : fallback;
}

/** Checks only the public package manifest. No account credentials are read or sent. */
export function createUpdateChecker({ currentVersion = localVersion(), fetchImpl = globalThis.fetch, now = Date.now,
  intervalMs = 21_600_000, retryMs = 900_000, manualCooldownMs = 60_000 } = {}) {
  const installed = semver(currentVersion);
  if (!installed) throw new Error('插件当前版本号无效。');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new Error('更新检查运行环境无效。');
  intervalMs = duration(intervalMs, 21_600_000);
  retryMs = duration(retryMs, 900_000);
  manualCooldownMs = duration(manualCooldownMs, 60_000, 0);
  let state = { state: 'unchecked', currentVersion, latestVersion: null, url: UPDATE_URL, checkedAt: null, error: null };
  let disposed = false, started = false, pending = null;
  let timer = null, deadlineTimer = null, controller = null;
  let lastAttemptAt = -Infinity, nextCheckAt = -Infinity;
  const timestamp = () => {
    const value = now();
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  };
  const status = () => ({ ...state });
  const available = version => {
    const remote = semver(version);
    return !!remote && (installed.pre.length > 0 || remote.pre.length === 0) && compareVersions(remote, installed) > 0;
  };
  const clearScheduled = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const clearDeadline = () => { if (deadlineTimer !== null) clearTimeout(deadlineTimer); deadlineTimer = null; };
  const schedule = () => {
    clearScheduled();
    if (!started || disposed || pending) return;
    const delay = Math.min(2_147_483_647, Math.max(0, nextCheckAt - timestamp()));
    timer = setTimeout(() => {
      timer = null;
      void check().finally(schedule);
    }, delay);
    timer.unref?.();
  };

  function check({ force = false } = {}) {
    if (disposed) return Promise.resolve(status());
    if (pending) return pending;
    const at = timestamp();
    if ((force && at - lastAttemptAt < manualCooldownMs) || (!force && at < nextCheckAt)) return Promise.resolve(status());
    clearScheduled();
    lastAttemptAt = at;
    state = { ...state, state: 'checking', error: null };
    const active = new AbortController();
    controller = active;
    let abortListener;
    const aborted = new Promise((_resolve, reject) => {
      abortListener = () => reject(active.signal.reason || problem('ABORTED'));
      active.signal.addEventListener('abort', abortListener, { once: true });
    });
    deadlineTimer = setTimeout(() => active.abort(problem('TIMEOUT')), REQUEST_TIMEOUT_MS);
    deadlineTimer.unref?.();
    // Defer work so the pending promise is assigned even if an injected fetch throws synchronously.
    const task = Promise.resolve().then(async () => {
      try {
        const loading = Promise.resolve().then(async () => {
          if (active.signal.aborted) throw active.signal.reason || problem('ABORTED');
          const response = await fetchImpl(UPDATE_MANIFEST_URL, {
            method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit',
            redirect: 'error', cache: 'no-store', signal: active.signal,
          });
          return readManifest(response, active.signal);
        });
        const latestVersion = await Promise.race([loading, aborted]);
        if (disposed) return status();
        const completedAt = timestamp();
        state = { ...state, state: available(latestVersion) ? 'available' : 'current', latestVersion,
          checkedAt: new Date(completedAt).toISOString(), error: null };
        nextCheckAt = completedAt + intervalMs;
      } catch (error) {
        if (disposed) return status();
        const completedAt = timestamp();
        const message = error?.code === 'TIMEOUT' ? '检查更新超时，请稍后重试。'
          : error?.code === 'INVALID_RESPONSE' ? 'GitHub 版本信息无效，请稍后重试。' : '暂时无法检查 GitHub 更新，请稍后重试。';
        state = { ...state, state: available(state.latestVersion) ? 'available' : 'error',
          checkedAt: new Date(completedAt).toISOString(), error: message };
        nextCheckAt = completedAt + retryMs;
      }
      return status();
    }).finally(() => {
      active.signal.removeEventListener('abort', abortListener);
      if (controller === active) { controller = null; clearDeadline(); }
      if (pending === task) pending = null;
      schedule();
    });
    pending = task;
    return task;
  }

  return {
    start() {
      if (!started && !disposed) { started = true; void check(); schedule(); }
      return status();
    },
    check,
    status,
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      clearScheduled();
      clearDeadline();
      controller?.abort(problem('DISPOSED'));
    },
  };
}
