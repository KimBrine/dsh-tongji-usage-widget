import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService } from '../lib/service.js';

const configured = async () => ({ configured: true, type: 'token' });
test('update checks do not block campus queries or require a login; manual checks never query usage', async () => {
  let count = 0, queryCount = 0, available = { state: 'checking', currentVersion: '0.2.1' };
  let finish;
  const checker = { check: ({ force = false } = {}) => {
    count++;
    if (force) { available = { state: 'available', currentVersion: '0.2.1', latestVersion: '0.3.0' }; return Promise.resolve(available); }
    return new Promise(resolve => { finish = resolve; });
  }, status: () => available };
  const service = createUsageService({ updateChecker: checker, credentialStatus: configured,
    query: async () => { queryCount++; return { points: { planRemaining: 10 } }; } });
  const value = await service.status();
  assert.equal(value.report.points.planRemaining, 10);
  assert.equal(value.updates.state, 'checking');
  assert.equal((await service.checkUpdate()).updates.latestVersion, '0.3.0');
  assert.equal(queryCount, 1); assert.equal(count, 2);
  finish(available); service.dispose();
  await assert.rejects(service.checkUpdate());
  const noLogin = createUsageService({ updateChecker: { ...checker, check: async () => available }, credentialStatus: async () => ({ configured: false }) });
  assert.equal((await noLogin.status()).updates.state, 'available'); noLogin.dispose();
});
test('shared requests use a 30-second cache and manual refresh has a 3-second cooldown', async () => {
  let count = 0, clock = 1000;
  let release;
  const service = createUsageService({ credentialStatus: configured, now: () => clock,
    query: async () => { count++; await new Promise(resolve => { release = resolve; }); return { queriedAt: 't', points: { planRemaining: 10 } }; } });
  const a = service.status(), b = service.status();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1); release();
  const first = await a;
  assert.deepEqual(first, await b);
  assert.equal(first.refreshInterval, 30);
  await service.status({ force: true });
  assert.equal(count, 1);
  clock += 29999;
  await service.status();
  assert.equal(count, 1);
  clock++;
  const c = service.status();
  await new Promise(resolve => setImmediate(resolve)); release(); await c;
  assert.equal(count, 2);
  clock += 2999;
  await service.status({ force: true });
  assert.equal(count, 2);
  clock++;
  const d = service.status({ force: true });
  await new Promise(resolve => setImmediate(resolve)); release(); await d;
  assert.equal(count, 3);
  service.dispose();
});

test('valid automatic and manual quota queries only read the existing login and never schedule renewal', async () => {
  let clock = 0, queries = 0, checks = 0, renewals = 0, revisions = 0;
  const service = createUsageService({ credentialStatus: configured, now: () => clock,
    credentialRevision: async () => { revisions++; return 'unchanged-saved-credential'; },
    autoLogin: { check: async () => { checks++; }, requestRenew: async () => { renewals++; },
      status: async () => ({ state: 'idle', connected: true, enabled: true }) },
    query: async () => { queries++; return { points: { planRemaining: 10 } }; } });
  assert.equal((await service.status()).report.points.planRemaining, 10);
  clock += 30000;
  assert.equal((await service.status()).report.points.planRemaining, 10);
  clock += 3000;
  assert.equal((await service.status({ force: true })).report.points.planRemaining, 10);
  assert.equal(queries, 3);
  assert.ok(revisions >= 3);
  assert.equal(checks, 0);
  assert.equal(renewals, 0);
  service.dispose();
});

test('network failure during quota refresh does not reset the login state', async () => {
  let checks = 0, renewals = 0;
  const service = createUsageService({ credentialStatus: configured,
    autoLogin: { check: async () => { checks++; }, requestRenew: async () => { renewals++; }, status: async () => ({ state: 'idle' }) },
    query: async () => { throw Object.assign(new Error('secret'), { code: 'NETWORK' }); } });
  assert.equal((await service.status({ force: true })).error.code, 'NETWORK');
  assert.equal(checks, 0); assert.equal(renewals, 0);
  service.dispose();
});

