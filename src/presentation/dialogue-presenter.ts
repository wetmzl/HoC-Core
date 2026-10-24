import { escapeHtml } from "./view-helpers";
import type { MatchState } from "../core/match/types";
import { type CharacterDefinition } from "../content/characters";
export interface DialoguePresenterDependencies {
    dialogueSession: import("../dialogue/session").DialogueSession | undefined;
    root: HTMLDivElement;
    save: import("../persistence/schema").LongTermSave;
}
export interface DialogueRenderSnapshot {
    readonly shouldType: boolean;
    readonly resumeTyping: boolean;
    readonly initialLength: number;
    readonly markup: string;
    readonly scrollTop: number;
}
export class DialoguePresenter {
    constructor(private readonly deps: DialoguePresenterDependencies) { }
    dispose = (): void => {
        window.clearInterval(this.dialogueTimer);
        window.clearTimeout(this.dialogueShakeTimer);
        this.dialogueTimer = undefined;
        this.dialogueShakeTimer = undefined;
        this.lastDialogueKey = null;
        this.dialogueAutoFollow = true;
    };
    capture = (text: string, key: string): DialogueRenderSnapshot => {
        const shouldType = key !== this.lastDialogueKey;
        const previous = this.deps.root.querySelector<HTMLElement>("#dialogue-text");
        const scrollTop = this.deps.root.querySelector<HTMLElement>(".dialogue-scroll")?.scrollTop ?? 0;
        const resumeTyping = !shouldType && previous?.dataset.typing === "true";
        const initialLength = resumeTyping ? previous.textContent?.length ?? 0 : 0;
        window.clearInterval(this.dialogueTimer);
        if (shouldType)
            this.dialogueAutoFollow = true;
        return { shouldType, resumeTyping, initialLength, scrollTop,
            markup: shouldType ? "" : escapeHtml(resumeTyping ? text.slice(0, initialLength) : text) };
    };
    restore = (text: string, key: string, snapshot: DialogueRenderSnapshot): void => {
        const scroller = this.deps.root.querySelector<HTMLElement>(".dialogue-scroll");
        if (scroller) {
            scroller.scrollTop = snapshot.shouldType ? 0 : snapshot.resumeTyping && this.dialogueAutoFollow ? scroller.scrollHeight : snapshot.scrollTop;
            scroller.addEventListener("scroll", () => {
                if (scroller.isConnected)
                    this.dialogueAutoFollow = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4;
            });
        }
        if (snapshot.shouldType || snapshot.resumeTyping) {
            this.lastDialogueKey = key;
            this.startTypewriter(text, snapshot.initialLength);
        }
    };
    dialogueTimer: number | undefined;
    dialogueShakeTimer: number | undefined;
    dialogueAutoFollow: boolean = true;
    lastDialogueKey: string | null = null;
    currentDialogue = (): string => { return this.deps.dialogueSession!.peek().line; };
    dialogueKey = (): string => { return this.deps.dialogueSession!.peek().key; };
    tablePortrait = (state: MatchState, character: CharacterDefinition): string => {
        const override = this.deps.dialogueSession?.peek().portrait;
        if (override)
            return override.image;
        if (state.round.phase === "roulette-result" && state.outcome?.reason === "opponent-killed")
            return character.assets.unconscious;
        if (state.round.phase === "roulette-trigger" && state.round.outcome?.penaltyTarget === "opponent")
            return character.assets.threatened;
        if (state.round.phase === "round-reveal" && state.round.outcome?.winner === "opponent")
            return character.assets.mocking;
        return character.assets.relaxed;
    };
    portraitState = (state: MatchState): string => {
        if (state.round.phase === "roulette-result" && state.outcome?.reason === "opponent-killed")
            return "unconscious";
        if (state.round.phase === "roulette-trigger" && state.round.outcome?.penaltyTarget === "opponent")
            return "trigger";
        if (state.round.phase === "round-reveal" && state.round.outcome?.winner === "opponent")
            return "mocking";
        return "relaxed";
    };
    portraitAlt = (state: MatchState, character: CharacterDefinition): string => {
        const override = this.deps.dialogueSession?.peek().portrait;
        if (override)
            return override.alt ?? `${character.name} 角色立绘`;
        const stateName = this.portraitState(state);
        if (stateName === "trigger")
            return `${character.name} 被工作人员用左轮抵住太阳穴，神情紧张`;
        if (stateName === "mocking")
            return `${character.name} 正在嘲讽`;
        if (stateName === "conflicted")
            return `${character.name} 正在判断牌势`;
        if (stateName === "unconscious")
            return `${character.name} 双眼上翻，微微后仰`;
        return `${character.name} 放松地看着牌桌`;
    };
    startTypewriter = (text: string, initialLength = 0): void => {
        window.clearInterval(this.dialogueTimer);
        window.clearTimeout(this.dialogueShakeTimer);
        const node = this.deps.root.querySelector<HTMLElement>("#dialogue-text");
        const portrait = this.deps.root.querySelector<HTMLElement>(".character-strip img");
        if (!node)
            return;
        const scroller = this.deps.root.querySelector<HTMLElement>(".dialogue-scroll");
        const followLatest = () => {
            if (scroller && this.dialogueAutoFollow)
                scroller.scrollTop = scroller.scrollHeight;
        };
        node.textContent = text.slice(0, initialLength);
        node.dataset.typing = this.deps.save.settings.reducedMotion ? "false" : "true";
        if (this.deps.save.settings.reducedMotion) {
            node.textContent = text;
            return;
        }
        if (initialLength === 0) {
            portrait?.classList.add("character-shake");
            this.dialogueShakeTimer = window.setTimeout(() => portrait?.classList.remove("character-shake"), 360);
        }
        let index = initialLength;
        this.dialogueTimer = window.setInterval(() => {
            index += 1;
            node.textContent = text.slice(0, index);
            followLatest();
            if (index >= text.length) {
                window.clearInterval(this.dialogueTimer);
                node.dataset.typing = "false";
            }
        }, 24);
    };
}
