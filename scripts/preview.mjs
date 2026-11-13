import { createServer } from 'node:http';
import { browserScript, BASE_PATH } from '../lib/index.js';
import { createUsageService } from '../lib/service.js';

const demo = process.argv.includes('--demo');
const portArg = process.argv.findIndex(arg => arg === '--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 17941;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效。');
const service = createUsageService(demo ? {
  credentialStatus: async () => ({ configured: true, type: 'demo' }),
  query: async ({ range }) => ({
    plan: { id: 'demo', name: '功能演示套餐 · 模拟数据' },
    points: { planRemaining: 823.386, planIncluded: 1000, planPeriodUsed: 176.614,
      totalAvailable: 847.7058, walletBalance: 24.3198, remainingPercentage: 82.3386,
      resetAt: '2026-12-01T00:00:00+08:00', source: 'plan' },
    usage: { range, pointsCost: range === 'today' ? 12.48 : 85.26, totalTokens: 12345,
      inputTokens: 4000, cachedInputTokens: 6000, outputTokens: 2345, calls: 63, byModel: [] },
    queriedAt: new Date().toISOString(), warnings: [{ code: 'DEMO', message: '模拟数据，仅用于功能预览。' }],
  }),
} : {});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  const host = req.headers.host;
  let validHost = false;
  try { validHost = !!host && ['127.0.0.1', 'localhost'].includes(new URL(`http://${host}`).hostname); } catch { /* reject malformed host */ }
  if (!validHost) { res.writeHead(403); res.end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === `${BASE_PATH}/widget.js`) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(browserScript()); return;
  }
  if (url.pathname === `${BASE_PATH}/status.json`) {
    let sameOrigin = !req.headers.origin;
    try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === host; } catch { /* reject malformed origin */ }
    if (req.headers['x-tongji-widget'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site' || !sameOrigin) { res.writeHead(403); res.end(); return; }
    try {
      const status = await service.status({ range: url.searchParams.get('range') || 'today', force: url.searchParams.get('force') === '1' });
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(status));
    } catch { res.writeHead(400); res.end('{}'); }
    return;
  }
  if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>同济 AI 积分浮窗预览</title>
<style>body{margin:0;background:#f2f5f9;color:#16293d;font:16px system-ui,"Microsoft Yahei",sans-serif}main{max-width:760px;margin:14vh auto;padding:36px}small{letter-spacing:.16em;color:#527185}h1{font-size:42px;letter-spacing:-.04em}p{color:#5d6c7c;line-height:1.9}.box{border:1px solid #d9e1e9;border-radius:18px;padding:24px;background:#fff;margin-top:40px}</style>
<body data-tongji-widget-preview><main><small>TONGJI AI / DSH</small><h1>把积分用量，放在手边。</h1><p>右下角是插件的真实前端。拖动标题栏可移动，靠近屏幕边缘可吸附。<br>展开查看周期余额与实际用量，收起后保持轻量显示。</p><div class="box">${demo ? '当前为模拟数据演示，不代表你的账户余额。' : '当前为本机实时查询预览，仅使用已保存的共享登录凭据。'}<br>这是独立预览页；DSH 内的宿主接入需要安装插件后验证。</div></main><script defer src="${BASE_PATH}/widget.js"></script></body></html>`);
});
server.listen(port, '127.0.0.1', () => console.log(`同济 AI 浮窗${demo ? '（模拟数据）' : '（实时查询）'}：http://127.0.0.1:${server.address().port}`));
process.on('SIGINT', () => { service.dispose(); server.close(); });
