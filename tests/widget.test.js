import assert from 'node:assert/strict';
import test from 'node:test';
import { mountWidget } from '../lib/widget.js';

// Only the DOM and timer surface used by mountWidget is emulated; requests remain observable.
function createEnvironment() {
  const allTargets = [];
  const hosts = new Map();
  const timers = new Map();
  const clipboardWrites = [];
  let timerId = 0;
  const target = (extra = {}) => {
    const listeners = new Map();
    const instance = {
      listeners,
      addEventListener(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
      },
      removeEventListener(event, listener) { listeners.get(event)?.delete(listener); },
      dispatch(event, payload = {}) {
        for (const listener of listeners.get(event) || []) listener({ target: instance, preventDefault() {}, ...payload });
      },
      ...extra,
    };
    allTargets.push(instance);
    return instance;
  };
  const element = () => target({
    id: '', style: {}, hidden: false, textContent: '', value: '', attributes: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    focus() {},
    remove() { hosts.delete(this.id); },
    closest() { return null; },
    getBoundingClientRect() { return { left: 8, top: 8, right: 292, bottom: 328, width: 284, height: 320 }; },
    attachShadow() {
      const entries = new Map();
      const card = element();
      const header = element();
      this.shadowRoot = {
        set innerHTML(value) {
          for (const match of value.matchAll(/id="([^"]+)"/g)) entries.set(match[1], element());
        },
        getElementById(id) { return entries.get(id); },
        querySelector() { return card; },
        querySelectorAll() { return [header, entries.get('pill')]; },
      };
      return this.shadowRoot;
    },
  });
  const window = target({
    innerWidth: 1200, innerHeight: 800,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    navigator: { clipboard: { async writeText(value) { clipboardWrites.push(value); } } },
  });
  const document = target({
    hidden: false, defaultView: window,
    body: { append(host) { hosts.set(host.id, host); } },
    getElementById(id) { return hosts.get(id); },
    createElement() { return element(); },
  });
  return {
    document, window, timers, clipboardWrites,
    element(id) { return hosts.get('tongji-ai-usage-widget')?.shadowRoot.getElementById(id); },
    assertClean() {
      assert.equal(hosts.size, 0, 'dispose removes the widget DOM');
      assert.equal(timers.size, 0, 'dispose clears every scheduled timer');
      assert.equal(allTargets.reduce((sum, item) => sum + [...item.listeners.values()].reduce((count, entries) => count + entries.size, 0), 0), 0, 'dispose removes all DOM/window/document listeners');
    },
  };
}

const successfulSnapshot = (overrides = {}) => ({
  error: null,
  report: {
    plan: { name: null },
    points: { source: 'account', planRemaining: 123, totalAvailable: 123 },
    usage: { range: 'today', pointsCost: 2, totalTokens: 14, inputTokens: 4, cachedInputTokens: 8, outputTokens: 2, calls: 1 },
    queriedAt: '2026-11-13T12:00:00Z',
    warnings: [],
    ...overrides,
  },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
function mountWithQueue(environment, snapshots) {
  const calls = [];
  const dispose = mountWidget({
    document: environment.document,
    storage: null,
    call: async (action, payload) => {
      calls.push({ action, payload });
      assert.ok(snapshots.length > 0, 'unexpected extra request');
      return snapshots.shift();
    },
  });
  return { dispose, calls };
}

test('account source uses the account label and dispose removes DOM, timers, and listeners', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [successfulSnapshot()]);
  await settle();
  assert.equal(environment.element('balance-label').textContent, '账户总积分');
  assert.equal(environment.element('balance').textContent, '123');
  assert.equal(environment.element('today-cost').textContent, '2');
  assert.equal(environment.timers.size, 1);
  dispose();
  dispose();
  environment.assertClean();
});

for (const code of ['AUTH_MISSING', 'AUTH_EXPIRED', 'INVALID_CREDENTIALS']) {
  test(`${code} clears formerly successful balance and daily statistics`, async () => {
    const environment = createEnvironment();
    const { dispose } = mountWithQueue(environment, [successfulSnapshot(), { report: null, error: { code, message: '请重新登录。' } }]);
    await settle();
    environment.element('refresh').dispatch('click');
    await settle();
    assert.equal(environment.element('balance').textContent, '—');
    assert.equal(environment.element('today-cost').textContent, '—');
    assert.equal(environment.element('setup').hidden, false);
    dispose();
    environment.assertClean();
  });
}

test('network failure preserves the last successful value and marks it old', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [successfulSnapshot(), { report: null, error: { code: 'NETWORK', message: '更新失败。' } }]);
  await settle();
  environment.element('refresh').dispatch('click');
  await settle();
  assert.equal(environment.element('balance').textContent, '123');
  assert.equal(environment.element('today-cost').textContent, '2');
  assert.match(environment.element('status').textContent, /更新失败 · 上次/);
  assert.equal(environment.element('today-label').textContent, '今日已用 · 上次统计');
  dispose();
  environment.assertClean();
});

