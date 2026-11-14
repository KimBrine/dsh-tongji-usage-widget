/* The worker stores only the local bridge key and non-secret job metadata. Website tokens never enter storage. */
importScripts('shared.js');
(function () {
  'use strict';
  const core = TongjiLoginCore;
  const browser = core.detectBrowser();
  const CONFIG_KEY = 'tongjiLoginBridge';
  const JOB_KEY = 'tongjiLoginJob';
  const SESSION_KEY = 'tongjiLoginBrowserSession';
  const ALARM = 'tongji-login-bridge-poll';
  let polling = false;
  let pollAgain = false;
  let installResetRequested = false;
  let sessionCreatedHere = false;
  let startAttemptedHere = false;
  let submitting = false;
  const ssoClaims = new Set();
  let jobWrites = Promise.resolve();
  const safeCodes = new Set(['INVALID_PORT', 'INVALID_PAIR_CODE', 'PAIR_REJECTED', 'BRIDGE_OFFLINE', 'BRIDGE_UNAUTHORIZED', 'BROWSER_ERROR', 'LOGIN_REQUIRED', 'ACCOUNT_MISMATCH', 'INVALID_TOKEN', 'JOB_EXPIRED', 'NOT_PAIRED', 'NO_LOGIN_TAB', 'BUSY']);
  const safeCode = error => safeCodes.has(error?.message) ? error.message : 'BROWSER_ERROR';
  async function readConfig() {
    const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
    if (!stored || typeof stored.bridgeKey !== 'string' || stored.bridgeKey.length < 20) return null;
    try { return { port: core.normalizePort(stored.port), bridgeKey: stored.bridgeKey }; } catch { return null; }
  }
  async function readJob() { await jobWrites; return (await chrome.storage.session.get(JOB_KEY))[JOB_KEY] || null; }
  function writeJob(job, expectedId) {
    const pending = jobWrites.then(async () => {
      const current = (await chrome.storage.session.get(JOB_KEY))[JOB_KEY];
      if (expectedId !== undefined && current?.id !== expectedId) return false;
      if (!job) { await chrome.storage.session.remove(JOB_KEY); return true; }
      const merged = current?.id === job.id ? { ...current, ...job,
        ssoStarted: !!(current.ssoStarted || job.ssoStarted), waiting: !!(current.waiting || job.waiting),
        timeoutReported: !!(current.timeoutReported || job.timeoutReported) } : job;
      await chrome.storage.session.set({ [JOB_KEY]: merged });
      return true;
    });
    jobWrites = pending.catch(() => {});
    return pending;
  }
  async function request(config, path, { method = 'GET', body, anonymous = false } = {}) {
    let response;
    try {
      response = await fetch(core.baseUrl(config.port) + path, {
        method, cache: 'no-store', credentials: 'omit', redirect: 'error',
        signal: AbortSignal.timeout(path === '/v1/complete' ? 30000 : 10000),
        headers: { Accept: 'application/json', 'X-Tongji-Extension': chrome.runtime.id, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(anonymous ? {} : { Authorization: `Bearer ${config.bridgeKey}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('BRIDGE_OFFLINE'); }
    if (!response.ok) {
      if (path === '/v1/pair') throw new Error('PAIR_REJECTED');
      if ([401, 403].includes(response.status)) throw new Error('BRIDGE_UNAUTHORIZED');
      let code;
      try { const data = await response.json(); code = data.error?.code || data.code; } catch { /* do not display server bodies */ }
      throw new Error(safeCodes.has(code) ? code : 'BROWSER_ERROR');
    }
    try { return await response.json(); } catch { throw new Error('BROWSER_ERROR'); }
  }
  async function reportFailure(config, job, code) {
    try { await request(config, '/v1/failure', { method: 'POST', body: { jobId: job.id, code } }); } catch { /* the next poll retries connection */ }
  }
  async function notifyBrowserStart(config) {
    let session = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
    const valid = session && typeof session.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(session.id) && typeof session.notified === 'boolean';
    // onInstalled and the worker's default boot may overlap. Reuse a session already
    // created/attempted by this worker so that those events cannot announce two IDs.
    if (!valid || (installResetRequested && !sessionCreatedHere && !startAttemptedHere)) {
      session = { id: crypto.randomUUID(), notified: false };
      sessionCreatedHere = true;
      await chrome.storage.session.set({ [SESSION_KEY]: session });
    }
    installResetRequested = false;
    if (session.notified) return;
    startAttemptedHere = true;
    await request(config, '/v1/browser-start', { method: 'POST', body: { sessionId: session.id } });
    // Persist only after acknowledgement. An offline bridge is retried with the same
    // non-secret ID on the next alarm; a revived MV3 worker reuses this session record.
    await chrome.storage.session.set({ [SESSION_KEY]: { id: session.id, notified: true } });
  }
  async function poll({ again = false } = {}) {
    if (polling) { if (again) pollAgain = true; return; }
    polling = true;
    try {
      const config = await readConfig();
      if (!config) return;
      await notifyBrowserStart(config);
      let owned = await readJob();
      if (owned && Date.now() - core.timestamp(owned.requestedAt) > 900000) { ssoClaims.delete(owned.id); await writeJob(null, owned.id); owned = null; }
      if (owned && !owned.waiting && Date.now() - owned.startedAt > 15000) {
        owned = { ...owned, waiting: true };
        await writeJob(owned, owned.id);
        await request(config, '/v1/progress', { method: 'POST', body: { jobId: owned.id, state: 'waiting_for_login' } });
      }
      if (owned && !owned.timeoutReported && Date.now() - owned.startedAt > 180000) {
        owned = { ...owned, timeoutReported: true, waiting: true };
        await writeJob(owned, owned.id);
        await reportFailure(config, owned, 'LOGIN_REQUIRED');
      }
      const command = await request(config, '/v1/command');
      const job = command?.job;
      if (!job || typeof job.id !== 'string' || core.timestamp(job.requestedAt) === null) return;
      if (job.kind === 'focus') return; // Focusing is always initiated by the user in the popup.
      if (job.kind && job.kind !== 'renew') return;
      if (owned?.id === job.id) return;
      const next = { id: job.id, requestedAt: job.requestedAt, tabId: null, startedAt: Date.now(), waiting: false, timeoutReported: false };
      await writeJob(next);
      try {
        const tab = await chrome.tabs.create({ url: `${core.SITE_ORIGIN}/login`, active: false });
        if (!Number.isInteger(tab.id)) throw new Error('BROWSER_ERROR');
        await writeJob({ ...next, tabId: tab.id }, next.id);
        await request(config, '/v1/progress', { method: 'POST', body: { jobId: next.id, state: 'opening' } });
      } catch {
        await reportFailure(config, next, 'BROWSER_ERROR');
      }
    } catch { /* No credentials or remote messages are logged. Popup gives a bounded status. */ }
    finally {
      polling = false;
      if (pollAgain) { pollAgain = false; void poll(); }
    }
  }
  async function status() {
    const config = await readConfig();
    const owned = await readJob();
    if (!config) return { paired: false, browser, startupNotifications: true, port: core.DEFAULT_PORT, connected: false, hasOwnedTab: false };
    try {
      const response = await request(config, '/v1/status');
      const value = response.autoLogin || response;
      // Explicit allowlist: the popup never receives bridgeKey or a website token.
      return { paired: true, browser, startupNotifications: true, port: config.port, connected: true, hasOwnedTab: Number.isInteger(owned?.tabId),
        state: typeof value.state === 'string' ? value.state : typeof value.phase === 'string' ? value.phase : 'connected',
        enabled: typeof value.enabled === 'boolean' ? value.enabled : null,
        renewIntervalHours: typeof value.renewIntervalHours === 'number' && Number.isFinite(value.renewIntervalHours) && value.renewIntervalHours > 0 ? value.renewIntervalHours : null,
        nextRenewAt: value.nextRenewAt ?? null,
        expiresAt: value.expiresAt ?? value.credentialExpiresAt ?? null,
        lastRenewedAt: value.lastRenewedAt ?? value.lastSuccessAt ?? null };
    } catch (error) {
      return { paired: true, browser, startupNotifications: true, port: config.port, connected: false, hasOwnedTab: Number.isInteger(owned?.tabId), code: safeCode(error) };
    }
  }
  async function popupMessage(message) {
    if (message.action === 'pair') {
      const port = core.normalizePort(message.port);
      const code = String(message.code || '').trim();
      if (!/^\d{8}$/.test(code)) throw new Error('INVALID_PAIR_CODE');
      const response = await request({ port }, '/v1/pair', { method: 'POST', body: { code, browser }, anonymous: true });
      if (typeof response.bridgeKey !== 'string' || response.bridgeKey.length < 20) throw new Error('PAIR_REJECTED');
      await chrome.storage.local.set({ [CONFIG_KEY]: { port, bridgeKey: response.bridgeKey } });
      await writeJob(null);
      await poll();
      return { ok: true, status: await status() };
    }
    if (message.action === 'status') { await poll(); return { ok: true, status: await status() }; }
    const config = await readConfig();
    if (!config) throw new Error('NOT_PAIRED');
    if (message.action === 'renew') {
      await request(config, '/v1/renew', { method: 'POST', body: {} });
      await poll();
      return { ok: true, status: await status() };
    }
    if (message.action === 'focus') {
      const owned = await readJob();
      if (!Number.isInteger(owned?.tabId)) throw new Error('NO_LOGIN_TAB');
      try {
        const tab = await chrome.tabs.update(owned.tabId, { active: true });
        if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
      } catch { throw new Error('NO_LOGIN_TAB'); }
      return { ok: true, status: await status() };
    }
    throw new Error('BROWSER_ERROR');
  }
  async function contentMessage(message, sender) {
    const owned = await readJob();
    if (!core.trustedContentSender(sender, owned)) return { ok: false, code: 'NOT_OWNED', job: null };
    if (Date.now() - core.timestamp(owned.requestedAt) > 900000) {
      await writeJob(null, owned.id);
      return { ok: false, code: 'JOB_EXPIRED', job: null };
    }
    if (message.action === 'owned-job') return { ok: true, job: { id: owned.id, requestedAt: owned.requestedAt } };
    if (message.jobId !== owned.id) return { ok: false, code: 'NOT_OWNED' };
    if (message.action === 'begin-sso') {
      if (owned.ssoStarted || ssoClaims.has(owned.id)) return { ok: true, click: false };
      ssoClaims.add(owned.id);
      const saved = await writeJob({ ...owned, ssoStarted: true }, owned.id);
      return { ok: true, click: saved };
    }
    const config = await readConfig();
    if (!config) throw new Error('NOT_PAIRED');
    if (message.action === 'waiting') {
      if (!owned.waiting) {
        await writeJob({ ...owned, waiting: true }, owned.id);
        await request(config, '/v1/progress', { method: 'POST', body: { jobId: owned.id, state: 'waiting_for_login' } });
      }
      return { ok: true };
    }
    if (message.action !== 'candidate') return { ok: false, code: 'BROWSER_ERROR' };
    if (!core.candidateMetadata(message.accessToken, owned.requestedAt)) return { ok: false, code: 'INVALID_TOKEN' };
    if (submitting) return { ok: false, code: 'BUSY' };
    submitting = true;
    try {
      const result = await request(config, '/v1/complete', { method: 'POST', body: { jobId: owned.id, accessToken: message.accessToken } });
      if (result.ok === false) throw new Error('BROWSER_ERROR');
      // Clear before removing: onRemoved must not turn a completed job into BROWSER_ERROR.
      await writeJob(null, owned.id);
      ssoClaims.delete(owned.id);
      try { await chrome.tabs.remove(owned.tabId); } catch { /* already closed */ }
      return { ok: true };
    } finally { submitting = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    (async () => {
      try {
        if (!message || typeof message.action !== 'string') return { ok: false, code: 'BROWSER_ERROR' };
        if (core.trustedPopupSender(sender, chrome.runtime)) return await popupMessage(message);
        return await contentMessage(message, sender);
      } catch (error) { return { ok: false, code: safeCode(error) }; }
    })().then(respond);
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    void (async () => {
      const owned = await readJob();
      if (owned?.tabId !== tabId) return;
      await writeJob(null, owned.id);
      const config = await readConfig();
      if (config) await reportFailure(config, owned, 'BROWSER_ERROR');
    })().catch(() => {});
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void poll(); });
  const start = () => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); void poll({ again: true }); };
  chrome.runtime.onInstalled.addListener(() => { installResetRequested = true; start(); });
  chrome.runtime.onStartup.addListener(start);
  start();
})();
