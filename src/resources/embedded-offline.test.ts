import { describe, expect, it, vi } from "vitest";
import { EmbeddedOfflineResources } from "./embedded-offline";
import { sha256 } from "../content/storage/encoding";

async function setup() {
  const bodies = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
  const resources = await Promise.all(bodies.map(async (bytes, index) => ({ url: `/embedded/${"a".repeat(64)}/${index}.png`, bytes: bytes.length, sha256: await sha256(bytes), mediaType: "image/png" })));
  const entries = new Map<string, Response>();
  const cache = {
    keys: async () => [...entries.keys()].map(url => new Request(`https://game.test${url}`)),
    match: async (key: string | Request) => entries.get(typeof key === 'string' ? key : new URL(key.url).pathname)?.clone(),
    put: async (key: string, response: Response) => { entries.set(key, response.clone()); },
    delete: async (key: string) => entries.delete(key)
  } as unknown as Cache;
  const storage = { open: async () => cache, delete: async () => { entries.clear(); return true; } };
  let failure = false, pause = false;
  const request = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input);
    if (url.endsWith('offline.json')) return Response.json({ format: "house-of-chances-offline-resources", formatVersion: 1, resources });
    if (pause) await new Promise<void>((resolve, reject) => {
      if (options?.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
      else options?.signal?.addEventListener('abort', () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      void resolve;
    });
    if (failure && url.endsWith('/1.png')) return new Response('unavailable', { status: 503 });
    const index = resources.findIndex(entry => entry.url === url); return new Response(bodies[index]);
  });
  return { manager: new EmbeddedOfflineResources(request, storage), resources, entries, request, storage,
    fail: (value: boolean) => { failure = value; }, pause: (value: boolean) => { pause = value; } };
}

describe("optional complete embedded downloads", () => {
  it("checks without downloading, reuses completed resources, and detects cache eviction", async () => {
    const { manager, request, entries } = await setup();
    await manager.check(); expect(manager.state.phase).toBe('idle'); expect(request).toHaveBeenCalledTimes(1);
    await manager.download(); expect(manager.state).toMatchObject({ phase: 'complete', completed: 2, bytes: 7 });
    const before = request.mock.calls.length; await manager.download(); expect(request).toHaveBeenCalledTimes(before);
    entries.clear(); await manager.check(); expect(manager.state).toMatchObject({ phase: 'idle', completed: 0 });
  });
  it("does not count failed resources as complete, and retries only missing resources", async () => {
    const { manager, request, fail } = await setup(); fail(true);
    await manager.download(); expect(manager.state).toMatchObject({ phase: 'error', completed: 1, bytes: 3 });
    const before = request.mock.calls.filter(([url]) => String(url).endsWith('/0.png')).length;
    fail(false); await manager.download(); expect(manager.state.phase).toBe('complete');
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/0.png'))).toHaveLength(before);
  });
  it("waits for cancelled workers, preserves completed files and supports retry and clear", async () => {
    const { manager, pause, entries } = await setup(); pause(true);
    const work = manager.download(); await vi.waitFor(() => expect(manager.state.phase).toBe('downloading'));
    manager.cancel(); await work; expect(manager.state.phase).toBe('cancelled');
    pause(false); await manager.download(); expect(entries.size).toBe(2);
    await manager.clear(); expect(entries.size).toBe(0); expect(manager.state.completed).toBe(0);
  });
  it("rejects damaged download bytes and never records them as cached", async () => {
    const fixture = await setup();
    fixture.request.mockImplementation(async input => String(input).endsWith('offline.json') ? Response.json({ format: 'house-of-chances-offline-resources', formatVersion: 1, resources: fixture.resources }) : new Response(new Uint8Array([0])));
    await fixture.manager.download(); expect(fixture.manager.state).toMatchObject({ phase: 'error', completed: 0 }); expect(fixture.entries.size).toBe(0);
  });
  it("reuses identical bytes when a directory revision changes its URLs", async () => {
    const { manager, resources, entries, request } = await setup(); await manager.download();
    const first = resources[0]!;
    entries.set('/embedded/old-revision/portrait.png', entries.get(first.url)!); entries.delete(first.url);
    const before = request.mock.calls.length; await manager.download();
    expect(manager.state.phase).toBe('complete'); expect(request).toHaveBeenCalledTimes(before);
    expect(entries.has(first.url)).toBe(true);
  });
  it("cancels while waiting for shell preparation without discarding completed media", async () => {
    const fixture = await setup(); await fixture.manager.download();
    let waiting = false;
    const manager = new EmbeddedOfflineResources(fixture.request, fixture.storage, signal => new Promise((_, reject) => {
      waiting = true; signal.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')), { once: true });
    }));
    const operation = manager.download(); await vi.waitFor(() => expect(waiting).toBe(true));
    manager.cancel(); await operation; expect(manager.state.phase).toBe('cancelled'); expect(fixture.entries.size).toBe(2);
  });
});