test('fresh balance with unavailable statistics clears an older daily value', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [successfulSnapshot(), successfulSnapshot({
    points: { source: 'account', planRemaining: 456, totalAvailable: 456 },
    usage: null,
    queriedAt: '2026-11-13T12:01:00Z',
    warnings: [{ code: 'STATS_UNAVAILABLE', message: 'Token 统计暂不可用。' }],
  })]);
  await settle();
  environment.element('refresh').dispatch('click');
  await settle();
  assert.equal(environment.element('balance').textContent, '456');
  assert.equal(environment.element('today-cost').textContent, '—');
  assert.equal(environment.element('today-label').textContent, '今日已用 · 暂不可用');
  assert.match(environment.element('notice').textContent, /今日统计暂不可用/);
  dispose();
  environment.assertClean();
});

test('daily preflight clears unavailable daily statistics while another range succeeds', async () => {
  const environment = createEnvironment();
  const { dispose, calls } = mountWithQueue(environment, [successfulSnapshot(), successfulSnapshot({ usage: null }), successfulSnapshot({ usage: { range: '7d', pointsCost: 20 } })]);
  await settle();
  environment.element('range').value = '7d';
  environment.element('range').dispatch('change');
  await settle();
  assert.deepEqual(calls.map(({ payload }) => payload.range), ['today', 'today', '7d']);
  assert.equal(environment.element('today-cost').textContent, '—');
  assert.equal(environment.element('range-cost').textContent, '20');
  assert.equal(environment.element('today-label').textContent, '今日已用 · 暂不可用');
  dispose();
  environment.assertClean();
});

test('daily preflight authentication failure clears account data and skips the selected range', async () => {
  const environment = createEnvironment();
  const { dispose, calls } = mountWithQueue(environment, [successfulSnapshot(), { report: null, error: { code: 'AUTH_EXPIRED', message: '请重新登录。' } }]);
  await settle();
  environment.element('range').value = '7d';
  environment.element('range').dispatch('change');
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(environment.element('balance').textContent, '—');
  assert.equal(environment.element('today-cost').textContent, '—');
  assert.equal(environment.element('setup').hidden, false);
  dispose();
  environment.assertClean();
});

test('hidden document pauses polling and an in-flight result cannot recreate a disposed widget', async () => {
  const environment = createEnvironment();
  let resolvePending;
  let count = 0;
  const dispose = mountWidget({
    document: environment.document,
    storage: null,
    call: async () => ++count === 1 ? successfulSnapshot() : new Promise((resolve) => { resolvePending = resolve; }),
  });
  await settle();
  environment.document.hidden = true;
  environment.document.dispatch('visibilitychange');
  assert.equal(environment.timers.size, 0);
  environment.document.hidden = false;
  environment.document.dispatch('visibilitychange');
  assert.equal(count, 2);
  dispose();
  resolvePending(successfulSnapshot());
  await settle();
  environment.assertClean();
});

const autoLoginState = (overrides = {}) => ({
  state: 'idle', enabled: true, paired: true, connected: true, port: 17945,
  expiresAt: '2026-11-14T12:00:00Z', lastRenewedAt: '2026-11-13T12:00:00Z',
  message: '', extensionPath: 'D:\\plugins\\example\\browser-extension', ...overrides,
});
const autoSnapshot = (autoLogin, reportOverrides = {}) => ({ ...successfulSnapshot(reportOverrides), autoLogin });

test('automatic login status is available in settings and expiry errors prioritize its guidance', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [{
    report: null, error: { code: 'AUTH_EXPIRED', message: '旧的手动导入提示。' },
    autoLogin: autoLoginState({ state: 'opening' }),
  }]);
  await settle();
  assert.match(environment.element('setup-message').textContent, /Chrome 自动更新登录/);
  assert.match(environment.element('notice').textContent, /Chrome 自动更新登录/);
  assert.equal(environment.element('manual-setup').hidden, true);
  assert.equal([...environment.timers.values()][0].delay, 5000);
  environment.element('setup-auto-settings').dispatch('click');
  assert.equal(environment.element('settings').hidden, false);
  assert.equal(environment.element('auto-login-section').hidden, false);
  environment.element('manual-toggle').dispatch('click');
  assert.equal(environment.element('manual-setup').hidden, false);
  dispose();
  environment.assertClean();
});

