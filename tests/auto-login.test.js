import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createAutoLoginManager } from '../lib/auto-login.js';
import { writePrivateJson, saveAccessToken } from '../lib/credential-store.js';

const id = 'a'.repeat(32), otherId = 'b'.repeat(32);
const jwt = ({ userId = 1, issued = Math.floor(Date.now() / 1000), expires = issued + 86400 } = {}) =>
  [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ user_id: userId, iss: 'test-platform', iat: issued, exp: expires })).toString('base64url'),
    Buffer.from('synthetic-signature').toString('base64url')].join('.');

async function fixture({ fetchImpl, environment = {}, oldToken, now = Date.now } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tongji-auto-login-'));
  const credentialFile = join(directory, 'credentials.json'), configFile = join(directory, 'bridge.json');
  const original = oldToken || jwt({ issued: Math.floor(Date.now() / 1000) - 1800 });
  await writePrivateJson(credentialFile, { version: 1, accessToken: original });
  let validations = 0;
  const options = { port: 0, configFile, credentialFile, environment, now, intervalMs: 1000000,
    fetchImpl: fetchImpl || (async (url, options) => {
      validations++;
      assert.equal(url, 'https://agi.tongji.edu.cn/api/v1/auth/me');
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ code: 200, data: { id: 1 } }), { status: 200 });
    }) };
  let manager = createAutoLoginManager(options);
  await manager.start();
  let port = (await manager.status()).port;
  let key = '';
  const request = async (path, body, extra = {}) => {
    const headers = { Origin: `chrome-extension://${id}`, 'X-Tongji-Extension': id,
      ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra };
    for (const name of Object.keys(headers)) if (headers[name] === null) delete headers[name];
    // OS-assigned loopback ports may be in fetch's browser blocked-port list.
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
        response.on('error', reject);
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const pair = async (browser) => {
    const setup = await manager.action('pair');
    assert.match(setup.pairCode, /^\d{8}$/);
    const result = await request('/v1/pair', { code: setup.pairCode, ...(browser === undefined ? {} : { browser }) });
    assert.equal(result.status, 200);
    key = result.data.bridgeKey;
    assert.match(key, /^[a-f0-9]{64}$/);
    return setup;
  };
  const cleanup = async () => { await manager.dispose(); await rm(directory, { recursive: true, force: true }); };
  const restart = async () => {
    await manager.dispose(); manager = createAutoLoginManager(options); await manager.start();
    await manager.check(); port = (await manager.status()).port;
  };
  return { get manager() { return manager; }, restart, request, pair, cleanup, original, credentialFile, configFile,
    validations: () => validations, key: () => key };
}

test('pairing and real loopback completion validate before saving; status never exposes token or bridge key', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.manager.status()).state, 'unpaired');
    const setup = await f.pair();
    assert.equal((await f.request('/v1/pair', { code: setup.pairCode })).status, 400, 'one-time pairing code cannot be reused');
    const command = (await f.request('/v1/command')).data.job;
    assert.equal(command.kind, 'renew');
    const fresh = jwt();
    const done = await f.request('/v1/complete', { jobId: command.id, accessToken: fresh });
    assert.equal(done.status, 200);
    assert.equal(done.data.ok, true);
    assert.equal(JSON.parse(await readFile(f.credentialFile, 'utf8')).accessToken, fresh);
    assert.equal(f.validations(), 1);
    const state = await f.manager.status();
    assert.equal(state.state, 'success');
    assert.ok(!JSON.stringify(state).includes(fresh));
    assert.ok(!JSON.stringify(state).includes(f.key()));
    assert.equal((await f.request('/v1/complete', { jobId: command.id, accessToken: fresh })).status, 409);
  } finally { await f.cleanup(); }
});

