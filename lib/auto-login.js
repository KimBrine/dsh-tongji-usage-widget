import { createServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_DIR, CREDENTIAL_FILE, readSavedCredentials, savedRevision,
  saveAccessToken, tokenMetadata, writePrivateJson } from './credential-store.js';

const DEFAULT_CONFIG = join(CREDENTIAL_DIR, 'browser-bridge.json');
const EXTENSION_PATH = fileURLToPath(new URL('../browser-extension/', import.meta.url));
const allowedStates = new Set(['opening', 'waiting_for_login']);
const errors = {
  NOT_PAIRED: '请先连接 Chrome 助手。',
  INVALID_PAIR_CODE: '连接码不正确或已过期，请在浮窗重新生成。',
  UNAUTHORIZED: 'Chrome 助手尚未连接或连接已失效。',
  INVALID_REQUEST: '请求格式无效。',
  INVALID_TOKEN: '网站没有返回有效的新登录凭据。',
  TOKEN_EXPIRED: '网站返回的登录凭据已过期。',
  ACCOUNT_MISMATCH: 'Chrome 登录的账号与插件原账号不同，未替换凭据。',
  CREDENTIAL_CHANGED: '本机登录凭据已被其他操作更新，本次结果已丢弃。',
  JOB_EXPIRED: '此次更新已结束，请重新点击更新登录。',
  TOKEN_REJECTED: '平台未接受新登录凭据，请在 Chrome 重新登录。',
  NETWORK: '验证新登录凭据时网络异常，原凭据已保留。',
  PRIVATE_WRITE_FAILED: '无法安全保存登录凭据，原文件已保留。',
  BROWSER_ERROR: 'Chrome 登录未完成，请打开助手继续登录。',
  DISABLED: '自动更新登录已关闭。',
  ENV_AUTH: '当前使用环境变量登录，请移除登录环境变量后再启用自动更新。',
};
const problem = code => Object.assign(new Error(errors[code] || errors.INVALID_REQUEST), { code });
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function extensionId(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '') ? origin.slice('chrome-extension://'.length) : null;
}
function requestExtension(req) {
  const declared = req.headers['x-tongji-extension'];
  const originId = extensionId(req.headers.origin);
  if (req.headers.origin && !originId) return null;
  if (declared && (!/^[a-p]{32}$/.test(declared) || (originId && originId !== declared))) return null;
  return declared || originId;
}