test('concurrent rejected quota queries request one login recovery and reuse the authentication error cache', async () => {
  let queries = 0, renewals = 0, release;
  const service = createUsageService({ credentialStatus: configured, now: () => 1000,
    autoLogin: { check: async () => { throw new Error('quota refresh must not run the login scheduler'); },
      status: async () => ({ state: 'opening' }), requestRenew: async () => { renewals++; } },
    query: async () => { queries++; await new Promise(resolve => { release = resolve; }); throw Object.assign(new Error('secret'), { code: 'AUTH_EXPIRED' }); } });
  const first = service.status({ force: true });
  const second = service.status({ force: true });
  await new Promise(resolve => setImmediate(resolve)); release();
  assert.equal((await first).error.code, 'AUTH_EXPIRED');
  assert.equal((await second).error.code, 'AUTH_EXPIRED');
  assert.equal((await service.status({ force: true })).error.code, 'AUTH_EXPIRED');
  assert.equal(queries, 1); assert.equal(renewals, 1);
  service.dispose();
});
test('network error keeps old report, auth error clears it and messages are redacted', async () => {
  let mode = 'ok', clock = 0;
  const service = createUsageService({ credentialStatus: configured, now: () => clock,
    query: async () => { if (mode !== 'ok') throw Object.assign(new Error('SECRET'), { code: mode }); return { points: { planRemaining: 12 } }; } });
  await service.status();
  mode = 'NETWORK'; clock += 60001;
  const stale = await service.status();
  assert.equal(stale.report.points.planRemaining, 12);
  assert.equal(stale.error.code, 'NETWORK');
  assert.ok(!JSON.stringify(stale).includes('SECRET'));
  mode = 'AUTH_EXPIRED'; clock += 60001;
  const expired = await service.status();
  assert.equal(expired.report, null);
  assert.equal(expired.error.code, 'AUTH_EXPIRED');
});
test('credential removal clears cached private reports; invalid range never queries', async () => {
  let configuredFlag = true, count = 0;
  const service = createUsageService({ credentialStatus: async () => ({ configured: configuredFlag, type: configuredFlag ? 'token' : null }),
    query: async () => { count++; return { points: { planRemaining: 12 } }; } });
  await service.status(); configuredFlag = false;
  const value = await service.status();
  assert.equal(value.report, null);
  assert.equal(value.error.code, 'AUTH_MISSING');
  await assert.rejects(service.status({ range: 'invalid' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(count, 1);
  service.dispose();
  await assert.rejects(service.status());
});
test('auth failures invalidate every range and old in-flight requests', async () => {
  let clock = 0, mode = 'ok', release;
  const service = createUsageService({ credentialStatus: configured, now: () => clock,
    query: async ({ range }) => {
      if (mode === 'wait') await new Promise(resolve => { release = resolve; });
      if (range === '7d') throw Object.assign(new Error('redact'), { code: 'AUTH_EXPIRED' });
      return { usage: { range }, points: { planRemaining: 12 } };
    } });
  await service.status();
  mode = 'wait'; clock += 60001;
  const pending = service.status();
  await new Promise(resolve => setImmediate(resolve));
  mode = 'fail';
  const failed = await service.status({ range: '7d' });
  release();
  assert.equal(failed.error.code, 'AUTH_EXPIRED');
  assert.equal((await pending).report, null);
});
test('credential replacement clears cached account and deletion stops pending writeback', async () => {
  let revision = 'a', release, count = 0;
  const service = createUsageService({ credentialStatus: configured, credentialRevision: async () => revision,
    query: async () => { count++; if (count === 3) await new Promise(resolve => { release = resolve; }); return { account: revision }; } });
  assert.equal((await service.status()).report.account, 'a');
  revision = 'b';
  assert.equal((await service.status()).report.account, 'b');
  assert.equal(count, 2);
  const pending = service.status({ range: '7d' });
  await new Promise(resolve => setImmediate(resolve));
  revision = null; release();
  assert.equal((await pending).report, null);
});
test('expired login requests automatic renewal and new credentials bypass the old auth-error cache', async () => {
  let revision = 'old', attempts = 0, state = 'idle';
  const autoLogin = { check: async () => {}, status: async () => ({ state }), requestRenew: async () => { attempts++; state = 'opening'; } };
  const service = createUsageService({ autoLogin, credentialStatus: configured, credentialRevision: async () => revision,
    query: async () => { if (revision === 'old') throw Object.assign(new Error('secret'), { code: 'AUTH_EXPIRED' }); return { points: { planRemaining: 15 } }; } });
  const expired = await service.status();
  assert.equal(attempts, 1); assert.equal(expired.autoLogin.state, 'opening'); assert.equal(expired.report, null);
  revision = 'new'; state = 'success';
  const renewed = await service.status();
  assert.equal(renewed.error, null); assert.equal(renewed.report.points.planRemaining, 15);
  assert.equal(renewed.autoLogin.state, 'success'); service.dispose();
});

test('explicit installs coalesce release resolution, do not query credits and expose restart state', async () => {
  let resolved = 0, installed = 0, releaseFetch;
  let installerState = { state: 'idle', canInstall: true };
  const service = createUsageService({ credentialStatus: async () => { throw new Error('must not read campus credentials'); },
    updateChecker: { status: () => ({ currentVersion: '0.2.4', latestVersion: '0.3.0' }) },
    updateInstaller: { probe: async () => {}, status: () => installerState, install: async release => {
      assert.equal(release.version, '0.3.0'); installed++; installerState = { state: 'installed', canInstall: false, restartRequired: true }; } },
    releaseResolver: async () => { resolved++; await new Promise(resolve => { releaseFetch = resolve; }); return { version: '0.3.0' }; } });
  const first = service.installUpdate(), second = service.installUpdate();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); releaseFetch();
  const result = await first;
  assert.equal(resolved, 1); assert.equal(installed, 1); assert.equal(result.updates.installer.restartRequired, true);
  service.dispose(); await assert.rejects(service.installUpdate());
});

test('unsupported installation returns download guidance without contacting GitHub or changing files', async () => {
  const service = createUsageService({ updateInstaller: { probe: async () => {}, status: () => ({ state: 'unsupported', canInstall: false }) },
    releaseResolver: async () => { throw new Error('must not resolve'); } });
  assert.equal((await service.installUpdate()).updates.installer.state, 'unsupported'); service.dispose();
});
