import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mountWidget } from '../lib/widget.js';

const { version: currentVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

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
          for (const match of value.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
            const node = element();
            for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], attribute[2]);
            node.textContent = value.slice(match.index + match[0].length).match(/^([^<]*)</)?.[1] || '';
            entries.set(match[1], node);
          }
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

test('quota refresh defaults to thirty seconds and automatic polling keeps using the existing login', async () => {
  const environment = createEnvironment();
  const { dispose, calls } = mountWithQueue(environment, [successfulSnapshot(), successfulSnapshot({ points: { source: 'account', planRemaining: 120 } })]);
  await settle();
  assert.match(environment.element('status').textContent, /30秒刷新/);
  assert.equal(environment.element('refresh-quota').textContent, '刷新额度');
  assert.equal([...environment.timers.values()][0].delay, 30000);
  [...environment.timers.values()][0].callback();
  await settle();
  assert.equal(environment.element('balance').textContent, '120');
  assert.deepEqual(calls, [
    { action: 'status', payload: { range: 'today', force: false } },
    { action: 'status', payload: { range: 'today', force: false } },
  ]);
  assert.equal([...environment.timers.values()][0].delay, 30000);
  dispose(); environment.assertClean();
});

test('visible quota refresh button forces one query, coalesces clicks and never requests a login update', async () => {
  const environment = createEnvironment();
  const calls = []; let finish;
  const dispose = mountWidget({ document: environment.document, storage: null, call: async (action, payload) => {
    calls.push({ action, payload });
    if (calls.length === 1) return successfulSnapshot();
    return new Promise(resolve => { finish = resolve; });
  } });
  await settle();
  environment.element('refresh-quota').dispatch('click');
  environment.element('refresh-quota').dispatch('click');
  environment.element('refresh').dispatch('click');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { action: 'status', payload: { range: 'today', force: true } });
  assert.equal(environment.element('refresh-quota').textContent, '刷新中…');
  assert.equal(environment.element('refresh-quota').disabled, true);
  assert.equal(environment.element('refresh').disabled, true);
  assert.equal(environment.element('refresh-quota').attributes['aria-busy'], 'true');
  finish(successfulSnapshot({ points: { source: 'account', planRemaining: 456 } }));
  await settle();
  assert.equal(environment.element('balance').textContent, '456');
  assert.equal(environment.element('refresh-quota').textContent, '刷新额度');
  assert.equal(environment.element('refresh-quota').disabled, false);
  assert.equal(environment.timers.size, 1);
  assert.equal([...environment.timers.values()][0].delay, 30000);
  assert.ok(calls.every(({ action }) => action === 'status'));
  dispose(); environment.assertClean();
});

test('manual quota refresh preserves the selected range while refreshing today for the budget', async () => {
  const environment = createEnvironment();
  const sevenDays = cost => successfulSnapshot({ usage: { range: '7d', pointsCost: cost, totalTokens: 30, calls: 2 } });
  const { dispose, calls } = mountWithQueue(environment, [successfulSnapshot(), successfulSnapshot(), sevenDays(10),
    successfulSnapshot({ usage: { range: 'today', pointsCost: 4, totalTokens: 20, calls: 1 } }), sevenDays(12)]);
  await settle();
  environment.element('range').value = '7d'; environment.element('range').dispatch('change');
  await settle();
  environment.element('refresh-quota').dispatch('click');
  await settle();
  assert.equal(environment.element('range').value, '7d');
  assert.equal(environment.element('range-cost').textContent, '12');
  assert.equal(environment.element('today-cost').textContent, '4');
  assert.deepEqual(calls.slice(-2), [
    { action: 'status', payload: { range: 'today', force: true } },
    { action: 'status', payload: { range: '7d', force: true } },
  ]);
  dispose(); environment.assertClean();
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
  state: 'idle', enabled: true, paired: true, connected: true, browser: 'chrome', port: 17945,
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
  assert.equal([...environment.timers.values()][0].delay, 30000);
  dispose();
  environment.assertClean();
});

