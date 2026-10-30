import { afterEach, expect, it, vi } from "vitest";
import { createMatch } from "../core/match/reducer";
import { DialogueEngine } from "./engine";
import { DialogueSession } from "./session";
import { DialogueEventRegistry, installDialogueEvents, clearDialogueEvents } from "./events";
import { DialoguePrimitiveRegistry } from "./registry";
import { MemoryPresentationDriver, PresentationStore } from "../persistence/presentation";
import type { CharacterDialogue, DialogueAtom, DialogueEvent, DialoguePrimitive } from "./types";
import type { CharacterInteraction, DialogueSourceContext, MountedDialogueSource } from "../content/packages/plugin-contracts";
// @ts-expect-error The separately loaded package is intentionally plain JavaScript.
import { register } from "../../public/characters/character-tap/module.js";
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync("public/characters/character-tap/resources.json", "utf8"));
const pkg = "hoc-core/character-tap";
const atom = (primitive: string, test: DialogueAtom["test"]): DialogueAtom => ({ primitive, apiVersion: 1, args: {}, test });
const tapEvent = (id: string): DialogueEvent => ({ id, type: `${pkg}#tap`, apiVersion: 1, data: { actor: "opponent", x: .5, y: .5, region: null } });
const program: CharacterDialogue = { pools: { fallback: ["基础"], tap: ["点击"], action: ["行动"], bad: ["坏图"] }, fallbackPoolId: "fallback", rules: [
  { id: "tap", on: [{ type: `${pkg}#tap`, apiVersion: 1 }], when: atom(`${pkg}#total-count`, { range: { min: 1 } }), poolId: "tap" },
  { id: "action", on: [{ type: "core.action", apiVersion: 1 }], when: atom("core.event-action", { eq: "hit" }), poolId: "action" }
] };
const input: CharacterInteraction = { characterId: "chatgpt", image: { packageId: "hoc-core/chatgpt", path: "relaxed.png" }, x: .5, y: .5 };
function fixture(attachments: unknown[] = []) {
  const events = new DialogueEventRegistry(); events.registerPackage(pkg, payload.dialogueEvents); installDialogueEvents(events);
  const registration = register(), registry = new DialoguePrimitiveRegistry(); registry.registerPackage(pkg, payload.dialoguePrimitives, registration.dialoguePrimitives);
  registration.createRuntime({ "plugin.character-tap": attachments });
  const source: MountedDialogueSource = { packageId: pkg, declaration: payload.presentationState, mount: registration.mountDialogueSource };
  const state = createMatch("tap-session"), driver = new MemoryPresentationDriver(), store = new PresentationStore(driver);
  return { events, registry, source, state, driver, store };
}
afterEach(() => { clearDialogueEvents(); vi.restoreAllMocks(); });
it("shows thinking after ordinary dialogue without resampling, but preserves skill and interaction portraits", async () => {
  const f = fixture(), selected = vi.fn(), changed = vi.fn();
  const state = { ...f.state, round: { ...f.state.round, phase: "turns" as const, currentActor: "opponent" as const } };
  // A shared rule proves priority follows the actual selecting event, not its on-list.
  const rules = [{ id: "shared", on: ["core.action", "core.ability-played", `${pkg}#tap`].map(type => ({ type, apiVersion: 1 })),
    when: atom("core.phase", { eq: "turns" }), poolId: "action", portrait: { image: "gesture.png" } }];
  const session = new DialogueSession(new DialogueEngine({ ...program, rules }, "chatgpt", f.registry), state, f.store, undefined, changed, selected);
  await session.start([], false);
  const action = (id: string): DialogueEvent => ({ id, type: "core.action", apiVersion: 1, data: { actor: "player", action: "stand" } });
  await session.deliver(action("stand"));
  const selection = session.peek(), before = selected.mock.calls.length;
  expect(session.beginThinking()).toBe(true);
  expect(session.isThinking).toBe(true);
  expect(session.peek()).toBe(selection);
  expect(selected).toHaveBeenCalledTimes(before);
  const renders = changed.mock.calls.length;
  session.beginThinking(); session.transition(state);
  expect(changed).toHaveBeenCalledTimes(renders);
  expect(session.isThinking).toBe(true);
  await session.deliver({ id: "ability", type: "core.ability-played", apiVersion: 1, data: { actor: "player", definitionId: "test", instanceId: "test" } });
  expect(session.isThinking).toBe(false);
  expect(session.beginThinking()).toBe(false);
  await session.deliver({ id: "unmatched", type: "core.round-start", apiVersion: 1, data: { roundIndex: 0 } });
  expect(session.beginThinking()).toBe(false);
  await session.deliver(tapEvent("tap"));
  expect(session.beginThinking()).toBe(false);
  await session.deliver(action("next-action"));
  expect(session.beginThinking()).toBe(true);
  session.transition({ ...state, round: { ...state.round, phase: "roulette-trigger" } });
  expect(session.isThinking).toBe(false);
  expect(session.beginThinking()).toBe(false);
  await session.dispose();
  expect(session.beginThinking()).toBe(false);
});
it("restores the ordinary-event thinking window and keeps it until the next portrait is committed", async () => {
  const f = fixture();
  const state = { ...f.state, history: [...f.state.history, { type: "PLAYER_HIT" as const, value: 12 }], round: { ...f.state.round, phase: "turns" as const, currentActor: "opponent" as const } };
  let finish: ((available: boolean) => void) | undefined;
  const rules = [{ ...program.rules[1], portrait: { image: "action.png" } },
    { id: "result", on: [{ type: "core.round-result", apiVersion: 1 }], when: atom("core.phase", { eq: "round-reveal" }), poolId: "bad", portrait: { image: "result.png" } }];
  const session = new DialogueSession(new DialogueEngine({ ...program, rules }, "chatgpt", f.registry), state, f.store, () => finish ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(true));
  await session.start([], true);
  await vi.waitFor(() => expect(session.peek().poolId).toBe("action"));
  expect(session.beginThinking()).toBe(true);
  finish = () => {};
  const pending = session.deliver({ id: "next", type: "core.action", apiVersion: 1, data: { actor: "opponent", action: "hit" } });
  expect(session.isThinking).toBe(true);
  finish!(true); await pending;
  expect(session.isThinking).toBe(false);
  expect(session.beginThinking()).toBe(true);
  const outcome = { winner: "opponent" as const, reason: "comparison" as const, penaltyTarget: "player" as const, bulletsAdded: 1 };
  session.transition({ ...state, history: [...state.history, { type: "ROUND_RESOLVED", outcome }], round: { ...state.round, phase: "round-reveal", currentActor: null, outcome } });
  expect(session.isThinking).toBe(true);
  finish!(true);
  await vi.waitFor(() => expect(session.peek().poolId).toBe("bad"));
  expect(session.isThinking).toBe(false);
  await session.dispose();
});
it("presents only committed changed selections, marks restore, and cancels on leaving", async () => {
  const f = fixture(), selected = vi.fn();
  const session = new DialogueSession(new DialogueEngine(program, "chatgpt", f.registry), f.state, f.store, undefined, undefined, selected);
  await session.start([f.source], true);
  expect(selected).toHaveBeenCalledTimes(1);
  expect(selected.mock.calls[0][0].poolId).toBe("fallback");
  expect(selected.mock.calls[0][1]).toBe(true);
  session.peek(); session.peek();
  expect(selected).toHaveBeenCalledTimes(1);
  session.interact(input);
  expect(selected).toHaveBeenCalledTimes(2);
  expect(selected.mock.calls[1][0]).toMatchObject({ poolId: "tap", line: "点击" });
  expect(selected.mock.calls[1][1]).toBe(false);
  const signal = selected.mock.calls[1][2] as AbortSignal;
  expect(signal.aborted).toBe(false);
  session.transition({ ...f.state, history: [...f.state.history, { type: "PLAYER_STOOD" as const }] });
  expect(selected).toHaveBeenCalledTimes(2);
  session.interact(input);
  expect(selected).toHaveBeenCalledTimes(3);
  expect(selected.mock.calls[2][0].key).not.toBe(selected.mock.calls[1][0].key);
  await session.dispose();
  expect(signal.aborted).toBe(true);
});