test('waiting for school login explains the user action and keeps fast status polling', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [{
    report: null, error: { code: 'AUTH_MISSING', message: '未登录。' },
    autoLogin: autoLoginState({ state: 'waiting_for_login' }),
  }]);
  await settle();
  assert.match(environment.element('setup-message').textContent, /在 Chrome 完成学校登录/);
  assert.equal([...environment.timers.values()][0].delay, 5000);
  dispose();
  environment.assertClean();
});

test('offline Chrome assistant guidance does not tell the user to copy a website token', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [{
    report: null, error: { code: 'AUTH_EXPIRED', message: '请手动导入 access_token。' },
    autoLogin: autoLoginState({ state: 'offline', connected: false }),
  }]);
  await settle();
  assert.match(environment.element('notice').textContent, /助手离线，请打开 Chrome/);
  assert.ok(!environment.element('setup-message').textContent.includes('access_token'));
  assert.equal([...environment.timers.values()][0].delay, 60000);
  dispose();
  environment.assertClean();
});

test('pairing displays and copies a leading-zero connection code without replacing the report', async () => {
  const environment = createEnvironment();
  const unpaired = autoLoginState({ state: 'unpaired', paired: false, connected: false });
  const { dispose, calls } = mountWithQueue(environment, [autoSnapshot(unpaired), {
    autoLogin: unpaired, pairCode: '01234567', pairExpiresAt: new Date(Date.now() + 300000).toISOString(),
  }]);
  await settle();
  environment.element('auto-pair').dispatch('click');
  await settle();
  assert.deepEqual(calls.map(({ action }) => action), ['status', 'auto-login']);
  assert.deepEqual(calls[1].payload, { action: 'pair' });
  assert.equal(environment.element('pairing').hidden, false);
  assert.equal(environment.element('pair-code').textContent, '01234567');
  assert.equal(environment.element('balance').textContent, '123');
  environment.element('copy-pair-code').dispatch('click');
  environment.element('copy-extension-path').dispatch('click');
  await settle();
  assert.deepEqual(environment.clipboardWrites, ['01234567', unpaired.extensionPath]);
  dispose();
  environment.assertClean();
});

test('renewal updates login metadata first and only a normal status response replaces the balance', async () => {
  const environment = createEnvironment();
  const calls = [];
  let completeStatus;
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async (action, payload) => {
      calls.push({ action, payload });
      if (calls.length === 1) return autoSnapshot(autoLoginState());
      if (action === 'auto-login') return { autoLogin: autoLoginState({ state: 'queued' }), report: { points: { planRemaining: 999 } } };
      return new Promise(resolve => { completeStatus = resolve; });
    },
  });
  await settle();
  environment.element('auto-renew').dispatch('click');
  await settle();
  assert.deepEqual(calls.map(({ action }) => action), ['status', 'auto-login', 'status']);
  assert.deepEqual(calls[1].payload, { action: 'renew' });
  assert.equal(environment.element('balance').textContent, '123');
  completeStatus(autoSnapshot(autoLoginState({ state: 'success' }), { points: { source: 'account', planRemaining: 456 } }));
  await settle();
  assert.equal(environment.element('balance').textContent, '456');
  assert.equal(environment.element('auto-state').textContent, '登录已自动更新。');
  assert.equal([...environment.timers.values()][0].delay, 60000);
  dispose();
  environment.assertClean();
});

test('enabling and disabling automatic login use the backend actions', async () => {
  const environment = createEnvironment();
  const disabled = autoLoginState({ state: 'disabled', enabled: false });
  const enabled = autoLoginState();
  const { dispose, calls } = mountWithQueue(environment, [
    autoSnapshot(disabled), { autoLogin: enabled }, autoSnapshot(enabled),
    { autoLogin: disabled }, autoSnapshot(disabled),
  ]);
  await settle();
  environment.element('auto-toggle').dispatch('click');
  await settle();
  assert.equal(environment.element('auto-toggle').textContent, '停用自动更新');
  environment.element('auto-toggle').dispatch('click');
  await settle();
  assert.deepEqual(calls.filter(({ action }) => action === 'auto-login').map(({ payload }) => payload.action), ['enable', 'disable']);
  assert.equal(environment.element('auto-toggle').textContent, '启用自动更新');
  assert.equal(environment.element('auto-renew').disabled, true);
  dispose();
  environment.assertClean();
});

test('disposing while a pairing action is pending prevents its result from adding DOM or timers', async () => {
  const environment = createEnvironment();
  let completePair;
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async (action) => action === 'status' ? autoSnapshot(autoLoginState({ state: 'unpaired', paired: false }))
      : new Promise(resolve => { completePair = resolve; }),
  });
  await settle();
  environment.element('auto-pair').dispatch('click');
  await settle();
  dispose();
  completePair({ autoLogin: autoLoginState(), pairCode: '01234567' });
  await settle();
  environment.assertClean();
});
