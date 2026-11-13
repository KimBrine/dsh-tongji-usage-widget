import { mountWidget } from './widget.js';
import { createUsageService } from './service.js';
import { createAutoLoginManager } from './auto-login.js';
import { createUpdateChecker } from './update-checker.js';

export const BASE_PATH = '/tongji-ai-widget';
const scriptPath = `${BASE_PATH}/widget.js`;

// Runs in DSH's page, including the desktop dsh-app://app carrier.
function boot(mount, basePath) {
  if (window.__tongjiUsageBoot) return;
  window.__tongjiUsageBoot = true;
  let destroy;
  let observer;
  function cleanup() {
    observer?.disconnect();
    destroy?.();
    window.__tongjiUsageBoot = false;
    delete window.__tongjiUsageDestroy;
  }
  window.__tongjiUsageDestroy = cleanup;
  async function call(action, payload = {}) {
    if (action !== 'status' && action !== 'auto-login' && action !== 'check-update') throw new Error('不支持的操作。');
    if (action === 'check-update') {
      const response = await fetch(`${basePath}/updates.json`, {
        headers: { 'X-Tongji-Widget': '1' }, cache: 'no-store', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('暂时无法检查插件更新。');
      return response.json();
    }
    if (action === 'auto-login') {
      const response = await fetch(`${basePath}/auto-login`, { method: 'POST',
        headers: { 'X-Tongji-Widget': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '自动登录操作暂时不可用。');
      return data;
    }
    const params = new URLSearchParams({ range: payload.range || 'today', force: payload.force ? '1' : '0' });
    const response = await fetch(`${basePath}/status.json?${params}`, {
      headers: { 'X-Tongji-Widget': '1' }, cache: 'no-store', signal: AbortSignal.timeout(90000),
    });
    if ([404, 410].includes(response.status)) { cleanup(); throw new Error('插件已停用，请重新打开 DSH。'); }
    if (!response.ok) throw new Error('DSH 未接受积分查询，请重新打开 DSH。');
    return response.json();
  }
  function start() {
    if (destroy) return;
    if (!document.querySelector('#root [data-composer-input], #root [data-composer-seat], #root textarea, #root [role="textbox"][aria-multiline="true"], [data-tongji-widget-preview]')) return;
    destroy = mount({ call });
    observer?.disconnect();
  }
  observer = new MutationObserver(start);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  start();
}

export function browserScript() {
  return `;(${boot.toString()})(${mountWidget.toString()}, ${JSON.stringify(BASE_PATH)});`;
}

export function registerRoutes(ctx, service, autoLogin = null) {
  const disposers = [];
  const script = browserScript();
  const register = (path, handler) => disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }));
  register(scriptPath, (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(script);
  });
  register(`${BASE_PATH}/updates.json`, async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return json(405, { error: 'GET required' });
    if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-tongji-widget'] !== '1') return json(403, { error: 'Forbidden' });
    try {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection) return json(typeof rejection === 'number' ? rejection : 403, { error: 'Forbidden' });
    } catch { return json(403, { error: 'Forbidden' }); }
    try { json(200, await service.checkUpdate()); }
    catch { json(503, { error: '暂时无法检查插件更新。' }); }
  });
  register(`${BASE_PATH}/status.json`, async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return json(405, { error: 'GET required' });
    if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-tongji-widget'] !== '1') return json(403, { error: 'Forbidden' });
    // Reuse the host's trust boundary (HTTP and desktop IPC carriers).
    try {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection) return json(typeof rejection === 'number' ? rejection : 403, { error: 'Forbidden' });
    } catch { return json(403, { error: 'Forbidden' }); }
    try {
      const params = new URL(req.url, 'http://dsh.internal').searchParams;
      const value = await service.status({ range: params.get('range') || 'today', force: params.get('force') === '1' });
      json(200, value);
    } catch (error) {
      json(error?.code === 'INVALID_ARGUMENT' ? 400 : 503, { error: '暂时无法查询积分。' });
    }
  });
  if (autoLogin) register(`${BASE_PATH}/auto-login`, async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST') return json(405, { error: { message: '需要 POST 请求。' } });
    if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-tongji-widget'] !== '1') return json(403, { error: { message: '请求未被接受。' } });
    try { if (ctx.connection.requestRejection(req)) return json(403, { error: { message: '请求未被接受。' } }); }
    catch { return json(403, { error: { message: '请求未被接受。' } }); }
    try {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error();
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 2048) throw new Error(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!['pair', 'renew', 'enable', 'disable'].includes(body.action)) throw new Error();
      json(200, await autoLogin.action(body.action));
    } catch (error) { json(400, { error: { message: error?.code ? error.message : '自动登录请求无效。' } }); }
  });
  return () => { for (const dispose of disposers) dispose(); service.dispose(); };
}

export default {
  name: 'tongji-usage-widget',
  apply(root) {
    // Register before waiting on host services: desktop collects this table once.
    root.on('webserver/index-inject', (rows) => {
      if (!Array.isArray(rows) || rows.some(row => row.kind === 'script' && row.text?.includes(scriptPath))) return;
      rows.push({ kind: 'script', placement: 'body', text: `(function(){try{var s=document.createElement('script');s.src=${JSON.stringify(scriptPath)};s.onerror=function(){};(document.body||document.head).appendChild(s)}catch(e){}})()` });
    });
    root.inject(['webServer', 'connection'], ctx => {
      ctx.effect(() => {
        const autoLogin = createAutoLoginManager();
        const updateChecker = createUpdateChecker();
        void autoLogin.start();
        updateChecker.start();
        const cleanup = registerRoutes(ctx, createUsageService({ autoLogin, updateChecker }), autoLogin);
        return () => { cleanup(); updateChecker.dispose(); void autoLogin.dispose(); };
      });
      ctx.effect(() => ctx.webServer.tapIndex(html => {
        if (html.includes(scriptPath)) return html;
        const tag = `<script defer src="${scriptPath}"></script>`;
        return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`;
      }));
    });
  },
};
