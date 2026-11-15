import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLatestRelease, LATEST_RELEASE_API } from '../lib/release-info.js';

function fixture() {
  const base = 'https://github.com/KimBrine/dsh-tongji-usage-widget/releases/download/v0.3.0/';
  return { tag_name: 'v0.3.0', draft: false, prerelease: false, published_at: '2026-11-14T00:00:00Z', assets: [
    { name: 'dsh-tongji-usage-widget-0.3.0.tgz', state: 'uploaded', size: 1200, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `${base}dsh-tongji-usage-widget-0.3.0.tgz` },
    { name: 'update.json', state: 'uploaded', size: 200, browser_download_url: `${base}update.json` },
  ] };
}

test('resolves fixed public release and returns only normalized installer metadata', async () => {
  const result = await resolveLatestRelease({ fetchImpl: async (url, options) => {
    assert.equal(url, LATEST_RELEASE_API);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json' });
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ ...fixture(), unrelatedSecret: 'SECRET' }));
  } });
  assert.deepEqual(result, { version: '0.3.0', tagName: 'v0.3.0', archiveUrl: 'https://github.com/KimBrine/dsh-tongji-usage-widget/releases/download/v0.3.0/dsh-tongji-usage-widget-0.3.0.tgz',
    sha256: 'a'.repeat(64), archiveSize: 1200 });
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('missing release has a specific actionable error and no fallback to arbitrary source', async () => {
  await assert.rejects(resolveLatestRelease({ fetchImpl: async () => new Response('{}', { status: 404 }) }), { code: 'NO_RELEASE' });
});

test('rejects drafts, prereleases, tag injection, duplicate or foreign assets and missing hashes', async () => {
  const changes = [
    value => { value.draft = true; }, value => { value.prerelease = true; }, value => { value.published_at = null; },
    value => { value.tag_name = 'v0.3.0; SECRET'; }, value => { value.tag_name = 'v0.3.0-rc.1'; },
    value => { value.assets.push(value.assets[0]); }, value => { value.assets.pop(); },
    value => { value.assets[0].digest = ''; }, value => { value.assets[0].size = 21 * 1024 * 1024; },
    value => { value.assets[0].browser_download_url = 'https://untrusted.example/SECRET'; },
    value => { value.assets[1].browser_download_url = 'https://github.com/another/repo/update.json'; },
  ];
  for (const change of changes) {
    const value = fixture(); change(value);
    await assert.rejects(resolveLatestRelease({ fetchImpl: async () => new Response(JSON.stringify(value)) }), error => {
      assert.equal(error.code, 'INVALID_RELEASE'); assert.ok(!error.message.includes('SECRET')); return true;
    });
  }
});

test('rejects redirected and oversized release responses with redacted failures', async () => {
  const response = new Response(JSON.stringify(fixture()));
  Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(resolveLatestRelease({ fetchImpl: async () => response }), { code: 'INVALID_RELEASE' });
  await assert.rejects(resolveLatestRelease({ fetchImpl: async () => new Response('x'.repeat(270000)) }), { code: 'INVALID_RELEASE' });
  await assert.rejects(resolveLatestRelease({ fetchImpl: async () => { throw new Error('Authorization Bearer SECRET'); } }), error => {
    assert.equal(error.code, 'RELEASE_NETWORK'); assert.ok(!error.message.includes('SECRET')); return true;
  });
});
