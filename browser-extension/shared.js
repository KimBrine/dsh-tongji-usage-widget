(function (scope) {
  'use strict';
  const SITE_ORIGIN = 'https://agi.tongji.edu.cn';
  const DEFAULT_PORT = 17945;
  // Chromium Edge exposes the same chrome.* extension APIs and URL scheme as Chrome.
  // This limited hint affects pairing/display only; it is not a trusted identity.
  function detectBrowser(navigatorLike = scope.navigator) {
    try {
      const brands = navigatorLike?.userAgentData?.brands;
      if (Array.isArray(brands) && brands.some(item => item?.brand === 'Microsoft Edge')) return 'edge';
    } catch { /* Client Hints may be unavailable; fall back to the User-Agent. */ }
    try {
      if (typeof navigatorLike?.userAgent === 'string' && /\bEdg\/[0-9]/.test(navigatorLike.userAgent)) return 'edge';
    } catch { /* Missing browser metadata defaults to Chrome. */ }
    return 'chrome';
  }
  function normalizePort(value = DEFAULT_PORT) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
    return port;
  }
  function baseUrl(port) { return `http://127.0.0.1:${normalizePort(port)}`; }
  function timestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
    return null;
  }
  // This is a freshness check, not signature verification. The local backend validates the token with the platform.
  function candidateMetadata(token, requestedAt, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const requested = timestamp(requestedAt);
    if (requested === null) return null;
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(part), c => c.charCodeAt(0));
      const claims = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
      if (claims.iat * 1000 < requested - 5000 || claims.iat * 1000 > now + 120000 || claims.exp * 1000 <= now + 10000) return null;
      return { issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000 };
    } catch { return null; }
  }
  function trustedContentSender(sender, job) {
    if (!job || !Number.isInteger(job.tabId) || sender?.tab?.id !== job.tabId || sender.frameId !== 0) return false;
    try {
      return new URL(sender.url).origin === SITE_ORIGIN && (!sender.origin || sender.origin === SITE_ORIGIN);
    } catch { return false; }
  }
  function trustedPopupSender(sender, runtime) {
    return sender?.id === runtime.id && !sender.tab && sender.url === runtime.getURL('popup.html');
  }
  scope.TongjiLoginCore = Object.freeze({ SITE_ORIGIN, DEFAULT_PORT, detectBrowser, normalizePort, baseUrl, timestamp, candidateMetadata, trustedContentSender, trustedPopupSender });
})(globalThis);
