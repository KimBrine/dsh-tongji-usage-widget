import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const directory = new URL('../browser-extension/', import.meta.url);
const sources = Object.fromEntries(await Promise.all(['shared.js', 'popup.js', 'popup.html'].map(async file => [file, await readFile(new URL(file, directory), 'utf8')])));
const markup = sources['popup.html'];
const settle = () => new Promise(resolve => setImmediate(resolve));
const edgeNavigator = { userAgent: 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0' };
const chromeNavigator = { userAgent: 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36' };

function popup(status, { navigatorLike = edgeNavigator, loadShared = true, reloadError = null } = {}) {
  const elements = new Map();
  const calls = [];
  let reloads = 0;
  for (const match of markup.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const listeners = new Map();
    elements.set(match[2], {
      tagName: match[1], textContent: '', value: match[0].match(/\bvalue="([^"]*)"/)?.[1] || '', disabled: /\bdisabled\b/.test(match[0]), open: /\bopen\b/.test(match[0]), hidden: /\bhidden\b/.test(match[0]),
      addEventListener(event, listener) { listeners.set(event, listener); },
      dispatch(event) { return listeners.get(event)?.({ preventDefault() {} }); },
    });
  }
  const document = {
    getElementById(id) { assert.ok(elements.has(id), `missing popup element: ${id}`); return elements.get(id); },
    querySelectorAll(selector) { assert.equal(selector, 'button'); return [...elements.values()].filter(element => element.tagName === 'button'); },
  };
  const chrome = { runtime: {
    async sendMessage(message) { calls.push(message); return { ok: true, status: typeof status === 'function' ? await status(message) : status }; },
    reload() { reloads++; if (reloadError) throw reloadError; },
  } };
  const context = vm.createContext({ document, chrome, navigator: navigatorLike });
  for (const [, file] of markup.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    if (!loadShared && file === 'shared.js') continue;
    assert.ok(sources[file], `unexpected popup script: ${file}`);
    vm.runInContext(sources[file], context, { filename: file });
  }
  return { element: id => elements.get(id), calls, get reloads() { return reloads; } };
}

const connected = overrides => ({ paired: true, connected: true, enabled: true, browser: 'edge', state: 'idle', port: 17945, hasOwnedTab: false, startupNotifications: true, ...overrides });

test('the paired Edge popup describes twelve-hour and browser-start renewal without another request or timer', async () => {
  const view = popup(connected());
  await settle();
  assert.equal(view.element('browser').textContent, '当前浏览器：Edge');
  assert.equal(view.element('details').textContent, '每12小时尝试更新，浏览器助手启动时也会更新。');
  assert.equal(view.element('renew').disabled, false);
  assert.equal(view.element('focus').disabled, true);
  assert.equal(view.element('connection').textContent, '已连接本机 DSH');
  assert.equal(view.element('pair-settings').open, false);
  assert.equal(view.element('compatibility').hidden, true);
  assert.equal(view.element('reload-assistant').hidden, true);
  assert.deepEqual(view.calls.map(call => call.action), ['status']);
});

test('the popup accepts a positive numeric renewal interval and otherwise uses twelve hours', async () => {
  for (const [renewIntervalHours, expected] of [[6, 6], [0, 12], [-1, 12], ['6', 12], [NaN, 12]]) {
    const view = popup(connected({ browser: 'chrome', renewIntervalHours }), { navigatorLike: chromeNavigator });
    await settle();
    assert.equal(view.element('browser').textContent, '当前浏览器：Chrome');
    assert.equal(view.element('details').textContent, `每${expected}小时尝试更新，浏览器助手启动时也会更新。`);
  }
});

test('unpaired, offline, disabled and school-verification states keep their required guidance', async () => {
  for (const [overrides, state, details] of [
    [{ paired: false, connected: false }, '尚未配对', /先在 DSH 浮窗中生成配对码/],
    [{ connected: false, code: 'BRIDGE_OFFLINE' }, '本机插件未连接', /请打开 DSH，并核对端口/],
    [{ state: 'disabled', enabled: false }, '自动更新已关闭', /在 DSH 浮窗设置中重新启用/],
    [{ state: 'waiting_for_login', browser: null, hasOwnedTab: true }, '需要完成学校登录', /继续学校登录.*Edge.*完成学校验证/],
  ]) {
    const view = popup(connected(overrides));
    await settle();
    assert.equal(view.element('state').textContent, state);
    assert.match(view.element('details').textContent, details);
    assert.ok(!view.element('details').textContent.includes('每12小时'));
    if (overrides.browser === null) assert.equal(view.element('browser').textContent, '当前浏览器：Edge');
    assert.equal(view.element('pair-settings').open, overrides.paired === false || overrides.connected === false);
  }
});

test('a successful old-worker status without browser metadata still identifies this Chrome popup and keeps the connection', async () => {
  const view = popup(connected({ state: 'success', browser: undefined, startupNotifications: undefined, renewIntervalHours: 12 }), { navigatorLike: chromeNavigator });
  await settle();
  assert.equal(view.element('browser').textContent, '当前浏览器：Chrome');
  assert.equal(view.element('state').textContent, '登录已自动更新');
  assert.equal(view.element('connection').textContent, '已连接本机 DSH');
  assert.equal(view.element('renew').disabled, false);
  assert.equal(view.element('pair-settings').open, false);
  assert.equal(view.element('pair-settings-summary').textContent, '重新配对 / 更换端口');
  assert.equal(view.element('code').value, '');
  assert.equal(view.element('compatibility').hidden, false);
  assert.equal(view.element('reload-assistant').hidden, false);
  assert.equal(view.element('compatibility').textContent, '助手后台需要重新加载，才能启用启动自动更新；当前连接正常。');
  assert.equal(view.element('details').textContent, '每12小时尝试更新，浏览器助手启动时也会更新。');
});

test('the Edge popup identifies its local browser when worker metadata is absent or names Chrome', async () => {
  for (const browser of [undefined, 'chrome']) {
    const view = popup(connected({ state: 'success', browser }), { navigatorLike: edgeNavigator });
    await settle();
    assert.equal(view.element('browser').textContent, '当前浏览器：Edge');
    assert.equal(view.element('state').textContent, '登录已自动更新');
    assert.equal(view.element('connection').textContent, '已连接本机 DSH');
    assert.equal(view.element('renew').disabled, false);
  }
});

test('pairing clears the one-time code, confirms the DSH connection and folds the pairing fields', async () => {
  const view = popup(message => connected(message.action === 'pair' ? {} : { paired: false, connected: false }));
  await settle();
  assert.equal(view.element('pair-settings').open, true);
  assert.equal(view.element('compatibility').hidden, true);
  view.element('code').value = '12345678';
  await view.element('pair-form').dispatch('submit');
  await settle();
  assert.deepEqual(view.calls.map(call => call.action), ['status', 'pair']);
  assert.equal(view.element('code').value, '');
  assert.equal(view.element('connection').textContent, '已连接本机 DSH');
  assert.equal(view.element('pair-settings').open, false);
  assert.equal(view.element('pair-settings-summary').textContent, '重新配对 / 更换端口');
});

test('the worker browser name remains a compatibility fallback if shared browser detection is unavailable', async () => {
  const view = popup(connected(), { loadShared: false });
  await settle();
  assert.equal(view.element('browser').textContent, '当前浏览器：Edge');
  assert.equal(view.element('connection').textContent, '已连接本机 DSH');
});

test('reloading an old helper restarts only this extension once without pairing or renewal requests', async () => {
  const view = popup(connected({ startupNotifications: undefined }));
  await settle();
  assert.equal(view.element('reload-assistant').hidden, false);
  view.element('reload-assistant').dispatch('click');
  view.element('reload-assistant').dispatch('click');
  assert.equal(view.reloads, 1);
  assert.equal(view.element('reload-assistant').disabled, true);
  assert.deepEqual(view.calls.map(call => call.action), ['status']);
  assert.equal(view.element('message').textContent, '');
});

test('a helper reload exception displays only the safe extension-management instruction', async () => {
  const view = popup(connected({ startupNotifications: undefined }), { reloadError: new Error('sensitive browser exception') });
  await settle();
  view.element('reload-assistant').dispatch('click');
  assert.equal(view.reloads, 1);
  assert.equal(view.element('reload-assistant').disabled, false);
  assert.equal(view.element('message').textContent, '无法重新加载，请在扩展管理页重新加载助手');
  assert.deepEqual(view.calls.map(call => call.action), ['status']);
  assert.equal(view.element('connection').textContent, '已连接本机 DSH');
});
