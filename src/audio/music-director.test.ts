import { expect, it, vi } from "vitest";
import { MusicDirector } from "./music-director";
import { createMatch, gameReducer } from "../core/match/reducer";
import type { InstalledMusicResource } from "../content/packages/music";

function resource(packageId = "example/music"): InstalledMusicResource {
  return { packageId, resourceId: "main", title: packageId, tracks: {
    lobby: { url: `blob:${packageId}/lobby`, name: "大厅" }, match: { url: `blob:${packageId}/match`, name: "牌局" }, special: { url: `blob:${packageId}/special`, name: "阶段曲" }
  }, rules: [
    { id: "lobby", scene: "lobby", track: "lobby", priority: "override" },
    { id: "match", scene: "match", track: "match", priority: "background" }
  ] };
}
function harness() {
  const changed = vi.fn(); const director = new MusicDirector(changed); director.install([resource()]);
  const controller = new AbortController(); const api = director.forPackage("example/plugin", controller.signal);
  const match = createMatch("music-conditions");
  return { director, changed, controller, api, match, winner: () => changed.mock.lastCall![0][0] };
}

it("arbitrates every priority and preserves faction-only legacy classification", () => {
  const { director, api, match, winner } = harness();
  expect(winner().track).toBe("example/music#main/lobby");
  director.setScene("match"); director.updateMatch(match);
  expect(winner().priority).toBe("background");
  director.setLegacy(["blob:faction"], ["faction"]); expect(winner().priority).toBe("faction");
  director.setLegacy(["blob:character", "blob:faction"], ["character", "faction"]); expect(winner().priority).toBe("character");
  for (const priority of ["override", "conditional", "temporary"] as const) {
    api.set(priority, { track: "example/music#main/special", priority, scope: "match" });
    expect(winner().priority).toBe(priority);
  }
  api.release("temporary"); expect(winner().priority).toBe("conditional");
  api.release("conditional"); api.release("override"); expect(winner().url).toBe("blob:character");
  director.install([]); director.setLegacy([]); expect(winner().priority).toBe("core");
});

it("resolves ties by durable package order, rule order and stable identity, independent of install order", () => {
  const { director, winner } = harness();
  director.install([resource("z/music"), resource("a/music")]); expect(winner().packageId).toBe("a/music");
  director.setOrder(["z/music", "a/music"]); expect(winner().packageId).toBe("z/music");
  director.install([resource("a/music"), resource("z/music")]); expect(winner().packageId).toBe("z/music");
  const multiple = resource("z/music"); multiple.rules.unshift({ id: "first", scene: "lobby", track: "special", priority: "override" });
  director.install([multiple]); expect(winner().track).toBe("z/music#main/special");
});

it("delivers frozen detached snapshots, only new events, and restores conditions without replaying history", () => {
  const { director, api, match } = harness();
  director.setScene("match"); director.updateMatch(match, [], true);
  const listener = vi.fn(); const stop = api.subscribeContext(listener);
  expect(listener.mock.lastCall![0]).toMatchObject({ restored: true, events: [], characterId: match.opponentId });
  const context = listener.mock.lastCall![0]; expect(context.match).not.toBe(match);
  expect(() => { context.match.round.phase = "changed"; }).toThrow();
  const after = gameReducer(match, { type: "PLAYER_HIT" }); const events = after.history.slice(match.history.length);
  director.updateMatch(after, events);
  expect(listener.mock.lastCall![0].events).toEqual(events);
  const late = vi.fn(); api.subscribeContext(late); expect(late.mock.lastCall![0].events).toEqual([]);
  stop(); const calls = listener.mock.calls.length; director.updateMatch(after); expect(listener).toHaveBeenCalledTimes(calls);
});

it("switches for a condition, recovers on release and expires match requests even between consecutive matches", () => {
  const { director, api, match, winner } = harness();
  director.setScene("match");
  api.subscribeContext(context => {
    if (context.match?.round.index === match.round.index) api.set("phase", { track: "example/music#main/special", priority: "conditional", scope: "match" });
    else api.release("phase");
  });
  director.updateMatch(match); expect(winner().priority).toBe("conditional");
  director.updateMatch({ ...match, round: { ...match.round, index: 2 } }); expect(winner().priority).toBe("background");
  api.set("one-match", { track: "example/music#main/special", priority: "temporary", scope: "match" });
  director.updateMatch({ ...match, id: "another", round: { ...match.round, index: 2 } }); expect(winner().priority).toBe("background");
});

it("keeps runtime requests across scenes but clears scene and match scopes and abort-owned requests", () => {
  const { director, api, match, controller, winner } = harness();
  api.set("runtime", { track: "example/music#main/special", priority: "conditional", scope: "runtime" });
  director.setScene("match"); director.updateMatch(match); expect(winner().priority).toBe("conditional");
  api.set("scene", { track: "example/music#main/special", priority: "temporary", scope: "scene" });
  director.setScene("lobby"); expect(winner().priority).toBe("conditional");
  const listener = vi.fn(); api.subscribeContext(listener); controller.abort();
  expect(winner().priority).toBe("override");
  const calls = listener.mock.calls.length; director.setScene("match"); expect(listener).toHaveBeenCalledTimes(calls);
  api.set("stale", { track: "example/music#main/special", priority: "temporary", scope: "runtime" }); expect(winner().priority).toBe("background");
});

it("uses one-shot completion latches, permits explicit rearming, and falls back from bad tracks", () => {
  const { director, api, winner } = harness();
  const request = { track: "example/music#main/special", priority: "temporary", scope: "runtime", loop: false } as const;
  api.set("intro", request); const id = winner().id; director.ended(id); expect(winner().priority).toBe("override");
  api.set("intro", request); expect(winner().priority).toBe("override");
  director.setScene("match"); director.setScene("lobby");
  api.set("intro", request); expect(winner().priority).toBe("override");
  api.release("intro"); api.set("intro", request); expect(winner().id).toBe(id);
  director.failedTrack(request.track); expect(winner().priority).toBe("override");
  director.failedTrack("example/music#main/lobby"); expect(winner().priority).toBe("core");
  expect(director.status().failedTracks).toContain(request.track);
});

it("rejects unknown resources and invalid requests while isolating package IDs and callback failures", () => {
  const { director, api } = harness();
  const input = { track: "example/music#main/special", priority: "temporary", scope: "runtime" } as const;
  expect(() => api.set("missing", { ...input, track: "missing/music#main/a" })).toThrow("未安装");
  expect(() => api.set("bad", { ...input, transitionMs: -1 })).toThrow();
  expect(() => api.set("match", { ...input, scope: "match" })).toThrow("活动牌局");
  api.set("same", input);
  const other = director.forPackage("other/plugin", new AbortController().signal); other.set("same", input); other.release("same");
  expect(director.candidates().some(c => c.id === "plugin:example/plugin:same")).toBe(true);
  const duplicate = director.forPackage("example/plugin", new AbortController().signal);
  expect(() => duplicate.set("same", input)).toThrow("另一模块");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  api.subscribeContext(() => { throw new Error("broken condition"); }); const healthy = vi.fn(); api.subscribeContext(healthy);
  director.setScene("match"); expect(healthy).toHaveBeenCalledTimes(2); vi.restoreAllMocks();
});
