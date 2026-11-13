import { mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const CREDENTIAL_DIR = join(homedir(), '.config', 'tongji-ai-usage');
export const CREDENTIAL_FILE = join(CREDENTIAL_DIR, 'credentials.json');
const writes = new Map();
const MAX_TOKEN_LENGTH = 16_384;

function problem(code, message) {
  return Object.assign(new Error(message), { code });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function filePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) {
    throw problem('PRIVATE_WRITE_FAILED', '本机保存位置无效，未替换原有配置。');
  }
  return resolve(file);
}

function serial(file, action) {
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const before = writes.get(key) || Promise.resolve();
  const task = before.catch(() => {}).then(action);
  writes.set(key, task);
  return task.finally(() => {
    if (writes.get(key) === task) writes.delete(key);
  });
}

export async function readSavedCredentials({ file = CREDENTIAL_FILE } = {}) {
  try {
    const value = JSON.parse(await readFile(filePath(file), 'utf8'));
    if (!object(value)) throw new Error('Not an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw problem('INVALID_CREDENTIALS', '本机凭据无法读取或格式无效，请重新导入登录令牌。');
  }
}

export async function savedRevision({ file = CREDENTIAL_FILE } = {}) {
  try {
    return createHash('sha256').update(await readFile(filePath(file))).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw problem('INVALID_CREDENTIALS', '无法核对本机凭据状态，未替换原有凭据。');
  }
}

function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) throw new Error('Invalid encoding');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('Noncanonical encoding');
  return bytes;
}

/** Parse only the minimum account/expiry metadata; authenticity is verified by the platform. */
export function tokenMetadata(token) {
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) throw new Error('Invalid token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const header = JSON.parse(decoder.decode(decodePart(parts[0])));
    const claims = JSON.parse(decoder.decode(decodePart(parts[1])));
    decodePart(parts[2]);
    if (!object(header) || typeof header.alg !== 'string' || !header.alg || header.alg.toLowerCase() === 'none' || !object(claims)) {
      throw new Error('Invalid JWT');
    }
    const issuedAt = claims.iat, expiresAt = claims.exp;
    const maxTime = 8_640_000_000_000;
    if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || issuedAt < 0 || expiresAt <= issuedAt || expiresAt > maxTime) throw new Error('Invalid dates');
    let userId = null;
    for (const value of [claims.user_id, claims.sub, claims.id]) {
      if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') {
        const normalized = String(value).trim();
        if (normalized && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/.test(normalized)) {
          userId = normalized;
          break;
        }
      }
    }
    if (!userId) throw new Error('Missing principal');
    let issuer = null;
    if (claims.iss !== undefined && claims.iss !== null) {
      if (typeof claims.iss !== 'string' || claims.iss.length > 1000 || /[\u0000-\u001f\u007f]/.test(claims.iss)) throw new Error('Invalid issuer');
      issuer = claims.iss.trim() || null;
    }
    return { issuedAt, expiresAt, principal: `${issuer || ''}\0${userId}`, userId, issuer };
  } catch {
    throw problem('INVALID_TOKEN', '登录令牌格式或账号信息无效，请重新登录平台。');
  }
}

export async function protectFile(file) {
  try {
    if (process.platform !== 'win32') {
      await chmod(file, 0o600);
      return;
    }
    const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = who.status === 0 && who.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('No user SID');
    const acl = spawnSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { stdio: 'ignore', windowsHide: true });
    if (acl.error || acl.status !== 0) throw new Error('Permission failure');
  } catch {
    throw problem('PRIVATE_WRITE_FAILED', '无法限制本机文件权限，未替换原有配置。');
  }
}

function checkCommitGuard(guard) {
  if (guard === undefined) return;
  try {
    if (typeof guard !== 'function') throw new Error('Invalid guard');
    const allowed = guard();
    // Guards must finish synchronously: awaiting one would reopen the cancellation race.
    if (allowed && typeof allowed.then === 'function') {
      Promise.resolve(allowed).catch(() => {});
      throw new Error('Asynchronous guard');
    }
    if (allowed === false) throw new Error('Cancelled');
  } catch {
    throw problem('JOB_EXPIRED', '本次自动更新已取消，原有凭据保持不变。');
  }
}

async function atomicPrivateWrite(file, text, verifyRevision, commitGuard) {
  let temporary;
  let handle;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    temporary = join(dirname(file), `.private-${process.pid}-${randomUUID()}.tmp`);
    // Protect the empty file before any secret is written, including on Windows.
    handle = await open(temporary, 'wx', 0o600);
    await protectFile(temporary);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (verifyRevision) await verifyRevision();
    // No external asynchronous work may run between this guard and submitting rename.
    checkCommitGuard(commitGuard);
    await rename(temporary, file);
    temporary = null;
  } catch (error) {
    if (['CREDENTIAL_CHANGED', 'PRIVATE_WRITE_FAILED', 'JOB_EXPIRED'].includes(error?.code)) throw error;
    throw problem('PRIVATE_WRITE_FAILED', '无法安全保存本机配置，原有配置保持不变。');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

export async function writePrivateJson(file, data) {
  const target = filePath(file);
  let text;
  try {
    const encoded = JSON.stringify(data);
    if (encoded === undefined) throw new Error('Invalid JSON');
    text = `${encoded}\n`;
  } catch {
    throw problem('PRIVATE_WRITE_FAILED', '本机配置格式无效，未替换原有配置。');
  }
  return serial(target, () => atomicPrivateWrite(target, text));
}

export async function saveAccessToken(token, { file = CREDENTIAL_FILE, expectedRevision, beforeCommit } = {}) {
  const target = filePath(file);
  const metadata = tokenMetadata(token);
  const checkCandidate = () => {
    const now = Date.now() / 1000;
    if (metadata.expiresAt <= now) throw problem('TOKEN_EXPIRED', '登录令牌已过期，请重新登录平台。');
    if (metadata.issuedAt > now + 60) throw problem('INVALID_TOKEN', '登录令牌签发时间异常，未替换原有凭据。');
  };
  checkCandidate();
  return serial(target, async () => {
    const checkRevision = async () => {
      checkCandidate();
      if (expectedRevision !== undefined && await savedRevision({ file: target }) !== expectedRevision) {
        throw problem('CREDENTIAL_CHANGED', '本机登录凭据已被更新，本次自动更新已取消。');
      }
    };
    await checkRevision();
    const text = `${JSON.stringify({ version: 1, accessToken: token })}\n`;
    await atomicPrivateWrite(target, text, checkRevision, beforeCommit);
    return { issuedAt: metadata.issuedAt, expiresAt: metadata.expiresAt, principal: metadata.principal };
  });
}
