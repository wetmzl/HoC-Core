import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, open, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { eligible } from './update-release.mjs';

export const PAGES_ORIGIN = 'https://hoc-core-updates.pages.dev';
export class UpdateUnavailable extends Error {}
const SHA = /^[a-f0-9]{64}$/;
const PART_BYTES = 24 * 1024 * 1024;
export function channelRelease(data, channel) {
  if (data?.schemaVersion !== 1 || data.channel !== channel || !Object.hasOwn(data, 'release')) throw new Error('Pages 更新通道信息无效。');
  if (data.release === null) return undefined;
  if (!data.release || data.release.draft !== false || typeof data.release.prerelease !== 'boolean' || !eligible(data.release, channel)
    || !Array.isArray(data.release.assets)) throw new Error('Pages 发布身份或通道不匹配。');
  return data.release;
}
export function chunkManifestUrl(release) { return `${PAGES_ORIGIN}/files/${release.tag}/${release.name}.json`; }
export function parseChunks(data, release) {
  if (data?.schemaVersion !== 1 || data.name !== release.name || data.bytes !== release.bytes || data.sha256 !== release.sha256
    || data.sourceUrl !== release.url || !Array.isArray(data.parts) || !data.parts.length || data.parts.length > 4096)
    throw new Error('分片清单与所选安装包的身份、大小或摘要不匹配。');
  let offset = 0;
  for (const [index, part] of data.parts.entries()) {
    if (part.index !== index || part.offset !== offset || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > PART_BYTES
      || !SHA.test(part.sha256) || part.url !== `${PAGES_ORIGIN}/assets/chunks/${part.sha256}.part`)
      throw new Error('分片顺序、大小、摘要或下载地址无效。');
    offset += part.bytes;
    if (offset > release.bytes) throw new Error('分片总大小超过发布声明。');
  }
  if (offset !== release.bytes) throw new Error('分片清单不完整。');
  return data;
}
export async function pagesResponse(fetchImpl, address, signal) {
  const url = new URL(address);
  if (url.origin !== PAGES_ORIGIN || url.username || url.password || url.search || url.hash) throw new Error('Pages 更新地址不受信任。');
  let response;
  try { response = await fetchImpl(address, { redirect: 'manual', credentials: 'omit', signal, headers: { Accept: '*/*' } }); }
  catch (error) { signal?.throwIfAborted(); throw new UpdateUnavailable('无法连接 Pages 更新源。', { cause: error }); }
  if ([403, 404, 408, 429].includes(response.status) || response.status >= 500) {
    await response.body?.cancel(); throw new UpdateUnavailable(`Pages 更新源暂不可用（HTTP ${response.status}）。`);
  }
  if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Pages 更新请求未完成（HTTP ${response.status}）。`); }
  return response;
}
export async function pagesJson(fetchImpl, address, signal) {
  const response = await pagesResponse(fetchImpl, address, signal), chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { await response.body?.cancel().catch(() => {}); throw new Error('Pages 更新信息过大。'); }
      chunks.push(chunk);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (bytes > 4 * 1024 * 1024) throw error;
    throw new UpdateUnavailable('Pages 更新信息传输中断。', { cause: error });
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function validFile(path, expected) {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink() && info.size === expected.bytes && await fileDigest(path) === expected.sha256; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function atomicJson(path, value) {
  const temporary = path + '.writing', file = await open(temporary, 'w');
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
async function saveResponse(response, path, expected, signal, progress) {
  const temporary = path + '.partial', file = await open(temporary, 'w'), hash = createHash('sha256');
  const iterator = response.body[Symbol.asyncIterator]();
  let bytes = 0;
  try {
    while (true) {
      let item;
      try { item = await iterator.next(); }
      catch (error) { signal.throwIfAborted(); throw new UpdateUnavailable('更新下载传输中断。', { cause: error }); }
      if (item.done) break;
      signal.throwIfAborted(); bytes += item.value.length;
      if (bytes > expected.bytes) { await response.body.cancel().catch(() => {}); throw new Error('分片或安装包超出声明大小。'); }
      await file.writeFile(item.value); hash.update(item.value); progress(bytes);
    }
    signal.throwIfAborted(); await file.sync();
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('分片或安装包不完整或校验失败。');
    await file.close(); await rename(temporary, path);
  } finally { await iterator.return?.().catch(() => {}); await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}
/** Only verified, fsynced parts survive cancellation; a new process revalidates them. */
export async function downloadRelease({ release, directory, signal, fetchImpl, githubRequest, progress }) {
  await mkdir(directory, { recursive: true });
  const identityKey = createHash('sha256').update(`${release.tag}\0${release.name}`).digest('hex');
  const identities = join(directory, 'identities'); await mkdir(identities, { recursive: true });
  const identityPath = join(identities, `${identityKey}.json`);
  const identity = { tag: release.tag, name: release.name, bytes: release.bytes, sha256: release.sha256 };
  try {
    const previous = JSON.parse(await readFile(identityPath, 'utf8'));
    if (JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error('同一发布版本的安装包身份或摘要已变化，已停止更新。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await atomicJson(identityPath, identity); }
  const target = join(directory, release.name);
  if (await validFile(target, release)) return target;
  const cache = join(directory, 'chunks', release.sha256); await mkdir(cache, { recursive: true });
  const planPath = join(cache, 'manifest.json');
  let plan;
  try { plan = parseChunks(JSON.parse(await readFile(planPath, 'utf8')), release); }
  catch (error) { if (error.code !== 'ENOENT') await rm(planPath, { force: true }); }
  if (!plan && release.chunkManifestUrl) {
    try { plan = parseChunks(await pagesJson(fetchImpl, release.chunkManifestUrl, signal), release); await atomicJson(planPath, plan); }
    catch (error) { if (!(error instanceof UpdateUnavailable)) throw error; }
  }
  const staging = join(directory, `${release.sha256}.assembling`);
  let lastProgress = 0;
  const report = (bytes, force = false) => {
    if (force || Date.now() - lastProgress >= 150) { progress({ phase: 'downloading', completedBytes: bytes, totalBytes: release.bytes }); lastProgress = Date.now(); }
  };
  try {
    if (plan) {
      let completed = 0;
      for (const part of plan.parts) {
        signal.throwIfAborted();
        const path = join(cache, `${part.sha256}.part`);
        if (!await validFile(path, part)) {
          await rm(path, { force: true });
          try {
            const response = await pagesResponse(fetchImpl, part.url, signal);
            await saveResponse(response, path, part, signal, bytes => report(completed + bytes));
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof UpdateUnavailable)) throw error;
            // A download fallback stays pinned to the chosen tag, filename and both digests.
            const end = part.offset + part.bytes - 1;
            const response = await githubRequest(release.url, signal, { Range: `bytes=${part.offset}-${end}` });
            if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${part.offset}-${end}/${release.bytes}`) {
              await response.body?.cancel(); throw new Error('GitHub 备用源未返回所选附件的正确分段，断点已保留。');
            }
            await saveResponse(response, path, part, signal, bytes => report(completed + bytes));
          }
        }
        completed += part.bytes; report(completed, true);
      }
      const file = await open(staging, 'w'), hash = createHash('sha256');
      let bytes = 0;
      try {
        for (const part of plan.parts) for await (const chunk of createReadStream(join(cache, `${part.sha256}.part`))) {
          signal.throwIfAborted(); bytes += chunk.length; hash.update(chunk); await file.writeFile(chunk);
        }
        await file.sync();
        if (bytes !== release.bytes || hash.digest('hex') !== release.sha256) throw new Error('重组安装包的完整大小或摘要校验失败。');
      } finally { await file.close(); }
    } else {
      const response = await githubRequest(release.url, signal);
      if (response.status !== 200) { await response.body?.cancel(); throw new Error('安装包下载失败，请稍后重试。'); }
      await saveResponse(response, staging, release, signal, bytes => report(bytes));
    }
    signal.throwIfAborted(); progress({ phase: 'verifying', completedBytes: release.bytes, totalBytes: release.bytes }); signal.throwIfAborted();
    // A different verified target is retained; invalid cached bytes may be replaced only now.
    if (await validFile(target, release)) await rm(staging, { force: true });
    else await rename(staging, target);
    return target;
  } catch (error) {
    if (!(error instanceof UpdateUnavailable) && !signal.aborted) await rm(planPath, { force: true });
    throw error;
  } finally { await rm(staging, { force: true }); }
}
