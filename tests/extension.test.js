import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const directory = new URL('../browser-extension/', import.meta.url);
const sources = Object.fromEntries(await Promise.all(['shared.js', 'background.js', 'content.js', 'popup.js'].map(async file => [file, await readFile(new URL(file, directory), 'utf8')])));
const now = Date.now();
const requestedAt = now - 1000;
const bridgeKey = 'test-local-bridge-key-not-a-website-token';
const runtimeId = 'a'.repeat(32);
const token = (issuedAt, expiresAt = now + 3600000) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ iat: Math.floor(issuedAt / 1000), exp: Math.floor(expiresAt / 1000), name: '模拟' })).toString('base64url')}.testsignature`;
const freshToken = token(now);
const metadata = { id: 'test-job-id', requestedAt, tabId: 777, startedAt: now, waiting: false };
const contentSender = { id: runtimeId, tab: { id: 777 }, frameId: 0, origin: 'https://agi.tongji.edu.cn', url: 'https://agi.tongji.edu.cn/models/hub' };
const popupSender = { id: runtimeId, url: `chrome-extension://${runtimeId}/popup.html` };
const sessionKey = 'tongjiLoginBrowserSession';
const flush = () => new Promise(resolve => setImmediate(resolve));

function sharedContext(extra = {}) {
  const context = vm.createContext({ URL, AbortSignal, TextDecoder, Uint8Array, atob, Date, ...extra });
  vm.runInContext(sources['shared.js'], context, { filename: 'shared.js' });
  return context;
}

function worker({ config = true, job = metadata, command = null, completeStatus = 200, completeBody = { ok: true }, navigatorLike,
  localData, sessionData, randomUUIDImpl = randomUUID, onBrowserStart = async () => {} } = {}) {
  const local = localData || (config ? { tongjiLoginBridge: { port: 17945, bridgeKey } } : {});
  const session = sessionData || (job ? { tongjiLoginJob: structuredClone(job) } : {});
  const requests = [], created = [], removed = [], storageWrites = [], listeners = {};
  const area = data => ({
    async get(key) { return Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {}; },
    async set(values) { storageWrites.push(structuredClone(values)); Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  });
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: { id: runtimeId, getURL: path => `chrome-extension://${runtimeId}/${path}`, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    alarms: { create() {}, onAlarm: event('alarm') },
    tabs: { async create(options) { created.push(options); return { id: 777, windowId: 1 }; }, async remove(id) { removed.push(id); }, async update(id) { return { id, windowId: 1 }; }, onRemoved: event('removed') },
    windows: { async update() {} },
  };
  const fetch = async (address, options) => {
    const path = new URL(address).pathname;
    requests.push({ address, path, ...options });
    let body = {};
    if (path === '/v1/command') body = { job: command };
    if (path === '/v1/status') body = { autoLogin: { state: 'idle', expiresAt: new Date(now + 1000).toISOString(), bridgeKey } };
    if (path === '/v1/pair') body = { bridgeKey };
    if (path === '/v1/browser-start') { await onBrowserStart(); body = { autoLogin: { state: 'idle' } }; }
    if (path === '/v1/complete') return { ok: completeStatus >= 200 && completeStatus < 300, status: completeStatus, async json() { return completeBody; } };
    return { ok: true, status: 200, async json() { return body; } };
  };
  const context = sharedContext({ chrome, fetch, crypto: { randomUUID: randomUUIDImpl }, ...(navigatorLike === undefined ? {} : { navigator: navigatorLike }) });
  context.importScripts = () => {};
  vm.runInContext(sources['background.js'], context, { filename: 'background.js' });
  return { local, session, requests, created, removed, storageWrites, listeners, popupUrl: chrome.runtime.getURL('popup.html'),
    message: (value, sender = contentSender) => new Promise(resolve => listeners.message(value, sender, resolve)),
  };
}

function content({ owned = true, candidate = freshToken, path = '/models/hub' } = {}) {
  const calls = [], timers = [];
  let reads = 0, clicks = 0;
  const window = {}; window.top = window;
  const chrome = { runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.action === 'owned-job') return { ok: true, job: owned ? { id: metadata.id, requestedAt } : null };
    if (message.action === 'begin-sso') return { ok: true, click: true };
    return { ok: true };
  } } };
  const context = sharedContext({ chrome, window, location: { origin: 'https://agi.tongji.edu.cn', pathname: path },
    document: { querySelectorAll: () => [{ textContent: '统一身份认证登录 →', disabled: false, click() { clicks++; } }] },
    sessionStorage: { getItem() { reads++; return candidate; } },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
  });
  vm.runInContext(sources['content.js'], context, { filename: 'content.js' });
  return { calls, timers, get reads() { return reads; }, get clicks() { return clicks; }, async tick() { timers.shift()?.callback(); await flush(); } };
}