test('unpaired guidance is browser neutral and names both Edge and Chrome installation pages', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [{
    report: null, error: { code: 'AUTH_MISSING', message: '未登录。' },
    autoLogin: autoLoginState({ state: 'unpaired', browser: null, paired: false, connected: false }),
  }]);
  await settle();
  assert.equal(environment.element('auto-pair').textContent, '连接浏览器助手');
  assert.match(environment.element('setup-message').textContent, /先连接一次浏览器助手/);
  assert.ok(!environment.element('setup-message').textContent.includes('Chrome'));
  assert.match(environment.element('extension-guide').textContent, /Edge 的 edge:\/\/extensions 或 Chrome 的 chrome:\/\/extensions/);
  dispose();
  environment.assertClean();
});

test('Edge renewal, school login and offline states consistently identify the paired browser', async () => {
  const environment = createEnvironment();
  const snapshot = overrides => ({ report: null, error: { code: 'AUTH_EXPIRED', message: '已过期。' },
    autoLogin: autoLoginState({ browser: 'edge', ...overrides }) });
  const { dispose } = mountWithQueue(environment, [
    snapshot({ state: 'opening' }), snapshot({ state: 'waiting_for_login' }),
    snapshot({ state: 'offline', connected: false }), snapshot({ state: 'queued', connected: false }),
  ]);
  await settle();
  assert.match(environment.element('setup-message').textContent, /通过 Edge 自动更新登录/);
  assert.equal(environment.element('auto-pair').textContent, '重新连接助手');
  environment.element('refresh').dispatch('click');
  await settle();
  assert.match(environment.element('setup-message').textContent, /在 Edge 完成学校登录/);
  environment.element('refresh').dispatch('click');
  await settle();
  assert.match(environment.element('setup-message').textContent, /Edge 助手离线，请打开 Edge；/);
  environment.element('refresh').dispatch('click');
  await settle();
  assert.match(environment.element('setup-message').textContent, /已排队，请打开 Edge；/);
  assert.ok(!environment.element('setup-message').textContent.includes('Chrome'));
  dispose();
  environment.assertClean();
});

test('a paired browser with unknown identity is not assumed to be Chrome', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [{
    report: null, error: { code: 'AUTH_EXPIRED', message: '已过期。' },
    autoLogin: autoLoginState({ state: 'offline', browser: null, connected: false }),
  }]);
  await settle();
  assert.match(environment.element('auto-state').textContent, /已配对浏览器助手离线，请打开已配对浏览器/);
  assert.ok(!/Chrome|Edge/.test(environment.element('auto-state').textContent));
  dispose();
  environment.assertClean();
});

test('automatic login explains the twelve-hour and browser-start policy using backend interval metadata', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [
    autoSnapshot(autoLoginState({ browser: 'edge', message: '旧的临近到期提示。' })),
    autoSnapshot(autoLoginState({ browser: 'edge', renewIntervalHours: 6 })),
  ]);
  await settle();
  assert.match(environment.element('auto-state').textContent, /Edge 助手已连接，每12小时尝试更新，浏览器助手启动时也会更新/);
  assert.match(environment.element('extension-guide').textContent, /每12小时尝试更新，浏览器助手启动时也会更新/);
  assert.ok(!environment.element('auto-state').textContent.includes('临近到期'));
  environment.element('refresh').dispatch('click');
  await settle();
  assert.match(environment.element('auto-state').textContent, /每6小时尝试更新/);
  assert.match(environment.element('extension-guide').textContent, /每6小时尝试更新/);
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
  assert.equal([...environment.timers.values()][0].delay, 30000);
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

const updateState = (overrides = {}) => ({
  state: 'current', currentVersion, latestVersion: currentVersion,
  url: 'https://github.com/KimBrine/dsh-tongji-usage-widget',
  checkedAt: '2026-11-14T12:00:00Z', error: null, ...overrides,
});

