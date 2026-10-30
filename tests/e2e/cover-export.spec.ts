import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { extractHocpkgFromPng } from '../../src/content/transfer/hocpkg';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('a WebP skin cover exports as a viewable PNG card while retaining WebP package bytes', async ({ page }) => {
  const webp = await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 40, g: 100, b: 180, alpha: .6 } } }).webp({ quality: 92 }).toBuffer();
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { MemoryContentHostProvider } = await load('/src/content/storage/memory-host.ts');
    const { FileContentRepository } = await load('/src/content/storage/repository.ts');
    const { HocpkgTransfer } = await load('/src/content/transfer/hocpkg.ts');
    const { sha256, encodeText } = await load('/src/content/storage/encoding.ts');
    const host = new MemoryContentHostProvider();
    const repository = new FileContentRepository(host.host);
    const transfer = new HocpkgTransfer(host.fileSystem, repository);
    const payloads: Record<string, Uint8Array> = {
      'cover.webp': Uint8Array.from(bytes),
      'match.json': encodeText(JSON.stringify({ presentationResourceId: 'appearance', definition: { assets: { cover: { presentationRef: 'cover' } } } })),
      'appearance.json': encodeText(JSON.stringify({ skins: [{ id: 'default', name: 'Default' }], resources: { cover: { type: 'image', variants: [{ skinId: 'default', value: 'cover.webp' }] } } }))
    };
    const files = await Promise.all(Object.entries(payloads).map(async ([path, data]) => ({ path, bytes: data.length, sha256: await sha256(data), mediaType: path.endsWith('.webp') ? 'image/webp' : 'application/json' })));
    const manifest = { format: 'house-of-chances-hocpkg', formatVersion: 1, identity: { authorId: 'example', packageName: 'webp-cover', version: '1.0.0' }, metadata: { title: 'Neutral WebP card', description: 'WebP export fixture', tags: [], creators: [{ displayName: 'Example', roles: ['design'] }] }, resources: [
      { id: 'match', type: 'game.character-match', apiVersion: 13, entry: 'match.json', requires: ['appearance'] },
      { id: 'appearance', type: 'presentation.character', apiVersion: 1, entry: 'appearance.json', requires: [] }
    ], files, extensions: {} };
    await repository.install({ manifest, async *files() { for (const [path, bytes] of Object.entries(payloads)) yield { path, bytes }; } });
    const png = await transfer.exportPackagePng('example/webp-cover');
    const session = await transfer.stage(new File([new Uint8Array(png)], 'card.png', { type: 'image/png' }));
    return { png: Array.from(png), candidate: session.candidates[0], installed: Array.from(await repository.readFile('example/webp-cover', 'cover.webp')) };
  }, Array.from(webp));
  expect(result.candidate.packageId).toBe('example/webp-cover');
  expect(result.candidate.error).toBeUndefined();
  expect(Buffer.from(result.installed)).toEqual(webp);
  const png = Buffer.from(result.png);
  const metadata = await sharp(png).metadata();
  expect([metadata.format, metadata.width, metadata.height]).toEqual(['png', 32, 24]);
  const files = unzipSync(extractHocpkgFromPng(png));
  expect(sha(files['cover.webp'])).toBe(sha(webp));
  expect(JSON.parse(Buffer.from(files['hocpkg-info.json']).toString()).files.find((file: any) => file.path === 'cover.webp').mediaType).toBe('image/webp');
});
