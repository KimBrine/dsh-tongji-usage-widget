import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import plugin, { registerRoutes, browserScript, BASE_PATH } from '../lib/index.js';

test('real HTTP route enforces host authentication and never exposes credentials', async () => {
  const routes = new Map();
  let rejection, calls = 0, disposed = false;
  const ctx = {
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    connection: { requestRejection() { return rejection; } },
  };
  const cleanup = registerRoutes(ctx, { status: async () => { calls++; return { report: { points: { planRemaining: 12 } } }; }, dispose() { disposed = true; } });
  const server = createServer((req, res) => routes.get(new URL(req.url, 'http://local').pathname)?.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}${BASE_PATH}`;
  try {
    assert.equal((await fetch(`${base}/status.json`)).status, 403);
    assert.equal((await fetch(`${base}/status.json`, { headers: { 'X-Tongji-Widget': '1', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    rejection = 401;
    assert.equal((await fetch(`${base}/status.json`, { headers: { 'X-Tongji-Widget': '1' } })).status, 401);
    rejection = undefined;
    const response = await fetch(`${base}/status.json`, { headers: { 'X-Tongji-Widget': '1' } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).report.points.planRemaining, 12);
    assert.equal(calls, 1);
    assert.equal((await fetch(`${base}/status.json`, { method: 'POST' })).status, 405);
    const script = await (await fetch(`${base}/widget.js`)).text();
    new vm.Script(script);
    assert.ok(!script.includes('credentials.json'));
    assert.ok(!script.includes('Authorization'));
  } finally { cleanup(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(disposed, true);
  assert.equal(routes.size, 0);
});

test('desktop injection registers synchronously and loader failure is harmless', () => {
  const listeners = new Map();
  let requested;
  plugin.apply({ on(event, handler) { listeners.set(event, handler); }, inject(names) { requested = names; } });
  assert.deepEqual(requested, ['webServer', 'connection']);
  const rows = [];
  listeners.get('webserver/index-inject')(rows);
  listeners.get('webserver/index-inject')(rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'script');
  const added = [];
  vm.runInNewContext(rows[0].text, { document: { createElement: () => ({}), body: { appendChild: script => added.push(script) } } });
  assert.equal(added[0].src, `${BASE_PATH}/widget.js`);
  assert.doesNotThrow(() => added[0].onerror());
  assert.doesNotThrow(() => new vm.Script(browserScript()));
});
test('automatic-login actions require the DSH operator guard and a bounded valid POST', async () => {
  const routes = new Map(); let calls = 0, deny = true;
  const ctx = { webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    connection: { requestRejection() { return deny ? 401 : undefined; } } };
  const cleanup = registerRoutes(ctx, { status: async () => ({}), dispose() {} }, { action: async action => { calls++; return { action, pairCode: '12345678' }; } });
  const server = createServer((req, res) => { const route = routes.get(new URL(req.url, 'http://local').pathname); if (route) route.handler(req, res); else { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${BASE_PATH}/auto-login`;
  const post = body => fetch(url, { method: 'POST', headers: { 'X-Tongji-Widget': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ action: 'pair' })).status, 403); assert.equal(calls, 0);
    deny = false;
    assert.equal((await post({ action: 'unsupported' })).status, 400);
    assert.equal((await post({ action: 'pair', extra: 'x'.repeat(3000) })).status, 400);
    const response = await post({ action: 'pair' }); assert.equal(response.status, 200);
    assert.equal((await response.json()).pairCode, '12345678'); assert.equal(calls, 1);
  } finally { cleanup(); await new Promise(resolve => server.close(resolve)); }
});

test('manual update checks require operator access and return version data without querying usage', async () => {
  const routes = new Map(); let deny = true, checks = 0;
  const ctx = { webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    connection: { requestRejection() { return deny ? 401 : undefined; } } };
  const cleanup = registerRoutes(ctx, { status: async () => { throw new Error('usage must not be queried'); }, dispose() {},
    checkUpdate: async () => { checks++; return { updates: { state: 'available', currentVersion: '0.2.1', latestVersion: '0.3.0' } }; } });
  const server = createServer((req, res) => routes.get(new URL(req.url, 'http://local').pathname)?.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${BASE_PATH}/updates.json`;
  const headers = { 'X-Tongji-Widget': '1' };
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers })).status, 401);
    deny = false;
    assert.equal((await fetch(url, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
    assert.equal(checks, 0);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).updates.latestVersion, '0.3.0'); assert.equal(checks, 1);
  } finally { cleanup(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(routes.size, 0);
});
