(function () {
  'use strict';
  if (window.top !== window || location.origin !== TongjiLoginCore.SITE_ORIGIN) return;
  let stopped = false;
  let emptyChecks = 0;
  let loginClicked = false;
  let firstOwnedAt = null;
  async function check() {
    if (stopped) return;
    let delay = 500;
    try {
      // Check ownership BEFORE touching sessionStorage. Normal user tabs are never read.
      const reply = await chrome.runtime.sendMessage({ action: 'owned-job' });
      const job = reply?.job;
      if (!job) { if (++emptyChecks >= 20) stopped = true; return; }
      emptyChecks = 0;
      firstOwnedAt ??= Date.now();
      if (location.pathname === '/login' && !loginClicked) {
        const button = [...document.querySelectorAll('button')].find(item => /^统一身份认证登录(?:\s*→)?$/.test(String(item.textContent || '').trim()));
        if (button && !button.disabled) {
          loginClicked = true;
          const start = await chrome.runtime.sendMessage({ action: 'begin-sso', jobId: job.id });
          if (start?.click === true) button.click();
        }
      }
      const token = sessionStorage.getItem('access_token');
      if (TongjiLoginCore.candidateMetadata(token, job.requestedAt)) {
        const result = await chrome.runtime.sendMessage({ action: 'candidate', jobId: job.id, accessToken: token });
        if (result?.ok) stopped = true;
        else if (['ACCOUNT_MISMATCH', 'JOB_EXPIRED', 'BRIDGE_UNAUTHORIZED', 'NOT_PAIRED'].includes(result?.code)) stopped = true;
        else delay = 3000;
      } else if (Date.now() - firstOwnedAt > 10000) {
        await chrome.runtime.sendMessage({ action: 'waiting', jobId: job.id });
      }
    } catch { delay = 3000; }
    finally { if (!stopped) setTimeout(check, delay); }
  }
  void check();
})();
