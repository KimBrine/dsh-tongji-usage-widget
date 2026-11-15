import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildRelease, validateReleasePaths } from '../scripts/build-release.mjs';

const name = 'dsh-tongji-usage-widget';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { extensionVersion = '0.3.0', extraFiles = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tongji-release-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), 'tongji-release-test-')));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'browser-extension'));
  await mkdir(join(root, 'lib'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '0.3.0', type: 'module', main: 'lib/index.js', files: ['lib/', 'browser-extension/', 'cordis.patch.yml', ...extraFiles], scripts: { prepack: 'node -e "throw new Error(\'Lifecycle script must not run\')"' } }));
  await writeFile(join(root, 'browser-extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, name: '同济 AI 登录助手', version: extensionVersion }));
  await writeFile(join(root, 'lib', 'index.js'), 'export default {};\n');
  await writeFile(join(root, 'cordis.patch.yml'), 'plugins: {}\n');
  return root;
}

test('release archives are reproducible, match the manifest and contain a complete install folder', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'research'));
  await writeFile(join(root, 'research', 'private-note.txt'), 'must not be packed');
  await writeFile(join(root, 'credentials.json'), '{"accessToken":"PRIVATE_TEST_FIXTURE"}');
  const first = await buildRelease({ root, tag: 'v0.3.0' });
  const bytes = new Map(await Promise.all(first.files.map(async file => [file, await readFile(join(first.directory, file))])));
  const update = JSON.parse(bytes.get('update.json'));
  assert.deepEqual(update, { name, version: '0.3.0', tagName: 'v0.3.0', archive: `${name}-0.3.0.tgz`, sha256: sha256(bytes.get(`${name}-0.3.0.tgz`)), archiveSize: bytes.get(`${name}-0.3.0.tgz`).length });
  for (const line of bytes.get('SHA256SUMS').toString().trim().split('\n')) {
    const [hash, file] = line.split('  ');
    assert.equal(hash, sha256(bytes.get(file)));
  }
  const zipInspection = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"files":z.namelist(),"crcError":z.testzip(),"manifest":json.loads(z.read("dsh-tongji-usage-widget/browser-extension/manifest.json"))}))', join(first.directory, `${name}-0.3.0.zip`)], { encoding: 'utf8', windowsHide: true }));
  assert.equal(zipInspection.crcError, null);
  assert.equal(zipInspection.manifest.version, '0.3.0');
  assert.deepEqual(zipInspection.files, [`${name}/browser-extension/manifest.json`, `${name}/cordis.patch.yml`, `${name}/lib/index.js`, `${name}/package.json`]);
  assert.ok(!zipInspection.files.some(file => /credentials|research|artifacts/.test(file)));
  const second = await buildRelease({ root });
  for (const file of second.files) assert.deepEqual(await readFile(join(second.directory, file)), bytes.get(file), `${file} should be byte-for-byte reproducible`);
});

test('a release cannot combine different plugin/extension versions or an unrelated tag', async t => {
  const root = await fixture(t, { extensionVersion: '0.2.4' });
  await assert.rejects(buildRelease({ root }), /extension version must match/);
  await writeFile(join(root, 'browser-extension', 'manifest.json'), JSON.stringify({ version: '0.3.0' }));
  await assert.rejects(buildRelease({ root, tag: 'v0.3.1' }), /tag must exactly match/);
  const packageDocument = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  packageDocument.name = 'unrelated-package';
  await writeFile(join(root, 'package.json'), JSON.stringify(packageDocument));
  await assert.rejects(buildRelease({ root }), /identity/);
});

test('explicitly added credential files are rejected before an archive is generated', async t => {
  const root = await fixture(t, { extraFiles: ['lib/credentials.json'] });
  await writeFile(join(root, 'lib', 'credentials.json'), '{"accessToken":"PRIVATE_TEST_FIXTURE"}');
  await assert.rejects(buildRelease({ root }), /Excluded release file/);
  assert.deepEqual(await readdir(join(root, 'artifacts', 'release-v0.3.0')), []);
});

test('release path validation refuses traversal, duplicate files, unmanaged files and missing entry points', () => {
  const base = ['package.json', 'lib/index.js', 'browser-extension/manifest.json', 'cordis.patch.yml'].map(path => ({ path }));
  for (const bad of ['/absolute', '../escape', 'lib/../escape', 'lib\\escape', 'lib/file:stream', 'lib/trailing.', 'lib/NUL.txt', 'lib/.env', 'scripts/browser-bridge.json', 'research/private.txt', 'lib/private.pem', 'lib/index.js', 'LIB/index.js']) {
    assert.throws(() => validateReleasePaths([...base, { path: bad }]), undefined, bad);
  }
  assert.throws(() => validateReleasePaths(base.filter(file => file.path !== 'browser-extension/manifest.json')), /Missing release file/);
});
