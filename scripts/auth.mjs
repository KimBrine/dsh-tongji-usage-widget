import { unlink } from 'node:fs/promises';
import { getCredentialStatus } from '../lib/api.js';
import { CREDENTIAL_FILE, saveAccessToken } from '../lib/credential-store.js';

const target = CREDENTIAL_FILE;
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
    await saveAccessToken(token);
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
