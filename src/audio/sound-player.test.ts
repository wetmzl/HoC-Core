import { afterEach, describe, expect, it, vi } from "vitest";
import { SoundPlayer } from "./sound-player";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("short sound lifecycle", () => {
  it("cancels pending achievement decoding on stop or mute, then permits a new notification", async () => {
    const pending: ((value: AudioBuffer) => void)[] = [];
    const sources: Source[] = [];
    class Source extends EventTarget {
      buffer?: AudioBuffer;
      readonly connect = vi.fn();
      readonly disconnect = vi.fn();
      readonly start = vi.fn();
      readonly stop = vi.fn(() => this.dispatchEvent(new Event("ended")));
    }
    class Context {
      state = "running";
      destination = {};
      currentTime = 0;
      createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createBufferSource() { const source = new Source(); sources.push(source); return source; }
      decodeAudioData(bytes: ArrayBuffer) {
        return new Uint8Array(bytes)[0] === 9
          ? new Promise<AudioBuffer>(resolve => pending.push(resolve)) : Promise.resolve({} as AudioBuffer);
      }
      close = vi.fn(async () => { this.state = "closed"; });
    }
    vi.stubGlobal("window", { AudioContext: Context });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array([url.includes("achievement-unlock") ? 9 : 1]))));
    const player = new SoundPlayer();
    player.unlock();
    player.play("achievementUnlock");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    player.stop("achievementUnlock");
    pending.shift()!({} as AudioBuffer);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sources).toHaveLength(0);
    player.play("achievementUnlock");
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0].start).toHaveBeenCalledOnce();
    player.configure(false);
    expect(sources[0].stop).toHaveBeenCalledOnce();
    player.configure(true);
    expect(sources).toHaveLength(1);
    player.play("achievementUnlock");
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await player.dispose();
    expect(sources[1].stop).toHaveBeenCalledOnce();
  });

  it("does not start a pending achievement buffer after muting and re-enabling", async () => {
    let release!: (value: AudioBuffer) => void;
    const start = vi.fn();
    class Context {
      state = "running";
      destination = {};
      currentTime = 0;
      createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }; }
      createBufferSource() { return { start, connect: vi.fn(), disconnect: vi.fn(), addEventListener: vi.fn() }; }
      decodeAudioData(bytes: ArrayBuffer) {
        return new Uint8Array(bytes)[0] === 9
          ? new Promise<AudioBuffer>(resolve => { release = resolve; }) : Promise.resolve({} as AudioBuffer);
      }
      close = vi.fn(async () => { this.state = "closed"; });
    }
    vi.stubGlobal("window", { AudioContext: Context });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array([url.includes("achievement-unlock") ? 9 : 1]))));
    const player = new SoundPlayer();
    player.unlock();
    player.play("achievementUnlock");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    player.configure(false);
    player.configure(true);
    release({} as AudioBuffer);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    await player.dispose();
  });

  it("ignores decoding from a disposed context after sound is unlocked again", async () => {
    const contexts: FakeContext[] = [];
    class FakeContext {
      state = "running";
      destination = {};
      currentTime = 0;
      readonly createBufferSource = vi.fn();
      readonly createGain = () => ({ connect: vi.fn(), gain: { value: 1 } });
      readonly close = vi.fn(async () => { this.state = "closed"; });
      readonly pending: ((buffer: AudioBuffer) => void)[] = [];
      decodeAudioData() { return new Promise<AudioBuffer>(resolve => this.pending.push(resolve)); }
      constructor() { contexts.push(this); }
    }
    vi.stubGlobal("window", { AudioContext: FakeContext });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]))));
    const player = new SoundPlayer();
    player.unlock();
    player.play("compare");
    await vi.waitFor(() => expect(contexts[0].pending.length).toBe(2));
    await player.dispose();
    player.unlock();
    contexts[0].pending.forEach(resolve => resolve({} as AudioBuffer));
    await Promise.resolve();
    await Promise.resolve();
    expect(contexts[0].createBufferSource).not.toHaveBeenCalled();
    await player.dispose();
  });
  it("cancels delayed fallback cues and stops active voices on disposal", async () => {
    vi.useFakeTimers();
    const voices: FakeAudio[] = [];
    class FakeAudio {
      play = vi.fn(async () => undefined);
      pause = vi.fn();
      constructor() { voices.push(this); }
    }
    vi.stubGlobal("window", { setTimeout });
    vi.stubGlobal("Audio", FakeAudio);
    const player = new SoundPlayer();
    player.unlock();
    player.play("cardFlip");
    player.play("bust", 160);
    await player.dispose();
    player.unlock();
    vi.runAllTimers();
    expect(voices[0].play).toHaveBeenCalledOnce();
    expect(voices[0].pause).toHaveBeenCalledOnce();
    expect(voices[1].play).not.toHaveBeenCalled();
  });
});
