import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateInstaller, UPDATE_REPOSITORY } from '../lib/update-installer.js';

const run = promisify(execFile);
const release = { version: '0.3.0', tagName: 'v0.3.0' };
const packageInfo = (version, extra = {}) => ({ name: 'dsh-tongji-usage-widget', version,
  main: 'lib/index.js', engines: { node: '>=20' }, ...extra });

async function fixture(action, { targetVersion = '0.3.0', targetExtra = {}, git = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tongji-updater-test-'));
  const command = async (...args) => String((await run('git', ['-C', root, ...args], { windowsHide: true })).stdout).trim();
  try {
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'package.json'), JSON.stringify(packageInfo('0.2.4')));
    await writeFile(join(root, 'lib', 'index.js'), 'export const version = "old";\n');
    await writeFile(join(root, '.gitignore'), '*.private\n');
    if (git) {
      await command('init', '-b', 'main');
      await command('config', 'user.name', 'Updater Fixture');
      await command('config', 'user.email', 'updater-fixture@example.invalid');
      await command('remote', 'add', 'origin', UPDATE_REPOSITORY);
      await command('add', '.');
      await command('commit', '-m', 'Initial fixture');
      await command('checkout', '-b', 'release-fixture');
      await writeFile(join(root, 'package.json'), JSON.stringify(packageInfo(targetVersion, targetExtra)));
      await writeFile(join(root, 'lib', 'index.js'), 'export const version = "new";\n');
      await command('add', '.');
      await command('commit', '-m', 'Release fixture');
      await command('tag', 'v0.3.0');
      await command('checkout', 'main');
    }
    await action({ root, command });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function runner(root, { beforeFetch, afterFetch, calls = [] } = {}) {
  return async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const position = args.indexOf('-C') + 2;
    if (args[position] === 'fetch') {
      assert.equal(args[position + 3], UPDATE_REPOSITORY);
      await beforeFetch?.();
      // Replace the public network fetch only inside this isolated fixture.
      const local = [...args];
      local[position + 3] = root;
      const result = await run(file, ['-c', 'protocol.file.allow=always', ...local], options);
      await afterFetch?.();
      return result;
    }
    return run(file, args, options);
  };
}

test('a clean linked checkout updates only to the validated release tag and requests restart', async () => {
  await fixture(async ({ root, command }) => {
    const calls = [];
    const hookOutput = join(root, 'hook-should-not-run');
    const hook = join(root, '.git', 'hooks', 'post-merge');
    await writeFile(hook, '#!/bin/sh\nprintf hook > hook-should-not-run\n');
    await chmod(hook, 0o755);
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls }),
      environment: { ...process.env, TONGJI_AI_ACCESS_TOKEN: 'PRIVATE_TOKEN', TONGJI_AI_COOKIE: 'PRIVATE_COOKIE' } });
    try {
      assert.equal(updater.status().canInstall, false);
      assert.equal((await updater.probe()).canInstall, true);
      assert.equal(calls.some(call => call.args.includes('fetch')), false);
      const value = await updater.install(release);
      assert.equal(value.state, 'installed');
      assert.equal(value.version, release.version);
      assert.equal(value.restartRequired, true);
      assert.equal(value.canInstall, false);
      assert.equal(await command('rev-parse', 'HEAD'), await command('rev-parse', 'v0.3.0^{commit}'));
      assert.equal((JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).version, '0.3.0');
      assert.equal(await command('status', '--porcelain'), '');
      await assert.rejects(readFile(hookOutput), error => error.code === 'ENOENT');
      for (const call of calls) {
        assert.equal(call.file, 'git');
        assert.equal(call.options.windowsHide, true);
        assert.equal(call.options.shell, false);
        assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(call.options.env.TONGJI_AI_ACCESS_TOKEN, undefined);
        assert.equal(call.options.env.TONGJI_AI_COOKIE, undefined);
        assert.ok(call.args.some(arg => arg.startsWith('core.hooksPath=')));
        assert.ok(call.args.includes('core.fsmonitor=false'));
      }
      assert.ok(!JSON.stringify(value).includes(root));
    } finally { updater.dispose(); }
  });
});

test('concurrent install callers share one fetch and one installation', async () => {
  await fixture(async ({ root }) => {
    let entered, resume;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const calls = [];
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls,
      beforeFetch: async () => { entered(); await gate; } }) });
    try {
      const first = updater.install(release);
      const second = updater.install(release);
      assert.equal(first, second);
      await waiting;
      assert.equal(updater.status().state, 'installing');
      resume();
      assert.equal((await first).state, 'installed');
      assert.equal(calls.filter(call => call.args.includes('fetch')).length, 1);
      assert.equal(calls.filter(call => call.args.includes('merge')).length, 1);
      assert.equal((await updater.install(release)).state, 'installed');
    } finally { resume?.(); updater.dispose(); }
  });
});

