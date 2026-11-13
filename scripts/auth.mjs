import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getCredentialStatus } from '../lib/api.js';

const folder = join(homedir(), '.config', 'tongji-ai-usage');
const target = join(folder, 'credentials.json');
const command = process.argv[2];
try {
  if (command === 'status') {
    const status = await getCredentialStatus();
    console.log(status.configured ? `已配置 ${status.type === 'token' ? 'access_token' : 'Cookie'}。` : '尚未配置登录令牌。');
    console.log(`共享凭据路径：${target}`);
  } else if (command === 'clear') {
    await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    console.log('已清除本机共享登录凭据（Qoder 与 DSH 共用）。');
  } else if (command === 'set-token') {
    console.log("在已登录的 https://agi.tongji.edu.cn 页面控制台执行：\ncopy(sessionStorage.getItem('access_token'))");
    const token = (await secretInput('粘贴 access_token 后按回车（不显示输入）：')).trim().replace(/^Bearer\s+/i, '');
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('需要完整的网站 JWT access_token。');
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw new Error('令牌格式无效，请重新复制。'); }
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) throw new Error('令牌已过期，请重新登录平台。');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temp = join(folder, `.credentials-${process.pid}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify({ version: 1, accessToken: token })}\n`, { mode: 0o600, flag: 'wx' });
      if (process.platform === 'win32') {
        const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
        const sid = who.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
        if (!sid) throw new Error('无法确定当前 Windows 用户，未替换凭据。');
        const acl = spawnSync('icacls.exe', [temp, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { stdio: 'ignore', windowsHide: true });
        if (acl.error || acl.status !== 0) throw new Error('无法限制文件权限，未替换凭据。');
      } else await chmod(temp, 0o600);
      await rename(temp, target);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    console.log('已保存到本机共享凭据文件。回到浮窗点击刷新即可。');
  } else {
    console.log('用法：node scripts/auth.mjs status | set-token | clear\n不要通过命令行参数或聊天传入令牌。');
    if (command && !['--help', '-h'].includes(command)) process.exitCode = 2;
  }
} catch (error) {
  console.error(`未完成：${error.message}`);
  process.exitCode = 1;
}

function secretInput(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在本机交互式终端中导入令牌。');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const data = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new Error('已取消导入。'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (/[a-zA-Z0-9_.\- ]/.test(char)) value += char;
      }
    };
    process.stdin.on('data', data);
  });
}
