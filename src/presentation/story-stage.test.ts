import { describe, expect, it } from "vitest";
import type { StoryAction, StoryActorState } from "../core/story/types";
import { defaultStoryActor, StoryClock, StoryTimeline, storyAnimationFrame, validateStoryParallel, type StoryFrameScheduler, type StoryTimelineHost } from "./story-stage";

class ManualFrames implements StoryFrameScheduler {
  private next = 0;
  readonly callbacks = new Map<number, (time: number) => void>();
  request(callback: (time: number) => void): number { const id = ++this.next; this.callbacks.set(id, callback); return id; }
  cancel(id: number): void { this.callbacks.delete(id); }
  at(time: number): void {
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    callbacks.forEach(callback => callback(time));
  }
}

function stageHost(initial: StoryActorState = defaultStoryActor("guide")): { host: StoryTimelineHost; actor: () => StoryActorState } {
  let actor = initial;
  return { actor: () => actor, host: { getActor: id => id === actor.id ? actor : undefined, patchActor: (_, transform) => { actor = { ...actor, ...transform }; }, stage: () => {} } };
}

const move: StoryAction = { type: "animate", actor: "guide", durationMs: 1000, keyframes: [{ x: 20, opacity: 0.5 }, { x: 80, opacity: 1 }] };

describe("story logical clock", () => {
  it("excludes hidden time and resumes with a fresh baseline", () => {
    const frames = new ManualFrames(); const clock = new StoryClock(frames); const deltas: number[] = [];
    clock.subscribe(delta => deltas.push(delta));
    frames.at(10); frames.at(110);
    clock.setPaused("background", true); frames.at(100000);
    clock.setPaused("background", false); frames.at(100010); frames.at(100060);
    expect(deltas).toEqual([0, 100, 0, 50]); clock.dispose();
    expect(frames.callbacks.size).toBe(0);
  });
  it("applies speed changes to active animation and waits while retaining pause timing", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const timeline = new StoryTimeline(stage.host, frames);
    const pending = timeline.perform(move);
    frames.at(0); frames.at(200); expect(stage.actor().x).toBe(32);
    timeline.clock.setPlaybackRate(2); frames.at(400); expect(stage.actor().x).toBe(56);
    timeline.clock.setPaused("panel", true); frames.at(10000);
    expect(stage.actor().x).toBe(56);
    timeline.clock.setPaused("panel", false); frames.at(10000); frames.at(10200); await pending;
    expect(stage.actor().x).toBe(80);
    let done = false;
    const wait = timeline.delay(1000).then(() => { done = true; });
    frames.at(11000); frames.at(11200); await Promise.resolve(); expect(done).toBe(false);
    timeline.clock.setPlaybackRate(1); frames.at(11700); await Promise.resolve(); expect(done).toBe(false);
    frames.at(11800); await wait; expect(done).toBe(true); timeline.dispose();
  });
  it("retains independent pause leases", () => {
    const frames = new ManualFrames(); const clock = new StoryClock(frames);
    clock.subscribe(() => {}); clock.setPaused("background", true); clock.setPaused("log", true);
    clock.setPaused("background", false); expect(frames.callbacks.size).toBe(0);
    clock.setPaused("log", false); expect(frames.callbacks.size).toBe(1); clock.dispose();
  });
});

