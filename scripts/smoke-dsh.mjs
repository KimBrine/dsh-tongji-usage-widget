// Integration smoke against installed Cordis/WebServer packages.
// This creates an isolated in-memory Context and a loopback port-0 HTTP server.
// It does not boot a DSH profile, load user settings, or exercise a desktop GUI.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import widget, { BASE_PATH } from '../lib/index.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/smoke-dsh.mjs\nRequires an installed DSH runtime under $DSH_HOME/profiles/node_modules.\nCreates only a temporary loopback server; no profile writes, campus requests, or GUI acceptance.');
  process.exit(0);
}

const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
const profileRequire = createRequire(join(dshHome, 'profiles', 'package.json'));
let runtimeRequire;
try {
  runtimeRequire = createRequire(profileRequire.resolve('@deepseek-ai/dsh/package.json'));
} catch {
  throw new Error('Installed DSH runtime not found under $DSH_HOME/profiles/node_modules. This smoke does not install dependencies.');
}
const { Context } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href);
const { default: WebServer } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-host-webserver')).href);
const cordisVersion = runtimeRequire('@deepseek-ai/cordis/package.json').version;
const webServerVersion = runtimeRequire('@deepseek-ai/dsh-host-webserver/package.json').version;

const ctx = new Context();
const originalFetch = globalThis.fetch;
let allowedOrigin;
let blockedExternalRequests = 0;
let updateFixtureRequests = 0;
let guardCalls = 0;
let widgetFiber;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href === 'https://raw.githubusercontent.com/KimBrine/dsh-tongji-usage-widget/main/package.json') {
    updateFixtureRequests++;
    assert.equal(init?.headers?.Authorization, undefined);
    return Promise.resolve(new Response(JSON.stringify({ name: 'dsh-tongji-usage-widget', version: '0.2.1' })));
  }
  if (!allowedOrigin || url.origin !== allowedOrigin) {
    blockedExternalRequests++;
    return Promise.reject(new Error('Integration smoke blocks every non-fixture network destination.'));
  }
  return originalFetch(input, { ...init, signal: AbortSignal.timeout(5000) });
};

try {
  widgetFiber = ctx.plugin(widget);
  await widgetFiber;

  // Desktop boot collects injection rows before its dependent services settle.
  const earlyRows = [];
  ctx.emit('webserver/index-inject', earlyRows);
  assert.equal(earlyRows.length, 1, 'structured injection must exist before webServer/connection');
  assert.equal(earlyRows[0].kind, 'script');
  assert.ok(earlyRows[0].text.includes(`${BASE_PATH}/widget.js`));
  ctx.emit('webserver/index-inject', earlyRows);
  assert.equal(earlyRows.length, 1, 'structured injection must deduplicate');

  await ctx.plugin({
    name: 'smoke-connection-deny-stub',
    apply(scope) {
      scope.provide('connection', {
        requestRejection(request) {
          guardCalls++;
          assert.ok(request.headers && typeof request.headers === 'object');
          // A minimal fixture guard intentionally denies every status request.
          // This prevents credentials from being read or the university queried.
          return 401;
        },
      });
    },
  });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
  await widgetFiber;
  const webServer = ctx.get('webServer');
  assert.ok(webServer?.port > 0, 'real WebServer must bind an ephemeral port');
  allowedOrigin = `http://127.0.0.1:${webServer.port}`;

  await ctx.plugin({
    name: 'smoke-index-fixture',
    inject: ['webServer'],
    apply(scope) {
      scope.effect(() => scope.webServer.registerFallback((request, response) => {
        if (request.url !== '/') { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(scope.webServer.renderIndex('<!doctype html><html><body><div id="root"></div></body></html>'));
      }));
    },
  });

  const scriptResponse = await fetch(`${allowedOrigin}${BASE_PATH}/widget.js`);
  assert.equal(scriptResponse.status, 200, 'widget route must be registered by real Cordis inject');
  assert.match(scriptResponse.headers.get('content-type'), /javascript/);
  new Script(await scriptResponse.text(), { filename: 'injected-tongji-widget.js' });

  const indexResponse = await fetch(`${allowedOrigin}/`);
  assert.equal(indexResponse.status, 200);
  const index = await indexResponse.text();
  assert.equal(index.split(`${BASE_PATH}/widget.js`).length - 1, 1, 'Web and structured injection must render only one loader');
  assert.equal(webServer.collectIndexInjections().length, 1);

  const statusUrl = `${allowedOrigin}${BASE_PATH}/status.json`;
  assert.equal((await fetch(statusUrl)).status, 403, 'missing widget marker must be rejected');
  assert.equal(guardCalls, 0);
  assert.equal((await fetch(statusUrl, { headers: { 'X-Tongji-Widget': '1' } })).status, 401, 'host guard status must be preserved');
  assert.equal(guardCalls, 1);
  assert.equal((await fetch(statusUrl, { headers: { 'X-Tongji-Widget': '1', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(guardCalls, 1, 'cross-site request must be rejected before the host guard');
  assert.equal((await fetch(statusUrl, { method: 'POST' })).status, 405);
  const updatesUrl = `${allowedOrigin}${BASE_PATH}/updates.json`;
  assert.equal((await fetch(updatesUrl)).status, 403);
  assert.equal((await fetch(updatesUrl, { headers: { 'X-Tongji-Widget': '1' } })).status, 401);
  assert.equal((await fetch(updatesUrl, { method: 'POST' })).status, 405);

  await widgetFiber.dispose();
  assert.equal((await fetch(`${allowedOrigin}${BASE_PATH}/widget.js`)).status, 404, 'unload must remove the script route');
  assert.equal((await fetch(statusUrl, { headers: { 'X-Tongji-Widget': '1' } })).status, 404, 'unload must remove the status route');
  assert.equal((await fetch(updatesUrl, { headers: { 'X-Tongji-Widget': '1' } })).status, 404, 'unload must remove update checking');
  assert.equal(webServer.collectIndexInjections().length, 0, 'unload must remove the desktop injection listener');
  assert.ok(!webServer.renderIndex('<html><body></body></html>').includes(BASE_PATH), 'unload must remove the Web index tap');
  assert.equal(blockedExternalRequests, 0, 'the service must never attempt an external query');

  console.log(JSON.stringify({
    ok: true,
    kind: 'installed-runtime integration smoke; not desktop GUI acceptance',
    cordisVersion,
    webServerVersion,
    checks: [
      'early structured injection and deduplication',
      'real Cordis dependency injection and real HTTP widget route',
      'injected script syntax and single Web index loader',
      '403 missing marker / 401 host guard / 403 cross-site / 405 POST',
      'update route enforces the same operator boundary',
      'plugin unload removes HTTP routes, injection listener, and index tap',
    ],
    campusRequests: 0,
    profileWrites: 0,
    updateFixtureRequests,
  }, null, 2));
} finally {
  try { await ctx.fiber.dispose(); }
  finally { globalThis.fetch = originalFetch; }
}
