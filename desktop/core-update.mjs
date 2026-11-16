import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, lstat, rm, copyFile, chmod, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { updateChannel, RELEASES_URL, WEB_RELEASES_URL, eligible, newestRelease, compareVersions, desktopRelease, desktopAssetNames, webReleaseIndex, webReleasePage, releaseChecksums } from './update-release.mjs';
import { PAGES_ORIGIN, UpdateUnavailable, channelRelease, chunkManifestUrl, pagesJson, downloadRelease, atomicJson } from './update-chunks.mjs';

class ReleaseApiUnavailable extends Error {}
async function responseText(response, limit, message) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error(message);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export function assertUpdateUrl(address, api) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      (api ? url.hostname !== 'api.github.com' : !DOWNLOAD_HOSTS.has(url.hostname))) throw new Error('更新下载地址不受信任。');
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Native work stays in the main process. The renderer cannot choose URLs or paths. */
export class DesktopCoreUpdater {
  constructor({ directory, version, supported, platform = process.platform, arch = process.arch, appImage = process.env.APPIMAGE,
    fetchImpl = globalThis.fetch, openPath, showItemInFolder, restart, onProgress = () => {} }) {
    Object.assign(this, { directory, version, supported, platform, arch, appImage, fetchImpl, openPath, showItemInFolder, restart, onProgress });
  }
  async exclusive(operation) {
    if (this.busy) throw new Error('更新操作正在进行，请稍候。');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  requireSupported() { if (!this.supported) throw new Error('此安装包使用开发模式，不适用公开版本更新。'); }
  async request(address, api, signal, method = 'GET', headers = {}) {
    return (await this.requestDetails(address, api, signal, method, headers)).response;
  }
  async requestDetails(address, api, signal, method = 'GET', headers = {}) {
    for (let count = 0; count <= 5; count++) {
      assertUpdateUrl(address, api);
      let response;
      try {
        response = await this.fetchImpl(address, { method, redirect: 'manual', credentials: 'omit', signal,
          headers: { 'User-Agent': 'HoC-Core-Desktop-Updater', 'Accept-Language': 'en-US', Accept: api ? 'application/vnd.github+json' : '*/*', ...headers } });
      } catch (error) {
        if (api) throw new ReleaseApiUnavailable('无法连接 GitHub 更新接口。', { cause: error });
        throw error;
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: address };
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('下载重定向缺少地址。');
      address = new URL(location, address).href;
    }
    throw new Error('下载重定向次数过多。');
  }
  async metadata(address) {
    const response = await this.request(address, true, AbortSignal.timeout(20_000));
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if ([403, 429].includes(response.status)) { await response.body?.cancel(); throw new ReleaseApiUnavailable('GitHub 暂时限制了检查频率，请稍后再试。'); }
    if (response.status >= 500) { await response.body?.cancel(); throw new ReleaseApiUnavailable('GitHub 更新接口暂不可用。'); }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`无法检查更新（HTTP ${response.status}），请稍后重试。`); }
    let text;
    try { text = await responseText(response, 4 * 1024 * 1024, '更新信息过大，已停止检查。'); }
    catch (error) {
      if (error.message === '更新信息过大，已停止检查。') throw error;
      throw new ReleaseApiUnavailable('GitHub 更新接口响应中断。', { cause: error });
    }
    return JSON.parse(text);
  }
  async webText(address, limit = 4 * 1024 * 1024) {
    const response = await this.request(address, false, AbortSignal.timeout(20_000));
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`备用更新检查未完成（HTTP ${response.status}）。`); }
    return responseText(response, limit, '备用更新信息过大，已停止检查。');
  }
  async webRelease(channel) {
    let selected;
    if (channel === 'stable') {
      const { response, url } = await this.requestDetails(`${WEB_RELEASES_URL}/latest`, false, AbortSignal.timeout(20_000));
      if (response.status === 404 || (response.status === 200 && url === WEB_RELEASES_URL)) { await response.body?.cancel(); return undefined; }
      const tag = url.startsWith(`${WEB_RELEASES_URL}/tag/`) ? url.slice(`${WEB_RELEASES_URL}/tag/`.length) : '';
      if (response.status !== 200 || !eligible({ tag_name: tag }, channel)) { await response.body?.cancel(); throw new Error('GitHub 稳定版网页信息无效。'); }
      selected = webReleasePage(await responseText(response, 4 * 1024 * 1024, '备用更新信息过大。'), tag);
      if (!eligible(selected, channel)) throw new Error('GitHub 稳定版网页信息无效。');
    } else {
      for (let page = 1; page <= 10; page++) {
        const releases = webReleaseIndex(await this.webText(`${WEB_RELEASES_URL}?page=${page}`), page);
        selected = newestRelease([...(selected ? [selected] : []), ...releases], channel);
        if (!releases.length) break;
        if (page === 10) throw new Error('网页发布列表过长，暂时无法确认最新版。');
      }
      if (selected) selected = webReleasePage(await this.webText(`${WEB_RELEASES_URL}/tag/${selected.tag_name}`), selected.tag_name);
    }
    if (!selected || compareVersions(selected.tag_name, this.version) <= 0) return selected;
    const base = `${WEB_RELEASES_URL}/download/${selected.tag_name}`;
    const sums = releaseChecksums(await this.webText(`${base}/SHA256SUMS`, 128 * 1024));
    // 附件名必须先在发布校验清单中精确出现，再验证直链与实际大小。
    const candidates = desktopAssetNames(selected.tag_name, this).filter(name => sums.has(name));
    if (!candidates.length) throw new Error('所选版本尚未提供当前平台和架构的安装包或校验信息。');
    const names = candidates.filter(name => name.endsWith('.AppImage'));
    if (names.length > 1) throw new Error('发布包含重复安装包，请稍后重试。');
    const name = candidates[0], url = `${base}/${name}`;
    const response = await this.request(url, false, AbortSignal.timeout(20_000), 'HEAD');
    await response.body?.cancel();
    const length = response.headers.get('content-length') ?? '';
    const size = /^\d+$/.test(length) ? Number(length) : NaN;
    if (response.status !== 200 || !Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024 * 1024)
      throw new Error('无法确认发布安装包的大小或下载地址。');
    return { ...selected, assets: [{ name, state: 'uploaded', size, digest: `sha256:${sums.get(name)}`, browser_download_url: url }] };
  }
  async releaseNotes() {
    return this.exclusive(async () => {
      this.requireSupported();
      const response = await this.request('https://github.com/wetmzl/HoC-Core/releases.atom', false, AbortSignal.timeout(20_000));
      if (response.status !== 200) { await response.body?.cancel(); throw new Error('无法读取公开发布日志。'); }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('发布日志过大，已停止读取。');
        chunks.push(chunk);
      }
      return { feed: Buffer.concat(chunks).toString('utf8') };
    });
  }
  async getStatus({ channel = 'stable' } = {}) {
    updateChannel(channel);
    return { supported: this.supported, currentVersion: this.version, currentVersionCode: 0,
      canInstall: true, ready: await this.ready(channel) };
  }
  async ready(channel) {
    try {
      const release = JSON.parse(await readFile(join(this.directory, 'ready.json'), 'utf8'));
      if (channel === 'stable' && release.prerelease) return undefined;
      // Validate the receipt through the same public contract before using any path.
      const checked = desktopRelease({ tag_name: release.tag, body: release.notes, prerelease: release.prerelease, assets: [{
        name: release.name, state: 'uploaded', size: release.bytes, digest: `sha256:${release.sha256}`, browser_download_url: release.url
      }] }, this);
      if (!eligible({ tag_name: checked.tag, prerelease: checked.prerelease }, channel) || compareVersions(checked.version, this.version) <= 0) return undefined;
      if ((await stat(join(this.directory, checked.name))).size !== checked.bytes) return undefined;
      return checked;
    } catch { return undefined; }
  }
  async check({ channel = 'stable' } = {}) {
    return this.exclusive(async () => {
      this.requireSupported(); updateChannel(channel); this.candidate = undefined;
      let selected, fromPages = false;
      try {
        selected = channelRelease(await pagesJson(this.fetchImpl, `${PAGES_ORIGIN}/channels/${channel}.json`, AbortSignal.timeout(20_000)), channel);
        fromPages = true;
      } catch (error) { if (!(error instanceof UpdateUnavailable)) throw error; }
      if (!fromPages) try {
        if (channel === 'stable') selected = await this.metadata(`${RELEASES_URL}/latest`);
        else {
          for (let page = 1; page <= 10; page++) {
            const releases = await this.metadata(`${RELEASES_URL}?per_page=100&page=${page}`) ?? [];
            if (!Array.isArray(releases)) throw new Error('GitHub 发布信息无效。');
            selected = newestRelease([...(selected ? [selected] : []), ...releases], channel);
            if (releases.length < 100) break;
            if (page === 10) throw new Error('发布列表过长，暂时无法确认最新版，请稍后重试。');
          }
        }
      } catch (error) {
        if (!(error instanceof ReleaseApiUnavailable)) throw error;
        selected = await this.webRelease(channel);
      }
      if (!eligible(selected, channel)) return { state: 'no-release' };
      if (compareVersions(selected.tag_name, this.version) <= 0) return { state: 'current' };
      this.candidate = desktopRelease(selected, this);
      if (fromPages) {
        const address = selected.assets.find(asset => asset.name === this.candidate.name)?.chunk_manifest_url;
        if (address !== chunkManifestUrl(this.candidate)) { this.candidate = undefined; throw new Error('Pages 分片清单地址与所选安装包不匹配。'); }
        this.candidate.chunkManifestUrl = address;
      }
      return { state: 'available', release: this.candidate };
    });
  }
  cancel() { this.aborter?.abort(); }
  async download({ tag, channel = 'stable' }) {
    return this.exclusive(async () => {
      this.requireSupported(); updateChannel(channel);
      const release = this.candidate;
      if (!release || release.tag !== tag || (channel === 'stable' && release.prerelease)) throw new Error('更新信息已失效，请重新检查。');
      await mkdir(this.directory, { recursive: true });
      this.aborter = new AbortController();
      const signal = AbortSignal.any([this.aborter.signal, AbortSignal.timeout(30 * 60_000)]);
      try {
        await downloadRelease({ release, directory: this.directory, signal, fetchImpl: this.fetchImpl,
          githubRequest: (address, signal, headers) => this.request(address, false, signal, 'GET', headers), progress: this.onProgress });
        signal.throwIfAborted();
        await atomicJson(join(this.directory, 'ready.json'), release);
        return release;
      } catch (error) {
        if (this.aborter.signal.aborted) throw new Error('已取消下载。');
        throw error;
      } finally { this.aborter = undefined; }
    });
  }
  async install({ channel = 'stable' } = {}) {
    return this.exclusive(async () => {
      this.requireSupported(); updateChannel(channel);
      const release = await this.ready(channel);
      if (!release) throw new Error('没有可安装的更新，请重新检查。');
      const path = join(this.directory, release.name);
      if (await digest(path) !== release.sha256) { await rm(join(this.directory, 'ready.json'), { force: true }); throw new Error('下载文件已损坏，请重新下载。'); }
      if (this.platform === 'linux' && this.appImage && release.format === 'AppImage') {
        try { await replaceAppImage(path, this.appImage, release.sha256); }
        catch { throw new Error('无法替换当前 AppImage，原应用已保留。请确认所在目录可写，或手动下载替换。'); }
        this.restart(this.appImage);
        return { state: 'restart', message: '更新已安装，正在重启应用。' };
      }
      if (['exe', 'dmg'].includes(release.format)) {
        const error = await this.openPath(path);
        if (error) throw new Error('无法打开系统安装器，请稍后重试。');
        return { state: 'installer', message: release.format === 'dmg' ? '安装镜像已打开。请退出当前应用，将新版应用拖入“应用程序”并替换，再重新启动。' : '安装程序已打开，请按系统提示更新；需要替换文件时请退出当前应用。' };
      }
      this.showItemInFolder(path);
      return { state: 'manual', message: '更新压缩包已下载并校验，已打开所在文件夹。请退出当前应用，解压并替换程序文件；玩家数据单独保存在系统用户目录中。' };
    });
  }
}

/** Rename on the same filesystem keeps the old executable intact until the final commit. */
export async function replaceAppImage(source, destination, expectedDigest) {
  const info = await lstat(destination);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('当前 AppImage 位置不支持自动替换，请手动更新。');
  const temporary = join(dirname(destination), `.${basename(destination)}.hoc-update`);
  let created = false;
  try {
    await copyFile(source, temporary, 1 /* COPYFILE_EXCL */);
    created = true;
    await chmod(temporary, info.mode | 0o100);
    if (await digest(temporary) !== expectedDigest) throw new Error('更新副本校验失败，原应用已保留。');
    await rename(temporary, destination);
  } finally { if (created) await rm(temporary, { force: true }); }
}