test('a new version has its own card and capsule markers alongside the low balance warning', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [{
    ...successfulSnapshot({ points: { source: 'account', planRemaining: 42, totalAvailable: 42 } }),
    updates: updateState({ state: 'available', latestVersion: '0.3.0', url: 'https://untrusted.example/update' }),
  }]);
  await settle();
  assert.equal(environment.element('update-notice').hidden, false);
  assert.equal(environment.element('update-notice-text').textContent, '发现新版本 v0.3.0');
  assert.match(environment.element('notice').textContent, /剩余积分低于 100/);
  environment.element('collapse').dispatch('click');
  assert.equal(environment.element('pill').hidden, false);
  assert.equal(environment.element('pill-update').hidden, false);
  assert.equal(environment.element('pill-alert').hidden, false);
  assert.match(environment.element('pill').attributes['aria-label'], /剩余积分低于 100.*发现新版本 v0.3.0/);
  assert.match(environment.element('pill').title, /发现新版本 v0.3.0/);
  assert.equal(environment.element('update-link').attributes.href, 'https://github.com/KimBrine/dsh-tongji-usage-widget/releases/latest');
  assert.equal(environment.element('update-help').attributes.href, 'https://github.com/KimBrine/dsh-tongji-usage-widget/releases/latest');
  for (const id of ['update-link', 'update-help']) {
    assert.equal(environment.element(id).attributes.target, '_blank');
    assert.match(environment.element(id).attributes.rel, /noopener/);
  }
  dispose();
  environment.assertClean();
});

test('manual update checking coalesces clicks and only changes version metadata', async () => {
  const environment = createEnvironment();
  const calls = [];
  let completeCheck;
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async action => {
      calls.push(action);
      if (action === 'status') return { ...autoSnapshot(autoLoginState()), updates: updateState() };
      return new Promise(resolve => { completeCheck = resolve; });
    },
  });
  await settle();
  environment.element('settings-toggle').dispatch('click');
  assert.equal(environment.element('update-current').textContent, `当前版本 v${currentVersion}`);
  assert.equal(environment.element('update-status').textContent, '已是最新版本');
  assert.match(environment.element('update-checked-at').textContent, /上次检查：/);
  environment.element('check-update').dispatch('click');
  environment.element('check-update').dispatch('click');
  assert.deepEqual(calls, ['status', 'check-update']);
  assert.equal(environment.element('check-update').disabled, true);
  assert.equal(environment.element('update-status').textContent, '正在检查更新…');
  assert.equal(environment.element('balance').textContent, '123');
  completeCheck({ updates: updateState({ state: 'available', latestVersion: '0.3.0' }),
    report: { points: { planRemaining: 999 } }, autoLogin: autoLoginState({ state: 'disabled', enabled: false }) });
  await settle();
  assert.equal(environment.element('balance').textContent, '123');
  assert.equal(environment.element('today-cost').textContent, '2');
  assert.equal(environment.element('auto-toggle').textContent, '停用自动更新');
  assert.equal(environment.element('check-update').disabled, false);
  assert.equal(environment.element('update-notice').hidden, false);
  assert.equal(environment.timers.size, 1);
  assert.equal([...environment.timers.values()][0].delay, 30000);
  dispose();
  environment.assertClean();
});

test('a failed update check preserves an available version and shows failure only in settings', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [
    { ...successfulSnapshot(), updates: updateState({ state: 'available', latestVersion: '0.3.0' }) },
    { updates: updateState({ state: 'error', latestVersion: null, checkedAt: '2026-11-14T12:01:00Z', error: '无法连接 GitHub，请稍后重试。' }) },
    { updates: updateState({ state: 'current', checkedAt: '2026-11-14T12:02:00Z' }) },
  ]);
  await settle();
  environment.element('check-update').dispatch('click');
  await settle();
  assert.equal(environment.element('update-notice').hidden, false);
  assert.equal(environment.element('update-notice-text').textContent, '发现新版本 v0.3.0');
  assert.equal(environment.element('pill-update').hidden, false);
  assert.equal(environment.element('update-status').textContent, '检查更新失败');
  assert.equal(environment.element('update-error').hidden, false);
  assert.equal(environment.element('update-error').textContent, '无法连接 GitHub，请稍后重试。');
  assert.equal(environment.element('balance').textContent, '123');
  environment.element('check-update').dispatch('click');
  await settle();
  assert.equal(environment.element('update-notice').hidden, true);
  assert.equal(environment.element('pill-update').hidden, true);
  assert.equal(environment.element('update-status').textContent, '已是最新版本');
  assert.equal(environment.element('update-error').hidden, true);
  dispose();
  environment.assertClean();
});

