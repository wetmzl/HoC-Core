import { describe, expect, it, vi } from "vitest";
import { createPublicEvent, createPublicEventBatch } from "../core/events/public-events";
import { RuntimeEventHub } from "./public-event-hub";

const event = (id: string, type = "match.PLAYER_HIT", match = "match") => createPublicEvent({ id, type, scopes: { match }, data: { actor: "player" } });
const batch = (id: string, facts = [event(id)]) => createPublicEventBatch({ id, facts });

describe("runtime public event hub", () => {
  it("deduplicates per stage and includes fresh facts from overlapping retry batches", () => {
    const hub = new RuntimeEventHub(), calls: string[] = [];
    hub.subscribe("resolved", value => { calls.push(`resolved:${value.facts.map(fact => fact.id)}`); });
    hub.subscribe("committed", value => { calls.push(`committed:${value.facts.map(fact => fact.id)}`); });
    const first = batch("a");
    hub.publish("resolved", first); hub.publish("resolved", first); hub.publish("committed", first);
    hub.publish("committed", batch("ab", [event("a"), event("b")]));
    expect(calls).toEqual(["resolved:a", "committed:a", "committed:b"]);
    hub.publish("resolved", createPublicEventBatch({ id: "restore", facts: [event("old")], restored: true }));
    expect(calls).toHaveLength(3);
  });

  it("requires type and scope to match one event and delivers the entire selected atomic batch", () => {
    const hub = new RuntimeEventHub();
    const selected = vi.fn(), crossEvent = vi.fn();
    hub.subscribe("resolved", selected, { types: ["match.PLAYER_HIT"], scopes: { match: "a" } });
    hub.subscribe("resolved", crossEvent, { types: ["match.PLAYER_HIT"], scopes: { match: "b" } });
    const atomic = batch("atomic", [event("hit", "match.PLAYER_HIT", "a"), event("stand", "match.PLAYER_STOOD", "b")]);
    hub.publish("resolved", atomic);
    expect(selected.mock.calls[0][0]).toBe(atomic);
    expect(selected.mock.calls[0][0].facts).toHaveLength(2);
    expect(crossEvent).not.toHaveBeenCalled();
  });

  it("subscribes declaratively with explicit cancellation and no cross-instance observers", () => {
    const hub = new RuntimeEventHub(), other = new RuntimeEventHub(), called = vi.fn();
    const lifetime = new AbortController();
    hub.subscribeTrigger("resolved", { on: ["match.PLAYER_HIT"], scope: { name: "match", id: "match" } }, called, { signal: lifetime.signal });
    other.publish("resolved", batch("other"));
    hub.publish("resolved", batch("one"));
    lifetime.abort(); hub.publish("resolved", batch("two"));
    expect(called).toHaveBeenCalledTimes(1);
    expect(called.mock.calls[0][1].aborted).toBe(true);
    expect(hub.nextId("restored")).not.toBe(hub.nextId("restored"));
    hub.dispose(); hub.publish("resolved", batch("three"));
    expect(() => hub.nextId("ended")).toThrow();
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("finishes an atomic delivery before reentrant commands publish the next batch", () => {
    const hub = new RuntimeEventHub(() => {}), calls: string[] = [];
    hub.subscribe("resolved", value => {
      calls.push(`first:${value.id}`);
      if (value.id === "a") hub.publish("resolved", batch("b"));
    });
    hub.subscribe("resolved", () => { throw new Error("presentation failure"); });
    hub.subscribe("resolved", value => { calls.push(`second:${value.id}`); });
    hub.publish("resolved", batch("a"));
    expect(calls).toEqual(["first:a", "second:a", "first:b", "second:b"]);
  });
});
