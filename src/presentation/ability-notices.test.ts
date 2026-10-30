import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../core/abilities/registry";
import type { AbilityRule } from "../core/abilities/types";
import type { GameEvent } from "../core/match/types";
import type { PendingTriggerPreview } from "../core/match/reducer";
import { abilityExpiredNotices, abilityTriggerNotice, pendingTriggerAbilityNotices } from "./ability-notices";

const originalRegistry = ABILITY_REGISTRY;
const rules: AbilityRule[] = [
  { id: "protection", trigger: "before-defeat", effects: [{ type: "prevent-pending-defeat", target: "owner" }, { type: "add-gun-bullets", target: "owner", amount: 2 }] },
  { id: "reload", trigger: "after-defeat-prevented", effects: [{ type: "add-gun-bullets", target: "rival", amount: 2 }] },
  { id: "first", trigger: "on-round-start", triggerNotice: "获得点数优势。", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] },
  { id: "repeat", trigger: "on-round-start", triggerNotice: "获得点数优势。", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] },
  { id: "second", trigger: "on-round-start", triggerNotice: "下一次 Hit 被封锁。", effects: [{ type: "force-stand", target: "rival" }] },
  { id: "hidden", trigger: "on-round-start", notify: false, triggerNotice: "内部清理", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] },
  { id: "misfire", trigger: "before-trigger-pull", effects: [{ type: "add-to-pending-trigger-misfire-chance", target: "owner", amount: 0.2 }] },
  { id: "misfire-again", trigger: "before-trigger-pull", effects: [{ type: "add-to-pending-trigger-misfire-chance", target: "owner", amount: 0.1 }] },
  { id: "limit-readout", trigger: "before-bust-check", effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 2 }] },
  { id: "score-readout", trigger: "before-round-resolution", effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 2 }] },
  { id: "ai-internal", trigger: "before-ai-decision", effects: [{ type: "add-to-pending-ai-threshold", target: "owner", amount: 1 }] },
  { id: "explicit-readout", trigger: "before-bust-check", notify: true, triggerNotice: "特殊上限变化", effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 2 }] },
  { id: "mixed-effects", trigger: "before-bust-check", effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 2 }, { type: "force-stand", target: "rival" }] }
];

