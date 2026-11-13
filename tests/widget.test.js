import assert from 'node:assert/strict';
import test from 'node:test';
import { mountWidget } from '../lib/widget.js';

// Only the DOM and timer surface used by mountWidget is emulated; requests remain observable.
function createEnvironment() {
  const allTargets = [];
  const hosts = new Map();
  const timers = new Map();
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
    navigator: { clipboard: { async writeText() {} } },
  });
  const document = target({
    hidden: false, defaultView: window,
    body: { append(host) { hosts.set(host.id, host); } },
    getElementById(id) { return hosts.get(id); },
    createElement() { return element(); },
  });
  return {
    document, window, timers,
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
