import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const flush = () => new Promise(resolve => setImmediate(resolve));

function sharedContext(extra = {}) {
  const context = vm.createContext({ URL, AbortSignal, TextDecoder, Uint8Array, atob, Date, ...extra });
  vm.runInContext(sources['shared.js'], context, { filename: 'shared.js' });
  return context;
}

function worker({ config = true, job = metadata, command = null, completeStatus = 200, completeBody = { ok: true } } = {}) {
  const local = config ? { tongjiLoginBridge: { port: 17945, bridgeKey } } : {};
  const session = job ? { tongjiLoginJob: structuredClone(job) } : {};
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
    if (path === '/v1/complete') return { ok: completeStatus >= 200 && completeStatus < 300, status: completeStatus, async json() { return completeBody; } };
    return { ok: true, status: 200, async json() { return body; } };
  };
  const context = sharedContext({ chrome, fetch });
  context.importScripts = () => {};
  vm.runInContext(sources['background.js'], context, { filename: 'background.js' });
  return { local, session, requests, created, removed, storageWrites, listeners,
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

test('extension permissions exclude cookies, history, debugger and broad tab access', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://agi.tongji.edu.cn/*', 'http://127.0.0.1/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://agi.tongji.edu.cn/*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.externally_connectable, undefined);
  for (const [file, source] of Object.entries(sources)) assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
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
  assert.equal(JSON.parse(request.body).code, '12345678');
  assert.ok(!JSON.stringify(paired).includes(bridgeKey));
  assert.equal(extension.local.tongjiLoginBridge.bridgeKey, bridgeKey);
});
