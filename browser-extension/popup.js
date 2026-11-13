(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  const errors = {
    INVALID_PORT: '端口应为 1024 至 65535 的整数。', INVALID_PAIR_CODE: '请输入浮窗显示的 8 位配对码。',
    PAIR_REJECTED: '配对码不正确或已过期，请在浮窗重新生成。', BRIDGE_OFFLINE: '本机插件未连接。请打开 DSH，并核对端口。',
    BRIDGE_UNAUTHORIZED: '本机连接已失效，请重新配对。', NOT_PAIRED: '请先连接浮窗中的配对码。',
    NO_LOGIN_TAB: '当前没有需要继续的登录页，可点击立即更新登录。', ACCOUNT_MISMATCH: '学校页面登录的账号与插件原账号不同，已保留原凭据。',
    JOB_EXPIRED: '本次更新已过期，请重新点击立即更新。', INVALID_TOKEN: '平台尚未返回新的有效登录凭据。',
    LOGIN_REQUIRED: '请点击继续学校登录，在学校页面完成认证。', BROWSER_ERROR: '未完成，请检查 Chrome 或稍后重试。', BUSY: '正在更新，请稍候。',
  };
  const states = { idle: '已连接，等待更新', connected: '已连接', ready: '已连接', opening: '正在打开学校登录', renewing: '正在自动更新登录', queued: '等待 Chrome 更新', waiting_for_login: '需要完成学校登录', login_required: '需要完成学校登录', renewed: '登录已自动更新', success: '登录已自动更新', disabled: '自动更新已关闭', error: '登录尚未更新' };
  const dateText = value => { const date = value ? new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''; };
  function render(status) {
    byId('port').value = String(status.port || 17945);
    byId('renew').disabled = !status.paired || !status.connected;
    byId('focus').disabled = !status.hasOwnedTab;
    byId('state').textContent = !status.paired ? '尚未配对' : !status.connected ? '本机插件未连接' : states[status.state] || '已连接';
    byId('details').textContent = !status.paired ? '先在 DSH 浮窗中生成配对码。' : !status.connected ? errors[status.code] || errors.BRIDGE_OFFLINE : '登录临近到期时，插件会请求 Chrome 自动更新。';
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
  void send({ action: 'status' });
})();