test('a rejected update request does not describe a previous check as the latest version', async () => {
  const environment = createEnvironment();
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async action => {
      if (action === 'status') return { ...successfulSnapshot(), updates: updateState() };
      throw new Error('request failed');
    },
  });
  await settle();
  environment.element('check-update').dispatch('click');
  await settle();
  assert.equal(environment.element('update-status').textContent, '检查更新失败');
  assert.match(environment.element('update-error').textContent, /暂时无法检查更新/);
  assert.equal(environment.element('update-notice').hidden, true);
  assert.equal(environment.element('balance').textContent, '123');
  dispose();
  environment.assertClean();
});

test('version strings remain text and an older status snapshot cannot replace a newer check', async () => {
  const environment = createEnvironment();
  const version = '0.3.0 <img src=x>';
  const { dispose } = mountWithQueue(environment, [
    { ...successfulSnapshot(), updates: updateState({ state: 'unchecked', checkedAt: null }) },
    { updates: updateState({ state: 'available', latestVersion: version }) },
    { ...successfulSnapshot(), updates: updateState({ state: 'unchecked', checkedAt: null }) },
  ]);
  await settle();
  environment.element('check-update').dispatch('click');
  await settle();
  assert.equal(environment.element('update-notice-text').textContent, `发现新版本 v${version}`);
  environment.element('refresh').dispatch('click');
  await settle();
  assert.equal(environment.element('update-status').textContent, `发现新版本 v${version}`);
  assert.equal(environment.element('update-notice').hidden, false);
  dispose();
  environment.assertClean();
});

test('disposing during update checking prevents late results from restoring DOM or timers', async () => {
  const environment = createEnvironment();
  let completeCheck;
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async action => action === 'status' ? { ...successfulSnapshot(), updates: updateState() }
      : new Promise(resolve => { completeCheck = resolve; }),
  });
  await settle();
  environment.element('check-update').dispatch('click');
  await settle();
  dispose();
  completeCheck({ updates: updateState({ state: 'available', latestVersion: '0.3.0' }) });
  await settle();
  environment.assertClean();
});

const installState = (overrides = {}) => ({ state: 'idle', canInstall: true, message: '', ...overrides });
const installSnapshot = (installer, overrides = {}) => ({
  updates: updateState({ state: 'available', latestVersion: '0.3.0', installer, ...overrides }),
});

test('card and settings install buttons coalesce one payload-free request and require a restart after success', async () => {
  const environment = createEnvironment();
  const calls = [];
  let completeInstall;
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'status') return { ...autoSnapshot(autoLoginState()), ...installSnapshot(installState()) };
      return new Promise(resolve => { completeInstall = resolve; });
    },
  });
  await settle();
  assert.equal(environment.element('install-update-notice').hidden, false);
  assert.equal(environment.element('install-update').hidden, false);
  environment.element('install-update-notice').dispatch('click');
  environment.element('install-update').dispatch('click');
  environment.element('check-update').dispatch('click');
  assert.deepEqual(calls.map(({ action }) => action), ['status', 'install-update']);
  assert.equal(calls[1].payload, undefined);
  assert.equal(environment.element('install-update').disabled, true);
  assert.equal(environment.element('install-update-notice').attributes['aria-busy'], 'true');
  assert.equal(environment.element('check-update').disabled, true);
  assert.match(environment.element('update-status').textContent, /正在下载并安装/);
  assert.equal([...environment.timers.values()][0].delay, 5000);
  completeInstall({ ...installSnapshot(installState({ state: 'installed', version: '0.3.0', restartRequired: true })),
    report: { points: { planRemaining: 999 } }, autoLogin: autoLoginState({ state: 'disabled', enabled: false }) });
  await settle();
  assert.equal(environment.element('balance').textContent, '123');
  assert.equal(environment.element('auto-toggle').textContent, '停用自动更新');
  assert.match(environment.element('install-status').textContent, /完全退出并重新打开 DSH.*助手.*重新加载/);
  assert.equal(environment.element('install-update').disabled, true);
  assert.equal(environment.element('install-update-notice').textContent, '已安装，重启 DSH 生效');
  assert.equal(environment.element('pill-update').textContent, '重启');
  assert.equal([...environment.timers.values()][0].delay, 30000);
  environment.element('install-update').dispatch('click');
  assert.equal(calls.filter(({ action }) => action === 'install-update').length, 1);
  dispose();
  environment.assertClean();
});

