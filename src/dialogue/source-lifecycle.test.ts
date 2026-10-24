import { afterEach, expect, it, vi } from "vitest";
import { createMatch } from "../core/match/reducer";
import type { DialogueSourceContext, MountedDialogueSource } from "../content/packages/plugin-contracts";
import { MemoryPresentationDriver, PresentationStore } from "../persistence/presentation";
import { DialogueEngine } from "./engine";
import { DialogueSession } from "./session";
import type { CharacterDialogue, DialogueEvent } from "./types";

const declaration: MountedDialogueSource["declaration"] = {
  apiVersion: 1, schema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false }, initial: { count: 0 }
};
const program: CharacterDialogue = {
  pools: { fallback: ["Ready"], action: ["Action"] }, fallbackPoolId: "fallback",
  rules: [{ id: "action", on: [{ type: "core.action", apiVersion: 1 }],
    when: { primitive: "core.event-action", apiVersion: 1, args: {}, test: { eq: "hit" } },
    poolId: "action", portrait: { image: "pending.png" } }]
};
const action = (id: string, choice = "stand"): DialogueEvent => ({ id, type: "core.action", apiVersion: 1, data: { actor: "player", action: choice } });
function fixture(imageAvailable?: (url: string) => Promise<boolean>) {
  const state = createMatch("source-lifetime"), driver = new MemoryPresentationDriver(), store = new PresentationStore(driver);
  const engine = new DialogueEngine(program, state.opponentId);
  const session = new DialogueSession(engine, state, store, imageAvailable);
  const interaction = { characterId: state.opponentId, image: { packageId: "example/character", path: "portrait.png" }, x: .5, y: .5 };
  return { state, driver, store, engine, session, interaction };
}
afterEach(() => vi.restoreAllMocks());

it("removes a revoked source and cancels its pending selection even when its disposer throws", async () => {
  let finish!: (available: boolean) => void, context!: DialogueSourceContext;
  const f = fixture(() => new Promise(resolve => finish = resolve));
  const controller = new AbortController(), error = new Error("source release failed");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failedRelease = vi.fn(() => { throw error; }), healthyRelease = vi.fn();
  const notify = vi.fn(), interact = vi.fn(), healthyNotify = vi.fn();
  await f.session.start([
    { packageId: "example/failing", declaration, signal: controller.signal, mount(c) {
      context = c; c.setPresentation({ count: 3 }); c.subscribeDialogueEvents(notify); c.subscribeCharacterInteraction(interact); return failedRelease;
    } },
    { packageId: "example/healthy", declaration, mount(c) { c.subscribeDialogueEvents(healthyNotify); return healthyRelease; } }
  ], false);
  const pending = f.session.deliver(action("pending", "hit"));
  const accept = vi.spyOn(f.engine, "accept"), commit = vi.spyOn(f.engine, "commit");
  controller.abort();
  expect(() => context.getPresentation()).toThrow("撤销");
  finish(true); await pending;
  expect(commit).not.toHaveBeenCalled();
  expect(f.session.peek().poolId).toBe("fallback");
  notify.mockClear(); healthyNotify.mockClear();
  await f.session.deliver(action("after-abort"));
  f.session.interact(f.interaction);
  expect(accept.mock.calls.at(-1)?.[2]).toEqual({ "example/healthy": { count: 0 } });
  expect(notify).not.toHaveBeenCalled(); expect(interact).not.toHaveBeenCalled();
  expect(healthyNotify).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("插件对白来源释放失败", { packageId: "example/failing", error });
  controller.abort(); await f.session.dispose(); await f.session.dispose();
  expect(failedRelease).toHaveBeenCalledTimes(1); expect(healthyRelease).toHaveBeenCalledTimes(1);
  // Revoking a source must not erase an active match's persisted presentation.
  expect(f.driver.records[f.store.key(f.state.id, "example/failing")]).toMatchObject({ apiVersion: 1, state: { count: 3 } });
});

it("continues disposing other sources and flushes finished matches after a release failure", async () => {
  const f = fixture(), error = new Error("source release failed");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const failedRelease = vi.fn(() => { throw error; }), healthyRelease = vi.fn(), flush = vi.spyOn(f.store, "flush");
  await f.session.start([
    { packageId: "example/failing", declaration, mount(c) { c.setPresentation({ count: 1 }); return failedRelease; } },
    { packageId: "example/healthy", declaration, mount(c) { c.setPresentation({ count: 2 }); return healthyRelease; } }
  ], false);
  f.session.transition({ ...f.state, status: "finished" });
  await f.session.dispose(); await f.session.dispose();
  expect(failedRelease).toHaveBeenCalledTimes(1); expect(healthyRelease).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalled(); expect(f.driver.records).toEqual({});
});

it("revokes the context and subscriptions of a source whose mount fails", async () => {
  const f = fixture(); let context!: DialogueSourceContext;
  const notify = vi.fn(), interact = vi.fn(), error = new Error("mount failed");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await f.session.start([{ packageId: "example/failing", declaration, mount(c) {
    context = c; c.subscribeDialogueEvents(notify); c.subscribeCharacterInteraction(interact); throw error;
  } }], false);
  expect(() => context.getMatch()).toThrow("撤销");
  expect(() => context.setPresentation({ count: 1 })).toThrow("撤销");
  const accept = vi.spyOn(f.engine, "accept");
  await f.session.deliver(action("after-mount-failure")); f.session.interact(f.interaction);
  expect(accept.mock.calls.at(-1)?.[2]).toEqual({});
  expect(notify).not.toHaveBeenCalled(); expect(interact).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith("插件对白来源不可用", { packageId: "example/failing", error });
  await f.session.dispose();
});

it("releases a disposer returned after synchronous source revocation during mount", async () => {
  const f = fixture(), controller = new AbortController(), notify = vi.fn(), release = vi.fn();
  await f.session.start([{ packageId: "example/revoked", declaration, signal: controller.signal, mount(c) {
    c.subscribeDialogueEvents(notify); controller.abort(); return release;
  } }], false);
  expect(release).toHaveBeenCalledTimes(1);
  const accept = vi.spyOn(f.engine, "accept");
  await f.session.deliver(action("after-mount-abort"));
  expect(accept.mock.calls.at(-1)?.[2]).toEqual({}); expect(notify).not.toHaveBeenCalled();
  await f.session.dispose(); expect(release).toHaveBeenCalledTimes(1);
});
