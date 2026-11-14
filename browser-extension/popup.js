(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  let reloading = false;
  const localBrowser = (() => {
    try {
      const browser = globalThis.TongjiLoginCore?.detectBrowser?.(globalThis.navigator);
      return ['edge', 'chrome'].includes(browser) ? browser : null;
    } catch { return null; }
  })();
  const errors = {
    INVALID_PORT: '端口应为 1024 至 65535 的整数。', INVALID_PAIR_CODE: '请输入浮窗显示的 8 位配对码。',
    PAIR_REJECTED: '配对码不正确或已过期，请在浮窗重新生成。', BRIDGE_OFFLINE: '本机插件未连接。请打开 DSH，并核对端口。',
    BRIDGE_UNAUTHORIZED: '本机连接已失效，请重新配对。', NOT_PAIRED: '请先连接浮窗中的配对码。',
    NO_LOGIN_TAB: '当前没有需要继续的登录页，可点击立即更新登录。', ACCOUNT_MISMATCH: '学校页面登录的账号与插件原账号不同，已保留原凭据。',
    JOB_EXPIRED: '本次更新已过期，请重新点击立即更新。', INVALID_TOKEN: '平台尚未返回新的有效登录凭据。',
    LOGIN_REQUIRED: '请点击继续学校登录，在学校页面完成认证。', BROWSER_ERROR: '未完成，请检查当前浏览器或稍后重试。', BUSY: '正在更新，请稍候。',
  };
  const states = { idle: '已连接，等待更新', connected: '已连接', ready: '已连接', opening: '正在打开学校登录', renewing: '正在自动更新登录', queued: '等待浏览器更新', waiting_for_login: '需要完成学校登录', login_required: '需要完成学校登录', renewed: '登录已自动更新', success: '登录已自动更新', disabled: '自动更新已关闭', error: '登录尚未更新' };
  const dateText = value => { const date = value ? new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''; };
  function render(status) {
    const browser = localBrowser || status.browser;
    const browserName = browser === 'edge' ? 'Edge' : browser === 'chrome' ? 'Chrome' : null;
    const isConnected = status.paired && status.connected;
    const intervalHours = typeof status.renewIntervalHours === 'number' && Number.isFinite(status.renewIntervalHours) && status.renewIntervalHours > 0 ? status.renewIntervalHours : 12;
    byId('browser').textContent = `当前浏览器：${browserName || '未识别'}`;
    byId('connection').textContent = isConnected ? '已连接本机 DSH' : '尚未连接本机 DSH';
    byId('pair-settings').open = !isConnected;
    byId('pair-settings-summary').textContent = isConnected ? '重新配对 / 更换端口' : '连接助手 / 设置端口';
    const compatibility = isConnected && status.startupNotifications !== true ? '助手后台需要重新加载，才能启用启动自动更新；当前连接正常。' : '';
    byId('compatibility').hidden = !compatibility;
    byId('compatibility').textContent = compatibility;
    byId('reload-assistant').hidden = !compatibility;
    byId('reload-assistant').disabled = reloading;
    byId('port').value = String(status.port || 17945);
    byId('renew').disabled = !status.paired || !status.connected;
    byId('focus').disabled = !status.hasOwnedTab;
    byId('state').textContent = !status.paired ? '尚未配对' : !status.connected ? '本机插件未连接' : states[status.state] || '已连接';
    byId('details').textContent = !status.paired ? '先在 DSH 浮窗中生成配对码。'
      : !status.connected ? errors[status.code] || errors.BRIDGE_OFFLINE
      : status.state === 'disabled' || status.enabled === false ? '自动更新已关闭，可在 DSH 浮窗设置中重新启用。'
      : ['waiting_for_login', 'login_required'].includes(status.state) ? `请点击“继续学校登录”，在${browserName ? ` ${browserName} ` : '当前浏览器'}中完成学校验证。`
      : `每${intervalHours}小时尝试更新，浏览器助手启动时也会更新。`;
    const expiresAt = dateText(status.expiresAt), renewedAt = dateText(status.lastRenewedAt);
    byId('expiry').textContent = [expiresAt ? `当前到期：${expiresAt}` : '', renewedAt ? `上次更新：${renewedAt}` : ''].filter(Boolean).join('；');
  }
  async function send(message, successText = '') {
    const buttons = [...document.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    byId('message').textContent = '';
    try {
      const reply = await chrome.runtime.sendMessage(message);
      if (!reply?.ok) throw new Error(reply?.code || 'BROWSER_ERROR');
      if (reply.status) render(reply.status);
      byId('message').textContent = successText;
      return true;
    } catch (error) { byId('message').textContent = errors[error.message] || errors.BROWSER_ERROR; return false; }
    finally { byId('pair').disabled = false; byId('status').disabled = false; }
  }
  byId('pair-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (await send({ action: 'pair', port: byId('port').value, code: byId('code').value }, '连接成功，今后会自动更新登录。')) byId('code').value = '';
  });
  byId('renew').addEventListener('click', () => send({ action: 'renew' }, '已请求更新。需要你登录时会提示。'));
  byId('focus').addEventListener('click', () => send({ action: 'focus' }, '已打开助手创建的登录页。'));
  byId('status').addEventListener('click', () => send({ action: 'status' }));
  byId('reload-assistant').addEventListener('click', () => {
    if (reloading || byId('reload-assistant').hidden) return;
    reloading = true;
    byId('reload-assistant').disabled = true;
    byId('message').textContent = '';
    try { chrome.runtime.reload(); }
    catch {
      reloading = false;
      byId('reload-assistant').disabled = false;
      byId('message').textContent = '无法重新加载，请在扩展管理页重新加载助手';
    }
  });
  void send({ action: 'status' });
})();
