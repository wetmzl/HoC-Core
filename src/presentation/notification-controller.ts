import { previewPendingTrigger } from "../core/match/reducer";
import { abilityExpiredNotices, abilityTriggerNotice, pendingTriggerAbilityNotices, type AbilityNotice } from "./ability-notices";
import { triggerResultText } from "./round-notice";
import { ABILITY_NOTICE_TTL_MS, ABILITY_NOTICE_LEAVE_MS, MAX_ABILITY_NOTICES, legal } from "./view-helpers";
import type { MatchTransition } from "../runtime/match-transition";
export interface NotificationControllerDependencies {
    root: HTMLDivElement;
    save: import("../persistence/schema").LongTermSave;
    currentCharacter: import("../content/characters/types").CharacterDefinition;
    offerTutorial: (cue: "skill-draw-available") => void;
}
export class NotificationController {
    constructor(private readonly deps: NotificationControllerDependencies) { }
    dispose = (): void => {
        window.clearTimeout(this.presentationTimer);
        window.clearTimeout(this.presentationHideTimer);
        this.presentationTimer = undefined;
        this.presentationHideTimer = undefined;
        this.clearAbilityNoticeQueue();
        this.detachAbilityNoticePositionListener();
        document.body.classList.remove("shake");
    };
    presentationTimer: number | undefined;
    presentationHideTimer: number | undefined;
    abilityNoticeTimers: Map<HTMLElement, {
        readonly expire: number;
        readonly remove: number;
    }> = new Map<HTMLElement, {
        readonly expire: number;
        readonly remove: number;
    }>();
    abilityNoticePositionAttached: boolean = false;
    abilityNoticeContainer = (): HTMLDivElement => {
        const existing = document.querySelector<HTMLDivElement>("#ability-notices");
        if (existing)
            return existing;
        const container = document.createElement("div");
        container.id = "ability-notices";
        container.setAttribute("role", "status");
        container.setAttribute("aria-live", "polite");
        container.setAttribute("aria-atomic", "false");
        document.body.append(container);
        return container;
    };
    syncAbilityNoticePosition = (): void => {
        const container = document.querySelector<HTMLDivElement>("#ability-notices");
        if (!container)
            return;
        const anchor = this.deps.root.querySelector<HTMLElement>(".table-dashboard") ?? this.deps.root.querySelector<HTMLElement>(".roulette-status") ?? this.deps.root.querySelector<HTMLElement>(".shoe-status") ?? this.deps.root.querySelector<HTMLElement>(".display-panel");
        if (!anchor)
            return;
        const anchorRect = anchor.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const containerWidth = container.getBoundingClientRect().width;
        const sideInset = 10;
        const rawRight = viewportWidth - anchorRect.right;
        const maxRight = Math.max(sideInset, viewportWidth - sideInset - containerWidth);
        const right = Math.min(Math.max(rawRight, sideInset), maxRight);
        container.style.top = `${Math.max(sideInset, anchorRect.top)}px`;
        container.style.right = `${right}px`;
        container.style.left = "auto";
    };
    attachAbilityNoticePositionListener = (): void => {
        if (this.abilityNoticePositionAttached)
            return;
        window.addEventListener("resize", this.syncAbilityNoticePosition);
        this.abilityNoticePositionAttached = true;
    };
    detachAbilityNoticePositionListener = (): void => {
        if (!this.abilityNoticePositionAttached)
            return;
        window.removeEventListener("resize", this.syncAbilityNoticePosition);
        this.abilityNoticePositionAttached = false;
    };
    removeAbilityNotice = (node: HTMLElement): void => {
        const timers = this.abilityNoticeTimers.get(node);
        if (timers) {
            window.clearTimeout(timers.expire);
            window.clearTimeout(timers.remove);
            this.abilityNoticeTimers.delete(node);
        }
        node.remove();
    };
    expireAbilityNotice = (node: HTMLElement): void => {
        if (!node.isConnected) {
            this.removeAbilityNotice(node);
            return;
        }
        node.classList.add("leaving");
        const remove = window.setTimeout(() => this.removeAbilityNotice(node), ABILITY_NOTICE_LEAVE_MS);
        const timers = this.abilityNoticeTimers.get(node);
        if (timers)
            this.abilityNoticeTimers.set(node, { ...timers, remove });
    };
    enqueueAbilityNotices = (notices: readonly AbilityNotice[]): void => {
        if (notices.length === 0)
            return;
        const container = this.abilityNoticeContainer();
        this.syncAbilityNoticePosition();
        for (const notice of notices) {
            const existing = notice.tone === "notification" && [...container.children].find((node): node is HTMLElement => node instanceof HTMLElement
                && node.dataset.owner === notice.owner && node.dataset.tone === notice.tone && node.textContent === notice.text);
            if (existing) {
                const timers = this.abilityNoticeTimers.get(existing);
                if (timers) {
                    window.clearTimeout(timers.expire);
                    window.clearTimeout(timers.remove);
                }
                existing.classList.remove("leaving");
                container.prepend(existing);
                const expire = window.setTimeout(() => this.expireAbilityNotice(existing), ABILITY_NOTICE_TTL_MS);
                this.abilityNoticeTimers.set(existing, { expire, remove: 0 });
                continue;
            }
            const node = document.createElement("div");
            node.className = `ability-notice ability-notice-${notice.tone}`;
            node.dataset.owner = notice.owner;
            node.dataset.tone = notice.tone;
            node.setAttribute("role", "status");
            node.textContent = notice.text;
            node.addEventListener("animationend", (event) => {
                if (event.animationName === "ability-notice-leave")
                    this.removeAbilityNotice(node);
            });
            container.prepend(node);
            const expire = window.setTimeout(() => this.expireAbilityNotice(node), ABILITY_NOTICE_TTL_MS);
            this.abilityNoticeTimers.set(node, { expire, remove: 0 });
            while (container.childElementCount > MAX_ABILITY_NOTICES) {
                const oldest = container.lastElementChild;
                if (oldest instanceof HTMLElement)
                    this.removeAbilityNotice(oldest);
                else
                    break;
            }
        }
    };
    enqueueNotification = (text: string): void => {
        this.enqueueAbilityNotices([{ owner: "system", tone: "notification", text }]);
    };
    clearAbilityNoticeQueue = (): void => {
        for (const node of [...this.abilityNoticeTimers.keys()])
            this.removeAbilityNotice(node);
        document.querySelectorAll("#ability-notices .ability-notice").forEach((node) => node.remove());
    };
    present = (text: string, tone = "normal", durationMs = 1000): void => {
        const node = document.querySelector<HTMLDivElement>("#presentation");
        if (!node)
            return;
        node.textContent = text;
        node.dataset.tone = tone;
        node.classList.remove("show");
        window.clearTimeout(this.presentationTimer);
        window.clearTimeout(this.presentationHideTimer);
        if (!this.deps.save.settings.reducedMotion)
            document.body.classList.add("shake");
        this.presentationTimer = window.setTimeout(() => { node.classList.add("show"); document.body.classList.remove("shake"); }, this.deps.save.settings.reducedMotion ? 0 : 40);
        this.presentationHideTimer = window.setTimeout(() => { node.textContent = node.dataset.default ?? ""; node.dataset.tone = "normal"; node.classList.remove("show"); document.body.classList.remove("shake"); }, durationMs);
    };
    presentDelta = ({ after, events }: MatchTransition): void => {
        const triggerWindowOpened = events.some((event) => event.type === "ROUND_RESULT_ACKNOWLEDGED")
            && (after.round.phase === "roulette-reaction" || after.round.phase === "roulette-trigger");
        const triggerPreview = triggerWindowOpened ? previewPendingTrigger(after) : null;
        const abilityNotices = after.scene === "match" && after.view === "table"
            ? [
                ...abilityTriggerNotice(events, this.deps.currentCharacter.name, after),
                ...(triggerPreview ? pendingTriggerAbilityNotices(triggerPreview, this.deps.currentCharacter.name) : []),
                ...abilityExpiredNotices(events)
            ]
            : [];
        if (abilityNotices.length > 0)
            this.enqueueAbilityNotices(abilityNotices);
        const trigger = events.find((candidate) => candidate.type === "TRIGGER_PULLED");
        if (trigger)
            this.present(triggerResultText(trigger, events.some(event => event.type === "DEFEAT_PREVENTED" && event.actor === trigger.actor)), trigger.fired ? "danger" : "gold");
        if (legal(after, { type: "OPEN_SKILL_DRAW" }))
            this.deps.offerTutorial("skill-draw-available");
    };
}
