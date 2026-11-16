import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createDefaultSave } from "../persistence/boot";
import { DEFAULT_CHARACTER_ID, type CharacterDefinition } from "../content/characters";
import { MatchSession, type MatchSessionDependencies } from "./match-session";
import { gameAudio } from "../audio/game-audio";
import type { MatchOwner } from "./match-owner";
import { DialogueSession } from "../dialogue/session";
import { IncompleteSkillDeckError } from "../core/flow/initialization";
import { RuntimeEventHub } from "./public-event-hub";
import type { PublicEventBatch } from "../core/events/public-events";

vi.mock("../audio/game-audio", () => ({ gameAudio: { updateMusicFacts: vi.fn(), updateMusicContext: vi.fn(), play: vi.fn(), setBgmScene: vi.fn(), setMatchMusic: vi.fn(), preloadMatch: vi.fn(), startHeartbeat: vi.fn(), stopHeartbeat: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());

function testOwner(summary: () => void = () => {}): MatchOwner {
  return { character: base => base, summary, attach: async match => ({ getState: () => match, getSave: createDefaultSave, flush: async () => {}, dispatch: () => match, updateSave() {} }) };
}

function harness() {
  const calls: string[] = [];
  const state = createMatch("session-transition");
  let current = state;
  const deps = {
    clearAiSchedule: () => calls.push("cancel-ai"),
    renderMatch: () => calls.push("render"),
    renderSummary: () => calls.push("summary"),
    presentDelta: (transition: import("./match-transition").MatchTransition) => { calls.push("notifications"); expect(transition.events).toEqual(transition.after.history.slice(transition.before.history.length)); expect(Object.isFrozen(transition)).toBe(true); },
    scheduleAiTurn: () => calls.push("ai"),
    save: createDefaultSave(),
    notifyExtensions: vi.fn(),
    runtimeContributions: [{ presentMatchEvents: () => { calls.push("plugin"); } }],
  } as unknown as MatchSessionDependencies;
  const session = new MatchSession(deps);
  session.autosave = {
    getState: () => current,
    dispatch: action => { calls.push("save-dispatch"); current = gameReducer(current, action); return current; },
    flush: async () => { calls.push("save-flush"); },
  } as NonNullable<MatchSession["autosave"]>;
  session.dialogueSession = { transitionFacts: () => calls.push("dialogue"), dispose: async () => { calls.push("dialogue-dispose"); } } as unknown as NonNullable<MatchSession["dialogueSession"]>;
  session.pluginMatchController = new AbortController();
  return { session, calls, deps };
}

describe("match session lifecycle", () => {
  it("routes only an incomplete resolved profile deck back to skill management", () => {
    const close = vi.fn(), openSkillManagement = vi.fn();
    const session = new MatchSession({ root: { querySelector: () => ({ close }) }, openSkillManagement } as unknown as MatchSessionDependencies);
    expect(session.showInitializationError(new Error("disk unavailable"))).toBe(false);
    expect(openSkillManagement).not.toHaveBeenCalled();
    expect(session.showInitializationError(new IncompleteSkillDeckError(3))).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(openSkillManagement).toHaveBeenCalledWith("还需加入 3 种技能才能开始新对局");
  });
  it.each(["table", "match-summary"] as const)("notifies initial runtime subscribers after the %s screen exists", async view => {
    const calls: string[] = [];
    const save = createDefaultSave();
    const state = { ...createMatch("initial-visible-notification", { opponentId: DEFAULT_CHARACTER_ID,
      intrinsicAbilities: [{ definitionId: "builtin-debug-control", enabled: true, parameters: { bustBonus: 2 } }] }), view };
    let visible = false;
    vi.spyOn(DialogueSession.prototype, "start").mockImplementation(async () => { calls.push("dialogue-ready"); });
    const session = new MatchSession({
      save, runtimeContributions: [], selectedCharacterId: state.opponentId,
      clearAiSchedule() {}, resetDialogue() {},
      repository: { saveRuntime: async () => {} },
      enterMatch: async () => { calls.push("enter-screen"); },
      renderMatch: () => { visible = true; calls.push("render-table"); },
      renderSummary: () => { visible = true; calls.push("render-summary"); },
      notifyExtensions: () => { expect(visible).toBe(true); calls.push("notify-plugins"); },
      enqueueAbilityNotices() {},
      scheduleAiTurn: () => { calls.push("schedule-ai"); }
    } as unknown as MatchSessionDependencies);
    session.prepareMatchResources = async () => {};
    const character = { id: state.opponentId, name: "Example", matchMusicSources: ["blob:character", "blob:faction"], dialogue: { rules: [] } } as unknown as CharacterDefinition;
    await session.resumeMatch(state, testOwner(() => { visible = true; calls.push("render-summary"); }), character);
    // Initialization belongs to the stored flow/table; absent current plugin defaults
    // must not erase node-provided abilities during a normal attachment or restoration.
    expect(session.autosave!.getState().abilities.instances.find(instance => instance.intrinsic)?.parameters.bustBonus).toBe(2);
    expect(gameAudio.setMatchMusic).toHaveBeenLastCalledWith(character.matchMusicSources, character.matchMusicPriorities);
    expect(calls).toEqual(view === "table"
      ? ["enter-screen", "dialogue-ready", "render-table", "notify-plugins", "schedule-ai"]
      : ["enter-screen", "dialogue-ready", "render-summary", "notify-plugins"]);
    await session.dispose();
  });
  it("saves before delivering one migration in presentation order", () => {
    const audio = vi.spyOn(gameAudio, "play").mockImplementation(() => undefined);
    const h = harness();
    h.session.dispatch({ type: "PLAYER_STAND" });
    expect(h.calls).toEqual(["save-dispatch", "dialogue", "render", "notifications", "plugin", "ai"]);
    audio.mockRestore();
  });
  it("keeps public batches ordered when a legacy subscriber immediately dispatches another action", async () => {
    const h = harness();
    const events = new RuntimeEventHub();
    Object.assign(h.deps, { events, eventScopes: { game: "reentrant-game" } });
    const batches: PublicEventBatch[] = [];
    events.subscribe("resolved", batch => { batches.push(batch); });
    let reentered = false;
    h.deps.notifyExtensions = () => {
      if (reentered) return;
      reentered = true;
      h.session.dispatch({ type: "AI_STAND" });
    };
    const schedule = vi.fn();
    h.deps.scheduleAiTurn = schedule;
    h.session.dispatch({ type: "PLAYER_STAND" });
    expect(batches).toHaveLength(2);
    expect(batches[0].facts.some(fact => fact.type === "match.PLAYER_STOOD")).toBe(true);
    expect(batches[0].facts.some(fact => fact.type === "match.OPPONENT_STOOD")).toBe(false);
    expect(batches[1].facts.some(fact => fact.type === "match.OPPONENT_STOOD")).toBe(true);
    expect(batches.every(batch => batch.facts.every(fact => fact.scopes.game === "reentrant-game"))).toBe(true);
    const current = h.session.autosave!.getState();
    expect(batches[1].context?.match).toEqual(current);
    expect(schedule.mock.calls).toEqual([[current], [current]]);
    await h.session.dispose();
    events.dispose();
  });

  it.each([false, true])("publishes fresh initialization after the visible screen and before AI, without replay on restore=%s", async restored => {
    const events = new RuntimeEventHub();
    const calls: string[] = [];
    const batches: PublicEventBatch[] = [];
    const state = createMatch("fresh-public-initialization", { opponentId: DEFAULT_CHARACTER_ID });
    vi.spyOn(DialogueSession.prototype, "start").mockResolvedValue(undefined);
    events.subscribe("resolved", batch => { batches.push(batch); calls.push("public"); });
    const session = new MatchSession({
      events, eventScopes: { game: "initial-game" }, save: createDefaultSave(), runtimeContributions: [],
      selectedCharacterId: state.opponentId, clearAiSchedule() {}, resetDialogue() {}, enqueueAbilityNotices() {},
      enterMatch: async () => { calls.push("screen"); }, renderMatch: () => { calls.push("render"); },
      notifyExtensions: () => { calls.push("legacy"); }, scheduleAiTurn: () => { calls.push("ai"); }
    } as unknown as MatchSessionDependencies);
    session.prepareMatchResources = async () => {};
    const character = { id: state.opponentId, name: "Example", dialogue: { rules: [] } } as unknown as CharacterDefinition;
    await session.resumeMatch(state, testOwner(), character, restored);
    expect(calls).toEqual(["screen", "render", "public", "legacy", "ai"]);
    expect(batches).toHaveLength(1);
    if (restored) {
      expect(batches[0].facts.map(fact => fact.type)).toEqual(["match.restored"]);
    } else {
      expect(batches[0].facts.some(fact => fact.type === "match.ROUND_STARTED")).toBe(true);
      expect(batches[0].facts.some(fact => fact.type === "rule.before-round-deal")).toBe(true);
      expect(batches[0].facts.every(fact => fact.scopes.game === "initial-game")).toBe(true);
    }
    await session.dispose();
    events.dispose();
  });
  it("stops presentation and AI scheduling when required rendering fails", () => {
    const h = harness();
    h.deps.renderMatch = () => { h.calls.push("render-failed"); throw new Error("table render failed"); };
    expect(() => h.session.dispatch({ type: "PLAYER_STAND" })).toThrow("table render failed");
    expect(h.calls).toEqual(["save-dispatch", "dialogue", "render-failed"]);
    expect(h.calls).not.toContain("ai");
  });
  it("disposes once, aborts plugin work, flushes saves and blocks late actions", async () => {
    const h = harness();
    const signal = h.session.pluginMatchController!.signal;
    await h.session.dispose();
    await h.session.dispose();
    h.session.dispatch({ type: "PLAYER_STAND" });
    expect(signal.aborted).toBe(true);
    expect(h.calls).toEqual(["cancel-ai", "dialogue-dispose", "save-flush"]);
  });
  it("does not establish a session after a late resource load", async () => {
    const h = harness();
    let finish!: () => void;
    h.session.prepareMatchResources = () => new Promise(resolve => { finish = resolve; });
    const resume = h.session.resumeMatch(createMatch("late-resume"), testOwner(), {} as CharacterDefinition);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await h.session.dispose();
    finish();
    await resume;
    expect(h.calls).not.toContain("render");
  });
});

it("keeps a replacement session isolated from an earlier resource request", async () => {
  const h = harness();
  const finishes: (() => void)[] = [];
  h.session.prepareMatchResources = () => new Promise(resolve => finishes.push(resolve));
  const originalAutosave = h.session.autosave;
  const first = h.session.resumeMatch(createMatch("old-session"), testOwner(), {} as CharacterDefinition);
  await vi.waitFor(() => expect(finishes).toHaveLength(1));
  const second = h.session.resumeMatch(createMatch("replacement-session"), testOwner(), {} as CharacterDefinition);
  await vi.waitFor(() => expect(finishes).toHaveLength(2));
  finishes[0]();
  await first;
  expect(h.session.autosave).toBe(originalAutosave);
  expect(h.calls).not.toContain("render");
  await h.session.dispose();
  finishes[1]();
  await second;
  expect(h.calls).not.toContain("render");
});

it("blocks actions while exit persistence is pending and accepts them after failure recovery", async () => {
  const h = harness();
  h.session.setPaused(true);
  h.session.dispatch({ type: "PLAYER_STAND" });
  expect(h.calls).toEqual([]);
  h.session.setPaused(false);
  h.session.dispatch({ type: "PLAYER_STAND" });
  expect(h.calls[0]).toBe("save-dispatch");
  await h.session.dispose();
});

it("holds a ready resource load during exit and cancels it on successful disposal", async () => {
  const h = harness();
  let finish!: () => void;
  h.session.prepareMatchResources = () => new Promise(resolve => { finish = resolve; });
  const original = h.session.autosave;
  const resume = h.session.resumeMatch(createMatch("paused-loading"), testOwner(), {} as CharacterDefinition);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  h.session.setPaused(true);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.session.autosave).toBe(original);
  await h.session.dispose();
  await resume;
  expect(h.calls).not.toContain("render");
});


it("does not mount or replace the autosave after disposal while an outer owner is attaching", async () => {
  const entered = vi.fn();
  const state = createMatch("late-owner", { opponentId: DEFAULT_CHARACTER_ID });
  const session = new MatchSession({
    save: createDefaultSave(), runtimeContributions: [], selectedCharacterId: state.opponentId,
    clearAiSchedule() {}, enterMatch: entered
  } as unknown as MatchSessionDependencies);
  session.prepareMatchResources = async () => {};
  let release!: (handle: NonNullable<MatchSession["autosave"]>) => void;
  const attaching = new Promise<NonNullable<MatchSession["autosave"]>>(resolve => { release = resolve; });
  const attach = vi.fn(() => attaching);
  const resumed = session.resumeMatch(state, { attach, character: base => base, summary() {} }, {} as CharacterDefinition);
  await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
  await session.dispose();
  release({ getState: () => state } as NonNullable<MatchSession["autosave"]>);
  await resumed;
  expect(entered).not.toHaveBeenCalled(); expect(session.autosave).toBeNull();
});
