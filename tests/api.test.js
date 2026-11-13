import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, chooseSubscription, getCredentialRevision, getCredentialStatus, number, queryUsage } from '../lib/api.js';

const credential = { type: 'token', value: 'synthetic-token' };
const account = { mode: 'points', total_available: 847.7058, wallet_balance: 10, tokens_per_point: 100000 };
const subscription = { id: 1, status: 'active', started_at: '2026-10-26T14:24:00Z', expires_at: '2099-01-01T00:00:00Z', plan: { name: 'Free' } };
const planUsage = {
  billing_mode: 'points', points_included: 1000, points_period_used: 176.614,
  points_period_remaining: 823.386, points_reset_cycle: 'week', next_reset_at: '2026-11-16T00:00:00+08:00',
};
const stats = {
  since: '2026-11-13T00:00:00+08:00', until: '2026-11-14T00:00:00+08:00',
  summary: { calls: 63, text_tokens: 12345, points_cost: 176.614 },
  by_model: [{ model_display_name: 'Example-Model', input_tokens: 4000, cached_tokens: 6000, output_tokens: 2345, text_tokens: 12345, calls: 63, points_cost: 176.614 }],
};

function server(overrides = {}, requests = []) {
  return async (url, init) => {
    assert.equal(url.origin, 'https://agi.tongji.edu.cn');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(init.headers.Cookie, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    requests.push(`${url.pathname}${url.search}`);
    const key = url.pathname.endsWith('/billing/overview') ? 'account'
      : url.pathname.endsWith('/my-coding-plans') ? 'subscriptions'
        : url.pathname.endsWith('/my-usage/stats') ? 'stats'
          : url.pathname.endsWith('/my-coding-plans/1/usage') ? 'plan' : null;
    assert.ok(key, `Unexpected path: ${url.pathname}`);
    if (Object.hasOwn(overrides, key)) {
      const override = overrides[key];
      if (override instanceof Error) throw override;
      if (override instanceof Response) return override;
      return new Response(JSON.stringify(override));
    }
    return new Response(JSON.stringify({ code: 200, data: { account, subscriptions: { list: [subscription] }, plan: planUsage, stats }[key] }));
  };
}

test('queries fixed read-only endpoints and preserves points, tokens and range meanings', async () => {
  const requests = [];
  const report = await queryUsage({ credential, range: '7d', fetchImpl: server({}, requests) });
  assert.equal(report.plan.name, 'Free');
  assert.equal(report.plan.id, 1);
  assert.equal(report.points.planRemaining, 823.386);
  assert.equal(report.points.planIncluded, 1000);
  assert.equal(report.points.planPeriodUsed, 176.614);
  assert.equal(report.points.totalAvailable, 847.7058);
  assert.equal(report.points.walletBalance, 10);
  assert.equal(report.points.source, 'plan');
  assert.equal(report.points.remainingPercentage, 82.3386);
  assert.equal(report.points.resetAt, '2026-11-15T16:00:00.000Z');
  assert.equal(report.tokenBudget, 82338600);
  assert.equal(report.usage.range, '7d');
  assert.equal(report.usage.totalTokens, 12345);
  assert.equal(report.usage.inputTokens, 4000);
  assert.equal(report.usage.cachedInputTokens, 6000);
  assert.equal(report.usage.outputTokens, 2345);
  assert.equal(report.usage.inputTokens + report.usage.cachedInputTokens + report.usage.outputTokens, report.usage.totalTokens);
  assert.equal(report.usage.calls, 63);
  assert.equal(report.usage.pointsCost, 176.614);
  assert.equal(report.usage.periodMatchesPlanReset, false);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(new Set(requests), new Set([
    '/api/v1/billing/overview', '/api/v1/my-coding-plans?page=1&page_size=100',
    '/api/v1/my-coding-plans/1/usage', '/api/v1/my-usage/stats?kind=plan&range=7d',
  ]));
  assert.ok(!JSON.stringify(report).includes('synthetic-token'));
});

test('account balance fallback stays explicitly labeled and does not invent a plan percentage', async () => {
  const report = await queryUsage({ credential, fetchImpl: server({ subscriptions: { list: [] } }) });
  assert.equal(report.points.source, 'account');
  assert.equal(report.points.planRemaining, account.total_available);
  assert.equal(report.points.remainingPercentage, null);
  assert.equal(report.points.planIncluded, null);
  assert.equal(report.points.planPeriodUsed, null);
});

test('missing consumption cannot turn a partially returned plan into a full allowance', () => {
  const report = buildReport({ account, subscription, planUsage: { points_included: 1000 } });
  assert.equal(report.points.source, 'account');
  assert.equal(report.points.planRemaining, 847.7058);
  assert.equal(report.points.planPeriodUsed, null);
  assert.equal(report.points.remainingPercentage, null);
  assert.ok(report.warnings.some((item) => item.code === 'INVALID_PLAN_BALANCE'));
});

test('numeric strings and true zero are accepted; absent and malformed numeric fields stay unknown', () => {
  for (const input of [null, undefined, '', ' ', false, {}, [], 'NaN', Infinity]) assert.equal(number(input), null);
  const zero = buildReport({ account, planUsage: { points_included: '1000', points_period_used: '1000', points_period_remaining: '0' } });
  assert.equal(zero.points.planRemaining, 0);
  assert.equal(zero.points.source, 'plan');
  assert.equal(zero.points.remainingPercentage, 0);
  const derived = buildReport({ account, planUsage: { points_included: '1000', points_period_used: '176.614' } });
  assert.equal(derived.points.planRemaining, 823.386);
});

test('no valid balance is an explicit error, never a synthetic zero', () => {
  assert.throws(() => buildReport({ account: { total_available: null }, planUsage: {} }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => buildReport(), { code: 'INVALID_RESPONSE' });
});

test('stats network failure still returns balance with a safe partial warning', async () => {
  const report = await queryUsage({ credential, fetchImpl: server({ stats: new Error('Authorization: Bearer synthetic-token') }) });
  assert.equal(report.points.planRemaining, 823.386);
  assert.equal(report.usage, null);
  assert.ok(report.warnings.some((item) => item.code === 'NETWORK'));
  assert.doesNotMatch(JSON.stringify(report), /synthetic-token|Authorization/);
});

test('a malformed optional stats schema cannot erase a valid balance', async () => {
  const report = await queryUsage({ credential, fetchImpl: server({ stats: { code: 200, data: { unexpected: true } } }) });
  assert.equal(report.points.planRemaining, 823.386);
  assert.equal(report.usage, null);
  assert.ok(report.warnings.some((item) => item.code === 'INVALID_USAGE'));
});

test('missing model fields stay null rather than producing an undercount', () => {
  const report = buildReport({ account, stats: { summary: { text_tokens: 100, calls: 2 }, by_model: [stats.by_model[0], { model_name: 'Missing metrics' }] } });
  assert.equal(report.usage.totalTokens, 100);
  assert.equal(report.usage.inputTokens, null);
  assert.equal(report.usage.outputTokens, null);
  assert.equal(report.usage.cachedInputTokens, null);
  assert.equal(report.usage.pointsCost, null);
  assert.ok(report.warnings.some((item) => item.code === 'PARTIAL_USAGE'));
});

test('401 or 403 on any endpoint is a global authentication error', async () => {
  for (const endpoint of ['account', 'subscriptions', 'stats', 'plan']) {
    await assert.rejects(queryUsage({ credential, fetchImpl: server({ [endpoint]: new Response('synthetic-token', { status: 401 }) }) }), { code: 'AUTH_EXPIRED' });
  }
  await assert.rejects(queryUsage({ credential, fetchImpl: server({ stats: { code: '403', message: 'synthetic-token' } }) }), { code: 'AUTH_EXPIRED' });
});

test('HTTP failures do not disclose server error bodies', async () => {
  const report = await queryUsage({ credential, fetchImpl: server({ plan: new Response('synthetic-token', { status: 500 }) }) });
  assert.equal(report.points.source, 'account');
  assert.equal(report.points.planRemaining, account.total_available);
  assert.ok(report.warnings.some((item) => item.code === 'HTTP_ERROR'));
  assert.doesNotMatch(JSON.stringify(report), /synthetic-token/);
});

test('API errors do not disclose arbitrary server messages', async () => {
  const report = await queryUsage({ credential, fetchImpl: server({ stats: { code: 500, message: 'Bearer synthetic-token' } }) });
  assert.equal(report.usage, null);
  assert.ok(report.warnings.some((item) => item.code === 'API_ERROR'));
  assert.doesNotMatch(JSON.stringify(report), /synthetic-token|Bearer/);
});

test('account failure can return a genuine plan balance, with account values unknown', async () => {
  const report = await queryUsage({ credential, fetchImpl: server({ account: new Response('not JSON') }) });
  assert.equal(report.points.planRemaining, 823.386);
  assert.equal(report.points.totalAvailable, null);
  assert.equal(report.tokenBudget, null);
  assert.ok(report.warnings.some((item) => item.code === 'INVALID_RESPONSE'));
});

test('complete connectivity failure remains a network error', async () => {
  await assert.rejects(queryUsage({ credential, fetchImpl: async () => { throw new Error('synthetic-token'); } }), (error) => {
    assert.equal(error.code, 'NETWORK');
    assert.doesNotMatch(error.message, /synthetic-token/);
    return true;
  });
});

test('selects latest unexpired active subscription and reports the 100-row boundary', () => {
  const warnings = [];
  const list = [
    { ...subscription, id: 2, started_at: '2026-11-02T00:00:00Z' },
    { ...subscription, id: 3, started_at: '2026-11-02T00:00:00Z' },
    { ...subscription, id: 4, started_at: '2026-11-03T00:00:00Z', expires_at: '2020-01-01' },
    { ...subscription, id: 5, status: 'cancelled', started_at: '2026-11-03T00:00:00Z' },
  ];
  assert.equal(chooseSubscription({ list }, { now: Date.parse('2026-11-13'), warnings }).id, 3);
  assert.deepEqual(warnings, []);
  chooseSubscription({ list: Array.from({ length: 100 }, () => subscription) }, { warnings });
  assert.ok(warnings.some((item) => item.code === 'SUBSCRIPTIONS_TRUNCATED'));
  assert.throws(() => chooseSubscription({ list: {} }), { code: 'INVALID_RESPONSE' });
});

test('invalid range or header injection is rejected before contacting the server', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  await assert.rejects(queryUsage({ range: 'month', credential, fetchImpl }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(queryUsage({ credential: { accessToken: 'test\r\nInjected: value' }, fetchImpl }), { code: 'INVALID_CREDENTIALS' });
  assert.equal(calls, 0);
});

test('credential status reports configuration type without exposing its secret', async () => {
  const previous = process.env.TONGJI_AI_ACCESS_TOKEN;
  try {
    process.env.TONGJI_AI_ACCESS_TOKEN = 'synthetic-token';
    assert.deepEqual(await getCredentialStatus(), { configured: true, type: 'token' });
  } finally {
    if (previous === undefined) delete process.env.TONGJI_AI_ACCESS_TOKEN;
    else process.env.TONGJI_AI_ACCESS_TOKEN = previous;
  }
});

test('internal credential revision changes when a same-type credential is replaced', async () => {
  const previous = process.env.TONGJI_AI_ACCESS_TOKEN;
  try {
    process.env.TONGJI_AI_ACCESS_TOKEN = 'synthetic-first-token';
    const first = await getCredentialRevision();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(await getCredentialRevision(), first);
    process.env.TONGJI_AI_ACCESS_TOKEN = 'synthetic-second-token';
    assert.notEqual(await getCredentialRevision(), first);
    assert.deepEqual(await getCredentialStatus(), { configured: true, type: 'token' });
    assert.doesNotMatch(first, /synthetic/);
  } finally {
    if (previous === undefined) delete process.env.TONGJI_AI_ACCESS_TOKEN;
    else process.env.TONGJI_AI_ACCESS_TOKEN = previous;
  }
});