test('an older in-flight balance response cannot revert a completed installation to idle', async () => {
  const environment = createEnvironment();
  let statusCalls = 0, completeStatus, completeInstall;
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async action => {
      if (action === 'install-update') return new Promise(resolve => { completeInstall = resolve; });
      if (++statusCalls === 1) return { ...successfulSnapshot(), ...installSnapshot(installState()) };
      return new Promise(resolve => { completeStatus = resolve; });
    },
  });
  await settle();
  environment.element('refresh').dispatch('click');
  environment.element('install-update').dispatch('click');
  await settle();
  completeInstall(installSnapshot(installState({ state: 'installed', version: '0.3.0', restartRequired: true })));
  await settle();
  completeStatus({ ...successfulSnapshot(), ...installSnapshot(installState()) });
  await settle();
  assert.equal(environment.element('update-status').textContent, '新版已安装，重启 DSH 生效');
  assert.equal(environment.element('install-update').disabled, true);
  assert.equal(environment.element('pill-update').textContent, '重启');
  dispose();
  environment.assertClean();
});

test('background installation progress uses fast status polling and accepts completion without a new version-check timestamp', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [
    { ...successfulSnapshot(), ...installSnapshot(installState()) },
    installSnapshot(installState({ state: 'installing', message: '正在校验下载。' })),
    { ...successfulSnapshot(), ...installSnapshot(installState()) },
    { ...successfulSnapshot(), ...installSnapshot(installState({ state: 'installed', version: '0.3.0', restartRequired: true })) },
  ]);
  await settle();
  environment.element('install-update').dispatch('click');
  await settle();
  assert.equal([...environment.timers.values()][0].delay, 5000);
  assert.equal(environment.element('install-update').disabled, true);
  environment.element('refresh').dispatch('click');
  await settle();
  assert.match(environment.element('update-status').textContent, /正在下载并安装/);
  environment.element('refresh').dispatch('click');
  await settle();
  assert.equal(environment.element('update-status').textContent, '新版已安装，重启 DSH 生效');
  assert.equal([...environment.timers.values()][0].delay, 30000);
  dispose();
  environment.assertClean();
});

test('an installer refusal explains manual Release downloads without issuing an install request', async () => {
  for (const installer of [installState({ state: 'unsupported', message: '当前安装位置不可写。' }), installState({ canInstall: false, message: '新版尚未发布安装包。' })]) {
    const environment = createEnvironment();
    const { dispose, calls } = mountWithQueue(environment, [{ ...successfulSnapshot(), ...installSnapshot(installer) }]);
    await settle();
    assert.equal(environment.element('install-update').hidden, true);
    assert.equal(environment.element('install-update-notice').hidden, true);
    assert.equal(environment.element('install-status').textContent, installer.message);
    assert.match(environment.element('install-help').textContent, /手动下载.*GitHub Release/);
    assert.equal(environment.element('update-help').attributes.href, 'https://github.com/KimBrine/dsh-tongji-usage-widget/releases/latest');
    environment.element('install-update').dispatch('click');
    assert.deepEqual(calls.map(({ action }) => action), ['status']);
    dispose();
    environment.assertClean();
  }
});

test('backend installation failure preserves credit data and allows an explicit retry', async () => {
  const environment = createEnvironment();
  const message = '下载校验失败，未替换插件。<img src=x>';
  const { dispose, calls } = mountWithQueue(environment, [
    { ...successfulSnapshot(), ...installSnapshot(installState()) },
    installSnapshot(installState({ state: 'error', message })),
    installSnapshot(installState({ state: 'installed', version: '0.3.0' })),
  ]);
  await settle();
  environment.element('install-update').dispatch('click');
  await settle();
  assert.equal(environment.element('update-status').textContent, '安装更新失败');
  assert.equal(environment.element('update-error').textContent, message);
  assert.equal(environment.element('install-update').disabled, false);
  assert.equal(environment.element('balance').textContent, '123');
  environment.element('install-update-notice').dispatch('click');
  await settle();
  assert.equal(environment.element('update-status').textContent, '新版已安装，重启 DSH 生效');
  assert.equal(environment.element('update-error').hidden, true);
  assert.deepEqual(calls.map(({ action }) => action), ['status', 'install-update', 'install-update']);
  dispose();
  environment.assertClean();
});