describe("story timelines", () => {
  it("presents final frames without ticking the clock, keeps audio playing and fast-forwards extensions", async () => {
    const frames = new ManualFrames(), stage = stageHost();
    const sounds: { action: StoryAction; skip: boolean }[] = [], extensions: { skip: boolean; restore?: boolean }[] = [];
    const timeline = new StoryTimeline({ ...stage.host,
      audio: (action, context) => {
        sounds.push({ action, skip: context.skip });
        if (action.wait) return new Promise(() => {});
      },
      extension: (_, context) => { extensions.push({ skip: context.skip, restore: context.restore }); }
    }, frames);
    const sound: StoryAction = { type: "audio", channel: "voice", operation: "play", src: "voice.ogg", wait: true, fadeMs: 60000 };
    const action: StoryAction = { type: "sequence", actions: [
      { type: "wait", durationMs: 60000 },
      { type: "parallel", actions: [
        { ...move, delayMs: 60000, durationMs: 60000 }, sound
      ] },
      { type: "extension", typeId: "demo:effect", apiVersion: 1, args: {} },
      { type: "wait", durationMs: 60000 }
    ] };
    await timeline.perform(action, { instant: true, restore: true });
    expect(stage.actor()).toMatchObject({ x: 80, opacity: 1 });
    expect(sounds).toEqual([{ action: { ...sound, wait: false, fadeMs: 0 }, skip: false }]);
    expect(extensions).toEqual([{ skip: true, restore: false }]);
    expect(frames.callbacks.size).toBe(0);
    expect(sound).toMatchObject({ wait: true, fadeMs: 60000 });
    // Instant presentation does not fast-forward the reading clock or mute normal audio.
    let done = false;
    const reading = timeline.delay(1000).then(() => { done = true; });
    frames.at(0); frames.at(500); await Promise.resolve(); expect(done).toBe(false);
    frames.at(1000); await reading;
    await timeline.perform(sound, { instant: true, skip: true });
    expect(sounds[1].skip).toBe(true); timeline.dispose();
  });

  it("interpolates sparse keyframes per property and retains their terminal values", () => {
    const actor = defaultStoryActor("guide");
    const keyframes = [{ offset: 0, x: 0 }, { offset: 0.5, opacity: 0.5 }, { offset: 1, x: 100 }];
    expect(storyAnimationFrame(actor, keyframes, 0.5)).toEqual({ x: 50, opacity: 0.5 });
    expect(storyAnimationFrame(actor, keyframes, 1)).toEqual({ x: 100, opacity: 0.5 });
  });
  it("fast-forwards active animations and every remaining wait to the deterministic final frame", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const timeline = new StoryTimeline(stage.host, frames);
    const pending = timeline.perform({ type: "sequence", actions: [move, { type: "wait", durationMs: 10000 }] });
    frames.at(0); frames.at(250); expect(stage.actor().x).toBe(35);
    timeline.setFastForward(true); await pending;
    expect(stage.actor()).toMatchObject({ x: 80, opacity: 1 }); expect(frames.callbacks.size).toBe(0); timeline.dispose();
  });
  it("restores an interrupted animation's starting state", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const initial = stage.actor(); const timeline = new StoryTimeline(stage.host, frames);
    const scope = new AbortController(); const pending = timeline.perform(move, { signal: scope.signal });
    frames.at(0); frames.at(500); expect(stage.actor().x).toBe(50);
    scope.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stage.actor()).toEqual(initial); expect(frames.callbacks.size).toBe(0); timeline.dispose();
  });
  it("allows independent parallel properties and rejects conflicting tracks before executing any", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const timeline = new StoryTimeline(stage.host, frames);
    const opacity: StoryAction = { type: "animate", actor: "guide", durationMs: 200, keyframes: [{ opacity: 0 }] };
    expect(() => validateStoryParallel({ type: "parallel", actions: [{ ...move, keyframes: [{ x: 10 }] }, opacity] })).not.toThrow();
    await expect(timeline.perform({ type: "parallel", actions: [move, opacity] })).rejects.toThrow("重复写入");
    expect(stage.actor()).toEqual(defaultStoryActor("guide")); timeline.dispose();
  });
  it("cancels sibling tracks on failure and cleans up their clock subscriptions", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const timeline = new StoryTimeline(stage.host, frames);
    const pending = timeline.perform({ type: "parallel", actions: [move, { type: "extension", typeId: "missing", apiVersion: 1, args: {} }] });
    await expect(pending).rejects.toThrow("表现扩展不可用");
    expect(stage.actor()).toEqual(defaultStoryActor("guide")); expect(frames.callbacks.size).toBe(0); timeline.dispose();
  });
  it("restores independent parallel properties without one cancellation restoring another track's partial state", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const timeline = new StoryTimeline(stage.host, frames);
    const scope = new AbortController();
    const pending = timeline.perform({ type: "parallel", actions: [
      { type: "animate", actor: "guide", durationMs: 1000, keyframes: [{ x: 0 }, { x: 100 }] },
      { type: "animate", actor: "guide", durationMs: 1000, keyframes: [{ opacity: 0 }, { opacity: 1 }] }
    ] }, { signal: scope.signal });
    frames.at(0); frames.at(250); expect(stage.actor()).toMatchObject({ x: 25, opacity: 0.25 });
    scope.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stage.actor()).toEqual(defaultStoryActor("guide")); timeline.dispose();
  });
  it("reduces motion while preserving intentional timing and delegates audio to the host", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const audio: string[] = [];
    const timeline = new StoryTimeline({ ...stage.host, reducedMotion: () => true, audio: action => { audio.push(action.channel); } }, frames);
    await timeline.perform(move); expect(stage.actor().x).toBe(80);
    let done = false;
    const pending = timeline.perform({ type: "wait", durationMs: 500 }).then(() => { done = true; });
    frames.at(0); frames.at(250); await Promise.resolve(); expect(done).toBe(false);
    frames.at(500); await pending;
    await timeline.perform({ type: "audio", channel: "sound", operation: "play", src: "effect.ogg" });
    expect(audio).toEqual(["sound"]); timeline.dispose();
  });
  it("rejects work after disposal, including waits without explicit abort signals", async () => {
    const frames = new ManualFrames(); const stage = stageHost(); const timeline = new StoryTimeline(stage.host, frames);
    const pending = timeline.delay(2000); timeline.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(timeline.perform(move)).rejects.toMatchObject({ name: "AbortError" });
    expect(frames.callbacks.size).toBe(0);
  });
});
