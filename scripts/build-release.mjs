import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'dsh-tongji-usage-widget';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOP_LEVEL = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'INSTALL.md', 'VALIDATION.md', 'RELEASING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);
const DIRECTORIES = new Set(['lib', 'scripts', 'browser-extension', 'tests']);
const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateReleasePaths(files) {
  if (!Array.isArray(files) || !files.length || files.length > 1000) throw new Error('Release file list is invalid.');
  const found = new Set();
  for (const file of files) {
    const path = file?.path;
    if (typeof path !== 'string' || !path || /[\\<>:"|?*\u0000-\u001f]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe release path.');
    if (found.has(path.toLowerCase())) throw new Error('Duplicate release path.');
    found.add(path.toLowerCase());
    const parts = path.split('/');
    if (parts.some(part => /^(?:\.|node_modules$|artifacts$|research$|coverage$)|^(?:credentials|browser-bridge)(?:[.-]|$)|\.(?:pem|key|tgz|zip|log|bak)$/i.test(part))) throw new Error(`Excluded release file: ${path}`);
    if (parts.length === 1 ? !TOP_LEVEL.has(path) : !DIRECTORIES.has(parts[0])) throw new Error(`Unexpected release file: ${path}`);
  }
  for (const required of ['package.json', 'lib/index.js', 'browser-extension/manifest.json', 'cordis.patch.yml']) {
    if (!found.has(required)) throw new Error(`Missing release file: ${required}`);
  }
  return files.map(file => file.path).sort();
}

function npmCli() {
  const binaryDirectory = dirname(process.execPath);
  const candidates = [process.env.npm_execpath, join(binaryDirectory, 'node_modules/npm/bin/npm-cli.js'), join(binaryDirectory, '../lib/node_modules/npm/bin/npm-cli.js'), process.env.npm_config_prefix && join(process.env.npm_config_prefix, 'node_modules/npm/bin/npm-cli.js')];
  const value = candidates.find(candidate => candidate && /npm-cli\.js$/i.test(candidate) && existsSync(candidate));
  if (!value) throw new Error('Cannot locate npm-cli.js beside Node.js; run this script through npm or install the official Node.js distribution.');
  return value;
}

const zipScript = String.raw`
import io, json, pathlib, sys, tarfile, zipfile
archive, output, root, expected_json = sys.argv[1:]
expected = set(json.loads(expected_json))
with tarfile.open(archive, 'r:gz') as source:
    members = [member for member in source.getmembers() if member.isfile()]
    paths = [member.name.removeprefix('package/') for member in members]
    if set(paths) != expected or len(paths) != len(expected):
        raise ValueError('archive contents differ from validated package')
    if any(not member.name.startswith('package/') or not member.isfile() for member in source.getmembers()):
        raise ValueError('non-file archive entry')
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as destination:
        for member in sorted(members, key=lambda item: item.name):
            relative = member.name.removeprefix('package/')
            entry = zipfile.ZipInfo(root + '/' + relative, date_time=(1985, 10, 26, 8, 15, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            destination.writestr(entry, source.extractfile(member).read())
with zipfile.ZipFile(output) as check:
    if check.testzip() is not None:
        raise ValueError('zip CRC validation failed')
`;

export async function buildRelease({ root = ROOT, outputDir, tag } = {}) {
  root = resolve(root);
  const packageDocument = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const extension = JSON.parse(await readFile(join(root, 'browser-extension/manifest.json'), 'utf8'));
  const version = packageDocument.version;
  if (packageDocument.name !== NAME || !stableVersion(version)) throw new Error('Release package identity or stable version is invalid.');
  if (extension.version !== version) throw new Error('Browser extension version must match the package version.');
  const tagName = `v${version}`;
  if (tag !== undefined && tag !== tagName) throw new Error('Release tag must exactly match the package version.');
  const directory = resolve(outputDir || join(root, 'artifacts', `release-${tagName}`));
  await mkdir(directory, { recursive: true });
  const cli = npmCli();
  const pack = dryRun => {
    const args = [cli, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory, ...(dryRun ? ['--dry-run'] : [])];
    const output = execFileSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(output);
    if (!Array.isArray(result) || result.length !== 1 || result[0].name !== NAME || result[0].version !== version) throw new Error('npm returned an unexpected package.');
    return result[0];
  };
  const preview = pack(true);
  const paths = validateReleasePaths(preview.files);
  for (const path of paths) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Non-regular release file: ${path}`);
  }
  const packed = pack(false);
  const archiveName = `${NAME}-${version}.tgz`;
  const archive = join(directory, archiveName);
  try {
    if (packed.filename !== archiveName || JSON.stringify(validateReleasePaths(packed.files)) !== JSON.stringify(paths)) throw new Error('Package changed while preparing the release; rebuild from a stable checkout.');
    const zipName = `${NAME}-${version}.zip`;
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', zipScript, archive, join(directory, zipName), NAME, JSON.stringify(paths)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    const archiveBytes = await readFile(archive);
    const update = { name: NAME, version, tagName, archive: archiveName, sha256: digest(archiveBytes), archiveSize: archiveBytes.length };
    await writeFile(join(directory, 'update.json'), `${JSON.stringify(update, null, 2)}\n`);
    const assets = [archiveName, zipName, 'update.json'];
    const sums = [];
    for (const asset of assets) sums.push(`${digest(await readFile(join(directory, asset)))}  ${asset}`);
    await writeFile(join(directory, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    return { version, tagName, directory, files: [...assets, 'SHA256SUMS'] };
  } catch (error) {
    await unlink(archive).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const arguments_ = process.argv.slice(2);
    const options = {};
    while (arguments_.length) {
      const flag = arguments_.shift();
      if (flag === '--out' && arguments_.length) options.outputDir = arguments_.shift();
      else if (flag === '--tag' && arguments_.length) options.tag = arguments_.shift();
      else throw new Error('Usage: node scripts/build-release.mjs [--tag vX.Y.Z] [--out directory]');
    }
    console.log(JSON.stringify(await buildRelease(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
