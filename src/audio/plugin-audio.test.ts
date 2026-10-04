import { afterEach, expect, it, vi } from "vitest";
import { GameAudio } from "./game-audio";
class Media extends EventTarget {
  static all: Media[] = [];
  paused = true; volume = 1; currentTime = 0; loop = false; preload = "";
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn(); load = vi.fn();
  constructor(readonly src: string) { super(); Media.all.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Media.all = []; });
it("owns plugin voices and URLs across mute, abort, unload and runtime teardown", async () => {
  vi.useFakeTimers(); vi.stubGlobal("window", {}); vi.stubGlobal("document", { hidden: false }); vi.stubGlobal("Audio", Media);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("audio")));
  const audio = new GameAudio(); const release = vi.fn();
  const effect = audio.createEffect("blob:plugin-sound", release);
  effect.play(); expect(Media.all).toHaveLength(0);
  audio.unlock();
  const signal = new AbortController(); effect.play({ volume: 0.58, signal: signal.signal });
  const voice = Media.all.find((entry) => entry.src === "blob:plugin-sound")!;
  expect(voice.volume).toBe(0.58); expect(voice.play).toHaveBeenCalledOnce();
  signal.abort(); expect(voice.pause).toHaveBeenCalledOnce();
  effect.play(); const second = Media.all.at(-1)!;
  audio.configure(false); expect(second.pause).toHaveBeenCalledOnce();
  const before = Media.all.length; effect.play(); expect(Media.all).toHaveLength(before);
  audio.configure(true); effect.play();
  await audio.dispose(); effect.dispose(); effect.play();
  expect(release).toHaveBeenCalledOnce();
  expect(Media.all.filter((entry) => entry.src === "blob:plugin-sound").every((entry) => entry.paused)).toBe(true);
});
