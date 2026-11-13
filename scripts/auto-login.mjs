import { createAutoLoginManager } from '../lib/auto-login.js';

const command = process.argv[2] || 'help';
if (!['serve', 'help', '--help', '-h'].includes(command)) {
  console.error('用法：node scripts/auto-login.mjs serve'); process.exitCode = 2;
} else if (command !== 'serve') {
  console.log('用法：node scripts/auto-login.mjs serve\n独立启动本机浏览器助手连接服务（Edge / Chrome）；DSH 插件启动后会自动提供同一功能。');
} else {
  const manager = createAutoLoginManager();
  await manager.start();
  const result = await manager.action('pair');
  console.log(`浏览器助手扩展目录（Edge / Chrome）：${result.autoLogin.extensionPath}`);
  console.log(`本机连接端口：${result.autoLogin.port}`);
  console.log(`一次性连接码：${result.pairCode}（5 分钟有效，不是登录令牌）`);
  console.log('加载扩展后，在扩展窗口输入此连接码。按 Ctrl+C 停止本机连接服务。');
  const keepAlive = setInterval(() => {}, 60000);
  process.once('SIGINT', async () => { clearInterval(keepAlive); await manager.dispose(); });
  process.once('SIGTERM', async () => { clearInterval(keepAlive); await manager.dispose(); });
}
