import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createMatch } from "../core/match/reducer";
import { DialogueEngine } from "./engine";
import { DialogueEventRegistry } from "./events";
import { DialoguePrimitiveRegistry } from "./registry";
import type { CharacterDialogue } from "./types";
import { CharacterDialogueResourceSchema } from "./schema";
import rouletteLines from "../test/fixtures/builtin-roulette-tap-dialogue.json";
import { readCharacterResourceFixture } from "../test/character-fixtures";
// @ts-expect-error The standalone plugin module is deliberately plain JavaScript.
import { register } from "../../public/characters/character-tap/module.js";
const pkg = "hoc-core/character-tap";
const payload = JSON.parse(readFileSync("public/characters/character-tap/resources.json", "utf8"));
it.each(Object.entries(rouletteLines))("%s uses the exact approved roulette pool without changing the roulette portrait", (id, lines) => {
  const program = CharacterDialogueResourceSchema.parse(readCharacterResourceFixture(id, "resources/dialogue.json"));
  expect(program.pools.CHARACTER_TAP_ROULETTE).toEqual(lines);
  const rule = program.rules.find(rule => rule.id === "character-tap-roulette")!;
  expect(rule.portrait).toBeUndefined();
  expect(program.rules.indexOf(rule)).toBeLessThan(program.rules.findIndex(rule => rule.id === "character-tap"));
  const registry = new DialoguePrimitiveRegistry(); registry.registerPackage(pkg, payload.dialoguePrimitives, register().dialoguePrimitives);
  const events = new DialogueEventRegistry(); events.registerPackage(pkg, payload.dialogueEvents);
  const base = createMatch(`roulette-tap-${id}`, { opponentId: id });
  for (const [phase, actor] of [["roulette-reaction", "player"], ["roulette-trigger", "player"], ["roulette-trigger", "opponent"]] as const) {
    const state = { ...base, round: { ...base.round, phase, currentActor: null, outcome: { winner: actor === "opponent" ? "player" as const : "opponent" as const, reason: "comparison" as const, penaltyTarget: actor, bulletsAdded: 1 } } };
    const engine = new DialogueEngine(program, id, registry, events);
    const before = engine.accept(state, { id: "ready", type: "core.trigger-ready", apiVersion: 1, data: { actor } }); engine.commit(before);
    for (const [count, x] of [[1, .5], [2, .5], [3, .5], [4, null]] as const) {
      const selected = engine.accept(state, { id: `tap-${count}`, type: `${pkg}#tap`, apiVersion: 1, data: { actor: "opponent", x, y: x, region: x === null ? null : "full-portrait" } });
      expect(selected.poolId).toBe("CHARACTER_TAP_ROULETTE"); expect(lines).toContain(selected.line);
      expect(selected.portrait).toEqual(before.portrait); engine.commit(selected);
    }
    expect(engine.diagnostics).toEqual([]);
  }
});
const defeatedLines = {
  chatgpt: ["我承认输了，但没同意让你拿我当按钮。", "胜负已经记录。请不要再重复提交触碰请求。", "你赢的是这局牌，不是无限次戳我的权限。"],
  claude: ["你赢了就赢了……别一直戳我呀。", "我没有不服输……只是你靠得太突然了。", "好了，我已经在看你了……可以先把手收回去吗？"],
  gemini: ["赢了还戳！你怎么这么得意啊！", "喵！本喵还没允许你庆祝到我身上呢！", "再戳我就咬你了，真的！"],
  deepseek: ["我输了，但这不是您继续戳我的理由。", "赛后复盘不包括反复触碰我。", "已经收到您的胜利提醒了。请不要重复发送。"],
  llama: ["你赢了……就别再这样逗我啦。", "我没有不服气，只是你靠得太近了……", "知道啦，知道你厉害……可以不要一直戳这里吗？"]
};
it.each(Object.entries(defeatedLines))("%s uses the exact approved defeat pool with existing tap art only after the opponent loses", (id, lines) => {
  const program = CharacterDialogueResourceSchema.parse(readCharacterResourceFixture(id, "resources/dialogue.json"));
  expect(program.pools.CHARACTER_TAP_DEFEATED).toEqual(lines);
  expect(program.rules[0].id).toBe("character-tap-defeated");
  const portrait = program.rules.find(rule => rule.id === "character-tap")!.portrait;
  expect(program.rules[0].portrait).toEqual(portrait);
  const registry = new DialoguePrimitiveRegistry(); registry.registerPackage(pkg, payload.dialoguePrimitives, register().dialoguePrimitives);
  const events = new DialogueEventRegistry(); events.registerPackage(pkg, payload.dialogueEvents);
  const base = createMatch(`defeated-tap-${id}`, { opponentId: id });
  for (const actor of ["opponent", "player"] as const) for (const result of ["fired", "empty-chamber"] as const) for (const prevented of result === "fired" ? [false, true] : [false]) {
    const state = { ...base, round: { ...base.round, phase: "roulette-result" as const, currentActor: null }, history: [...base.history, { type: "TRIGGER_PULLED" as const, actor, probability: 1, baseProbability: 1, misfireChance: 0, result, fired: result === "fired" }, ...(prevented ? [{ type: "DEFEAT_PREVENTED" as const, actor, sourceInstanceId: "fixture" }] : [])] };
    const engine = new DialogueEngine(program, id, registry, events);
    const lost = actor === "opponent" && result === "fired" && !prevented;
    for (let count = 1; count <= 3; count++) {
      const choice = engine.accept(state, { id: `tap-${count}`, type: `${pkg}#tap`, apiVersion: 1, data: { actor: "opponent", x: .5, y: .5, region: "full-portrait" } });
      expect(choice.poolId).toBe(lost ? "CHARACTER_TAP_DEFEATED" : "CHARACTER_TAP");
      expect(program.pools[choice.poolId]).toContain(choice.line);
      expect(choice.portrait).toEqual(portrait);
      engine.commit(choice);
    }
    if (lost) {
      const keyboard = engine.accept(state, { id: "keyboard", type: `${pkg}#tap`, apiVersion: 1, data: { actor: "opponent", x: null, y: null, region: null } });
      expect(keyboard.poolId).toBe("CHARACTER_TAP_DEFEATED");
      expect(keyboard.portrait).toEqual(portrait);
    }
    expect(engine.diagnostics).toEqual([]);
  }
});
it("all built-in roles react to uncalibrated full-portrait with optional package art and retain normal dialogue", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const registry = new DialoguePrimitiveRegistry(); registry.registerPackage(pkg, payload.dialoguePrimitives, register().dialoguePrimitives);
    const events = new DialogueEventRegistry(); events.registerPackage(pkg, payload.dialogueEvents);
    for (const id of ["chatgpt", "claude", "gemini", "deepseek", "llama"]) {
      const program: CharacterDialogue = readCharacterResourceFixture(id, "resources/dialogue.json");
      const manifest = JSON.parse(readFileSync(`public/characters/${id}/hocpkg-info.json`, "utf8"));
      expect(manifest.resources.some((r: { type: string }) => r.type === "plugin.character-tap")).toBe(false);
      expect(manifest.resources.flatMap((r: { requires: string[] }) => r.requires).some((r: string) => r.includes(pkg))).toBe(false);
      expect(manifest.files.find((f: { path: string }) => f.path === "tap.png")?.mediaType).toBe("image/png");
      const state = createMatch(`tap-${id}`, { opponentId: id }), engine = new DialogueEngine(program, id, registry, events);
      const normal = engine.accept(state, { id: "opening", type: "core.round-start", apiVersion: 1, data: { roundIndex: state.roundIndex } }); engine.commit(normal);
      const tap = { id: "tap-one", type: `${pkg}#tap`, apiVersion: 1, data: { actor: "opponent", x: .5, y: .5, region: "full-portrait" } };
      const choice = engine.accept(state, tap); engine.commit(choice);
      expect(choice.poolId).toBe("CHARACTER_TAP"); expect(choice.portrait?.image).toBe("tap.png"); expect(program.pools.CHARACTER_TAP).toContain(choice.line);
      expect(engine.accept(state, tap)).toEqual(choice); expect(engine.peek(state)).toEqual(choice);
      expect(engine.accept(state, { ...tap, id: "keyboard", data: { ...tap.data, x: null, y: null, region: null } })).toEqual(choice);
      expect(engine.accept(state, { ...tap, id: "calibrated", data: { ...tap.data, region: "custom-area" } }).poolId).toBe("CHARACTER_TAP");
      expect(engine.accept(state, { id: "next-round", type: "core.round-start", apiVersion: 1, data: { roundIndex: state.roundIndex } }).poolId).toBe("MATCH_START");
      const unavailable = new DialogueEngine(program, id, new DialoguePrimitiveRegistry(), events);
      expect(unavailable.accept(state, tap).poolId).toBe(program.fallbackPoolId);
    }
  } finally { warn.mockRestore(); }
});
it("full-portrait remains selectable inside custom areas, with rule order deciding priority", () => {
  const registry = new DialoguePrimitiveRegistry(); registry.registerPackage(pkg, payload.dialoguePrimitives, register().dialoguePrimitives);
  const events = new DialogueEventRegistry(); events.registerPackage(pkg, payload.dialogueEvents);
  const state = createMatch("full-portrait-query");
  const custom = { id: "custom", on: [{ type: `${pkg}#tap`, apiVersion: 1 }], poolId: "custom", when: { primitive: `${pkg}#region`, apiVersion: 1, args: { id: "upper" }, test: { eq: "upper" } } };
  const full = { ...custom, id: "whole", poolId: "whole", when: { ...custom.when, args: { id: "full-portrait" }, test: { eq: "full-portrait" } } };
  const program: CharacterDialogue = { pools: { custom: ["局部"], whole: ["全立绘"], fallback: ["基础"] }, fallbackPoolId: "fallback", rules: [custom, full] };
  const tap = { id: "tap", type: `${pkg}#tap`, apiVersion: 1, data: { actor: "opponent", x: .5, y: .25, region: "upper" } };
  expect(new DialogueEngine(program, "neutral", registry, events).accept(state, tap).poolId).toBe("custom");
  expect(new DialogueEngine({ ...program, rules: [full, custom] }, "neutral", registry, events).accept(state, tap).poolId).toBe("whole");
  expect(new DialogueEngine(program, "neutral", registry, events).accept(state, { ...tap, data: { ...tap.data, region: "full-portrait" } }).poolId).toBe("whole");
  expect(new DialogueEngine(program, "neutral", registry, events).accept(state, { ...tap, data: { ...tap.data, x: null, y: null, region: null } }).poolId).toBe("fallback");
  expect(registry.validateArgs(`${pkg}#region`, 1, { id: 0 })).toBe(false);
});
