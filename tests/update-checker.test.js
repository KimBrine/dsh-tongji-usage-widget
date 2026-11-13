import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateChecker, UPDATE_MANIFEST_URL, UPDATE_URL } from '../lib/update-checker.js';

const manifest = (version, extra = {}) => new Response(JSON.stringify({ name: 'dsh-tongji-usage-widget', version, ...extra }));
const tick = () => new Promise(resolve => setImmediate(resolve));
function timers(t) {
  let counter = 0;
  const active = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const handle = { id: ++counter, unref() {} };
    active.set(handle, { callback, delay });
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => active.delete(handle));
  return {
    active,
    delays: () => [...active.values()].map(timer => timer.delay),
    fire(delay) {
      const entry = [...active].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected scheduled timer with delay ${delay}`);
      active.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('public manifest request is fixed, anonymous, non-redirecting and reports only allowed fields', async () => {
  const requests = [];
  const checker = createUpdateChecker({ currentVersion: '0.2.1', now: () => 1000,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return manifest('0.3.0', { homepage: 'https://untrusted.example', accessToken: 'SECRET' }); } });
  try {
    assert.equal(checker.status().state, 'unchecked');
    const result = await checker.check();
    assert.deepEqual(result, { state: 'available', currentVersion: '0.2.1', latestVersion: '0.3.0', url: UPDATE_URL,
      checkedAt: '1970-01-01T00:00:01.000Z', error: null });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, UPDATE_MANIFEST_URL);
    assert.deepEqual(requests[0].options.headers, { Accept: 'application/json' });
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.redirect, 'error');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.ok(requests[0].options.signal instanceof AbortSignal);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    result.state = 'tampered';
    assert.equal(checker.status().state, 'available');
  } finally { checker.dispose(); }
});

test('concurrent callers share one promise, automatic cache is 6h and manual cooldown is 60s', async () => {
  let calls = 0, clock = 1000, release;
  const checker = createUpdateChecker({ currentVersion: '1.0.0', now: () => clock,
    fetchImpl: async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return manifest('1.0.0'); } });
  try {
    const first = checker.check();
    const same = checker.check({ force: true });
    assert.equal(first, same);
    assert.equal(checker.status().state, 'checking');
    await tick(); release(); await first;
    assert.equal(calls, 1);
    clock += 59_999;
    await checker.check({ force: true });
    assert.equal(calls, 1);
    clock++;
    await checker.check({ force: true });
    assert.equal(calls, 2);
    clock += 21_599_999;
    await checker.check();
    assert.equal(calls, 2);
    clock++;
    await checker.check();
    assert.equal(calls, 3);
  } finally { checker.dispose(); }
});

test('failure preserves an already-known update and retries automatically after 15min', async t => {
  const timing = timers(t);
  let calls = 0, clock = 0;
  const checker = createUpdateChecker({ currentVersion: '1.0.0', now: () => clock,
    fetchImpl: async () => { calls++; if (calls === 2) throw new Error('SECRET Authorization Bearer token'); return manifest('1.1.0'); } });
  try {
    checker.start(); await checker.check();
    assert.deepEqual(timing.delays(), [21_600_000]);
    clock = 60_000;
    const failed = await checker.check({ force: true });
    assert.equal(failed.state, 'available');
    assert.equal(failed.latestVersion, '1.1.0');
    assert.ok(failed.error && !failed.error.includes('SECRET'));
    assert.deepEqual(timing.delays(), [900_000]);
    clock += 899_999;
    await checker.check(); assert.equal(calls, 2);
    clock++;
    timing.fire(900_000);
    await checker.check();
    assert.equal(calls, 3);
    assert.equal(checker.status().error, null);
    assert.deepEqual(timing.delays(), [21_600_000]);
  } finally { checker.dispose(); }
  assert.equal(timing.active.size, 0);
});

test('semantic versions compare numeric releases, prerelease identifiers and ignore build metadata', async () => {
  const cases = [
    ['1.9.9', '1.10.0', 'available'], ['2.0.0', '1.99.99', 'current'],
    ['1.2.3+local', '1.2.3+remote', 'current'], ['1.0.0-alpha.2', '1.0.0-alpha.10', 'available'],
    ['1.0.0-alpha.10', '1.0.0-alpha.2', 'current'], ['1.0.0-alpha.1', '1.0.0-alpha.beta', 'available'],
    ['1.0.0-beta', '1.0.0-beta.2', 'available'], ['1.0.0-rc.1', '1.0.0', 'available'],
    ['1.0.0', '2.0.0-beta.1', 'current'], ['1.0.0', '1.0.1-rc.1', 'current'],
    ['1.0.0-alpha', '1.0.0-alpha.0', 'available'], ['1.0.0-z', '1.0.0-1', 'current'],
    ['9007199254740992.0.0', '9007199254740993.0.0', 'available'],
  ];
  for (const [currentVersion, latestVersion, expected] of cases) {
    const checker = createUpdateChecker({ currentVersion, fetchImpl: async () => manifest(latestVersion) });
    try {
      const result = await checker.check();
      assert.equal(result.state, expected, `${currentVersion} → ${latestVersion}`);
      assert.equal(result.latestVersion, latestVersion);
    } finally { checker.dispose(); }
  }
});

test('invalid package identity, JSON, versions, redirects and HTTP errors stay redacted', async () => {
  const responses = [
    () => manifest('1.1.0', { name: 'another-package-SECRET' }),
    () => new Response('<html>SECRET</html>'),
    ...['1.2', 'v1.2.3', '01.2.3', '1.2.3-alpha.01', '1.2.3+bad build', '1.2.3\nSECRET'].map(version => () => manifest(version)),
    () => new Response('SECRET', { status: 403 }),
  ];
  responses.push(() => {
    const response = manifest('1.1.0');
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  });
  responses.push(() => {
    const response = manifest('1.1.0');
    Object.defineProperty(response, 'url', { value: 'https://untrusted.example/package.json' });
    return response;
  });
  for (const response of responses) {
    const checker = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => response() });
    try {
      const result = await checker.check();
      assert.equal(result.state, 'error');
      assert.equal(result.latestVersion, null);
      assert.ok(result.error && !JSON.stringify(result).includes('SECRET'));
      assert.equal(result.url, UPDATE_URL);
    } finally { checker.dispose(); }
  }
});

test('response limit rejects both declared and streamed oversized data and cancels the stream', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(70_000)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(body, { headers: declared ? { 'Content-Length': '70000' } : {} });
    const checker = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => response });
    try {
      assert.equal((await checker.check()).state, 'error');
      assert.equal(cancelled, true);
    } finally { checker.dispose(); }
  }
});

test('8s deadline aborts hanging fetches and schedules failure retry without leaking timers', async t => {
  const timing = timers(t);
  let signal;
  const checker = createUpdateChecker({ currentVersion: '1.0.0', now: () => 0,
    fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  checker.start();
  const result = checker.check();
  await tick();
  assert.equal(signal.aborted, false);
  timing.fire(8000);
  const failed = await result;
  assert.equal(signal.aborted, true);
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /超时/);
  assert.deepEqual(timing.delays(), [900_000]);
  checker.dispose();
  assert.equal(timing.active.size, 0);
});

test('8s deadline also cancels a stalled response body', async t => {
  const timing = timers(t);
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const checker = createUpdateChecker({ currentVersion: '1.0.0',
    fetchImpl: async () => new Response(body) });
  try {
    const pending = checker.check();
    await tick();
    timing.fire(8000);
    const result = await pending;
    assert.equal(result.state, 'error');
    assert.match(result.error, /超时/);
    assert.equal(cancelled, true);
    assert.equal(timing.active.size, 0);
  } finally { checker.dispose(); }
});

test('dispose before the request microtask prevents starting a fetch', async t => {
  const timing = timers(t);
  let calls = 0;
  const checker = createUpdateChecker({ currentVersion: '1.0.0',
    fetchImpl: async () => { calls++; return manifest('2.0.0'); } });
  const pending = checker.check();
  const before = checker.status();
  checker.dispose();
  await pending;
  await tick();
  assert.equal(calls, 0);
  assert.equal(timing.active.size, 0);
  assert.deepEqual(checker.status(), before);
});

test('dispose aborts synchronously and late responses cannot change status or restart polling', async t => {
  const timing = timers(t);
  let release, signal, calls = 0;
  const checker = createUpdateChecker({ currentVersion: '1.0.0',
    fetchImpl: (_url, options) => { calls++; signal = options.signal; return new Promise(resolve => { release = resolve; }); } });
  checker.start();
  const pending = checker.check();
  await tick();
  const before = checker.status();
  checker.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(timing.active.size, 0);
  await pending;
  release(manifest('99.0.0'));
  await tick();
  assert.deepEqual(checker.status(), before);
  checker.start(); await checker.check({ force: true }); checker.dispose();
  assert.equal(calls, 1);
  assert.equal(timing.active.size, 0);
});

test('startup is nonblocking/idempotent, and the local default version is read from package.json', async t => {
  const timing = timers(t);
  let calls = 0;
  const checker = createUpdateChecker({ fetchImpl: async () => { calls++; return manifest('0.0.0'); } });
  const started = checker.start();
  assert.equal(started.state, 'checking');
  assert.equal(typeof started.currentVersion, 'string');
  checker.start();
  await checker.check();
  assert.equal(calls, 1);
  assert.equal(checker.status().state, 'current');
  assert.equal(timing.active.size, 1);
  checker.dispose();
  assert.equal(timing.active.size, 0);
});