test('a failed transport install request stays visible after normal polling and does not claim installation', async () => {
  const environment = createEnvironment();
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async action => {
      if (action === 'status') return { ...successfulSnapshot(), ...installSnapshot(installState()) };
      throw new Error('network SECRET');
    },
  });
  await settle();
  environment.element('install-update').dispatch('click');
  await settle();
  environment.element('refresh').dispatch('click');
  await settle();
  assert.equal(environment.element('update-status').textContent, '安装更新失败');
  assert.match(environment.element('update-error').textContent, /暂时无法安装更新/);
  assert.ok(!environment.element('update-error').textContent.includes('SECRET'));
  assert.equal(environment.element('install-update').disabled, false);
  dispose();
  environment.assertClean();
});

test('disposing during installation discards late installer results and clears progress timers', async () => {
  const environment = createEnvironment();
  let completeInstall;
  const dispose = mountWidget({
    document: environment.document, storage: null,
    call: async action => action === 'status' ? { ...successfulSnapshot(), ...installSnapshot(installState()) }
      : new Promise(resolve => { completeInstall = resolve; }),
  });
  await settle();
  environment.element('install-update').dispatch('click');
  await settle();
  dispose();
  completeInstall(installSnapshot(installState({ state: 'installed', version: '0.3.0' })));
  await settle();
  environment.assertClean();
});

test('an install action with nothing newer to install accepts idle status and explains the result', async () => {
  const environment = createEnvironment();
  const message = '本机文件已是该发布版本或更新，无需重复安装。';
  const { dispose } = mountWithQueue(environment, [
    { ...successfulSnapshot(), ...installSnapshot(installState()) },
    installSnapshot(installState({ message, version: '0.3.0' })),
  ]);
  await settle();
  environment.element('install-update').dispatch('click');
  await settle();
  assert.equal(environment.element('install-status').textContent, message);
  assert.equal(environment.element('update-error').hidden, true);
  assert.equal(environment.element('install-update').disabled, false);
  assert.ok(!environment.element('update-status').textContent.includes('失败'));
  dispose();
  environment.assertClean();
});

test('a failed installation that may have changed files preserves restart and recovery guidance', async () => {
  const environment = createEnvironment();
  const { dispose } = mountWithQueue(environment, [
    { ...successfulSnapshot(), ...installSnapshot(installState()) },
    installSnapshot(installState({ state: 'error', message: '安装未完成。', restartRequired: true })),
  ]);
  await settle();
  environment.element('install-update').dispatch('click');
  await settle();
  assert.equal(environment.element('update-status').textContent, '安装更新失败');
  for (const id of ['install-status', 'install-notice-status']) assert.match(environment.element(id).textContent, /安装未完成.*本机文件可能已经变化.*重新打开 DSH 后核对版本.*手动下载/);
  assert.equal(environment.element('update-error').textContent, '安装未完成。');
  dispose();
  environment.assertClean();
});

test('only allowlisted release lookup errors expose the backend user message', async () => {
  for (const code of ['NO_RELEASE', 'INVALID_RELEASE', 'RELEASE_NETWORK', 'UNKNOWN']) {
    const environment = createEnvironment();
    const message = code === 'UNKNOWN' ? 'SECRET arbitrary backend text' : '正式发行版尚未准备好，请稍后检查 Release。';
    const dispose = mountWidget({
      document: environment.document, storage: null,
      call: async action => {
        if (action === 'status') return { ...successfulSnapshot(), ...installSnapshot(installState()) };
        throw Object.assign(new Error(message), { code });
      },
    });
    await settle();
    environment.element('install-update').dispatch('click');
    await settle();
    if (code === 'UNKNOWN') {
      assert.match(environment.element('update-error').textContent, /暂时无法安装更新/);
      assert.ok(!environment.element('update-error').textContent.includes('SECRET'));
    } else assert.equal(environment.element('update-error').textContent, message);
    dispose();
    environment.assertClean();
  }
});