it("does not present a portrait selection superseded while its image is loading", async () => {
  const f = fixture(), selected = vi.fn(); let finish!: (available: boolean) => void;
  const rules = [{ ...program.rules[0], portrait: { image: "slow.png" } }, program.rules[1]];
  const session = new DialogueSession(new DialogueEngine({ ...program, rules }, "chatgpt", f.registry), f.state, f.store, () => new Promise(resolve => finish = resolve), undefined, selected);
  await session.start([f.source], false);
  session.interact(input);
  expect(selected).toHaveBeenCalledTimes(1);
  session.transition({ ...f.state, history: [...f.state.history, { type: "PLAYER_HIT" as const, value: 12 }] });
  expect(selected.mock.calls.at(-1)![0].poolId).toBe("action");
  finish(true); await Promise.resolve(); await Promise.resolve();
  expect(selected).toHaveBeenCalledTimes(2);
  await session.dispose();
});
it.each(["dealing", "initial-blackjack-check", "turns", "settlement", "round-reveal", "roulette-reaction", "roulette-trigger", "roulette-result", "round-end"] as const)("delivers role-owned tap responses during the %s table phase", async phase => {
  const f = fixture(), state = { ...f.state, round: { ...f.state.round, phase } };
  const session = new DialogueSession(new DialogueEngine(program, "chatgpt", f.registry), state, f.store);
  await session.start([f.source], false);
  session.interact(input);
  expect(session.peek().line).toBe("点击");
  expect(f.store.get(state.id, pkg, f.source.declaration)).toMatchObject({ totalCount: 1 });
  await session.dispose();
});
it.each(["opponent-killed", "player-killed"] as const)("keeps tap identities and counts through %s until leaving the session", async reason => {
  const f = fixture(), session = new DialogueSession(new DialogueEngine(program, "chatgpt", f.registry), f.state, f.store);
  await session.start([f.source], false);
  session.interact(input);
  const firstKey = session.peek().key;
  const finished = { ...f.state, status: "finished" as const, outcome: { winner: reason === "opponent-killed" ? "player" as const : "opponent" as const, reason }, round: { ...f.state.round, phase: "roulette-result" as const } };
  session.transition(finished);
  session.interact(input);
  expect(session.peek().key).not.toBe(firstKey);
  const secondKey = session.peek().key;
  session.interact(input);
  expect(session.peek().key).not.toBe(secondKey);
  expect(f.store.get(f.state.id, pkg, f.source.declaration)).toMatchObject({ totalCount: 3 });
  session.transition({ ...finished, view: "match-summary" });
  session.interact(input);
  session.transition({ ...finished, scene: "lobby" });
  session.interact(input);
  expect(f.store.get(f.state.id, pkg, f.source.declaration)).toMatchObject({ totalCount: 3 });
  await session.dispose();
  session.interact(input);
  expect(f.driver.records).toEqual({});
});
it("counts missed taps, clears streak on every normal event and restores only normal dialogue", async () => {
  const f = fixture(), engine = new DialogueEngine(program, "chatgpt", f.registry), session = new DialogueSession(engine, f.state, f.store);
  await session.start([f.source], false); expect(session.peek().line).toBe("基础");
  session.interact(input); expect(session.peek().line).toBe("点击");
  session.interact({ ...input, x: null, y: null });
  expect(f.store.get(f.state.id, pkg, f.source.declaration)).toMatchObject({ roundCount: 2, consecutiveCount: 2, totalCount: 2 });
  const miss = { ...f.state, history: [...f.state.history, { type: "PLAYER_STOOD" as const }] };
  session.transition(miss); expect(session.peek().line).toBe("点击");
  expect(f.store.get(f.state.id, pkg, f.source.declaration)).toMatchObject({ consecutiveCount: 0, roundCount: 2 });
  session.interact(input);
  const next = { ...miss, roundIndex: 1, round: { ...miss.round, index: 1 }, history: [...miss.history, { type: "ROUND_STARTED" as const, roundIndex: 1 }] };
  session.transition(next); expect(f.store.get(f.state.id, pkg, f.source.declaration)).toMatchObject({ roundCount: 0, consecutiveCount: 0, totalCount: 3 });
  session.interact(input); const current = session.peek(); await session.dispose();
  const restored = new DialogueSession(new DialogueEngine(program, "chatgpt", f.registry), next, new PresentationStore(f.driver));
  await restored.start([f.source], true); expect(restored.peek().line).toBe("基础");
  expect(f.driver.records).toBeDefined(); expect(f.store.get(next.id, pkg, f.source.declaration)).toMatchObject({ roundCount: 1, totalCount: 4 });
  restored.interact(input); expect(restored.peek().key).not.toBe(current.key);
  expect(restored.store.get(next.id, pkg, f.source.declaration)).toMatchObject({ roundCount: 2, consecutiveCount: 1, totalCount: 5 });
  await restored.dispose();
});
it("keeps cached event queries on image failure and discards late image completions", async () => {
  const f = fixture(), read = vi.fn(() => 1);
  const p: DialoguePrimitive = { id: "value", apiVersion: 1, title: "中性", description: "中性验证", returnType: "number", dependencies: ["event"], parameters: { type: "object", additionalProperties: false }, read };
  f.registry.registerPackage("test/neutral", [p], [p]);
  const rules = [
    { id: "bad", on: [{ type: `${pkg}#tap`, apiVersion: 1 }], when: atom("test/neutral#value", { eq: 1 }), poolId: "bad", portrait: { image: "bad.png" } },
    { ...program.rules[0], when: atom("test/neutral#value", { eq: 1 }) }, program.rules[1]
  ];
  let finish!: (available: boolean) => void;
  const available = vi.fn(() => new Promise<boolean>(resolve => finish = resolve));
  const session = new DialogueSession(new DialogueEngine({ ...program, rules }, "chatgpt", f.registry), f.state, f.store, available);
  await session.start([], false);
  const first = session.deliver(tapEvent("one")); expect(session.peek().line).toBe("基础"); expect(read).toHaveBeenCalledTimes(1);
  finish(false); await first; expect(session.peek().line).toBe("点击"); expect(read).toHaveBeenCalledTimes(1);
  const other = new DialogueSession(new DialogueEngine({ ...program, rules }, "chatgpt", f.registry), f.state, f.store, available);
  await other.start([], false); const pending = other.deliver(tapEvent("two"));
  const hit = { ...f.state, history: [...f.state.history, { type: "PLAYER_HIT" as const, value: 12 }] }; other.transition(hit);
  expect(other.peek().line).toBe("行动"); finish(true); await pending; expect(other.peek().line).toBe("行动");
  await session.dispose(); await other.dispose();
});
it("rejects reentrant, undeclared and late publication and removes source subscriptions", async () => {
  const f = fixture(); let context!: DialogueSourceContext;
  const signal = new AbortController(); const notify = vi.fn();
  const source: MountedDialogueSource = { ...f.source, signal: signal.signal, mount(c) { context = c; c.subscribeDialogueEvents(notify); c.subscribeCharacterInteraction(() => c.publish("tap", 1, { actor: "opponent", x: null, y: null, region: null })); } };
  const engine = new DialogueEngine(program, "chatgpt", f.registry), session = new DialogueSession(engine, f.state, f.store);
  await session.start([source], false);
  expect(() => context.publish("other", 1, {})).toThrow("未声明"); expect(() => context.publish("tap", 1, { x: "bad" })).toThrow();
  f.registry.evaluating++; expect(() => context.publish("tap", 1, {})).toThrow("重入"); f.registry.evaluating--;
  session.interact(input); expect(notify).toHaveBeenCalledTimes(2);
  signal.abort(); expect(() => context.publish("tap", 1, {})).toThrow("撤销");
  await session.deliver({ id: "after-unload", type: "core.action", apiVersion: 1, data: { actor: "player", action: "hit" } });
  session.interact(input); expect(notify).toHaveBeenCalledTimes(2);
  await session.dispose();
});
it("without the plugin an optional tap rule cannot block fallback or a normal action", async () => {
  const f = fixture(), session = new DialogueSession(new DialogueEngine(program, "chatgpt"), f.state, f.store);
  await session.start([], true); expect(session.peek().line).toBe("基础");
  session.transition({ ...f.state, history: [...f.state.history, { type: "PLAYER_HIT" as const, value: 12 }] }); expect(session.peek().line).toBe("行动");
  await session.dispose();
});
it("mounting does not block the first table on an optional portrait request", async () => {
  const f = fixture(); let finish!: (available: boolean) => void;
  const opening = { ...program.rules[1], id: "opening-art", on: [{ type: "core.round-start", apiVersion: 1 }], when: atom("core.round-number", { eq: 1 }), portrait: { image: "slow.png" } };
  const session = new DialogueSession(new DialogueEngine({ ...program, rules: [opening] }, "chatgpt", f.registry), f.state, f.store, () => new Promise<boolean>(resolve => finish = resolve));
  await session.start([], false); expect(session.peek().line).toBe("基础");
  finish(true); await Promise.resolve(); await Promise.resolve(); expect(session.peek().line).toBe("行动"); await session.dispose();
});
it("unloading a primitive clears event caches/diagnostics and invalidates pending portrait commits", async () => {
  const f = fixture(), read = vi.fn(() => 1);
  const p: DialoguePrimitive = { id: "value", apiVersion: 1, title: "中性", description: "缓存释放", returnType: "number", parameters: { type: "object", additionalProperties: false }, dependencies: ["event"], read };
  const release = f.registry.registerPackage("test/neutral", [p], [p]);
  const rules = [{ ...program.rules[1], on: [{ type: `${pkg}#tap`, apiVersion: 1 }], when: atom("test/neutral#value", { eq: 1 }), portrait: { image: "pending.png" } }];
  let finish!: (available: boolean) => void;
  const engine = new DialogueEngine({ ...program, rules }, "chatgpt", f.registry), session = new DialogueSession(engine, f.state, f.store, () => new Promise<boolean>(resolve => finish = resolve));
  await session.start([], false); const pending = session.deliver(tapEvent("unload")); release();
  expect(engine.diagnostics).toEqual([]); finish(true); await pending; expect(session.peek().line).toBe("基础");
  await session.dispose(); const invalidate = vi.spyOn(engine, "invalidateCapabilities"); f.registry.registerPackage("test/neutral", [p], [p]); expect(invalidate).not.toHaveBeenCalled();
});

