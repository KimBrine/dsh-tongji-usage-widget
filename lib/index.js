import { mountWidget } from './widget.js';
import { createUsageService } from './service.js';

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
  async function call(action, payload) {
    if (action !== 'status') throw new Error('不支持的操作。');
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

export function registerRoutes(ctx, service) {
  const disposers = [];
  const script = browserScript();
  const register = (path, handler) => disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }));
  register(scriptPath, (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(script);
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
      ctx.effect(() => registerRoutes(ctx, createUsageService()));
      ctx.effect(() => ctx.webServer.tapIndex(html => {
        if (html.includes(scriptPath)) return html;
        const tag = `<script defer src="${scriptPath}"></script>`;
        return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`;
      }));
    });
  },
};
