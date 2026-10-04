import { afterEach, describe, expect, it, vi } from "vitest";
import { LOBBY_BGM_URL, TABLE_BGM_URL } from "../resources/cache-policy";
import { GameAudio, SOUND_SOURCES } from "./game-audio";

class RecordingAudioElement {
  static readonly instances: RecordingAudioElement[] = [];
  readonly load = vi.fn();
  readonly play = vi.fn(async () => { this.paused = false; });
  readonly pause = vi.fn(() => { this.paused = true; });
  readonly src: string;
  loop = false;
  preload = "";
  volume = 1;
  paused = true;
  currentTime = 0;

  constructor(src: string) {
    this.src = src;
    RecordingAudioElement.instances.push(this);
  }
}

afterEach(() => {
  RecordingAudioElement.instances.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("staged game audio loading", () => {
  it("keeps skill cues independently routed while they temporarily reuse Stand", () => {
    expect(SOUND_SOURCES.skillDraw).toBe(SOUND_SOURCES.stand);
    expect(SOUND_SOURCES.skillUse).toBe(SOUND_SOURCES.stand);
  });

  it("loads lobby music without effect requests, then preloads table music", () => {
    vi.useFakeTimers();
    const requestFetch = vi.fn(async (_input: RequestInfo | URL) => new Response("sound", { status: 200 }));
    vi.stubGlobal("fetch", requestFetch);
    vi.stubGlobal("Audio", RecordingAudioElement);

    new GameAudio().preloadLobby();

    expect(requestFetch).not.toHaveBeenCalled();
    expect(RecordingAudioElement.instances).toHaveLength(1);
    expect(RecordingAudioElement.instances[0]).toMatchObject({
      src: LOBBY_BGM_URL,
      preload: "auto",
      loop: true
    });
    expect(RecordingAudioElement.instances[0]?.load).toHaveBeenCalledOnce();

    vi.runOnlyPendingTimers();

    expect(RecordingAudioElement.instances).toHaveLength(2);
    expect(RecordingAudioElement.instances[1]).toMatchObject({
      src: TABLE_BGM_URL,
      preload: "auto",
      loop: true
    });
    expect(RecordingAudioElement.instances[1]?.load).toHaveBeenCalledOnce();
  });

  it("preloads every configured sound at the match stage", async () => {
    const requestFetch = vi.fn(async (_input: RequestInfo | URL) => new Response("sound", { status: 200 }));
    vi.stubGlobal("fetch", requestFetch);
    vi.stubGlobal("Audio", RecordingAudioElement);

    new GameAudio().preloadMatch();

    await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledTimes(Object.keys(SOUND_SOURCES).length));
    const soundUrls = new Set<string>(Object.values(SOUND_SOURCES));
    expect(requestFetch.mock.calls.every(([url]) => soundUrls.has(String(url)))).toBe(true);
    expect(requestFetch.mock.calls.some(([url]) => String(url) === TABLE_BGM_URL)).toBe(false);
    expect(RecordingAudioElement.instances).toHaveLength(1);
    expect(RecordingAudioElement.instances[0]).toMatchObject({ src: TABLE_BGM_URL, preload: "auto" });
  });

  it("does not preload audio while sound is disabled", () => {
    const requestFetch = vi.fn();
    vi.stubGlobal("fetch", requestFetch);
    vi.stubGlobal("Audio", RecordingAudioElement);
    const audio = new GameAudio();
    audio.configure(false);

    audio.preloadLobby();
    audio.preloadMatch();

    expect(RecordingAudioElement.instances).toHaveLength(0);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("crossfades between lobby and match music", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", RecordingAudioElement);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { hidden: false });
    const audio = new GameAudio();

    audio.unlock();
    await vi.runAllTimersAsync();
    const lobby = RecordingAudioElement.instances.find((candidate) => candidate.src === LOBBY_BGM_URL)!;
    expect(lobby.paused).toBe(false);
    expect(lobby.volume).toBeCloseTo(0.18);

    audio.setBgmScene("match");
    await vi.advanceTimersByTimeAsync(400);
    const match = RecordingAudioElement.instances.find((candidate) => candidate.src === TABLE_BGM_URL)!;
    expect(lobby.paused).toBe(false);
    expect(lobby.volume).toBeGreaterThan(0);
    expect(lobby.volume).toBeLessThan(0.18);
    expect(match.paused).toBe(false);
    expect(match.volume).toBeGreaterThan(0);
    expect(match.volume).toBeLessThan(0.18);

    await vi.runAllTimersAsync();
    expect(lobby.paused).toBe(true);
    expect(lobby.volume).toBe(0);
    expect(match.paused).toBe(false);
    expect(match.volume).toBeCloseTo(0.18);

    audio.setBgmScene("lobby");
    await vi.runAllTimersAsync();
    expect(match.paused).toBe(true);
    expect(match.volume).toBe(0);
    expect(lobby.paused).toBe(false);
    expect(lobby.volume).toBeCloseTo(0.18);
  });
});