test('archive installations offer the manual Release fallback without changing files', async () => {
  await fixture(async ({ root }) => {
    const updater = createUpdateInstaller({ root, execFileImpl: () => { throw new Error('must not invoke Git'); } });
    try {
      const value = await updater.probe();
      assert.equal(value.state, 'unsupported');
      assert.equal(value.canInstall, false);
      assert.match(value.message, /Release/);
      assert.equal((await updater.install(release)).canInstall, false);
      assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '0.2.4');
    } finally { updater.dispose(); }
  }, { git: false });
});

test('tracked, staged and untracked local changes are preserved and prevent fetch', async () => {
  for (const kind of ['tracked', 'staged', 'untracked']) {
    await fixture(async ({ root, command }) => {
      const file = join(root, kind === 'untracked' ? 'personal.txt' : 'lib/index.js');
      await writeFile(file, 'PERSONAL_CHANGE');
      if (kind === 'staged') await command('add', 'lib/index.js');
      const calls = [];
      const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls }) });
      try {
        const value = await updater.install(release);
        assert.equal(value.state, 'error', kind);
        assert.match(value.message, /本机修改|未提交/);
        assert.equal(await readFile(file, 'utf8'), 'PERSONAL_CHANGE');
        assert.equal(calls.some(call => call.args.includes('fetch')), false);
      } finally { updater.dispose(); }
    });
  }
});

test('an unrelated origin or a non-main checkout cannot be updated', async () => {
  for (const kind of ['source', 'branch', 'detached']) {
    await fixture(async ({ root, command }) => {
      if (kind === 'source') await command('remote', 'set-url', 'origin', 'https://example.invalid/PRIVATE');
      if (kind === 'branch') await command('checkout', 'release-fixture');
      if (kind === 'detached') await command('checkout', '--detach', 'HEAD');
      const calls = [];
      const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls }) });
      try {
        const value = await updater.probe();
        assert.equal(value.state, 'unsupported', kind);
        assert.equal(value.canInstall, false);
        assert.ok(!JSON.stringify(value).includes('PRIVATE'));
        assert.equal(calls.some(call => call.args.includes('fetch')), false);
      } finally { updater.dispose(); }
    });
  }
});

test('malformed or mismatched release metadata is rejected before fetch', async () => {
  await fixture(async ({ root }) => {
    const calls = [];
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls }) });
    try {
      for (const invalid of [null, {}, { version: '0.3.0', tagName: 'main' },
        { version: '0.3.0; PRIVATE', tagName: 'v0.3.0; PRIVATE' },
        { version: '0.3.0-rc.1', tagName: 'v0.3.0-rc.1' }]) {
        const value = await updater.install(invalid);
        assert.equal(value.state, 'error');
        assert.match(value.message, /发布信息无效/);
        assert.ok(!JSON.stringify(value).includes('PRIVATE'));
      }
      assert.equal(calls.some(call => call.args.includes('fetch')), false);
    } finally { updater.dispose(); }
  });
});

test('a release tag whose package version disagrees with the release is not installed', async () => {
  await fixture(async ({ root, command }) => {
    const before = await command('rev-parse', 'HEAD');
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root) });
    try {
      assert.equal((await updater.install(release)).state, 'error');
      assert.equal(await command('rev-parse', 'HEAD'), before);
    } finally { updater.dispose(); }
  }, { targetVersion: '0.3.1' });
});

test('diverged history is never force-reset or merged', async () => {
  await fixture(async ({ root, command }) => {
    await writeFile(join(root, 'local-commit.txt'), 'LOCAL COMMIT');
    await command('add', '.'); await command('commit', '-m', 'Local history');
    const before = await command('rev-parse', 'HEAD');
    const calls = [];
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls }) });
    try {
      const value = await updater.install(release);
      assert.equal(value.state, 'error');
      assert.match(value.message, /历史无法直接合并/);
      assert.equal(await command('rev-parse', 'HEAD'), before);
      assert.equal(calls.some(call => call.args.includes('merge') || call.args.includes('reset')), false);
    } finally { updater.dispose(); }
  });
});