/** Loopback-only bridge. It never provides website credentials to callers. */
export function createAutoLoginManager({ port = 17945, configFile = DEFAULT_CONFIG,
  credentialFile = CREDENTIAL_FILE, fetchImpl = globalThis.fetch, now = Date.now,
  environment = process.env, intervalMs = 30000, refreshAheadMs = 15 * 60000 } = {}) {
  let config = { version: 1, enabled: true, bridgeKey: '', extensionId: '', lastRenewedAt: null, principal: null };
  let server, startup, disposed = false, currentPort = port, startupError = false;
  let timer, checking, renewing, heartbeat = 0, pairing = null, job = null;
  let lastFailure = null, lastAttempt = -Infinity, lastSuccess = 0;
  let operationEpoch = 0, changing = 0;
  const environmentAuth = () => !!(environment.TONGJI_AI_ACCESS_TOKEN || environment.TONGJI_AI_COOKIE);
  async function credentialInfo() {
    try {
      const saved = await readSavedCredentials({ file: credentialFile });
      if (!saved?.accessToken) return null;
      return tokenMetadata(saved.accessToken);
    } catch { return null; }
  }
  function expireJob() {
    if (job && now() > job.deadline) {
      job.abort?.abort(); job = null;
      lastFailure = '登录等待已超时，请点击“更新登录”重试。';
      lastAttempt = now();
    }
  }
  async function status() {
    expireJob();
    const info = await credentialInfo();
    const paired = !!config.bridgeKey && !!config.extensionId;
    const connected = paired && heartbeat > 0 && now() - heartbeat < 90000;
    let state = 'idle', message = '已连接，到期前会自动更新登录。';
    if (startupError) { state = 'error'; message = '本机连接端口不可用，请关闭重复的监控实例后重开 DSH。'; }
    else if (environmentAuth()) { state = 'disabled'; message = errors.ENV_AUTH; }
    else if (job) {
      state = job.state;
      message = ({ queued: connected ? '正在等待 Chrome 助手更新登录…' : '已排队，请打开 Chrome。',
        opening: '正在借用学校登录状态重新登录…', waiting_for_login: '请在 Chrome 助手中点“继续登录”，完成学校验证。',
        validating: '正在验证并安全保存新登录凭据…' })[state];
      if (job.errorMessage) message = `${job.errorMessage} 请在 Chrome 助手中点“继续登录”。`;
    } else if (!config.enabled) { state = 'disabled'; message = '自动更新登录已关闭。'; }
    else if (!paired) { state = 'unpaired'; message = '连接 Chrome 助手后，可自动更新登录。'; }
    else if (!connected) { state = 'offline'; message = 'Chrome 助手离线，打开 Chrome 后会继续自动更新。'; }
    else if (lastFailure) { state = 'error'; message = lastFailure; }
    else if (lastSuccess && now() - lastSuccess < 60000) { state = 'success'; message = '登录已自动更新，积分即将刷新。'; }
    else if (!info) message = '尚未绑定登录，点击“更新登录”即可获取。';
    return { state, message, enabled: config.enabled, paired, connected, port: currentPort,
      expiresAt: info ? new Date(info.expiresAt * 1000).toISOString() : null,
      lastRenewedAt: config.lastRenewedAt, extensionPath: EXTENSION_PATH };
  }
  async function persist(next) { await writePrivateJson(configFile, next); config = next; }
  async function requestRenew({ manual = false } = {}) {
    await start();
    if (changing) return status();
    if (renewing) return renewing;
    const epoch = operationEpoch;
    renewing = (async () => {
    expireJob();
    if (disposed) throw problem('DISABLED');
    if (!config.bridgeKey || !config.extensionId) throw problem('NOT_PAIRED');
    if (environmentAuth()) throw problem('ENV_AUTH');
    if (!config.enabled && !manual) return status();
    if (job) return status();
    if (now() - lastAttempt < (manual ? 3000 : 120000)) return status();
    const revision = await savedRevision({ file: credentialFile });
    const info = await credentialInfo();
    if (disposed || changing || epoch !== operationEpoch) throw problem('JOB_EXPIRED');
    if (job) return status();
    // Explicitly clearing credentials must not be undone by a timer.
    if (!manual && !info) return status();
    const principal = info?.principal || config.principal || null;
    job = { id: randomBytes(16).toString('hex'), requestedAt: now(), deadline: now() + 15 * 60000,
      state: 'queued', revision, principal, epoch: operationEpoch };
    lastAttempt = now(); lastFailure = null;
    return status();
    })().finally(() => { renewing = null; });
    return renewing;
  }
  async function cancelJob() {
    operationEpoch++;
    const current = job;
    job = null; current?.abort?.abort();
    // A commit already handed to the filesystem must finish before cancellation returns.
    try { await current?.commitPromise; } catch { /* canceled before commit */ }
  }
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      if (disposed || !config.enabled || !config.bridgeKey || environmentAuth()) return;
      expireJob();
      if (job) return;
      const info = await credentialInfo();
      if (info && info.expiresAt * 1000 <= now() + refreshAheadMs) await requestRenew();
    })().catch(() => { /* next visible status explains missing connection */ }).finally(() => { checking = null; });
    return checking;
  }
  async function beginPairing() {
    await start();
    if (disposed || startupError) throw problem('BROWSER_ERROR');
    if (environmentAuth()) throw problem('ENV_AUTH');
    pairing = { code: String(randomInt(10000000, 100000000)), expires: now() + 5 * 60000, attempts: 0, consumed: false };
    return { autoLogin: await status(), pairCode: pairing.code, pairExpiresAt: new Date(pairing.expires).toISOString() };
  }
  async function pair(code, id) {
    const current = pairing;
    if (!id || !current || current.consumed || now() > current.expires || current.attempts >= 10) throw problem('INVALID_PAIR_CODE');
    current.attempts++;
    if (!equal(String(code || ''), current.code)) throw problem('INVALID_PAIR_CODE');
    current.consumed = true;
    await cancelJob();
    const next = { ...config, enabled: true, bridgeKey: randomBytes(32).toString('hex'), extensionId: id };
    await persist(next);
    heartbeat = now();
    await requestRenew({ manual: true });
    return { bridgeKey: config.bridgeKey, autoLogin: await status() };
  }
  async function validateOnPlatform(token, meta, signal) {
    let response, data;
    try {
      response = await fetchImpl('https://agi.tongji.edu.cn/api/v1/auth/me', { method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, redirect: 'error', signal });
      if (!response.ok) throw problem([401, 403].includes(response.status) ? 'TOKEN_REJECTED' : 'NETWORK');
      const text = await response.text();
      if (text.length > 256000) throw problem('TOKEN_REJECTED');
      data = JSON.parse(text);
    } catch (error) { throw problem(error?.code === 'TOKEN_REJECTED' ? 'TOKEN_REJECTED' : 'NETWORK'); }
    for (let depth = 0; depth < 3 && data && typeof data === 'object'; depth++) {
      if (Object.hasOwn(data, 'code') && ![0, 200, '0', '200'].includes(data.code)) throw problem('TOKEN_REJECTED');
      if (!Object.hasOwn(data, 'data')) break;
      data = data.data;
    }
    if (!data || typeof data !== 'object' || !['string', 'number'].includes(typeof data.id) || String(data.id) !== meta.userId) throw problem('ACCOUNT_MISMATCH');
  }
  async function complete(body) {
    expireJob();
    const current = job;
    if (!current || body.jobId !== current.id || current.epoch !== operationEpoch) throw problem('JOB_EXPIRED');
    if (current.state === 'validating') throw problem('INVALID_REQUEST');
    const token = body.accessToken;
    const meta = tokenMetadata(token);
    if (meta.expiresAt * 1000 <= now() + 60000) throw problem('TOKEN_EXPIRED');
    if (meta.issuedAt * 1000 < current.requestedAt - 5000 || meta.issuedAt * 1000 > now() + 60000) throw problem('INVALID_TOKEN');
    if (current.principal && current.principal !== meta.principal) throw problem('ACCOUNT_MISMATCH');
    current.state = 'validating'; current.abort = new AbortController();
    const signal = AbortSignal.any ? AbortSignal.any([current.abort.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    try {
      await validateOnPlatform(token, meta, signal);
      if (disposed || job !== current || current.epoch !== operationEpoch) throw problem('JOB_EXPIRED');
      current.commitPromise = saveAccessToken(token, { file: credentialFile, expectedRevision: current.revision,
        beforeCommit: () => !disposed && job === current && current.epoch === operationEpoch });
      await current.commitPromise;
      if (disposed || job !== current || current.epoch !== operationEpoch) throw problem('JOB_EXPIRED');
      lastSuccess = now(); lastFailure = null; job = null;
      const next = { ...config, principal: meta.principal, lastRenewedAt: new Date(now()).toISOString() };
      // The credential itself was committed; a settings-write error must not report login failure.
      try { await persist(next); } catch { config = next; }
      return { ok: true, autoLogin: await status() };
    } catch (error) {
      const code = Object.hasOwn(errors, error?.code) ? error.code : 'PRIVATE_WRITE_FAILED';
      if (job === current) {
        if (code === 'CREDENTIAL_CHANGED') { job = null; lastFailure = errors[code]; }
        else { current.state = 'waiting_for_login'; current.errorMessage = errors[code]; lastFailure = null; }
      }
      throw problem(code);
    }
  }
  function authorize(req) {
    const id = requestExtension(req);
    return id && id === config.extensionId && equal(req.headers.authorization || '', `Bearer ${config.bridgeKey}`);
  }
  async function readBody(req) {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw problem('INVALID_REQUEST');
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32768) throw problem('INVALID_REQUEST');
      chunks.push(chunk);
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw problem('INVALID_REQUEST');
      return data;
    } catch { throw problem('INVALID_REQUEST'); }
  }
  async function handle(req, res) {
    const origin = req.headers.origin;
    const json = (statusCode, data) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...(extensionId(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
      res.end(JSON.stringify(data));
    };
    const host = `127.0.0.1:${currentPort}`;
    const requestId = requestExtension(req);
    if (req.headers.host !== host || !requestId || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(403, { error: { code: 'UNAUTHORIZED', message: errors.UNAUTHORIZED } });
    const path = new URL(req.url, 'http://local').pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Tongji-Extension', 'Access-Control-Max-Age': '300', Vary: 'Origin' }); res.end(); return;
    }
    try {
      if (path === '/v1/pair' && req.method === 'POST') return json(200, await pair((await readBody(req)).code, requestId));
      if (!authorize(req)) throw problem('UNAUTHORIZED');
      heartbeat = now(); expireJob();
      if (req.method === 'GET' && path === '/v1/status') return json(200, { autoLogin: await status() });
      if (req.method === 'GET' && path === '/v1/command') {
        if (job && job.state !== 'validating') return json(200, { job: { id: job.id, kind: 'renew', requestedAt: job.requestedAt } });
        return json(200, { job: null });
      }
      if (req.method !== 'POST') return json(405, { error: { code: 'INVALID_REQUEST', message: errors.INVALID_REQUEST } });
      const body = await readBody(req);
      if (path === '/v1/renew') return json(200, { autoLogin: await requestRenew({ manual: true }) });
      if (!job || body.jobId !== job.id) throw problem('JOB_EXPIRED');
      if (path === '/v1/progress' && allowedStates.has(body.state)) {
        if (job.state !== 'validating') job.state = body.state;
        return json(200, { ok: true });
      }
      if (path === '/v1/complete') return json(200, await complete(body));
      if (path === '/v1/failure') {
        if (body.code === 'LOGIN_REQUIRED') job.state = 'waiting_for_login';
        else { job.abort?.abort(); job = null; lastFailure = errors.BROWSER_ERROR; lastAttempt = now(); }
        return json(200, { autoLogin: await status() });
      }
      throw problem('INVALID_REQUEST');
    } catch (error) {
      const code = Object.hasOwn(errors, error?.code) ? error.code : 'INVALID_REQUEST';
      json(code === 'UNAUTHORIZED' ? 403 : code === 'JOB_EXPIRED' ? 409 : 400, { error: { code, message: errors[code] } });
    }
  }
  async function start() {
    if (startup) return startup;
    startup = (async () => {
      try {
        const saved = JSON.parse(await readFile(configFile, 'utf8'));
        if (saved?.version === 1 && typeof saved.enabled === 'boolean') config.enabled = saved.enabled;
        if (/^[a-f0-9]{64}$/.test(saved?.bridgeKey || '') && /^[a-p]{32}$/.test(saved?.extensionId || '')) {
          config = { ...config, bridgeKey: saved.bridgeKey, extensionId: saved.extensionId,
            lastRenewedAt: typeof saved.lastRenewedAt === 'string' ? saved.lastRenewedAt : null,
            principal: typeof saved.principal === 'string' ? saved.principal : null };
        }
      } catch { /* no pairing yet; no private information leaves this process */ }
      if (disposed) return;
      server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.writableEnded) { res.writeHead(500); res.end(); } }); });
      server.requestTimeout = 15000; server.headersTimeout = 10000;
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        currentPort = server.address().port;
      } catch { startupError = true; return; }
      if (disposed) { await new Promise(resolve => server.close(resolve)); return; }
      timer = setInterval(() => check(), intervalMs); timer.unref?.();
      void check();
    })();
    return startup;
  }
  async function action(name) {
    await start();
    if (name === 'pair') return beginPairing();
    if (name === 'renew') return { autoLogin: await requestRenew({ manual: true }) };
    if (name === 'enable' || name === 'disable') {
      changing++;
      config = { ...config, enabled: name === 'enable' };
      try {
        await cancelJob();
        await persist(config);
      } finally { changing--; }
      if (name === 'enable') await check();
      return { autoLogin: await status() };
    }
    throw problem('INVALID_REQUEST');
  }
  return { start, status, check, action, requestRenew,
    async dispose() {
      disposed = true; clearInterval(timer); await cancelJob();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      server?.closeAllConnections?.();
    },
  };
}