beforeEach(() => installAbilityRegistry([
  { id: "example-skill", name: "示例技能", description: "示例", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"], activation: { type: "automatic" }, rules },
  { id: "example-passive", name: "示例被动", description: "示例", sourceKind: "player-skill", primaryDomain: "cheater", tags: ["example"], skillTags: ["cheater"], drop: { enabled: true, baseWeight: 1 }, stackable: false, activation: { type: "passive" }, ttl: { type: "rounds", amount: 2 }, rules },
  { id: "example-active", name: "示例主动", description: "示例", sourceKind: "player-skill", primaryDomain: "cheater", tags: ["example"], skillTags: ["cheater"], drop: { enabled: true, baseWeight: 1 }, stackable: false, activation: { type: "action", windows: ["owner-turn"], consume: "card" }, rules },
  { id: "example-talent", name: "示例天赋", description: "示例", sourceKind: "talent", primaryDomain: "cheater", tags: ["example"], activation: { type: "passive" }, unlock: { type: "defeat-count", count: 1, label: "示例" }, rules: rules.slice(0, 1) }
], [], originalRegistry.catalogVersion));
afterEach(() => installAbilityRegistry(originalRegistry.definitions, originalRegistry.statuses, originalRegistry.catalogVersion));

function trigger(ruleId: string, instanceId = "example-instance", owner: "player" | "opponent" = "player"): Extract<GameEvent, { type: "ABILITY_TRIGGERED" }> {
  return { type: "ABILITY_TRIGGERED", definitionId: "example-skill", instanceId, owner, ruleId };
}

describe("concise ability notices", () => {
  it("combines rules from one skill while retaining distinct effects in order", () => {
    expect(abilityTriggerNotice([trigger("first"), trigger("repeat"), trigger("second")], "对手")).toEqual([
      { owner: "player", tone: "player", text: "策展人 · 示例技能：获得点数优势；下一次 Hit 被封锁" }
    ]);
  });

  it("keeps separate skill instances and actors separate", () => {
    const notices = abilityTriggerNotice([trigger("first"), trigger("first", "another"), trigger("first", "example-instance", "opponent")], "对手");
    expect(notices).toHaveLength(3);
    expect(notices[2]).toEqual({ owner: "opponent", tone: "ai", text: "对手 · 示例技能：获得点数优势" });
  });

  it("still excludes internal rules and talents", () => {
    expect(abilityTriggerNotice([trigger("hidden"), { ...trigger("first"), definitionId: "example-talent" }], "对手")).toEqual([]);
  });

  it("silences repeated readout calculations while keeping opt-ins and mixed effects", () => {
    expect(abilityTriggerNotice([trigger("limit-readout"), trigger("score-readout"), trigger("ai-internal")], "对手")).toEqual([]);
    expect(abilityTriggerNotice([trigger("explicit-readout")], "对手")[0]?.text).toContain("特殊上限变化");
    expect(abilityTriggerNotice([trigger("mixed-effects")], "对手")).toHaveLength(1);
  });

  it("keeps only useful player passive expiry reminders", () => {
    const expired = { type: "ABILITY_EXPIRED", instanceId: "example-instance", definitionId: "example-passive", owner: "player", reason: "rounds" } as const;
    expect(abilityExpiredNotices([expired])).toEqual([{ owner: "system", tone: "notification", text: "示例被动的效果已耗尽" }]);
    expect(abilityExpiredNotices([
      { ...expired, definitionId: "example-active" },
      { ...expired, definitionId: "example-skill", owner: "opponent" },
      { ...expired, definitionId: "example-talent" },
      { ...expired, definitionId: "missing" }
    ])).toEqual([]);
    expect(abilityExpiredNotices([{ ...trigger("first"), definitionId: "example-passive" }, { ...expired, reason: "triggers" }])).toEqual([]);
    expect(abilityExpiredNotices([{ ...trigger("hidden"), definitionId: "example-passive" }, expired])).toHaveLength(1);
    expect(abilityExpiredNotices([{ ...trigger("first", "different-instance"), definitionId: "example-passive" }, expired])).toHaveLength(1);
  });

  it("combines duplicate misfire previews without changing the preview", () => {
    const preview: PendingTriggerPreview = { events: [trigger("misfire"), trigger("misfire-again")], misfireChance: 0.3, baseProbability: 0.5, probability: 0.35, actor: "player", cancelled: false };
    const snapshot = JSON.stringify(preview);
    expect(pendingTriggerAbilityNotices(preview, "对手")).toEqual([
      { owner: "player", tone: "player", text: "策展人 · 示例技能：本轮哑火概率为30%" }
    ]);
    expect(JSON.stringify(preview)).toBe(snapshot);
  });
});

it("reports actual protection and reloads without inventing a cancelled trigger", () => {
  const loaded = { type: "ABILITY_RESULT" as const, instanceId: "example-instance", definitionId: "example-skill", owner: "player" as const, result: { type: "gun-bullets-added" as const, actor: "opponent" as const, amount: 2, bullets: 3 } };
  expect(abilityTriggerNotice([trigger("reload"), loaded], "对手")[0].text).toBe("策展人 · 示例技能：为对手装填2发子弹，当前弹巢共有3发");
  const protectedEvents: GameEvent[] = [trigger("protection"), loaded, { type: "DEFEAT_PREVENTED", actor: "player", sourceInstanceId: "example-instance" }];
  expect(abilityTriggerNotice(protectedEvents, "对手")[0].text).toBe("策展人 · 示例技能：抵御了致命一击，对局继续");
});
