import { getAbilityDefinition } from "../core/abilities/registry";
import type { Actor, MatchState } from "../core/match/types";
import type { TelemetryFlow as FlowRun } from "./types";
import type { GunStatistics, MatchStatistics } from "./types";

export function gunStatistics(match: MatchState, actor: Actor, initial: number | null): GunStatistics {
  const firing = new Map<number, number>();
  let loaded = 0, removed = 0, known = true, requested = 0, triggers = 0, fired = 0, misfires = 0;
  for (const event of match.history) {
    if (event.type === "BULLET_ADDED" && event.actor === actor) {
      requested += event.amount;
      if (event.actualAmount === undefined) known = false; else loaded += event.actualAmount;
    }
    if (event.type === "ABILITY_RESULT" && event.result.type === "gun-bullets-added" && event.result.actor === actor) {
      if (event.result.amount >= 0) loaded += event.result.amount; else removed -= event.result.amount;
    }
    if (event.type === "TRIGGER_PULLED" && event.actor === actor) {
      triggers++; if (event.result === "fired") {
        fired++;
        if (event.bulletsBefore !== undefined && (firing.has(event.bulletsBefore) || firing.size < 128)) firing.set(event.bulletsBefore, (firing.get(event.bulletsBefore) ?? 0) + 1);
      } if (event.result === "misfire") misfires++;
    }
  }
  return { firing_bullets: [...firing].sort(([a], [b]) => a - b).map(([bullets, count]) => ({ bullets, count })), capacity: match.roulette[actor].capacity, initial_bullets: initial, final_bullets: match.roulette[actor].bullets,
    loaded_actual: known ? loaded : null, removed_actual: removed, load_requested: requested, triggers, fired, misfires };
}

export function summarizeTelemetry(match: MatchState, run: FlowRun, metadata: {
  matchId: string; startedAt: string | null; endedAt: string; durationMs: number | null; restored: boolean;
  initial: Record<Actor, number> | null; debugUsed: boolean; opponent: MatchStatistics["opponent"]; configurationHash?: string;
}): MatchStatistics {
  if (match.status !== "finished" || !match.outcome || !run.encounter) throw new Error("Cannot summarize an unfinished encounter");
  const rounds: MatchStatistics["rounds"] = { resolved: 0, player_wins: 0, opponent_wins: 0, pushes: 0,
    player_busts: 0, opponent_busts: 0, player_blackjacks: 0, opponent_blackjacks: 0 };
  const skills = new Map<string, MatchStatistics["skills"][number]>();
  for (const event of match.history) {
    if (event.type === "ROUND_RESOLVED") {
      rounds.resolved++;
      if (event.outcome.winner === "player") rounds.player_wins++;
      else if (event.outcome.winner === "opponent") rounds.opponent_wins++; else rounds.pushes++;
    }
    if (event.type === "BUST") rounds[event.actor === "player" ? "player_busts" : "opponent_busts"]++;
    if (event.type === "BLACKJACK") rounds[event.actor === "player" ? "player_blackjacks" : "opponent_blackjacks"]++;
    if (event.type === "ABILITY_PLAYED" || event.type === "ABILITY_TRIGGERED") {
      const key = JSON.stringify([event.owner, event.definitionId, event.level ?? 1]);
      let skill = skills.get(key);
      if (!skill) { skill = { id: event.definitionId, level: event.level ?? 1, owner: event.owner, plays: 0, rule_triggers: 0 }; skills.set(key, skill); }
      if (event.type === "ABILITY_PLAYED") skill.plays++; else skill.rule_triggers++;
    }
  }
  const guns = { player: gunStatistics(match, "player", metadata.initial?.player ?? null), opponent: gunStatistics(match, "opponent", metadata.initial?.opponent ?? null) };
  const allSkills = [...skills.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id) || a.level - b.level);
  for (const skill of allSkills) {
    const name = getAbilityDefinition(skill.id, undefined, skill.level)?.name;
    if (name) skill.name = name.slice(0, 256);
  }
  return { match_id: metadata.matchId, opponent: metadata.opponent,
    flow: { run_id: run.id, definition_id: run.definition.id, node_id: run.encounter.nodeId, encounter_index: run.encounterIndex },
    outcome: match.outcome.reason === "escaped" ? "escaped" : match.outcome.winner === "player" ? "win" : "loss", reason: match.outcome.reason,
    started_at: metadata.startedAt, ended_at: metadata.endedAt, duration_ms: metadata.durationMs,
    restored: metadata.restored, incomplete: metadata.restored || metadata.initial === null || guns.player.loaded_actual === null || guns.opponent.loaded_actual === null || allSkills.length > 128,
    debug_used: metadata.debugUsed, rounds, guns, skills: allSkills.slice(0, 128),
    loadout: { deck: [...(match.playerSkills.deckDefinitionIds ?? [])], talents: [...match.talentIds] },
    ...(metadata.configurationHash ? { configuration_hash: metadata.configurationHash } : {}) };
}