test('Edge uses Chromium extension authentication, persists its browser and revokes the previous pairing', async () => {
  const f = await fixture(); let restarted;
  try {
    await f.pair(); const oldKey = f.key();
    assert.equal((await f.manager.status()).browser, 'chrome', 'old helper requests remain compatible');
    const setup = await f.manager.action('pair');
    const invalid = await f.request('/v1/pair', { code: setup.pairCode, browser: 'edge://forged' });
    assert.equal(invalid.status, 400);
    await f.pair('edge');
    assert.equal((await f.manager.status()).browser, 'edge');
    assert.equal((await f.request('/v1/status', undefined, { Authorization: `Bearer ${oldKey}` })).status, 403);
    assert.equal((await f.request('/v1/status', undefined, { Origin: `edge-extension://${id}` })).status, 403, 'Edge still uses chrome-extension, not a new trusted scheme');
    const command = (await f.request('/v1/command')).data.job;
    assert.equal(command.kind, 'renew', 'switching browser immediately queues a new trial');
    const fresh = jwt();
    assert.equal((await f.request('/v1/complete', { jobId: command.id, accessToken: fresh })).status, 200);
    assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).browser, 'edge');
    await f.manager.dispose();
    restarted = createAutoLoginManager({ port: 0, configFile: f.configFile, credentialFile: f.credentialFile, environment: {} });
    await restarted.start();
    assert.equal((await restarted.status()).browser, 'edge');
    assert.match((await restarted.status()).message, /Edge/);
  } finally { await restarted?.dispose(); await f.cleanup(); }
});

test('existing Chrome bridge settings without a browser field retain their pairing', async () => {
  const f = await fixture(); let restarted;
  try {
    await f.pair();
    await f.manager.dispose();
    const saved = JSON.parse(await readFile(f.configFile, 'utf8')); delete saved.browser;
    await writePrivateJson(f.configFile, saved);
    restarted = createAutoLoginManager({ port: 0, configFile: f.configFile, credentialFile: f.credentialFile, environment: {} });
    await restarted.start();
    const status = await restarted.status();
    assert.equal(status.paired, true); assert.equal(status.browser, 'chrome');
  } finally { await restarted?.dispose(); await f.cleanup(); }
});

test('disabling during concurrent renewal preparation leaves no executable login job', async () => {
  const f = await fixture();
  try {
    await f.pair();
    await Promise.all([f.manager.requestRenew({ manual: true }), f.manager.action('disable'),
      ...Array.from({ length: 12 }, () => f.manager.check())]);
    const state = await f.manager.status();
    assert.equal(state.enabled, false);
    assert.equal(state.state, 'disabled');
    assert.equal((await f.request('/v1/command')).data.job, null);
    assert.equal(JSON.parse(await readFile(f.credentialFile, 'utf8')).accessToken, f.original);
  } finally { await f.cleanup(); }
});

test('browser origins, paired extension identity and bearer key are all enforced', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/v1/command')).status, 403);
    await f.pair();
    assert.equal((await f.request('/v1/status', undefined, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.request('/v1/status', undefined, { Origin: `chrome-extension://${otherId}`, 'X-Tongji-Extension': otherId })).status, 403);
    assert.equal((await f.request('/v1/status', undefined, { Authorization: 'Bearer wrong' })).status, 403);
    const hostTestPort = (await f.manager.status()).port;
    const forgedHostStatus = await new Promise((resolve, reject) => {
        const raw = httpRequest({ hostname: '127.0.0.1', port: hostTestPort, path: '/v1/status',
          headers: { Host: 'evil.example', Origin: `chrome-extension://${id}`, 'X-Tongji-Extension': id, Authorization: `Bearer ${f.key()}` } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        }); raw.on('error', reject); raw.end();
    });
    assert.equal(forgedHostStatus, 403);
    const noOrigin = await f.request('/v1/status', undefined, { Origin: null });
    assert.equal(noOrigin.status, 200, 'privileged extension requests may omit Origin');
  } finally { await f.cleanup(); }
});

