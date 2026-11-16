import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GameAudio } from "./game-audio";

class Media {
  static instances: Media[] = [];
  paused = true; volume = 1; loop = false; preload = ""; currentTime = 0;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  readonly load = vi.fn(); readonly removeAttribute = vi.fn();
  readonly pause = vi.fn(() => { this.paused = true; });
  readonly play = vi.fn(async () => { this.paused = false; });
  constructor(readonly src: string) { Media.instances.push(this); }
}
let audio: GameAudio;
const find = (url: string) => [...Media.instances].reverse().find(item => item.src === url)!;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("Audio", Media); vi.stubGlobal("document", { hidden: false }); vi.stubGlobal("window", {});
  audio = new GameAudio();
  audio.installMusic([{ packageId: "example/music", resourceId: "main", title: "音乐包", tracks: {
    lobby: { url: "blob:lobby", name: "大厅" }, special: { url: "blob:special", name: "插曲" }
  }, rules: [{ id: "lobby", scene: "lobby", track: "lobby", priority: "override" }] }]);
});
afterEach(async () => { await audio.dispose(); Media.instances = []; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("plays global lobby music, resumes its cursor after a one-shot and does not replay identical requests", async () => {
  const controller = new AbortController(), api = audio.musicDirector.forPackage("example/plugin", controller.signal);
  audio.unlock(); await vi.runAllTimersAsync(); const lobby = find("blob:lobby"); lobby.currentTime = 32;
  const request = { track: "example/music#main/special", priority: "temporary", scope: "runtime", loop: false, transitionMs: 0 } as const;
  api.set("intro", request); await vi.runAllTimersAsync(); const special = find("blob:special");
  expect(special).toMatchObject({ paused: false, loop: false, volume: .18 }); expect(lobby.paused).toBe(true);
  expect(lobby.removeAttribute).toHaveBeenCalledWith("src");
  special.paused = true; special.onended?.(); await vi.runAllTimersAsync();
  expect(find("blob:lobby")).toMatchObject({ paused: false, currentTime: 32, volume: .18 });
  const plays = special.play.mock.calls.length; api.set("intro", request); await vi.runAllTimersAsync(); expect(special.play).toHaveBeenCalledTimes(plays);
  controller.abort();
});

it("keeps the previous track audible until the requested media actually starts, then falls back after an error", async () => {
  audio.unlock(); await vi.runAllTimersAsync(); const lobby = find("blob:lobby");
  const api = audio.musicDirector.forPackage("example/plugin", new AbortController().signal);
  // Delay a newly constructed track without changing the host's audio controls.
  let resolve!: () => void;
  class Delayed extends Media { override readonly play = vi.fn(() => new Promise<void>(done => { resolve = () => { this.paused = false; done(); }; })); }
  vi.stubGlobal("Audio", Delayed);
  api.set("pending", { track: "example/music#main/special", priority: "conditional", scope: "runtime" });
  await Promise.resolve(); expect(lobby.volume).toBeCloseTo(.18); expect(lobby.paused).toBe(false);
  const pending = find("blob:special"); pending.onerror?.();
  resolve(); await vi.runAllTimersAsync();
  expect(pending.paused).toBe(true); expect(lobby.paused).toBe(false); expect(lobby.volume).toBeCloseTo(.18);
  expect(audio.musicDirector.status().current?.title).toBe("大厅");
  expect(audio.musicDirector.status().failedTracks).toContain("example/music#main/special");
});

it("honors mute and ducking for temporary tracks and removes handlers on disposal", async () => {
  audio.configure(false); const controller = new AbortController(); const api = audio.musicDirector.forPackage("example/plugin", controller.signal);
  api.set("special", { track: "example/music#main/special", priority: "temporary", scope: "runtime" });
  audio.unlock(); expect(Media.instances).toHaveLength(0);
  audio.configure(true, .45); await vi.runAllTimersAsync(); const special = find("blob:special"); expect(special.volume).toBeCloseTo(.45);
  audio.setMusicVolume(0); expect(special.volume).toBe(0);
  audio.setMusicVolume(.6); audio.pauseBgm(); expect(special.paused).toBe(true);
  audio.restoreBgm(); await vi.runAllTimersAsync(); expect(special.volume).toBeCloseTo(.6);
  controller.abort(); await vi.runAllTimersAsync(); expect(find("blob:lobby").paused).toBe(false);
  expect(special.onerror).toBeNull(); expect(special.onended).toBeNull();
});
