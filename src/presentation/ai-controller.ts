import type { Action, MatchState } from "../core/match/types";
import { getAiTurnDelayMs } from "./ai-timing";
import { legal } from "./view-helpers";
export interface AiControllerDependencies {
    getState(): MatchState | undefined;
    isPaused(): boolean;
    showThinking(): void;
    dispatch(action: Action): void;
}
/** Owns scheduling only; the table owns the thinking pose and text. */
export class AiController {
    private actionTimer: ReturnType<typeof setTimeout> | undefined;
    private poseTimer: ReturnType<typeof setTimeout> | undefined;
    private scheduleKey: string | null = null;
    private disposed = false;
    constructor(private readonly deps: AiControllerDependencies) { }
    private isAiTurn(state: MatchState): boolean {
        return state.status === "active" && state.scene === "match" && state.view === "table"
            && state.round.phase === "turns" && state.round.currentActor === "opponent"
            && legal(state, { type: "AI_TURN" });
    }
    clearAiSchedule = (): void => {
        clearTimeout(this.actionTimer);
        clearTimeout(this.poseTimer);
        this.actionTimer = undefined;
        this.poseTimer = undefined;
        this.scheduleKey = null;
    };
    dispose = (): void => {
        this.disposed = true;
        this.clearAiSchedule();
    };
    scheduleAiTurn = (state: MatchState): void => {
        if (this.disposed || this.deps.isPaused() || !this.isAiTurn(state)) {
            this.clearAiSchedule();
            return;
        }
        const key = `${state.id}:${state.roundIndex}:${state.history.length}`;
        if (this.scheduleKey === key)
            return;
        this.clearAiSchedule();
        this.scheduleKey = key;
        const liveTurn = () => {
            const live = this.deps.getState();
            return this.scheduleKey === key && !this.deps.isPaused() && live && `${live.id}:${live.roundIndex}:${live.history.length}` === key && this.isAiTurn(live);
        };
        const delay = getAiTurnDelayMs(state);
        this.poseTimer = setTimeout(() => {
            if (liveTurn())
                this.deps.showThinking();
            else
                this.clearAiSchedule();
        }, Math.round(delay / 2));
        this.actionTimer = setTimeout(() => {
            const act = liveTurn();
            this.clearAiSchedule();
            if (act)
                this.deps.dispatch({ type: "AI_TURN" });
        }, delay);
    };
}