test('wrong account and old or rejected tokens preserve the existing credential', async () => {
  const f = await fixture();
  try {
    await f.pair(); const job = (await f.request('/v1/command')).data.job;
    const account = await f.request('/v1/complete', { jobId: job.id, accessToken: jwt({ userId: 2 }) });
    assert.equal(account.data.error.code, 'ACCOUNT_MISMATCH');
    const stale = await f.request('/v1/complete', { jobId: job.id, accessToken: f.original });
    assert.equal(stale.data.error.code, 'INVALID_TOKEN');
    assert.equal(JSON.parse(await readFile(f.credentialFile, 'utf8')).accessToken, f.original);
    assert.equal(f.validations(), 0);
  } finally { await f.cleanup(); }
  const denied = await fixture({ fetchImpl: async () => new Response('secret server details', { status: 401 }) });
  try {
    await denied.pair(); const job = (await denied.request('/v1/command')).data.job;
    const result = await denied.request('/v1/complete', { jobId: job.id, accessToken: jwt() });
    assert.equal(result.data.error.code, 'TOKEN_REJECTED');
    assert.ok(!JSON.stringify(result).includes('secret server details'));
    assert.equal(JSON.parse(await readFile(denied.credentialFile, 'utf8')).accessToken, denied.original);
  } finally { await denied.cleanup(); }
});

test('manual credential changes cannot be overwritten by a delayed login response', async () => {
  const f = await fixture();
  try {
    await f.pair(); const job = (await f.request('/v1/command')).data.job;
    const manual = jwt({ issued: Math.floor(Date.now() / 1000) - 30 });
    await saveAccessToken(manual, { file: f.credentialFile });
    const result = await f.request('/v1/complete', { jobId: job.id, accessToken: jwt() });
    assert.equal(result.data.error.code, 'CREDENTIAL_CHANGED');
    assert.equal(JSON.parse(await readFile(f.credentialFile, 'utf8')).accessToken, manual);
  } finally { await f.cleanup(); }
});

test('disable cancels a pending validation and cannot write its late result', async () => {
  let release;
  const f = await fixture({ fetchImpl: async () => {
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify({ code: 200, data: { id: 1 } }));
  } });
  try {
    await f.pair(); const job = (await f.request('/v1/command')).data.job;
    const completion = f.request('/v1/complete', { jobId: job.id, accessToken: jwt() });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await f.manager.action('disable'); release();
    assert.equal((await completion).data.error.code, 'JOB_EXPIRED');
    assert.equal(JSON.parse(await readFile(f.credentialFile, 'utf8')).accessToken, f.original);
    assert.equal((await f.manager.status()).state, 'disabled');
  } finally { await f.cleanup(); }
});

test('near-expiry credential queues one renewal, while missing credentials never silently log in', async () => {
  const f = await fixture({ oldToken: jwt({ issued: Math.floor(Date.now() / 1000) - 100, expires: Math.floor(Date.now() / 1000) + 60 }) });
  try {
    await f.pair();
    const a = (await f.request('/v1/command')).data.job;
    await f.manager.check(); await f.manager.check();
    assert.equal((await f.request('/v1/command')).data.job.id, a.id);
    await f.request('/v1/failure', { jobId: a.id, code: 'LOGIN_REQUIRED' });
    assert.equal((await f.manager.status()).state, 'waiting_for_login');
    assert.equal((await f.request('/v1/command')).data.job.id, a.id, 'a restarted browser can resume the pending job');
  } finally { await f.cleanup(); }
});

test('clearing credentials does not silently start another login', async () => {
  const f = await fixture();
  try {
    await f.pair(); await f.manager.action('disable');
    await unlink(f.credentialFile);
    await f.manager.action('enable'); await f.manager.check();
    assert.equal((await f.request('/v1/command')).data.job, null);
    assert.equal((await f.manager.status()).expiresAt, null);
  } finally { await f.cleanup(); }
});

const browserSession = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('normal scheduling renews at 12 hours after token issuance, independently of its 24-hour expiration', async () => {
  const issued = Math.floor(Date.now() / 1000); let clock = issued * 1000;
  const f = await fixture({ now: () => clock });
  try {
    await f.pair(); const initial = (await f.request('/v1/command')).data.job;
    assert.equal((await f.request('/v1/complete', { jobId: initial.id, accessToken: jwt({ issued }) })).status, 200);
    assert.equal((await f.manager.status()).renewIntervalHours, 12);
    assert.equal((await f.manager.status()).nextRenewAt, new Date(clock + 12 * 3600000).toISOString());
    clock += 12 * 3600000 - 1; await f.manager.check();
    assert.equal((await f.request('/v1/command')).data.job, null);
    clock++; await f.manager.check();
    const renewal = (await f.request('/v1/command')).data.job;
    assert.equal(renewal.kind, 'renew');
    assert.notEqual(renewal.id, initial.id);
    assert.equal((await f.manager.status()).expiresAt, new Date(issued * 1000 + 24 * 3600000).toISOString());
    await f.manager.check(); assert.equal((await f.request('/v1/command')).data.job.id, renewal.id);
  } finally { await f.cleanup(); }
});

