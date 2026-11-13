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

async function fixture({ fetchImpl, environment = {}, oldToken } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tongji-auto-login-'));
  const credentialFile = join(directory, 'credentials.json'), configFile = join(directory, 'bridge.json');
  const original = oldToken || jwt({ issued: Math.floor(Date.now() / 1000) - 1800 });
  await writePrivateJson(credentialFile, { version: 1, accessToken: original });
  let validations = 0;
  const manager = createAutoLoginManager({ port: 0, configFile, credentialFile, environment, intervalMs: 1000000,
    fetchImpl: fetchImpl || (async (url, options) => {
      validations++;
      assert.equal(url, 'https://agi.tongji.edu.cn/api/v1/auth/me');
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ code: 200, data: { id: 1 } }), { status: 200 });
    }) });
  await manager.start();
  const port = (await manager.status()).port;
  let key = '';
  const request = async (path, body, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: `chrome-extension://${id}`, 'X-Tongji-Extension': id,
        ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); return { status: response.status, data };
  };
  const pair = async () => {
    const setup = await manager.action('pair');
    assert.match(setup.pairCode, /^\d{8}$/);
    const result = await request('/v1/pair', { code: setup.pairCode });
    assert.equal(result.status, 200);
    key = result.data.bridgeKey;
    assert.match(key, /^[a-f0-9]{64}$/);
    return setup;
  };
  const cleanup = async () => { await manager.dispose(); await rm(directory, { recursive: true, force: true }); };
  return { manager, request, pair, cleanup, original, credentialFile, configFile,
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
    const noOrigin = await fetch(`http://127.0.0.1:${(await f.manager.status()).port}/v1/status`, {
      headers: { 'X-Tongji-Extension': id, Authorization: `Bearer ${f.key()}` } });
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
