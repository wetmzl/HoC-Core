import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LOBBY_BGM_URL, TABLE_BGM_URL } from "../resources/cache-policy";
import { BgmPlayer } from "./bgm-player";

class Media {
  static instances: Media[] = [];
  paused = true;
  volume = 1;
  loop = false;
  preload = "";
  onerror: (() => void) | null = null;
  readonly load = vi.fn();
  readonly removeAttribute = vi.fn();
  readonly pause = vi.fn(() => { this.paused = true; });
  readonly play = vi.fn(async () => { this.paused = false; });
  constructor(readonly src: string) { Media.instances.push(this); }
}
const find = (url: string) => [...Media.instances].reverse().find(media => media.src === url)!;
let player: BgmPlayer;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Audio", Media);
  vi.stubGlobal("document", { hidden: false });
  player = new BgmPlayer();
});
afterEach(() => {
  player.dispose(); Media.instances = [];
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("streams character music, crossfades when changing opponents, and keeps lobby music", async () => {
  player.unlock();
  await vi.runAllTimersAsync();
  player.setMatchMusic(["blob:character-one", "blob:faction"]);
  player.setBgmScene("match");
  await vi.advanceTimersByTimeAsync(400);
  expect(find("blob:character-one")).toMatchObject({ loop: true, preload: "auto", paused: false });
  expect(find(LOBBY_BGM_URL).volume).toBeGreaterThan(0);
  await vi.runAllTimersAsync();
  expect(find("blob:character-one").volume).toBeCloseTo(0.18);
  expect(find(LOBBY_BGM_URL).paused).toBe(true);
  expect(find(TABLE_BGM_URL)).toBeUndefined();

  player.setMatchMusic(["blob:character-two"]);
  await vi.advanceTimersByTimeAsync(400);
  expect(find("blob:character-one").paused).toBe(false);
  expect(find("blob:character-two").volume).toBeGreaterThan(0);
  await vi.runAllTimersAsync();
  expect(find("blob:character-one").removeAttribute).toHaveBeenCalledWith("src");
  expect(find("blob:character-two").volume).toBeCloseTo(0.18);
  player.setBgmScene("lobby");
  await vi.runAllTimersAsync();
  expect(find(LOBBY_BGM_URL).volume).toBeCloseTo(0.18);
  expect(find("blob:character-two").paused).toBe(true);
});

it("falls through character, faction and default on media or unsupported-codec errors", async () => {
  player.setMatchMusic(["blob:character", "blob:faction"]);
  player.setBgmScene("match"); player.unlock();
  await vi.runAllTimersAsync();
  const character = find("blob:character");
  character.onerror?.();
  await vi.runAllTimersAsync();
  expect(character.removeAttribute).toHaveBeenCalledWith("src");
  const faction = find("blob:faction");
  expect(faction.paused).toBe(false);
  expect(faction.volume).toBeCloseTo(0.18);
  faction.play.mockRejectedValueOnce({ name: "NotSupportedError" });
  player.pauseBgm(); player.restoreBgm();
  await vi.runAllTimersAsync();
  expect(find(TABLE_BGM_URL).paused).toBe(false);
  find(TABLE_BGM_URL).onerror?.();
  await vi.runAllTimersAsync();
  expect(Media.instances.every(media => media.paused)).toBe(true);
});

it("does not treat autoplay denial as bad media or restart identical sources", async () => {
  player.setMatchMusic(["blob:character"]); player.preloadMatch();
  const character = find("blob:character");
  character.play.mockRejectedValueOnce({ name: "NotAllowedError" });
  player.setBgmScene("match"); player.unlock();
  await vi.runAllTimersAsync();
  expect(find(TABLE_BGM_URL)).toBeUndefined();
  player.unlock(); await vi.runAllTimersAsync();
  expect(character.volume).toBeCloseTo(0.18);
  const calls = character.play.mock.calls.length;
  player.setMatchMusic(["blob:character", "blob:character"]); player.setBgmScene("match");
  await vi.runAllTimersAsync();
  expect(character.play).toHaveBeenCalledTimes(calls);
});

it("preserves disabled sound, ducking and visibility restoration for package music", async () => {
  player.configure(false);
  player.setMatchMusic(["blob:character"]); player.setBgmScene("match"); player.preloadMatch(); player.unlock();
  expect(Media.instances).toHaveLength(0);
  player.configure(true); await vi.runAllTimersAsync();
  player.duck(true);
  expect(find("blob:character").volume).toBeCloseTo(0.08);
  player.pauseBgm(); expect(find("blob:character").paused).toBe(true);
  player.restoreBgm(); await vi.runAllTimersAsync();
  expect(find("blob:character").volume).toBeCloseTo(0.08);
  player.duck(false); expect(find("blob:character").volume).toBeCloseTo(0.18);
});

it("applies the saved music level to lobby and package tracks, preserving ducking and pause/resume", async () => {
  player.setMusicVolume(.45); player.unlock(); await vi.runAllTimersAsync();
  const lobby = find(LOBBY_BGM_URL);
  expect(lobby.volume).toBeCloseTo(.45);
  const calls = lobby.play.mock.calls.length;
  player.setMusicVolume(.63); expect(lobby.volume).toBeCloseTo(.63);
  expect(lobby.play).toHaveBeenCalledTimes(calls);
  player.setMatchMusic(["blob:custom"]); player.setBgmScene("match"); await vi.runAllTimersAsync();
  const custom = find("blob:custom"); expect(custom.volume).toBeCloseTo(.63);
  player.duck(true); expect(custom.volume).toBeCloseTo(.28);
  player.setMusicVolume(.45); expect(custom.volume).toBeCloseTo(.2);
  player.pauseBgm(); player.restoreBgm(); await vi.runAllTimersAsync();
  expect(custom.volume).toBeCloseTo(.2);
  player.duck(false); expect(custom.volume).toBeCloseTo(.45);
  player.configure(false); player.setMusicVolume(.27); expect(custom.paused).toBe(true);
  player.configure(true); await vi.runAllTimersAsync(); expect(custom.volume).toBeCloseTo(.27);
});

it("scales both sides of an active crossfade immediately, including mute and unmute", async () => {
  player.unlock(); await vi.runAllTimersAsync();
  player.setBgmScene("match"); await vi.advanceTimersByTimeAsync(400);
  const lobby = find(LOBBY_BGM_URL), match = find(TABLE_BGM_URL);
  expect(lobby.volume).toBeCloseTo(.09); expect(match.volume).toBeCloseTo(.09);
  player.setMusicVolume(.6);
  expect(lobby.volume).toBeCloseTo(.3); expect(match.volume).toBeCloseTo(.3);
  player.setMusicVolume(0);
  expect(lobby.volume).toBe(0); expect(match.volume).toBe(0);
  await vi.advanceTimersByTimeAsync(80);
  expect(lobby.volume).toBe(0); expect(match.volume).toBe(0);
  player.setMusicVolume(1); await vi.runAllTimersAsync();
  expect(lobby.paused).toBe(true); expect(match.volume).toBe(1);
  for (const invalid of [-1, 2, NaN, Infinity]) player.setMusicVolume(invalid);
  expect(match.volume).toBe(1);
});

it("ignores stale errors and late playback after source replacement or disposal", async () => {
  player.setMatchMusic(["blob:old"]); player.setBgmScene("match"); player.preloadMatch();
  const old = find("blob:old");
  const oldError = old.onerror;
  let resolve!: () => void;
  old.play.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  player.unlock();
  player.setMatchMusic(["blob:new"]);
  oldError?.();
  old.paused = false; resolve();
  await vi.runAllTimersAsync();
  expect(old.paused).toBe(true);
  expect(find("blob:new").volume).toBeCloseTo(0.18);
  const current = find("blob:new");
  player.pauseBgm();
  current.play.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  player.restoreBgm(); player.dispose();
  current.paused = false; resolve();
  await vi.runAllTimersAsync();
  expect(current.paused).toBe(true);
  expect(current.onerror).toBeNull();
});
