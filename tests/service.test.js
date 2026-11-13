import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService } from '../lib/service.js';

const configured = async () => ({ configured: true, type: 'token' });
test('shared requests, cache TTL and force cooldown avoid duplicate polling', async () => {
  let count = 0, clock = 1000;
  let release;
  const service = createUsageService({ credentialStatus: configured, now: () => clock,
    query: async () => { count++; await new Promise(resolve => { release = resolve; }); return { queriedAt: 't', points: { planRemaining: 10 } }; } });
  const a = service.status(), b = service.status();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1); release();
  assert.deepEqual(await a, await b);
  await service.status({ force: true });
  assert.equal(count, 1);
  clock += 60001;
  const c = service.status();
  await new Promise(resolve => setImmediate(resolve)); release(); await c;
  assert.equal(count, 2);
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