async function popup(status) {
  const markup = await readFile(new URL('popup.html', directory), 'utf8');
  const ids = [...markup.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const elements = Object.fromEntries(ids.map(id => [id, { textContent: '', value: '', disabled: false, addEventListener() {} }]));
  const context = sharedContext({ Date, navigator: { userAgent: status.browser === 'edge' ? 'Edg/142.0' : 'Chrome/142.0' }, document: {
    getElementById: id => elements[id],
    querySelectorAll: () => ['renew', 'focus', 'pair', 'status'].map(id => elements[id]),
  }, chrome: { runtime: { async sendMessage() { return { ok: true, status }; } } } });
  vm.runInContext(sources['popup.js'], context, { filename: 'popup.js' });
  await flush();
  return elements;
}

test('extension permissions exclude cookies, history, debugger and broad tab access', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  const packageVersion = JSON.parse(await readFile(new URL('../package.json', directory), 'utf8')).version;
  assert.equal(manifest.version, packageVersion);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://agi.tongji.edu.cn/*', 'http://127.0.0.1/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://agi.tongji.edu.cn/*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.externally_connectable, undefined);
  for (const [file, source] of Object.entries(sources)) assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
});

test('browser detection is bounded to Edge or Chrome and recognizes Client Hints and Edge UA', () => {
  const detect = sharedContext().TongjiLoginCore.detectBrowser;
  assert.equal(detect(), 'chrome');
  assert.equal(detect(null), 'chrome');
  assert.equal(detect({}), 'chrome');
  assert.equal(detect({ userAgentData: { brands: [{ brand: 'Microsoft Edge', version: '142' }, { brand: 'Chromium', version: '142' }] } }), 'edge');
  assert.equal(detect({ userAgent: 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0' }), 'edge');
  assert.equal(detect({ userAgentData: { brands: [{ brand: 'Google Chrome', version: '142' }] }, userAgent: 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36' }), 'chrome');
  assert.equal(detect({ userAgentData: { brands: [{ brand: 'Unknown Edge Browser' }] }, userAgent: 'UnknownBrowser/1.0' }), 'chrome');
  assert.equal(detect({ userAgentData: { brands: 'Microsoft Edge' } }), 'chrome');
  assert.equal(detect({ get userAgentData() { throw new Error('Unavailable'); }, userAgent: 'Edg/142.0' }), 'edge');
  const core = sharedContext({ navigator: { userAgent: 'Edg/142.0' } }).TongjiLoginCore;
  const runtime = { id: runtimeId, getURL: path => `chrome-extension://${runtimeId}/${path}` };
  assert.equal(core.trustedPopupSender(popupSender, runtime), true);
  assert.equal(core.trustedPopupSender({ ...popupSender, url: `ms-browser-extension://${runtimeId}/popup.html` }, runtime), false);
});

test('popup displays its current Edge or Chrome browser and keeps login instructions browser-aware', async () => {
  const html = await readFile(new URL('popup.html', directory), 'utf8');
  assert.match(html, /id="browser"/);
  for (const [browser, name] of [['edge', 'Edge'], ['chrome', 'Chrome']]) {
    const elements = await popup({ browser, paired: true, connected: true, state: 'queued', port: 17945 });
    assert.equal(elements.browser.textContent, `当前浏览器：${name}`);
    assert.equal(elements.state.textContent, '等待浏览器更新');
    assert.match(elements.details.textContent, /每12小时.*浏览器助手启动/);
    assert.equal(elements.renew.disabled, false);
    if (browser === 'edge') assert.ok(!elements.details.textContent.includes('Chrome'));
    const waiting = await popup({ browser, paired: true, connected: true, state: 'waiting_for_login' });
    assert.ok(waiting.details.textContent.includes(name));
    assert.ok(waiting.details.textContent.includes('学校验证'));
  }
  const unpaired = await popup({ browser: 'edge', paired: false });
  assert.equal(unpaired.browser.textContent, '当前浏览器：Edge');
  assert.equal(unpaired.details.textContent, '先在 DSH 浮窗中生成配对码。');
});

test('candidate freshness rejects old, expired, future and malformed JWTs without exposing claims', () => {
  const core = sharedContext().TongjiLoginCore;
  assert.ok(core.candidateMetadata(freshToken, requestedAt, now));
  assert.equal(core.candidateMetadata(token(now - 60000), requestedAt, now), null);
  assert.equal(core.candidateMetadata(token(now, now - 1000), requestedAt, now), null);
  assert.equal(core.candidateMetadata(token(now + 180000), requestedAt, now), null);
  assert.equal(core.candidateMetadata('not-a-jwt', requestedAt, now), null);
  assert.throws(() => core.baseUrl('https://example.com'), /INVALID_PORT/);
  assert.equal(core.baseUrl(17945), 'http://127.0.0.1:17945');
});

test('ordinary platform pages never read sessionStorage or forward credentials', async () => {
  const page = content({ owned: false });
  await flush();
  for (let i = 0; i < 22; i++) await page.tick();
  assert.equal(page.reads, 0);
  assert.equal(page.calls.filter(call => call.action === 'candidate').length, 0);
  assert.equal(page.timers.length, 0, 'unowned pages stop polling after bounded startup checks');
});

test('an owned login page clicks only its normal SSO button once and does not submit an old token', async () => {
  const page = content({ path: '/login', candidate: token(now - 60000) });
  await flush();
  await page.tick(); await page.tick();
  assert.equal(page.clicks, 1);
  assert.equal(page.calls.filter(call => call.action === 'candidate').length, 0);
});

test('an owned fresh login candidate is delivered through runtime messaging only', async () => {
  const page = content();
  await flush();
  const submitted = page.calls.find(call => call.action === 'candidate');
  assert.equal(submitted.jobId, metadata.id);
  assert.equal(submitted.accessToken, freshToken);
  assert.equal(page.timers.length, 0);
});

test('worker rejects hostile origin, another tab, subframes and mismatched jobs before backend submission', async () => {
  const extension = worker(); await flush();
  const message = { action: 'candidate', jobId: metadata.id, accessToken: freshToken };
  for (const sender of [
    { ...contentSender, origin: 'https://example.com' },
    { ...contentSender, url: 'https://example.com/' },
    { ...contentSender, tab: { id: 778 } },
    { ...contentSender, frameId: 1 },
  ]) assert.equal((await extension.message(message, sender)).ok, false);
  assert.equal((await extension.message({ ...message, jobId: 'wrong-job' })).ok, false);
  assert.equal(extension.requests.filter(request => request.path === '/v1/complete').length, 0);
  assert.equal(extension.removed.length, 0);
});

test('SSO click is claimed once per job even across page reloads or concurrent messages', async () => {
  const extension = worker(); await flush();
  const message = { action: 'begin-sso', jobId: metadata.id };
  const results = await Promise.all([extension.message(message), extension.message(message)]);
  assert.equal(results.filter(result => result.click === true).length, 1);
  assert.equal((await extension.message(message)).click, false);
  const restarted = worker({ job: extension.session.tongjiLoginJob }); await flush();
  assert.equal((await restarted.message(message)).click, false);
});

test('successful validated import closes only the owned tab and never persists the website token', async () => {
  const extension = worker(); await flush();
  const result = await extension.message({ action: 'candidate', jobId: metadata.id, accessToken: freshToken });
  assert.equal(result.ok, true);
  const submitted = extension.requests.find(request => request.path === '/v1/complete');
  assert.equal(JSON.parse(submitted.body).accessToken, freshToken);
  assert.equal(submitted.headers.Authorization, `Bearer ${bridgeKey}`);
  assert.equal(submitted.headers['X-Tongji-Extension'], runtimeId);
  assert.equal(submitted.redirect, 'error');
  assert.equal(submitted.credentials, 'omit');
  assert.deepEqual(extension.removed, [777]);
  assert.equal(extension.session.tongjiLoginJob, undefined);
  assert.ok(!JSON.stringify(extension.storageWrites).includes(freshToken));
  const status = await extension.message({ action: 'status' }, popupSender);
  assert.equal(status.status.state, 'idle');
  assert.ok(!JSON.stringify(status).includes(bridgeKey));
});

test('backend rejection keeps the owned login tab and preserves job metadata for user action', async () => {
  const extension = worker({ completeStatus: 400, completeBody: { error: { code: 'ACCOUNT_MISMATCH', message: 'do not display remote content' } } });
  await flush();
  const result = await extension.message({ action: 'candidate', jobId: metadata.id, accessToken: freshToken });
  assert.equal(result.code, 'ACCOUNT_MISMATCH');
  assert.equal(extension.removed.length, 0);
  assert.equal(extension.session.tongjiLoginJob.id, metadata.id);
  assert.ok(!JSON.stringify(result).includes('remote content'));
});

test('alarm polling coalesces one command into a single background login tab', async () => {
  const extension = worker({ job: null, command: { id: metadata.id, requestedAt, kind: 'renew' } });
  await flush();
  extension.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  extension.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  await flush();
  assert.equal(extension.created.length, 1);
  assert.equal(extension.created[0].url, 'https://agi.tongji.edu.cn/login');
  assert.equal(extension.created[0].active, false);
  assert.equal(extension.session.tongjiLoginJob.tabId, 777);
});

test('a content script cannot pair or request unrelated local bridge operations', async () => {
  const extension = worker(); await flush();
  const result = await extension.message({ action: 'pair', port: 17945, code: '12345678' });
  assert.equal(result.ok, false);
  assert.equal(extension.requests.filter(request => request.path === '/v1/pair').length, 0);
});

test('pairing uses a bounded code and the extension identity header without disclosing its returned key', async () => {
  const extension = worker({ config: false, job: null }); await flush();
  const paired = await extension.message({ action: 'pair', port: 17945, code: '12345678' }, popupSender);
  assert.equal(paired.ok, true);
  const request = extension.requests.find(item => item.path === '/v1/pair');
  assert.equal(request.headers['X-Tongji-Extension'], runtimeId);
  assert.equal(request.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(request.body), { code: '12345678', browser: 'chrome' });
  assert.equal(paired.status.browser, 'chrome');
  assert.ok(!JSON.stringify(paired).includes(bridgeKey));
  assert.equal(extension.local.tongjiLoginBridge.bridgeKey, bridgeKey);
});

test('Edge pairs anonymously with its browser hint and runs the same owned-tab renewal through chrome APIs', async () => {
  for (const navigatorLike of [
    { userAgent: 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0' },
    { userAgentData: { brands: [{ brand: 'Microsoft Edge', version: '142' }] } },
  ]) {
    const extension = worker({ config: false, job: null, navigatorLike,
      command: { id: metadata.id, requestedAt, kind: 'renew' } });
    await flush();
    assert.equal(extension.popupUrl, `chrome-extension://${runtimeId}/popup.html`);
    const unpaired = await extension.message({ action: 'status' }, popupSender);
    assert.equal(unpaired.status.browser, 'edge');
    assert.equal(unpaired.status.paired, false);
    const rejected = await extension.message({ action: 'pair', port: 17945, code: '12345678' },
      { ...popupSender, url: `ms-browser-extension://${runtimeId}/popup.html` });
    assert.equal(rejected.ok, false);
    assert.equal(extension.requests.filter(item => item.path === '/v1/pair').length, 0);
    const paired = await extension.message({ action: 'pair', port: 17945, code: '12345678' }, popupSender);
    assert.equal(paired.ok, true);
    assert.equal(paired.status.browser, 'edge');
    const pairRequest = extension.requests.find(item => item.path === '/v1/pair');
    assert.deepEqual(JSON.parse(pairRequest.body), { code: '12345678', browser: 'edge' });
    assert.equal(pairRequest.headers.Authorization, undefined);
    assert.equal(pairRequest.headers['X-Tongji-Extension'], runtimeId);
    assert.equal(pairRequest.credentials, 'omit');
    assert.equal(pairRequest.redirect, 'error');
    assert.equal(extension.created.length, 1);
    assert.equal(extension.created[0].url, 'https://agi.tongji.edu.cn/login');
    assert.equal(extension.created[0].active, false);
    const completed = await extension.message({ action: 'candidate', jobId: metadata.id, accessToken: freshToken });
    assert.equal(completed.ok, true);
    assert.equal(extension.requests.filter(item => item.path === '/v1/complete').length, 1);
    assert.deepEqual(extension.removed, [777]);
    assert.ok(!JSON.stringify(extension.storageWrites).includes(freshToken));
    assert.ok(!JSON.stringify(paired).includes(bridgeKey));
  }
});

test('browser startup and installation events coalesce one authenticated session notification and one job', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  let idCalls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const extension = worker({ job: null, command: { id: metadata.id, requestedAt, kind: 'renew' },
    randomUUIDImpl: () => { idCalls++; return sessionId; }, onBrowserStart: () => gate });
  extension.listeners.startup();
  extension.listeners.installed({ reason: 'install' });
  await flush();
  assert.equal(extension.session[sessionKey].id, sessionId);
  assert.equal(extension.session[sessionKey].notified, false, 'an in-flight request is not acknowledged yet');
  extension.listeners.startup();
  extension.listeners.installed({ reason: 'install' });
  extension.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  assert.equal(extension.requests.filter(item => item.path === '/v1/browser-start').length, 1);
  release(); await flush();
  const starts = extension.requests.filter(item => item.path === '/v1/browser-start');
  assert.equal(starts.length, 1);
  assert.equal(idCalls, 1);
  assert.equal(starts[0].method, 'POST');
  assert.deepEqual(JSON.parse(starts[0].body), { sessionId });
  assert.equal(starts[0].headers.Authorization, `Bearer ${bridgeKey}`);
  assert.equal(starts[0].headers['X-Tongji-Extension'], runtimeId);
  assert.equal(starts[0].credentials, 'omit');
  assert.equal(starts[0].redirect, 'error');
  assert.equal(extension.session[sessionKey].notified, true);
  assert.equal(extension.requests.filter(item => item.path === '/v1/renew').length, 0);
  assert.equal(extension.created.length, 1);
  assert.equal(extension.session.tongjiLoginJob.id, metadata.id);
  assert.ok(extension.requests.findIndex(item => item.path === '/v1/browser-start') < extension.requests.findIndex(item => item.path === '/v1/command'));
});

test('a revived MV3 worker reuses its acknowledged session while a real browser restart creates a new one', async () => {
  const firstId = '22222222-2222-4222-8222-222222222222';
  const nextId = '33333333-3333-4333-8333-333333333333';
  const first = worker({ job: null, randomUUIDImpl: () => firstId });
  await flush();
  assert.equal(first.session[sessionKey].notified, true);
  const revived = worker({ localData: first.local, sessionData: first.session,
    randomUUIDImpl: () => { assert.fail('worker wake must not create another session'); } });
  await flush();
  revived.listeners.startup();
  revived.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  await flush();
  assert.equal(revived.requests.filter(item => item.path === '/v1/browser-start').length, 0);
  assert.equal(revived.session[sessionKey].id, firstId);
  // Browser shutdown clears chrome.storage.session, unlike a worker's idle shutdown.
  const restarted = worker({ localData: first.local, sessionData: {}, randomUUIDImpl: () => nextId });
  restarted.listeners.startup();
  await flush();
  assert.equal(restarted.requests.filter(item => item.path === '/v1/browser-start').length, 1);
  assert.equal(JSON.parse(restarted.requests.find(item => item.path === '/v1/browser-start').body).sessionId, nextId);
});

test('extension reload starts a new session once without repeating it on subsequent worker wake', async () => {
  const priorId = '44444444-4444-4444-8444-444444444444';
  const nextId = '55555555-5555-4555-8555-555555555555';
  let idCalls = 0;
  const extension = worker({ job: null, sessionData: { [sessionKey]: { id: priorId, notified: true } },
    randomUUIDImpl: () => { idCalls++; return nextId; } });
  await flush();
  assert.equal(extension.requests.filter(item => item.path === '/v1/browser-start').length, 0);
  extension.listeners.installed({ reason: 'update' });
  await flush();
  extension.listeners.installed({ reason: 'update' });
  await flush();
  assert.equal(idCalls, 1);
  assert.equal(extension.requests.filter(item => item.path === '/v1/browser-start').length, 1);
  assert.equal(extension.session[sessionKey].id, nextId);
  assert.equal(extension.session[sessionKey].notified, true);
  const revived = worker({ localData: extension.local, sessionData: extension.session });
  await flush();
  assert.equal(revived.requests.filter(item => item.path === '/v1/browser-start').length, 0);
});

test('an offline backend is retried with the same session after an alarm and across worker revival', async () => {
  const sessionId = '66666666-6666-4666-8666-666666666666';
  let online = false;
  const onBrowserStart = async () => { if (!online) throw new Error('simulated offline'); };
  const first = worker({ job: null, onBrowserStart, randomUUIDImpl: () => sessionId });
  await flush();
  assert.equal(first.session[sessionKey].notified, false);
  assert.equal(first.requests.filter(item => item.path === '/v1/command').length, 0);
  const revived = worker({ localData: first.local, sessionData: first.session, onBrowserStart,
    randomUUIDImpl: () => { assert.fail('retry must preserve its prior session ID'); } });
  await flush();
  assert.equal(revived.session[sessionKey].notified, false);
  online = true;
  revived.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  await flush();
  assert.equal(revived.session[sessionKey].notified, true);
  assert.equal(revived.requests.filter(item => item.path === '/v1/command').length, 1);
  const attempts = [...first.requests, ...revived.requests].filter(item => item.path === '/v1/browser-start');
  assert.equal(attempts.length, 3);
  for (const request of attempts) assert.deepEqual(JSON.parse(request.body), { sessionId });
  revived.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  await flush();
  assert.equal(revived.requests.filter(item => item.path === '/v1/browser-start').length, 2);
});

test('an unpaired assistant waits for pairing, then notifies once and claims one pending job', async () => {
  const extension = worker({ config: false, job: null, command: { id: metadata.id, requestedAt, kind: 'renew' } });
  extension.listeners.startup();
  extension.listeners.installed({ reason: 'install' });
  await flush();
  assert.equal(extension.requests.length, 0);
  assert.equal(extension.session[sessionKey], undefined);
  const result = await extension.message({ action: 'pair', port: 17945, code: '12345678' }, popupSender);
  assert.equal(result.ok, true);
  assert.equal(extension.requests.filter(item => item.path === '/v1/browser-start').length, 1);
  assert.equal(extension.created.length, 1);
  assert.equal(extension.session[sessionKey].notified, true);
  extension.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  await flush();
  assert.equal(extension.requests.filter(item => item.path === '/v1/browser-start').length, 1);
  assert.equal(extension.created.length, 1);
});

test('re-pairing an acknowledged browser session announces a new session and merges one pending job', async () => {
  const priorId = '77777777-7777-4777-8777-777777777777';
  const nextId = '88888888-8888-4888-8888-888888888888';
  let idCalls = 0;
  const extension = worker({ sessionData: { [sessionKey]: { id: priorId, notified: true }, tongjiLoginJob: structuredClone(metadata) },
    command: { id: metadata.id, requestedAt, kind: 'renew' }, randomUUIDImpl: () => { idCalls++; return nextId; } });
  await flush();
  assert.equal(extension.requests.filter(item => item.path === '/v1/browser-start').length, 0);
  const paired = await extension.message({ action: 'pair', port: 17945, code: '12345678' }, popupSender);
  assert.equal(paired.ok, true);
  assert.equal(idCalls, 1);
  const starts = extension.requests.filter(item => item.path === '/v1/browser-start');
  assert.equal(starts.length, 1);
  assert.deepEqual(JSON.parse(starts[0].body), { sessionId: nextId });
  assert.equal(extension.session[sessionKey].id, nextId);
  assert.equal(extension.session[sessionKey].notified, true);
  assert.equal(extension.created.length, 1);
  assert.equal(extension.session.tongjiLoginJob.id, metadata.id);
  extension.listeners.alarm({ name: 'tongji-login-bridge-poll' });
  await flush();
  assert.equal(extension.created.length, 1);
  assert.equal(extension.requests.filter(item => item.path === '/v1/browser-start').length, 1);
  assert.ok(!JSON.stringify(paired).includes(bridgeKey));
});

test('a late startup acknowledgement cannot recreate a session cleared by re-pairing', async () => {
  const priorId = '99999999-9999-4999-8999-999999999999';
  const nextId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let starts = 0, ids = 0, releasePrior, releaseNext;
  const priorGate = new Promise(resolve => { releasePrior = resolve; });
  const nextGate = new Promise(resolve => { releaseNext = resolve; });
  const extension = worker({ job: null, randomUUIDImpl: () => ids++ ? nextId : priorId,
    onBrowserStart: () => ++starts === 1 ? priorGate : nextGate });
  await flush();
  assert.equal(extension.session[sessionKey].id, priorId);
  assert.equal(extension.session[sessionKey].notified, false);
  const paired = await extension.message({ action: 'pair', port: 17945, code: '12345678' }, popupSender);
  assert.equal(paired.ok, true);
  assert.equal(extension.session[sessionKey], undefined);
  const writesAfterClear = extension.storageWrites.length;
  releasePrior(); await flush();
  assert.equal(starts, 2, 'pairing schedules another poll after the in-flight poll finishes');
  assert.equal(extension.session[sessionKey].id, nextId);
  assert.equal(extension.session[sessionKey].notified, false);
  assert.ok(!extension.storageWrites.slice(writesAfterClear).some(write => write[sessionKey]?.id === priorId));
  releaseNext(); await flush();
  assert.equal(extension.session[sessionKey].id, nextId);
  assert.equal(extension.session[sessionKey].notified, true);
  assert.equal(ids, 2);
});
