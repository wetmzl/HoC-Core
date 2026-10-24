import { afterEach, describe, expect, it, vi } from "vitest";
import { SoundPlayer } from "./sound-player";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("short sound lifecycle", () => {
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
