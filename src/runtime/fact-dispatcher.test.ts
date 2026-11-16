import { describe, expect, it, vi } from "vitest";
import { FactDispatcher } from "./fact-dispatcher";

const batch = (type: string) => Object.freeze({ facts: Object.freeze([Object.freeze({ type })]) });

describe("runtime fact routing", () => {
  it("keeps stages separate and filters whole batches in subscription order", () => {
    const dispatcher = new FactDispatcher<ReturnType<typeof batch>>();
    const calls: string[] = [];
    const first = batch("draw");
    dispatcher.subscribe("resolved", value => { expect(value).toBe(first); calls.push("resolved"); });
    dispatcher.subscribe("committed", () => { calls.push("saved"); });
    dispatcher.subscribe("resolved", () => { calls.push("filtered"); }, { types: ["finish"] });
    dispatcher.publish("resolved", first);
    expect(calls).toEqual(["resolved"]);
    dispatcher.publish("committed", first);
    expect(calls).toEqual(["resolved", "saved"]);
  });

  it("isolates synchronous and asynchronous failures, including broken diagnostics", async () => {
    const errors = vi.fn();
    const dispatcher = new FactDispatcher<ReturnType<typeof batch>>(errors);
    const last = vi.fn();
    dispatcher.subscribe("resolved", () => { throw new Error("sync"); });
    dispatcher.subscribe("resolved", async () => { throw new Error("async"); });
    dispatcher.subscribe("resolved", last);
    dispatcher.publish("resolved", batch("draw"));
    await Promise.resolve();
    expect(last).toHaveBeenCalledOnce();
    expect(errors.mock.calls.map(([error]) => error.message)).toEqual(["sync", "async"]);
    errors.mockImplementation(() => { throw new Error("diagnostic"); });
    expect(() => dispatcher.publish("resolved", batch("draw"))).not.toThrow();
    await Promise.resolve();
  });

  it("queues reentrant deliveries until every observer has seen the previous batch", () => {
    const dispatcher = new FactDispatcher<ReturnType<typeof batch>>();
    const calls: string[] = [];
    dispatcher.subscribe("resolved", value => {
      calls.push(`first:${value.facts[0].type}`);
      if (value.facts[0].type === "draw") dispatcher.publish("resolved", batch("finish"));
    });
    dispatcher.subscribe("resolved", value => { calls.push(`second:${value.facts[0].type}`); });
    dispatcher.publish("resolved", batch("draw"));
    expect(calls).toEqual(["first:draw", "second:draw", "first:finish", "second:finish"]);
  });

  it("cancels pending work and removes listeners on release, external abort and disposal", () => {
    const dispatcher = new FactDispatcher<ReturnType<typeof batch>>();
    const lifetime = new AbortController();
    let received: AbortSignal | undefined;
    const observer = vi.fn((_batch, signal: AbortSignal) => { received = signal; });
    const release = dispatcher.subscribe("resolved", observer, { signal: lifetime.signal });
    dispatcher.publish("resolved", batch("draw"));
    lifetime.abort();
    expect(received?.aborted).toBe(true);
    release();
    dispatcher.publish("resolved", batch("finish"));
    expect(observer).toHaveBeenCalledOnce();
    const late = vi.fn();
    dispatcher.subscribe("resolved", late);
    dispatcher.dispose();
    dispatcher.subscribe("resolved", late);
    dispatcher.publish("resolved", batch("draw"));
    expect(late).not.toHaveBeenCalled();
  });
});
