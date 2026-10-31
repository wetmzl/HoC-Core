/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { RangeRequestsPlugin } from "workbox-range-requests";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };
self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// Preserve already-downloaded shared media before Workbox retires its old shell
// cache. This migration reads local cache entries; it never downloads media.
self.addEventListener('install', event => event.waitUntil((async () => {
  const oldNames = (await caches.keys()).filter(name => name.startsWith('workbox-precache') || name === 'blackjack-resource-pack-v1');
  if (!oldNames.length) return;
  const response = await fetch('/embedded/offline.json');
  if (!response.ok) throw new Error('Offline description unavailable during cache migration');
  const manifest = await response.json();
  const destination = await caches.open('hoc-embedded-media-v1');
  for (const entry of manifest.resources as Array<{ url: string; legacyUrl?: string; bytes: number; sha256: string; mediaType: string }>) {
    if (!entry.legacyUrl || !entry.legacyUrl.startsWith('/assets/') || entry.legacyUrl.includes('..')) continue;
    for (const name of oldNames) {
      const old = await (await caches.open(name)).match(entry.legacyUrl, { ignoreSearch: true });
      if (!old) continue;
      const bytes = await old.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== entry.bytes || digest !== entry.sha256) continue;
      await destination.put(entry.url, new Response(bytes, { headers: { 'content-type': entry.mediaType, 'x-hoc-digest': digest } }));
      break;
    }
  }
})()));
let resources: Promise<Map<string, { bytes: number; sha256: string }>> | undefined;
const verifiedMedia = {
  async cacheWillUpdate({ request, response }: { request: Request; response: Response }): Promise<Response | null> {
    if (response.status !== 200) return null;
    const index = await (resources ??= (async () => {
      const stored = await matchPrecache('/embedded/offline.json');
      const body = await stored!.json();
      return new Map<string, { bytes: number; sha256: string }>(body.resources.map((entry: { url: string; bytes: number; sha256: string }) => [new URL(entry.url, self.location.origin).href, entry]));
    })());
    const expected = index.get(request.url); if (!expected) return null;
    const bytes = await response.clone().arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== expected.bytes || digest !== expected.sha256) return null;
    const headers = new Headers(response.headers); headers.set('x-hoc-digest', digest);
    return new Response(bytes, { status: 200, headers });
  }
};
registerRoute(({ url }) => url.origin === self.location.origin && (
  /^\/embedded\/[a-f0-9]{64}\//.test(url.pathname) || /^\/assets\/.*\.[a-f0-9]{64}\.[^.]+$/.test(url.pathname)
), new CacheFirst({ cacheName: "hoc-embedded-media-v1", plugins: [new CacheableResponsePlugin({ statuses: [200] }), verifiedMedia, new RangeRequestsPlugin()] }));