test('browser startup refreshes an unexpired token once, coalesces retries and survives a DSH restart', async () => {
  let clock = Date.now();
  const f = await fixture({ now: () => clock });
  try {
    await f.pair(); const initial = (await f.request('/v1/command')).data.job;
    await f.request('/v1/failure', { jobId: initial.id, code: 'BROWSER_ERROR' });
    clock += 5 * 60000;
    const start = () => f.request('/v1/browser-start', { sessionId: browserSession(1) });
    const responses = await Promise.all([start(), start(), start()]);
    assert.ok(responses.every(response => response.status === 200));
    const renewal = (await f.request('/v1/command')).data.job;
    assert.equal(renewal.kind, 'renew');
    assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).startupRenewPending, true);
    assert.notEqual(renewal.id, initial.id);
    await f.restart();
    const resumed = (await f.request('/v1/command')).data.job;
    assert.equal(resumed.kind, 'renew', 'acknowledged startup work must resume after a host restart');
    assert.equal((await start()).status, 200);
    assert.equal((await f.request('/v1/command')).data.job.id, resumed.id);
    assert.equal(JSON.parse(await readFile(f.credentialFile, 'utf8')).accessToken, f.original);
  } finally { await f.cleanup(); }
});

test('recent success suppresses repeated browser startups for five minutes, but a later session renews', async () => {
  const issued = Math.floor(Date.now() / 1000); let clock = issued * 1000;
  const f = await fixture({ now: () => clock });
  try {
    await f.pair(); const initial = (await f.request('/v1/command')).data.job;
    assert.equal((await f.request('/v1/complete', { jobId: initial.id, accessToken: jwt({ issued }) })).status, 200);
    clock += 5 * 60000 - 1;
    assert.equal((await f.request('/v1/browser-start', { sessionId: browserSession(2) })).status, 200);
    assert.equal((await f.request('/v1/command')).data.job, null);
    assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).startupRenewPending, false);
    clock += 2;
    await f.request('/v1/browser-start', { sessionId: browserSession(2) });
    assert.equal((await f.request('/v1/command')).data.job, null, 'the same session is not retried when the cooldown ends');
    await f.request('/v1/browser-start', { sessionId: browserSession(3) });
    assert.equal((await f.request('/v1/command')).data.job.kind, 'renew');
  } finally { await f.cleanup(); }
});

test('browser startup respects disabled login and credential removal; invalid notifications are rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/v1/browser-start', { sessionId: browserSession(4) })).status, 403);
    await f.pair(); await f.manager.action('disable');
    assert.equal((await f.request('/v1/browser-start', { sessionId: 'invalid' })).status, 400);
    await f.request('/v1/browser-start', { sessionId: browserSession(5) });
    assert.equal((await f.request('/v1/command')).data.job, null);
    await unlink(f.credentialFile); await f.manager.action('enable');
    await f.request('/v1/browser-start', { sessionId: browserSession(6) });
    assert.equal((await f.request('/v1/command')).data.job, null);
    assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).startupRenewPending, false);
  } finally { await f.cleanup(); }
});

test('a failed scheduled login waits 30 minutes before another automatic attempt', async () => {
  let clock = Date.now(); const issued = Math.floor(clock / 1000) - 13 * 3600;
  const f = await fixture({ now: () => clock, oldToken: jwt({ issued }) });
  try {
    await f.pair(); const initial = (await f.request('/v1/command')).data.job;
    await f.request('/v1/failure', { jobId: initial.id, code: 'BROWSER_ERROR' });
    clock += 30 * 60000 - 1; await f.manager.check();
    assert.equal((await f.request('/v1/command')).data.job, null);
    clock++; await f.manager.check();
    assert.equal((await f.request('/v1/command')).data.job.kind, 'renew');
  } finally { await f.cleanup(); }
});
