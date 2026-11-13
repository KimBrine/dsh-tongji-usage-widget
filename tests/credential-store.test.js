import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readSavedCredentials, savedRevision, saveAccessToken, tokenMetadata, writePrivateJson } from '../lib/credential-store.js';

const now = Math.floor(Date.now() / 1000);
const jwt = (changes = {}, header = { alg: 'HS256', typ: 'JWT' }) => [
  Buffer.from(JSON.stringify(header)).toString('base64url'),
  Buffer.from(JSON.stringify({ user_id: 7, iss: 'synthetic-platform', iat: now - 20, exp: now + 3600, ...changes })).toString('base64url'),
  Buffer.from('synthetic-test-signature').toString('base64url'),
].join('.');

async function fixture(action) {
  const folder = await mkdtemp(join(tmpdir(), 'tongji-credential-store-'));
  try { await action(join(folder, 'nested', 'credentials.json'), folder); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test('metadata contains only identity and time fields, and expired metadata remains readable', () => {
  const value = tokenMetadata(jwt());
  assert.deepEqual(value, { issuedAt: now - 20, expiresAt: now + 3600, principal: 'synthetic-platform' + '\0' + '7', userId: '7', issuer: 'synthetic-platform' });
  assert.ok(!JSON.stringify(value).includes('synthetic-test-signature'));
  assert.equal(tokenMetadata(jwt({ iat: now - 100, exp: now - 1 })).expiresAt, now - 1);
  assert.equal(tokenMetadata(jwt({ user_id: null, sub: 'alternate' })).userId, 'alternate');
  assert.equal(tokenMetadata(jwt({ user_id: null, id: 12 })).userId, '12');
});

test('malformed, oversized and identity-less JWTs fail with safe errors', () => {
  const samples = [
    'not-a-jwt-SECRET', jwt({ user_id: undefined }), jwt({ iat: '10' }), jwt({ exp: '20' }),
    jwt({ exp: null }), jwt({ exp: -1 }), jwt({ iat: -1 }), jwt({ exp: now - 30 }),
    jwt({ iss: 'issuer\0SECRET' }), jwt({}, { alg: 'none' }), jwt().replace('.', '=.'), 'A'.repeat(16_385),
  ];
  for (const sample of samples) {
    assert.throws(() => tokenMetadata(sample), error => error.code === 'INVALID_TOKEN' && !error.message.includes('SECRET'));
  }
});

test('missing credentials have null data/revision and invalid saved JSON is not disclosed', async () => {
  await fixture(async file => {
    assert.equal(await readSavedCredentials({ file }), null);
    assert.equal(await savedRevision({ file }), null);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'SECRET invalid json');
    await assert.rejects(readSavedCredentials({ file }), error => error.code === 'INVALID_CREDENTIALS' && !error.message.includes('SECRET'));
  });
});

test('token saving is atomic, private and compatible with the shared credential file', async () => {
  await fixture(async file => {
    const token = jwt();
    const result = await saveAccessToken(token, { file, expectedRevision: null });
    assert.deepEqual(result, { issuedAt: now - 20, expiresAt: now + 3600, principal: 'synthetic-platform' + '\0' + '7' });
    assert.deepEqual(await readSavedCredentials({ file }), { version: 1, accessToken: token });
    const bytes = await readFile(file);
    assert.equal(await savedRevision({ file }), createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await readdir(join(file, '..'))).length, 1);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test('CAS refuses to overwrite credentials replaced by a later manual import', async () => {
  await fixture(async file => {
    const first = jwt();
    await saveAccessToken(first, { file });
    const revision = await savedRevision({ file });
    const manuallyUpdated = jwt({ iat: now - 10, exp: now + 7200 });
    await saveAccessToken(manuallyUpdated, { file });
    await assert.rejects(saveAccessToken(jwt({ exp: now + 4000 }), { file, expectedRevision: revision }), { code: 'CREDENTIAL_CHANGED' });
    assert.equal((await readSavedCredentials({ file })).accessToken, manuallyUpdated);
    assert.equal((await readdir(join(file, '..'))).length, 1);
  });
});

test('simultaneous saves sharing one revision allow exactly one commit', async () => {
  await fixture(async file => {
    await saveAccessToken(jwt(), { file });
    const revision = await savedRevision({ file });
    const results = await Promise.allSettled([
      saveAccessToken(jwt({ exp: now + 4000 }), { file, expectedRevision: revision }),
      saveAccessToken(jwt({ exp: now + 5000 }), { file, expectedRevision: revision }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failure = results.find(result => result.status === 'rejected');
    assert.equal(failure.reason.code, 'CREDENTIAL_CHANGED');
  });
});

test('expired or future-issued candidates never replace the current credential', async () => {
  await fixture(async file => {
    const original = jwt();
    await saveAccessToken(original, { file });
    await assert.rejects(saveAccessToken(jwt({ iat: now - 100, exp: now - 1 }), { file }), { code: 'TOKEN_EXPIRED' });
    await assert.rejects(saveAccessToken(jwt({ iat: now + 121, exp: now + 3600 }), { file }), { code: 'INVALID_TOKEN' });
    assert.equal((await readSavedCredentials({ file })).accessToken, original);
  });
});

test('generic private JSON uses the same atomic protected write without leaking serialization errors', async () => {
  await fixture(async file => {
    await writePrivateJson(file, { bridgeKey: 'synthetic-bridge-key', enabled: true });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { bridgeKey: 'synthetic-bridge-key', enabled: true });
    const cyclic = { SECRET: 'not-for-errors' }; cyclic.self = cyclic;
    await assert.rejects(writePrivateJson(file, cyclic), error => error.code === 'PRIVATE_WRITE_FAILED' && !error.message.includes('SECRET'));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).bridgeKey, 'synthetic-bridge-key');
    assert.equal((await readdir(join(file, '..'))).length, 1);
  });
});

test('a cancellation observed during temporary-file writing prevents the final credential commit', async () => {
  await fixture(async file => {
    const original = jwt();
    await saveAccessToken(original, { file });
    const revision = await savedRevision({ file });
    let cancelled = false;
    let guardCalls = 0;
    let resolveCancellation;
    const cancellation = new Promise(resolve => { resolveCancellation = resolve; });
    const watcher = watch(join(file, '..'), (_event, name) => {
      if (!String(name).startsWith('.private-')) return;
      cancelled = true;
      resolveCancellation();
    });
    try {
      const saving = saveAccessToken(jwt({ exp: now + 4000 }), {
        file, expectedRevision: revision,
        beforeCommit: () => { guardCalls++; return !cancelled; },
      });
      // Attach immediately so an early rejection can never become unhandled.
      const refusal = assert.rejects(saving, { code: 'JOB_EXPIRED' });
      await cancellation;
      await refusal;
      assert.equal(guardCalls, 1);
      assert.equal(await savedRevision({ file }), revision);
      assert.equal((await readSavedCredentials({ file })).accessToken, original);
      assert.equal((await readdir(join(file, '..'))).length, 1);
    } finally { watcher.close(); }
  });
});

test('the synchronous commit guard runs only after the final revision check', async () => {
  await fixture(async file => {
    await saveAccessToken(jwt(), { file });
    let called = false;
    await assert.rejects(saveAccessToken(jwt({ exp: now + 4000 }), {
      file, expectedRevision: 'outdated', beforeCommit: () => { called = true; return true; },
    }), { code: 'CREDENTIAL_CHANGED' });
    assert.equal(called, false);
    await saveAccessToken(jwt({ exp: now + 5000 }), { file, beforeCommit: () => true });
    assert.equal(tokenMetadata((await readSavedCredentials({ file })).accessToken).expiresAt, now + 5000);
  });
});

test('throwing or asynchronous commit guards fail closed without exposing their errors', async () => {
  await fixture(async file => {
    const original = jwt();
    await saveAccessToken(original, { file });
    for (const beforeCommit of [() => { throw new Error('SECRET'); }, async () => true]) {
      await assert.rejects(saveAccessToken(jwt({ exp: now + 4000 }), { file, beforeCommit }),
        error => error.code === 'JOB_EXPIRED' && !error.message.includes('SECRET'));
      assert.equal((await readSavedCredentials({ file })).accessToken, original);
      assert.equal((await readdir(join(file, '..'))).length, 1);
    }
  });
});
