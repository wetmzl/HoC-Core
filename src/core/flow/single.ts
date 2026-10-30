import { createGun } from "../roulette/roulette";
import type { GunState } from "../roulette/types";
import type { FlowDefinition, FlowProgress } from "./schema";

/** A normal invitation is a flow with one terminal encounter. */
export function singleEncounterFlow(opponentId: string, playerGun: GunState = createGun(6), opponentGun?: GunState): FlowDefinition {
  return { id: `single:${opponentId}`, playerGun, nodes: [{ id: "match", opponentId, requires: [], repeatable: false,
    opponentGun, routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } }
  }] };
}
export function singleEncounterProgress(match: { id: string; seed: string }): FlowProgress {
  return { id: match.id, seed: match.seed, phase: "encounter", encounterIndex: 1, completedNodes: [],
    encounter: { nodeId: "match", matchId: match.id }, result: null };
}
