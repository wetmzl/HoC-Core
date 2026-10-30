import type { MatchState } from "../core/match/types";
export interface TelemetryFlow {
  readonly id: string;
  readonly definition: { readonly id: string };
  readonly encounter: { readonly nodeId: string; readonly matchId: string } | null;
  readonly encounterIndex: number;
}

export interface ClientMetadata { type: "web" | "pwa" | "android"; os: string; browser: string; browser_major: string; locale: string; }
export interface EventEnvelope {
  schema_version: 1; event_id: string; installation_id: string; session_id: string; occurred_at: string;
  game_version: string; build_id: string; environment: "production" | "test" | "development"; client: ClientMetadata;
}
export interface GunStatistics {
  capacity: number; initial_bullets: number | null; final_bullets: number; loaded_actual: number | null;
  removed_actual: number; load_requested: number; triggers: number; fired: number; misfires: number;
}
export interface MatchStatistics {
  match_id: string;
  opponent: { id: string; name: string; package_id?: string; package_version?: string };
  flow: { run_id: string; definition_id: string; node_id: string; encounter_index: number };
  outcome: "win" | "loss" | "escaped"; reason: "player-killed" | "opponent-killed" | "escaped";
  started_at: string | null; ended_at: string; duration_ms: number | null;
  restored: boolean; incomplete: boolean; debug_used: boolean;
  rounds: { resolved: number; player_wins: number; opponent_wins: number; pushes: number;
    player_busts: number; opponent_busts: number; player_blackjacks: number; opponent_blackjacks: number };
  guns: Record<"player" | "opponent", GunStatistics>;
  skills: { id: string; level: number; owner: "player" | "opponent"; plays: number; rule_triggers: number }[];
  loadout: { deck: string[]; talents: string[] }; configuration_hash?: string;
}
export type TelemetryEvent = EventEnvelope & (
  { event_type: "app_started"; data: { storage: "persistent" | "ephemeral" } }
  | { event_type: "match_finished"; data: MatchStatistics }
);
export interface MatchObservation { restored?: boolean; debugUsed?: boolean; }
/** The organizer checkpoints summaries; this port never waits for network delivery. */
export interface EncounterTelemetry {
  observe(match: MatchState, run: TelemetryFlow, observation?: MatchObservation): Promise<void>;
}
