import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const BASE_URL = 'https://agi.tongji.edu.cn';
export const CREDENTIAL_FILE = join(homedir(), '.config', 'tongji-ai-usage', 'credentials.json');
const RANGES = new Set(['today', 'yesterday', '7d']);

function problem(code, message) {
  return Object.assign(new Error(message), { code });
}

function warning(warnings, code, message) {
  if (!warnings.some((item) => item.code === code && item.message === message)) warnings.push({ code, message });
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function number(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegative(value) {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function date(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function label(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : null;
}

function normalizeCredential(value) {
  if (!record(value)) throw problem('INVALID_CREDENTIALS', '本机凭据格式无效，请重新导入登录令牌。');
  let type;
  let secret;
  if (value.type === 'token' || value.type === 'cookie') {
    type = value.type;
    secret = value.value;
  } else if (typeof value.accessToken === 'string' && value.accessToken.trim()) {
    type = 'token';
    secret = value.accessToken;
  } else if (typeof value.cookie === 'string' && value.cookie.trim()) {
    type = 'cookie';
    secret = value.cookie;
  }
  if (typeof secret !== 'string' || !secret.trim() || /[\r\n\0]/.test(secret)) {
    throw problem('INVALID_CREDENTIALS', '本机凭据格式无效，请重新导入登录令牌。');
  }
  secret = secret.trim();
  if (type === 'token') secret = secret.replace(/^Bearer\s+/i, '');
  if (!secret) throw problem('INVALID_CREDENTIALS', '本机凭据格式无效，请重新导入登录令牌。');
  return { type, value: secret };
}

async function readCredential() {
  if (process.env.TONGJI_AI_ACCESS_TOKEN?.trim()) return normalizeCredential({ accessToken: process.env.TONGJI_AI_ACCESS_TOKEN });
  if (process.env.TONGJI_AI_COOKIE?.trim()) return normalizeCredential({ cookie: process.env.TONGJI_AI_COOKIE });
  try {
    return normalizeCredential(JSON.parse(await readFile(CREDENTIAL_FILE, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') throw problem('AUTH_MISSING', '尚未配置同济 AI 登录令牌，请在本机导入 access_token。');
    throw problem('INVALID_CREDENTIALS', '本机凭据无法读取，请重新导入登录令牌。');
  }
}

export async function getCredentialStatus() {
  try {
    const credential = await readCredential();
    return { configured: true, type: credential.type };
  } catch {
    return { configured: false, type: null };
  }
}

// Internal cache invalidation only. Never include this fingerprint in browser responses.
export async function getCredentialRevision() {
  try {
    const credential = await readCredential();
    return createHash('sha256').update(`${credential.type}\0${credential.value}`).digest('hex');
  } catch {
    return null;
  }
}

function unwrap(body) {
  let result = body;
  for (let depth = 0; depth < 3 && record(result); depth++) {
    if ('code' in result) {
      const code = number(result.code);
      if (code === 401 || code === 403) throw problem('AUTH_EXPIRED', '登录令牌已过期或未被平台接受，请重新登录并导入 access_token。');
      if (code !== null && code !== 0 && code !== 200) throw problem('API_ERROR', '平台拒绝了查询请求，请稍后重试。');
      if (code === null) throw problem('INVALID_RESPONSE', '平台响应格式已变化，无法识别状态码。');
    }
    if (!Object.hasOwn(result, 'data')) break;
    result = result.data;
  }
  return result;
}

async function request(path, credential, fetchImpl) {
  const headers = { Accept: 'application/json' };
  if (credential.type === 'token') headers.Authorization = `Bearer ${credential.value}`;
  else headers.Cookie = credential.value;
  let response;
  try {
    response = await fetchImpl(new URL(path, BASE_URL), {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw problem('NETWORK', '无法连接同济 AI 平台，请检查网络或稍后重试。');
  }
  if (response.status === 401 || response.status === 403) {
    throw problem('AUTH_EXPIRED', '登录令牌已过期或未被平台接受，请重新登录并导入 access_token。');
  }
  if (!response.ok) throw problem('HTTP_ERROR', `平台查询失败（HTTP ${response.status}），请稍后重试。`);
  let body;
  try {
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Too large');
    body = JSON.parse(text);
  } catch {
    throw problem('INVALID_RESPONSE', '平台未返回有效 JSON，接口可能已变化。');
  }
  const data = unwrap(body);
  if (!record(data)) throw problem('INVALID_RESPONSE', '平台返回的数据结构异常，无法读取积分。');
  return data;
}

/** Select the newest currently active subscription, matching the platform's points-mode ordering. */
export function chooseSubscription(data, { now = Date.now(), warnings = [] } = {}) {
  if (!record(data) || !Array.isArray(data.list)) throw problem('INVALID_RESPONSE', '平台套餐列表格式异常。');
  if (data.list.length >= 100 || (number(data.total) !== null && number(data.total) > data.list.length)) {
    warning(warnings, 'SUBSCRIPTIONS_TRUNCATED', '套餐列表只读取前 100 条，当前套餐选择可能不完整。');
  }
  const candidates = data.list.filter((item) => {
    if (!record(item) || item.status !== 'active') return false;
    if (typeof item.id !== 'string' && typeof item.id !== 'number') {
      warning(warnings, 'INVALID_SUBSCRIPTION', '部分有效套餐缺少可识别的编号，已跳过。');
      return false;
    }
    if (!String(item.id).trim()) return false;
    if (item.expires_at === undefined || item.expires_at === null || item.expires_at === '') return true;
    const expiration = date(item.expires_at);
    if (!expiration) {
      warning(warnings, 'INVALID_SUBSCRIPTION', '部分套餐有效期格式异常，已跳过。');
      return false;
    }
    return new Date(expiration).getTime() > now;
  });
  return candidates.sort((a, b) => (new Date(date(b.started_at) || 0).getTime() - new Date(date(a.started_at) || 0).getTime())
    || ((number(b.id) || 0) - (number(a.id) || 0)))[0] || null;
}

function buildUsage(stats, range, warnings) {
  if (stats === null || stats === undefined) return null;
  if (!record(stats) || (!record(stats.summary) && !Array.isArray(stats.by_model))) {
    warning(warnings, 'INVALID_USAGE', '用量统计结构异常，本次只显示积分余额。');
    return null;
  }
  const summary = record(stats.summary) ? stats.summary : {};
  const byModel = Array.isArray(stats.by_model) ? stats.by_model.filter(record).map((model) => ({
    model: label(model.model_display_name) || label(model.model_name) || '未知模型',
    // Tongji reports uncached input separately: input + cached + output = text_tokens.
    inputTokens: nonnegative(model.input_tokens),
    cachedInputTokens: nonnegative(model.cached_tokens),
    outputTokens: nonnegative(model.output_tokens),
    totalTokens: nonnegative(model.text_tokens),
    calls: nonnegative(model.calls),
    pointsCost: nonnegative(model.points_cost),
  })) : [];
  if (!Array.isArray(stats.by_model) || stats.by_model.some((item) => !record(item))) {
    warning(warnings, 'PARTIAL_USAGE', '分模型统计不完整，缺失字段显示为未知。');
  }
  const sum = (field) => {
    if (!Array.isArray(stats.by_model) || stats.by_model.some((item) => !record(item))) return null;
    if (!byModel.length) return nonnegative(summary.text_tokens) === 0 ? 0 : null;
    return byModel.every((model) => model[field] !== null) ? byModel.reduce((total, model) => total + model[field], 0) : null;
  };
  const usage = {
    range, since: date(stats.since), until: date(stats.until),
    totalTokens: nonnegative(summary.text_tokens) ?? sum('totalTokens'),
    inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'),
    calls: nonnegative(summary.calls) ?? sum('calls'), pointsCost: nonnegative(summary.points_cost) ?? sum('pointsCost'),
    byModel, periodMatchesPlanReset: false,
  };
  if (['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'calls', 'pointsCost'].some((key) => usage[key] === null)) {
    warning(warnings, 'PARTIAL_USAGE', '部分用量字段缺失或格式异常，显示为未知。');
  }
  return usage;
}

/** Normalize platform fields without substituting zero for missing measurements. */
export function buildReport({ account = null, subscription = null, planUsage = null, stats = null, range = 'today', warnings: priorWarnings = [], now = new Date() } = {}) {
  const warnings = [...priorWarnings];
  const totalAvailable = record(account) ? number(account.total_available) : null;
  const walletBalance = record(account) && account.mode === 'points' ? number(account.wallet_balance) : null;
  if (account && totalAvailable === null) warning(warnings, 'INVALID_ACCOUNT_BALANCE', '账户总积分字段缺失或格式异常。');
  const planIncluded = record(planUsage) ? nonnegative(planUsage.points_included) : null;
  const planPeriodUsed = record(planUsage) ? nonnegative(planUsage.points_period_used) : null;
  const explicitRemaining = record(planUsage) ? number(planUsage.points_period_remaining) : null;
  let periodRemaining = explicitRemaining !== null ? Math.max(0, explicitRemaining)
    : planIncluded !== null && planPeriodUsed !== null ? Math.max(0, planIncluded - planPeriodUsed) : null;
  if (planUsage && periodRemaining === null) warning(warnings, 'INVALID_PLAN_BALANCE', '套餐余额字段不完整，改用账户总积分。');
  if (planUsage && (planIncluded === null || planPeriodUsed === null)) {
    warning(warnings, 'PARTIAL_PLAN', '套餐额度或本周期消耗缺失，相关字段显示为未知。');
  }
  const source = periodRemaining !== null ? 'plan' : 'account';
  const planRemaining = periodRemaining ?? totalAvailable;
  if (planRemaining === null) throw problem('INVALID_RESPONSE', '未能获取可用的积分余额，请稍后重试或检查平台接口。');
  const resetAt = record(planUsage) ? date(planUsage.next_reset_at) : null;
  if (planUsage?.next_reset_at && !resetAt) warning(warnings, 'INVALID_RESET_DATE', '套餐重置时间格式异常。');
  const tokensPerPoint = record(account) ? nonnegative(account.tokens_per_point) : null;
  return {
    plan: {
      id: subscription?.id ?? null, name: label(subscription?.plan?.name),
      billingMode: label(planUsage?.billing_mode), resetCycle: label(planUsage?.points_reset_cycle),
    },
    points: {
      totalAvailable, walletBalance, planRemaining, planIncluded, planPeriodUsed,
      remainingPercentage: source === 'plan' && planIncluded > 0 ? Math.min(100, Math.max(0, periodRemaining / planIncluded * 100)) : null,
      resetAt, source,
    },
    tokenBudget: tokensPerPoint > 0 && planRemaining >= 0 ? Math.floor(planRemaining * tokensPerPoint) : null,
    tokensPerPoint, usage: buildUsage(stats, range, warnings), warnings,
    queriedAt: new Date(now).toISOString(),
  };
}

export async function queryUsage({ range = 'today', fetchImpl = globalThis.fetch, credential } = {}) {
  if (!RANGES.has(range)) throw problem('INVALID_ARGUMENT', '统计范围应为 today、yesterday 或 7d。');
  if (typeof fetchImpl !== 'function') throw problem('UNSUPPORTED_RUNTIME', '当前运行环境不支持网络查询，请使用 Node.js 18 或更新版本。');
  const auth = credential === undefined ? await readCredential() : normalizeCredential(credential);
  const warnings = [];
  const results = await Promise.allSettled([
    request('/api/v1/billing/overview', auth, fetchImpl),
    request('/api/v1/my-coding-plans?page=1&page_size=100', auth, fetchImpl),
    request(`/api/v1/my-usage/stats?kind=plan&range=${range}`, auth, fetchImpl),
  ]);
  for (const result of results) {
    if (result.status === 'rejected' && result.reason?.code === 'AUTH_EXPIRED') throw result.reason;
  }
  const partial = (index, labelText) => {
    const result = results[index];
    if (result.status === 'fulfilled') return result.value;
    warning(warnings, result.reason?.code || 'QUERY_FAILED', `${labelText}暂时无法读取：${result.reason?.message || '查询失败。'}`);
    return null;
  };
  const account = partial(0, '账户积分');
  const subscriptions = partial(1, '套餐列表');
  const stats = partial(2, '用量统计');
  let subscription = null;
  let planUsage = null;
  if (subscriptions) {
    try {
      subscription = chooseSubscription(subscriptions, { warnings });
    } catch (error) {
      warning(warnings, error.code, error.message);
    }
  }
  if (subscription) {
    try {
      planUsage = await request(`/api/v1/my-coding-plans/${encodeURIComponent(subscription.id)}/usage`, auth, fetchImpl);
    } catch (error) {
      if (error.code === 'AUTH_EXPIRED') throw error;
      warning(warnings, error.code, `套餐额度暂时无法读取：${error.message}`);
    }
  }
  if (!account && !planUsage) {
    const failed = results.find((result) => result.status === 'rejected');
    throw failed?.reason || problem('INVALID_RESPONSE', '未能获取可用的积分余额，请稍后重试。');
  }
  return buildReport({ account, subscription, planUsage, stats, range, warnings });
}
