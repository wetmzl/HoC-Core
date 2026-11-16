import { describe, expect, it, vi } from "vitest";
import type { PluginGameRuntimeContext, PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import { createDefaultSave } from "../persistence/boot";
import { RuntimeExtensions } from "./runtime-extensions";
import { bindPluginTutorialIdentity, type PluginTutorialApi } from "../content/packages/plugin-tutorials";
import { RuntimeEventHub } from "./public-event-hub";
import { createPublicEvent, createPublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import { createMatch } from "../core/match/reducer";

function extensions(contributions: readonly PluginRuntimeContribution[], createTutorialApi?: (packageId: string, signal: AbortSignal) => PluginTutorialApi,
  eventOptions?: { events: RuntimeEventHub; eventScopes: PublicEventScopes }) {
  return new RuntimeExtensions({
    ...eventOptions,
    context: {
      root: new EventTarget() as HTMLDivElement,
      audio: { setBgmScene() {} },
      resources: {} as never,
      getSave: () => createDefaultSave(),
      navigateToHistory: async () => {},
      navigateToExtension: async () => {}
    },
    contributions,
    createTutorialApi,
    getMatch: () => undefined,
    dispatch: vi.fn(),
    autoActionsChanged: vi.fn()
  });
}

it("provides package-lived event and declarative trigger subscriptions scoped to the owning game", async () => {
  const hub = new RuntimeEventHub();
  const lifetime = new AbortController();
  const supplied = new AbortController();
  let context!: PluginGameRuntimeContext;
  const contribution = bindPluginTutorialIdentity({ mountRuntime(current: PluginGameRuntimeContext) { context = current; } }, {
    packageId: "test/events", apiVersion: 9, signal: lifetime.signal
  });
  const runtime = extensions([contribution], undefined, { events: hub, eventScopes: { game: "own" } });
  await runtime.mount();
  const listener = vi.fn(), triggered = vi.fn(), cancelled = vi.fn();
  const api = context.game.events!;
  expect(api).toBeDefined();
  expect("publish" in api).toBe(false);
  api.subscribe("resolved", listener, { scopes: { game: "other" } });
  api.subscribe("resolved", cancelled, { signal: supplied.signal });
  api.subscribeTrigger("resolved", {
    on: ["core.screen-entered"],
    when: { type: "compare", left: { type: "query", query: { id: "event.data", key: "screen" } }, operator: "eq", right: { type: "literal", value: "match" } }
  }, triggered);
  const publish = (id: string, game: string, screen = "match") => hub.publish("resolved", createPublicEventBatch({ id, facts: [
    createPublicEvent({ id, type: "core.screen-entered", scopes: { game }, data: { screen } })
  ] }));
  publish("foreign", "other");
  expect(listener).not.toHaveBeenCalled();
  publish("own-first", "own");
  expect(listener).toHaveBeenCalledOnce();
  expect(triggered).toHaveBeenCalledOnce();
  expect(cancelled).toHaveBeenCalledOnce();
  supplied.abort();
  publish("own-lobby", "own", "lobby");
  expect(listener).toHaveBeenCalledTimes(2);
  expect(triggered).toHaveBeenCalledOnce();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(() => api.subscribeTrigger("resolved", { when: { type: "bad" } } as never, vi.fn())).toThrow();
  lifetime.abort();
  publish("after-package-unload", "own");
  expect(listener).toHaveBeenCalledTimes(2);
  api.subscribe("resolved", vi.fn());
  runtime.dispose();
  hub.dispose();
});

it("detaches and freezes gameplay context before exposing event batches to plugins", async () => {
  const hub = new RuntimeEventHub();
  let context!: PluginGameRuntimeContext;
  const runtime = extensions([{ mountRuntime(current) { context = current; } }], undefined, { events: hub, eventScopes: { game: "own" } });
  await runtime.mount();
  const match = createMatch("public-plugin-snapshot");
  const batch = createPublicEventBatch({ id: "visible", facts: [createPublicEvent({
    id: "visible", type: "core.screen-entered", scopes: { game: "own" }, data: { screen: "match" }
  })], context: { match } });
  const listener = vi.fn(received => {
    expect(received.context.match).not.toBe(match);
    expect(Object.isFrozen(received.context.match.player.hand.cards)).toBe(true);
    expect(Reflect.set(received.context.match.player, "busted", true)).toBe(false);
  });
  context.game.events!.subscribe("resolved", listener);
  hub.publish("resolved", batch);
  expect(listener).toHaveBeenCalledOnce();
  expect(match.player.busted).toBe(false);
  runtime.dispose();
  hub.dispose();
});

describe("RuntimeExtensions cleanup", () => {
  it("attempts every release once in reverse order and clears subscriptions even when releases throw", async () => {
    const order: string[] = [];
    const firstError = new Error("first cleanup failed");
    const lastError = new Error("last cleanup failed");
    const subscriber = vi.fn();
    let signal!: AbortSignal;
    let context!: PluginGameRuntimeContext;
    const runtime = extensions([
      { mountRuntime(current, currentSignal) {
        context = current;
        signal = currentSignal;
        context.game.subscribe(subscriber);
        context.game.pauseAutoActions();
        return () => { order.push("first"); throw firstError; };
      } },
      { mountRuntime: () => () => { order.push("middle"); } },
      { mountRuntime: () => () => { order.push("last"); throw lastError; } }
    ]);
    await runtime.mount();
    expect(runtime.paused).toBe(true);

    let failure: unknown;
    try { runtime.dispose(); } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([lastError, firstError]);
    expect(order).toEqual(["last", "middle", "first"]);
    expect(signal.aborted).toBe(true);
    expect(runtime.paused).toBe(false);
    runtime.notify();
    expect(subscriber).not.toHaveBeenCalled();
    context.game.pauseAutoActions();
    expect(runtime.paused).toBe(false);
    expect(() => runtime.dispose()).not.toThrow();
    expect(order).toEqual(["last", "middle", "first"]);
  });

  it("preserves the mount failure alongside cleanup failures and releases earlier plugins", async () => {
    const mountError = new Error("plugin mount failed");
    const cleanupError = new Error("plugin cleanup failed");
    const firstRelease = vi.fn();
    const failingRelease = vi.fn(() => { throw cleanupError; });
    const laterMount = vi.fn();
    const runtime = extensions([
      { mountRuntime: () => firstRelease },
      { mountRuntime: () => failingRelease },
      { mountRuntime: () => { throw mountError; } },
      { mountRuntime: laterMount }
    ]);

    const failure = await runtime.mount().catch(error => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBe(mountError);
    expect(failure.errors[1]).toBeInstanceOf(AggregateError);
    expect(failure.errors[1].errors).toEqual([cleanupError]);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(failingRelease).toHaveBeenCalledOnce();
    expect(laterMount).not.toHaveBeenCalled();
    runtime.dispose();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(failingRelease).toHaveBeenCalledOnce();
  });

  it("releases a late mount result after disposal without rerunning earlier releases", async () => {
    let finish!: (release: () => void) => void;
    const firstRelease = vi.fn();
    const lateRelease = vi.fn();
    const runtime = extensions([
      { mountRuntime: () => firstRelease },
      { mountRuntime: () => new Promise(resolve => { finish = resolve; }) }
    ]);
    const mounting = runtime.mount();
    await vi.waitFor(() => expect(finish).toBeDefined());
    runtime.dispose();
    finish(lateRelease);
    await mounting;
    runtime.dispose();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(lateRelease).toHaveBeenCalledOnce();
  });
});

it("provides separate package-scoped tutorial contexts only to loader-bound API 10 modules", async () => {
  const contexts: PluginGameRuntimeContext[] = [];
  const mount = (context: PluginGameRuntimeContext) => { contexts.push(context); };
  const identities: string[] = [];
  const signals: AbortSignal[] = [];
  const show = vi.fn();
  const runtime = extensions([
    bindPluginTutorialIdentity({ mountRuntime: mount }, { packageId: "one/guide", apiVersion: 10 }),
    bindPluginTutorialIdentity({ mountRuntime: mount }, { packageId: "two/guide", apiVersion: 10 }),
    bindPluginTutorialIdentity({ mountRuntime: mount }, { packageId: "old/guide", apiVersion: 9 }),
    { mountRuntime: mount, packageId: "forged/guide", apiVersion: 10 } as PluginRuntimeContribution
  ], (packageId, signal) => {
    identities.push(packageId); signals.push(signal);
    return { show: definition => { show(packageId, definition.id); return () => {}; }, isCompleted: () => false };
  });
  await runtime.mount();
  expect(identities).toEqual(["one/guide", "two/guide"]);
  expect(new Set(contexts).size).toBe(4);
  expect(contexts[0].tutorials).not.toBe(contexts[1].tutorials);
  expect("tutorials" in contexts[2]).toBe(false);
  expect("tutorials" in contexts[3]).toBe(false);
  const tutorial = { id: "intro", title: "Guide", pages: [{ body: "Explanation" }] } as const;
  contexts[0].tutorials!.show(tutorial);
  contexts[1].tutorials!.show(tutorial);
  expect(show.mock.calls).toEqual([["one/guide", "intro"], ["two/guide", "intro"]]);
  runtime.dispose();
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

it("shares host modal and plugin auto-action pauses and releases each token once", async () => {
  let context!: PluginGameRuntimeContext;
  const runtime = extensions([{ mountRuntime: current => { context = current; } }]);
  await runtime.mount();
  const hostRelease = runtime.pauseAutoActions();
  const pluginRelease = context.game.pauseAutoActions();
  expect(runtime.paused).toBe(true);
  hostRelease(); hostRelease();
  expect(runtime.paused).toBe(true);
  pluginRelease();
  expect(runtime.paused).toBe(false);
  runtime.dispose();
  runtime.pauseAutoActions();
  expect(runtime.paused).toBe(false);
});

it("exposes music only to API 13 modules and cancels subscriptions on module or runtime disposal", async () => {
  const contexts: PluginGameRuntimeContext[] = [];
  const module = new AbortController();
  const runtime = extensions([
    bindPluginTutorialIdentity({ mountRuntime: context => { contexts.push(context); } }, { packageId: "example/music", apiVersion: 13, signal: module.signal }),
    bindPluginTutorialIdentity({ mountRuntime: context => { contexts.push(context); } }, { packageId: "example/old", apiVersion: 12 }),
    { mountRuntime: context => { contexts.push(context); } }
  ]);
  await runtime.mount();
  expect(contexts[0].music).toBeDefined(); expect(contexts[1].music).toBeUndefined(); expect(contexts[2].music).toBeUndefined();
  const listener = vi.fn(); contexts[0].music!.subscribeContext(listener); expect(listener).toHaveBeenCalledOnce();
  module.abort(); contexts[0].music!.subscribeContext(listener); expect(listener).toHaveBeenCalledOnce();
  runtime.dispose();
});
