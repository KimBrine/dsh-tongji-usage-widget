import { fileURLToPath } from 'node:url';
import { queryUsage, getCredentialStatus, getCredentialRevision } from './api.js';

const setupCommand = `node "${fileURLToPath(new URL('../scripts/auth.mjs', import.meta.url))}" set-token`;
const ranges = new Set(['today', 'yesterday', '7d']);
const safeErrors = {
  AUTH_MISSING: '尚未绑定同济平台登录令牌，请按下方说明在本机导入。',
  AUTH_EXPIRED: '同济平台登录已过期，请重新登录并导入 access_token。',
  INVALID_CREDENTIALS: '本机凭据不可读或格式无效，请重新导入。',
  NETWORK: '无法连接同济平台，稍后自动重试。',
  HTTP_ERROR: '平台暂时无法完成查询，稍后自动重试。',
  INVALID_RESPONSE: '平台返回格式已变化，请检查接口适配。',
  API_ERROR: '平台未接受此次查询，请稍后重试。',
  INVALID_DATA: '平台返回的数据不完整，暂时无法更新积分。',
};

// Shared by every window in this host; only redacted reports are cached in memory.
export function createUsageService({ query = queryUsage, credentialStatus = getCredentialStatus,
  credentialRevision = credentialStatus === getCredentialStatus ? getCredentialRevision : async () => 'test', now = Date.now,
  autoLogin = null } = {}) {
  const cache = new Map();
  const pending = new Map();
  let disposed = false;
  let epoch = 0;
  let revision;
  let authError = null;
  let authFailureAt = -Infinity;
  const invalidate = () => { epoch++; cache.clear(); pending.clear(); };
  return {
    async status({ range = 'today', force = false } = {}) {
      if (!ranges.has(range)) throw Object.assign(new Error('不支持的统计范围。'), { code: 'INVALID_ARGUMENT' });
      if (disposed) throw new Error('积分监控已停用。');
      let credential;
      try { credential = await credentialStatus(); }
      catch { credential = { configured: false, type: null }; }
      if (disposed) throw new Error('积分监控已停用。');
      await autoLogin?.check();
      const common = { credential, setupCommand, refreshInterval: 60,
        ...(autoLogin ? { autoLogin: await autoLogin.status() } : {}) };
      if (!credential.configured) {
        invalidate(); revision = null;
        authError = { code: 'AUTH_MISSING', message: safeErrors.AUTH_MISSING };
        return { ...common, report: null, error: { code: 'AUTH_MISSING', message: safeErrors.AUTH_MISSING } };
      }
      const nextRevision = await credentialRevision();
      if (revision !== nextRevision) { invalidate(); revision = nextRevision; authError = null; }
      if (authError && now() - authFailureAt < (force ? 3000 : 60000)) return { ...common, report: null, error: authError };
      const entry = cache.get(range);
      // A short cooldown also applies to forced refreshes and failed queries.
      if (entry && now() - entry.at < (force ? 3000 : 60000)) return { ...common, ...entry.value };
      if (pending.has(range)) {
        const value = await pending.get(range);
        if (autoLogin) common.autoLogin = await autoLogin.status();
        return { ...common, ...value };
      }
      const startedEpoch = epoch;
      const promise = (async () => {
        let value;
        try {
          value = { report: await query({ range }), error: null };
        } catch (error) {
          const code = Object.hasOwn(safeErrors, error?.code) ? error.code : 'NETWORK';
          if (code.startsWith('AUTH_') || code === 'INVALID_CREDENTIALS') {
            invalidate(); authError = { code, message: safeErrors[code] }; authFailureAt = now();
            if (code === 'AUTH_EXPIRED' && autoLogin) {
              try { await autoLogin.requestRenew(); } catch { /* surfaced by autoLogin status */ }
              common.autoLogin = await autoLogin.status();
            }
          }
          value = { report: code.startsWith('AUTH_') || code === 'INVALID_CREDENTIALS' ? null : entry?.value.report || null,
            error: { code, message: safeErrors[code] } };
        }
        if (startedEpoch !== epoch || disposed) return { report: null, error: authError || { code: 'AUTH_MISSING', message: '登录凭据已变更，请刷新后重新查询。' } };
        // Check removal or replacement even if no other tab made a request in between.
        if (await credentialRevision() !== revision) {
          invalidate();
          return { report: null, error: { code: 'AUTH_MISSING', message: '登录凭据已变更，请刷新后重新查询。' } };
        }
        if (!disposed) { cache.set(range, { at: now(), value }); if (!value.error) authError = null; }
        return value;
      })();
      pending.set(range, promise);
      try { const value = await promise; return { ...common, ...value }; }
      finally { if (pending.get(range) === promise) pending.delete(range); }
    },
    dispose() { disposed = true; invalidate(); },
  };
}
