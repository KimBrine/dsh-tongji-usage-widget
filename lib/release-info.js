const REPOSITORY = 'KimBrine/dsh-tongji-usage-widget';
const PACKAGE_NAME = 'dsh-tongji-usage-widget';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASE_DOWNLOAD_PAGE = `https://github.com/${REPOSITORY}/releases/latest`;
const VERSION = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const TAG = new RegExp(`^v(${VERSION})$`);
const MAX_RESPONSE = 262144;
const MAX_ARCHIVE = 20 * 1024 * 1024;

function problem(code, message) { return Object.assign(new Error(message), { code }); }

/** Resolves only a published release of this repository, never a URL supplied by the UI. */
export async function resolveLatestRelease({ fetchImpl = globalThis.fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(15000);
  const active = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let response;
  try {
    response = await fetchImpl(LATEST_RELEASE_API, {
      method: 'GET', headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: active,
    });
    if (response.status === 404) throw problem('NO_RELEASE', '暂时没有可安装的正式发行版，请稍后检查 Release。');
    if (!response.ok || response.status !== 200 || response.redirected || (response.url && response.url !== LATEST_RELEASE_API)) throw problem('INVALID_RELEASE', 'GitHub 发行版信息无效，请稍后重试。');
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE || !response.body?.getReader) throw problem('INVALID_RELEASE', 'GitHub 发行版信息无效，请稍后重试。');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    active.addEventListener('abort', cancel, { once: true });
    let value;
    try {
      while (true) {
        active.throwIfAborted();
        const next = await reader.read();
        active.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE) { cancel(); throw problem('INVALID_RELEASE', 'GitHub 发行版信息过大，未安装。'); }
        chunks.push(next.value);
      }
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    } finally { active.removeEventListener('abort', cancel); reader.releaseLock(); }
    const match = typeof value.tag_name === 'string' && TAG.exec(value.tag_name);
    if (!match || value.draft !== false || value.prerelease !== false || !value.published_at || !Array.isArray(value.assets)) throw problem('INVALID_RELEASE', '发行版尚未发布或版本信息无效，未安装。');
    const version = match[1], tagName = value.tag_name;
    const base = `https://github.com/${REPOSITORY}/releases/download/${tagName}/`;
    const archiveName = `${PACKAGE_NAME}-${version}.tgz`;
    const archive = value.assets.filter(asset => asset.name === archiveName);
    const manifest = value.assets.filter(asset => asset.name === 'update.json');
    if (archive.length !== 1 || manifest.length !== 1) throw problem('INVALID_RELEASE', '发行版文件尚未准备完整，请稍后重试。');
    for (const asset of [archive[0], manifest[0]]) {
      if (asset.state !== 'uploaded' || asset.browser_download_url !== base + asset.name || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE) throw problem('INVALID_RELEASE', '发行版下载文件无效，未安装。');
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(archive[0].digest || '')) throw problem('INVALID_RELEASE', '发行版缺少校验信息，未安装。');
    return { version, tagName, archiveUrl: base + archiveName, archiveSize: archive[0].size,
      sha256: archive[0].digest.slice(7).toLowerCase() };
  } catch (error) {
    if (['NO_RELEASE', 'INVALID_RELEASE'].includes(error?.code)) throw error;
    throw problem('RELEASE_NETWORK', active.aborted ? '获取发行版超时或已取消，请重试。' : '暂时无法连接 GitHub 发行版，请稍后重试。');
  } finally { try { await response?.body?.cancel(); } catch { /* body may already be consumed */ } }
}