test('new runtime dependencies or changed engine requirements require manual installation', async () => {
  for (const extra of [{ dependencies: { 'example-dependency': '^1.0.0' } }, { engines: { node: '>=999' } }]) {
    await fixture(async ({ root, command }) => {
      const before = await command('rev-parse', 'HEAD');
      const updater = createUpdateInstaller({ root, execFileImpl: runner(root) });
      try {
        const value = await updater.install(release);
        assert.equal(value.state, 'error');
        assert.match(value.message, /运行依赖|运行环境/);
        assert.equal(await command('rev-parse', 'HEAD'), before);
      } finally { updater.dispose(); }
    }, { targetExtra: extra });
  }
});

test('local edits appearing while downloading are rechecked and preserved', async () => {
  await fixture(async ({ root, command }) => {
    const before = await command('rev-parse', 'HEAD');
    const calls = [];
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls,
      afterFetch: () => writeFile(join(root, 'lib', 'index.js'), 'CHANGE DURING DOWNLOAD') }) });
    try {
      const value = await updater.install(release);
      assert.equal(value.state, 'error');
      assert.match(value.message, /本机修改|未提交/);
      assert.equal(await readFile(join(root, 'lib', 'index.js'), 'utf8'), 'CHANGE DURING DOWNLOAD');
      assert.equal(await command('rev-parse', 'HEAD'), before);
      assert.equal(calls.some(call => call.args.includes('merge')), false);
    } finally { updater.dispose(); }
  });
});

test('network errors remain generic and no external Git diagnostics reach the UI', async () => {
  await fixture(async ({ root }) => {
    const base = runner(root);
    const updater = createUpdateInstaller({ root, execFileImpl: async (file, args, options) => {
      if (args.includes('fetch')) throw Object.assign(new Error('PRIVATE_SECRET'), { stderr: 'PRIVATE_SECRET' });
      return base(file, args, options);
    } });
    try {
      const value = await updater.install(release);
      assert.equal(value.state, 'error');
      assert.equal(value.canInstall, true);
      assert.ok(!JSON.stringify(value).includes('PRIVATE_SECRET'));
      const snapshot = updater.status(); snapshot.state = 'tampered';
      assert.equal(updater.status().state, 'error');
    } finally { updater.dispose(); }
  });
});

test('same-version and older releases do not download or alter the checkout', async () => {
  await fixture(async ({ root }) => {
    const calls = [];
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root, { calls }) });
    try {
      for (const version of ['0.2.4', '0.2.3']) {
        const value = await updater.install({ version, tagName: `v${version}` });
        assert.equal(value.state, 'idle');
        assert.match(value.message, /无需重复安装/);
      }
      assert.equal(calls.some(call => call.args.includes('fetch')), false);
    } finally { updater.dispose(); }
  });
});

test('a newer version already on disk is reported as awaiting restart of the older running plugin', async () => {
  await fixture(async ({ root }) => {
    const updater = createUpdateInstaller({ root, currentVersion: '0.2.3', execFileImpl: runner(root) });
    try {
      const value = await updater.probe();
      assert.equal(value.state, 'installed');
      assert.equal(value.version, '0.2.4');
      assert.equal(value.restartRequired, true);
      assert.match(value.message, /重新打开 DSH/);
    } finally { updater.dispose(); }
  });
});

test('an install request also detects already updated files without requiring an earlier probe', async () => {
  await fixture(async ({ root }) => {
    const calls = [];
    const updater = createUpdateInstaller({ root, currentVersion: '0.2.3', execFileImpl: runner(root, { calls }) });
    try {
      const value = await updater.install({ version: '0.2.4', tagName: 'v0.2.4' });
      assert.equal(value.state, 'installed');
      assert.equal(value.restartRequired, true);
      assert.equal(calls.some(call => call.args.includes('fetch')), false);
    } finally { updater.dispose(); }
  });
});

test('ignored personal files are not silently overwritten by a release', async () => {
  await fixture(async ({ root, command }) => {
    await command('checkout', 'release-fixture');
    await writeFile(join(root, 'notes.private'), 'RELEASE FILE');
    await command('add', '-f', 'notes.private');
    await command('commit', '-m', 'Ignored-path collision fixture');
    await command('tag', '-f', 'v0.3.0');
    await command('checkout', 'main');
    await writeFile(join(root, 'notes.private'), 'PERSONAL FILE');
    assert.equal(await command('status', '--porcelain'), '');
    const before = await command('rev-parse', 'HEAD');
    const updater = createUpdateInstaller({ root, execFileImpl: runner(root) });
    try {
      assert.equal((await updater.install(release)).state, 'error');
      assert.equal(await readFile(join(root, 'notes.private'), 'utf8'), 'PERSONAL FILE');
      assert.equal(await command('rev-parse', 'HEAD'), before);
    } finally { updater.dispose(); }
  });
});