it("publishes declared region IDs and defaults unmatched images to full-portrait", async () => {
  const f = fixture([{ packageId: input.image.packageId, value: { characterId: input.characterId, regions: ["upper", "whole"], images: [{ image: input.image.path, regions: [
    { id: "upper", shape: "rectangle", x: 0, y: 0, width: 1, height: .25 },
    { id: "whole", shape: "rectangle", x: 0, y: 0, width: .75, height: 1 }
  ] }] } }]);
  const notify = vi.fn();
  const source: MountedDialogueSource = { ...f.source, mount(c, signal) { c.subscribeDialogueEvents(notify); return f.source.mount(c, signal); } };
  const session = new DialogueSession(new DialogueEngine(program, "chatgpt", f.registry), f.state, f.store);
  await session.start([source], false);
  const last = () => notify.mock.calls.at(-1)![0].data.region;
  session.interact({ ...input, y: .25 }); expect(last()).toBe("upper");
  session.interact(input); expect(last()).toBe("whole");
  session.interact({ ...input, x: 1 }); expect(last()).toBe("full-portrait");
  session.interact({ ...input, image: { ...input.image, path: "other.png" } }); expect(last()).toBe("full-portrait");
  session.interact({ ...input, image: { ...input.image, packageId: "test/other" } }); expect(last()).toBe("full-portrait");
  session.interact({ ...input, x: null, y: null }); expect(last()).toBeNull();
  expect(f.store.get(f.state.id, pkg, f.source.declaration)).toMatchObject({ totalCount: 6 });
  await session.dispose();
});
it("without attachments a pointer event exposes string full-portrait to dialogue rules", async () => {
  const f = fixture();
  const rules = [{ ...program.rules[0], when: atom(`${pkg}#region`, { eq: "full-portrait" }) }];
  const session = new DialogueSession(new DialogueEngine({ ...program, rules }, "chatgpt", f.registry), f.state, f.store);
  await session.start([f.source], false); session.interact(input); expect(session.peek().line).toBe("点击");
  await session.dispose();
});
it("rejects runtime attachments with undeclared, duplicate or reserved region IDs", () => {
  const handler = register().handlers[0];
  const context = { dependencies: new Map([["match", { metadata: { id: "chatgpt" } }]]) };
  const data = { characterResourceId: "match", regions: ["upper"], images: [{ image: "relaxed.png", regions: [{ id: "upper", shape: "rectangle", x: 0, y: 0, width: 1, height: 1 }] }] };
  expect(handler.apiVersions).toEqual([2]); expect(handler.parse(data, context).characterId).toBe("chatgpt");
  for (const regions of [[], ["full-portrait"], ["upper", "upper"]]) expect(() => handler.parse({ ...data, regions }, context)).toThrow();
});
