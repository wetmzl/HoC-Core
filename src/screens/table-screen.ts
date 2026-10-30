import { skillSheetMarkup } from "../presentation/skill-sheet";
import { skillMetadata } from "../presentation/skill-copy";
import { TableLayers } from "../presentation/table-layers";
import { mountCharacterIntel } from "../presentation/character-intel";
import { mountTableSurface } from "../presentation/table-surface";
import { mountSkillDrawer } from "../presentation/table-drawers";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, getCharacterMetadata, loadCharacter, type CharacterDefinition } from "../content/characters";
import type { Action, MatchState } from "../core/match/types";
import { getPlayerSkillDefinition } from "../core/skills/definitions";
import { characterImageIdentity, prepareCharacterImageHitTest, visibleCharacterImagePoint } from "../presentation/character-interaction";
import { displayContentMarkup, displayText } from "../presentation/displays";
import { HandScrollController } from "../presentation/hand-scroll";
import { ACTION_LABELS, DEV_CALIBRATION_HASH, DEV_REVOLVER_KEY, EVENT_LABELS, REVOLVER_REFERENCE_ART_HEIGHT, cardLabel, decisionLabel, escapeHtml, phaseLabel, wireActions } from "../presentation/view-helpers";
import { STAFF_REVOLVER_URL } from "../resources/cache-policy";
import { projectTableView } from "./table-view";
interface DevRevolverEntry extends DevRevolverOffset {
    readonly baseTop: number;
    readonly baseLeft: number;
}
interface DevRevolverOffset {
    readonly top: number;
    readonly left: number;
}
export interface TableScreenDependencies {
    exitEncounter?: () => void;
    readonly encounterPresentation?: import("../presentation/encounter-table").EncounterTablePresentation;
    dispatch: (action: import("../core/match/types").Action) => void;
    root: HTMLDivElement;
    currentCharacter: import("../content/characters/types").CharacterDefinition;
    currentDialogue: () => string;
    dialogueKey: () => string;
    captureDialogue: (text: string, key: string) => import("../presentation/dialogue-presenter").DialogueRenderSnapshot;
    restoreDialogue: (text: string, key: string, snapshot: import("../presentation/dialogue-presenter").DialogueRenderSnapshot) => void;
    dialogueSession: import("../dialogue/session").DialogueSession | undefined;
    portraitState: (state: import("../core/match/types").MatchState) => string;
    tablePortrait: (state: import("../core/match/types").MatchState, character: import("../content/characters/types").CharacterDefinition) => string;
    portraitAlt: (state: import("../core/match/types").MatchState, character: import("../content/characters/types").CharacterDefinition) => string;
    runtimeContributions: readonly import("../content/packages/plugin-contracts").PluginRuntimeContribution[];
    enqueueNotification: (text: string) => void;
    attachFullscreenListener: () => void;
    syncFullscreenButton: () => void;
    syncAbilityNoticePosition: () => void;
    toggleFullscreen: () => void;
    save: import("../persistence/schema").LongTermSave;
    lastAction: import("../core/match/types").Action | null;
    lastDomainEvent: import("../core/match/types").GameEvent["type"] | null;
}
export class TableScreen {
    private generation = 0;
    private skillDrawer?: ReturnType<typeof mountSkillDrawer>;
    private readonly layers = new TableLayers();
    private tableSurface?: ReturnType<typeof mountTableSurface>;
    private thinkingTimer: number | undefined;
    showThinking = (): void => {
        this.deps.dialogueSession?.beginThinking();
        const portrait = this.deps.root.querySelector<HTMLImageElement>(".character-portrait");
        const override = this.deps.dialogueSession?.isThinking ? undefined : this.deps.dialogueSession?.peek().portrait;
        const character = this.deps.currentCharacter;
        if (portrait) {
            portrait.src = override?.image ?? character.assets.conflicted;
            portrait.alt = override?.alt ?? (character.name + " 正在思考中……");
            portrait.classList.add("character-shake");
            window.clearTimeout(this.thinkingTimer);
            this.thinkingTimer = window.setTimeout(() => portrait.classList.remove("character-shake"), 360);
        }
        const waiting = this.deps.root.querySelector<HTMLElement>("#ai-wait");
        if (waiting) {
            waiting.textContent = (character.name + " 正在思考中……");
            waiting.dataset.step = "shifted";
        }
    };
    dispose = (): void => {
        this.generation++;
        this.skillDrawer?.dispose();
        this.layers.reset();
        this.tableSurface?.dispose();
        window.clearTimeout(this.thinkingTimer);
        this.handScroll.dispose();
        if (this.devRevolverKeyHandler)
            window.removeEventListener("keydown", this.devRevolverKeyHandler);
        this.devRevolverKeyHandler = undefined;
        this.devRevolverKeysAttached = false;
    };
    constructor(private readonly deps: TableScreenDependencies) { this.devRevolverOffsets = import.meta.env.DEV ? this.readDevRevolverOffsets() : {}; }
    handScroll: HandScrollController = new HandScrollController();
    skillDrawerOpen: boolean = false;
    requestDispatch = (action: Action): void => { this.deps.dispatch(action); };
    revolverPlacementRatios = (placement: {
        readonly top: number;
        readonly left: number;
    }): {
        readonly top: number;
        readonly left: number;
    } => {
        const round = (value: number): number => Math.round(value * 1e5) / 1e5;
        return { top: round(placement.top / REVOLVER_REFERENCE_ART_HEIGHT), left: round(placement.left / REVOLVER_REFERENCE_ART_HEIGHT) };
    };
    revolverPlacementStyle = (placement: {
        readonly top: number;
        readonly left: number;
    }): string => {
        const ratios = this.revolverPlacementRatios(placement);
        return `--revolver-top-ratio:${ratios.top};--revolver-left-ratio:${ratios.left};`;
    };
    devRevolverOffsets: Record<string, DevRevolverEntry> = {};
    devRevolverKeysAttached: boolean = false;
    devRevolverKeyHandler: ((event: KeyboardEvent) => void) | undefined;
    readDevRevolverOffsets = (): Record<string, DevRevolverEntry> => {
        try {
            const parsed: unknown = JSON.parse(window.localStorage.getItem(DEV_REVOLVER_KEY) ?? "{}");
            if (!parsed || typeof parsed !== "object")
                return {};
            const result: Record<string, DevRevolverEntry> = {};
            for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
                const entry = value as {
                    top?: unknown;
                    left?: unknown;
                    baseTop?: unknown;
                    baseLeft?: unknown;
                } | null;
                if (entry && typeof entry.top === "number" && typeof entry.left === "number" && typeof entry.baseTop === "number" && typeof entry.baseLeft === "number") {
                    result[id] = { top: entry.top, left: entry.left, baseTop: entry.baseTop, baseLeft: entry.baseLeft };
                }
            }
            return result;
        }
        catch {
            return {};
        }
    };
    devRevolverOffset = (character: CharacterDefinition): DevRevolverOffset => {
        const entry = this.devRevolverOffsets[character.id];
        if (!entry || entry.baseTop !== character.revolverPlacement.top || entry.baseLeft !== character.revolverPlacement.left)
            return { top: 0, left: 0 };
        return { top: entry.top, left: entry.left };
    };
    saveDevRevolverOffsets = (): void => {
        try {
            window.localStorage.setItem(DEV_REVOLVER_KEY, JSON.stringify(this.devRevolverOffsets));
        }
        catch { /* 隐私模式或配额不足时忽略 */ }
    };
    devPlacement = (character: CharacterDefinition): DevRevolverOffset => {
        if (!import.meta.env.DEV)
            return character.revolverPlacement;
        const offset = this.devRevolverOffset(character);
        return { top: character.revolverPlacement.top + offset.top, left: character.revolverPlacement.left + offset.left };
    };
    nudgeDevRevolver = (character: CharacterDefinition, top: number, left: number): void => {
        const current = this.devRevolverOffset(character);
        const round = (value: number): number => Math.round(value * 10) / 10;
        this.devRevolverOffsets = {
            ...this.devRevolverOffsets,
            [character.id]: {
                top: round(current.top + top),
                left: round(current.left + left),
                baseTop: character.revolverPlacement.top,
                baseLeft: character.revolverPlacement.left
            }
        };
        this.saveDevRevolverOffsets();
    };
    resetDevRevolver = (id: string): void => {
        const next: Record<string, DevRevolverEntry> = { ...this.devRevolverOffsets };
        delete next[id];
        this.devRevolverOffsets = next;
        this.saveDevRevolverOffsets();
    };
    devRevolverReport = (character: CharacterDefinition): string => {
        const placement = this.devPlacement(character);
        const lines = [`// dev 左轮标定：${character.name}(${character.id})`, `"revolverPlacement": { "top": ${placement.top}, "left": ${placement.left} },`, this.devRevolverArtReference(character), "", "// 各角色偏移（相对当前 JSON 基准值）"];
        for (const [id, offset] of Object.entries(this.devRevolverOffsets))
            lines.push(`${id}: top ${offset.top >= 0 ? "+" : ""}${offset.top}, left ${offset.left >= 0 ? "+" : ""}${offset.left}（基准 ${offset.baseTop}/${offset.baseLeft}）`);
        return lines.join("\n");
    };
    devRevolverArtReference = (character: CharacterDefinition): string => {
        const portrait = this.deps.root.querySelector<HTMLImageElement>("img.character-portrait");
        if (!portrait || !portrait.naturalWidth)
            return "";
        const scale = Math.min(portrait.offsetWidth / portrait.naturalWidth, portrait.offsetHeight / portrait.naturalHeight);
        const artHeight = portrait.naturalHeight * scale;
        if (!(artHeight > 0))
            return "";
        const placement = this.devPlacement(character);
        const factor = artHeight / REVOLVER_REFERENCE_ART_HEIGHT;
        const round = (value: number): number => Math.round(value * 10) / 10;
        return `立绘实体 ${Math.round(portrait.naturalWidth * scale)}×${Math.round(artHeight)}px · 实际偏移 top ${round(placement.top * factor)} / left ${round(placement.left * factor)}px · 写入 JSON 的参考值 top ${placement.top} / left ${placement.left}`;
    };
    applyDevRevolver = (character: CharacterDefinition, prop: HTMLImageElement): void => {
        const placement = this.devPlacement(character);
        const ratios = this.revolverPlacementRatios(placement);
        prop.style.setProperty("--revolver-top-ratio", String(ratios.top));
        prop.style.setProperty("--revolver-left-ratio", String(ratios.left));
        const offset = this.devRevolverOffset(character);
        const readout = this.deps.root.querySelector<HTMLElement>("[data-dev-revolver-readout]");
        if (readout)
            readout.textContent = `top ${placement.top} / left ${placement.left}（基准 ${character.revolverPlacement.top}/${character.revolverPlacement.left}，偏移 ${offset.top}/${offset.left}）`;
        const artNote = this.deps.root.querySelector<HTMLElement>("[data-dev-revolver-art]");
        if (artNote)
            artNote.textContent = this.devRevolverArtReference(character);
    };
    attachDevRevolverTool = (character: CharacterDefinition): void => {
        if (!import.meta.env.DEV)
            return;
        if (!this.devRevolverKeysAttached) {
            this.devRevolverKeysAttached = true;
            this.devRevolverKeyHandler = (event) => {
                if (!import.meta.env.DEV)
                    return;
                const prop = this.deps.root.querySelector<HTMLImageElement>("img.trigger-prop");
                if (!prop)
                    return;
                const target = event.target as HTMLElement | null;
                if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable))
                    return;
                const step = event.shiftKey ? 5 : 1;
                const delta = event.key === "ArrowUp" ? { top: -step, left: 0 }
                    : event.key === "ArrowDown" ? { top: step, left: 0 }
                        : event.key === "ArrowLeft" ? { top: 0, left: -step }
                            : event.key === "ArrowRight" ? { top: 0, left: step }
                                : null;
                if (delta) {
                    event.preventDefault();
                    this.nudgeDevRevolver(this.deps.currentCharacter, delta.top, delta.left);
                    this.applyDevRevolver(this.deps.currentCharacter, prop);
                    return;
                }
                if (event.key === "r" || event.key === "R") {
                    event.preventDefault();
                    this.resetDevRevolver(this.deps.currentCharacter.id);
                    this.applyDevRevolver(this.deps.currentCharacter, prop);
                    return;
                }
                if (event.key === "c" || event.key === "C")
                    void navigator.clipboard?.writeText(this.devRevolverReport(this.deps.currentCharacter));
            };
            window.addEventListener("keydown", this.devRevolverKeyHandler);
        }
        const prop = this.deps.root.querySelector<HTMLImageElement>("img.trigger-prop");
        const main = this.deps.root.querySelector("main");
        if (!prop || !main)
            return;
        const panel = document.createElement("aside");
        panel.id = "dev-revolver";
        panel.style.cssText = "position:fixed;top:8px;left:8px;z-index:9999;display:grid;gap:6px;padding:8px 10px;border:1px solid #65d6e3;border-radius:10px;background:#0b1622f2;color:#d8f4f8;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:min(94vw,460px);pointer-events:none";
        panel.innerHTML = `<strong>左轮标定（dev）</strong><span data-dev-revolver-readout></span><span data-dev-revolver-art style="opacity:.85"></span><span style="opacity:.75">方向键 1px · Shift+方向 5px · R 重置本角色 · C 复制结果</span><button type="button" data-dev-revolver-copy style="justify-self:start;pointer-events:auto">复制当前数值</button>`;
        panel.querySelector<HTMLButtonElement>("[data-dev-revolver-copy]")?.addEventListener("click", () => { void navigator.clipboard?.writeText(this.devRevolverReport(character)); });
        main.append(panel);
        this.applyDevRevolver(character, prop);
    };
    devCalibrationCharacterId = (): string | null => {
        if (!import.meta.env.DEV)
            return null;
        const hash = window.location.hash;
        if (!hash.startsWith(DEV_CALIBRATION_HASH))
            return null;
        const id = hash.slice(DEV_CALIBRATION_HASH.length).replace(/^\/+/, "");
        return getCharacterMetadata(id) ? id : DEFAULT_CHARACTER_ID;
    };
    renderDevRevolverCalibration = async (): Promise<void> => {
        const id = this.devCalibrationCharacterId();
        if (!id)
            return;
        this.tableSurface?.dispose();
        const generation = ++this.generation;
        const character = await loadCharacter(id);
        if (generation !== this.generation) return;
        this.deps.currentCharacter = character;
        const placement = this.devPlacement(character);
        const options = CHARACTER_CATALOG.map((meta) => `<option value="${escapeHtml(meta.id)}"${meta.id === id ? " selected" : ""}>${escapeHtml(meta.name)}</option>`).join("");
        this.deps.root.innerHTML = `<main class="table-shell" data-phase="roulette-trigger"><header class="table-top"><div><span class="eyebrow">标定模式 // dev</span><h1>左轮标定</h1></div><div class="table-actions"><label class="eyebrow">与会者 <select data-dev-calibration-select>${options}</select></label></div></header><section class="opponent-zone"><div class="character-strip"><img class="character-portrait scaled-character-art portrait-trigger" style="--character-art-scale:${character.portraitScales.table}" src="${character.assets.threatened}" alt="${escapeHtml(character.name)} 紧张态立绘" /><img class="trigger-prop" style="${this.revolverPlacementStyle(placement)}--art-scale:${character.portraitScales.table}" src="${STAFF_REVOLVER_URL}" alt="工作人员用 7mm 左轮对准 ${escapeHtml(character.name)} 的太阳穴" /><div><span class="eyebrow">${escapeHtml(character.name)}</span><p class="dialogue">方向键把枪口对到太阳穴，下拉切换与会者</p></div></div></section></main>`;
        this.deps.root.querySelector<HTMLSelectElement>("[data-dev-calibration-select]")?.addEventListener("change", (event) => {
            const next = (event.target as HTMLSelectElement).value;
            window.history.replaceState(null, "", `${DEV_CALIBRATION_HASH}/${next}`);
            void this.renderDevRevolverCalibration();
        });
        this.attachDevRevolverTool(character);
    };
    renderMatch = (state: MatchState): void => {
        this.generation++;
        this.tableSurface?.dispose();
        this.handScroll.capture();
        const character = this.deps.currentCharacter;
        const dialogue = this.deps.currentDialogue();
        const key = this.deps.dialogueKey();
        const snapshot = this.deps.captureDialogue(dialogue, key);
        const portraitFocused = document.activeElement === this.deps.root.querySelector(".character-portrait");
        const previousIntel = this.deps.root.querySelector<HTMLDetailsElement>(".character-intel");
        const intelState = previousIntel ? { seed: previousIntel.dataset.matchSeed, open: previousIntel.open,
            scroll: previousIntel.querySelector(".character-intel-scroll")?.scrollTop ?? 0,
            expandedSkills: Array.from(previousIntel.querySelectorAll<HTMLDetailsElement>("details.skill-sheet")).map(skill => skill.open) } : undefined;
        const previousDisplayPanel = this.deps.root.querySelector<HTMLElement>(".display-panel");
        const sameDisplayMatch = previousDisplayPanel?.dataset.matchSeed === state.seed;
        const displayScrollTop = sameDisplayMatch ? previousDisplayPanel.querySelector(".display-scroll")?.scrollTop ?? 0 : 0;
        const skillPosition = this.skillDrawerOpen ? this.skillDrawer?.position ?? "end" : 0;
        this.skillDrawer?.dispose();
        const { html, totalSkills, displays, shoeInfoDialog } = projectTableView({
            state, character, dialogueSelection: this.deps.dialogueSession!.peek(), dialogueMarkup: snapshot.markup,
            thinking: this.deps.dialogueSession!.isThinking,
            portraitState: this.deps.portraitState(state), portraitUrl: this.deps.tablePortrait(state, character),
            portraitAlt: this.deps.portraitAlt(state, character), skillDrawerOpen: this.skillDrawerOpen,
            encounter: this.deps.encounterPresentation,
            debugMarkup: this.devHud(state)
        });
        this.deps.root.innerHTML = html;
        mountCharacterIntel(this.deps.root, state.seed, intelState);
        const portraitOverride = this.deps.dialogueSession!.peek().portrait;
        const tablePortrait = portraitOverride?.anchorY !== undefined ? {
            ...character.tablePortrait,
            anchorY: character.tablePortrait?.anchorY ?? 1,
            images: [...(character.tablePortrait?.images ?? []).filter(entry => entry.image !== portraitOverride.image), { ...character.tablePortrait?.images?.find(entry => entry.image === portraitOverride.image), image: portraitOverride.image, anchorY: portraitOverride.anchorY }]
        } : character.tablePortrait;
        this.tableSurface = mountTableSurface(this.deps.root, tablePortrait);
        this.layers.mount(this.deps.root, state.seed, key);
        const portraitImage = this.deps.root.querySelector<HTMLImageElement>("img.character-portrait");
        if (portraitImage) {
            prepareCharacterImageHitTest(portraitImage);
            portraitImage.addEventListener("load", () => prepareCharacterImageHitTest(portraitImage), { once: true });
            portraitImage.tabIndex = 0;
            portraitImage.setAttribute("role", "button");
            if (portraitFocused)
                portraitImage.focus({ preventScroll: true });
            const session = this.deps.dialogueSession;
            const activate = (point: {
                x: number;
                y: number;
            } | null) => {
                if (session !== this.deps.dialogueSession)
                    return;
                this.layers.bringForward("character");
                if (!this.deps.runtimeContributions.some(c => c.dialogueSource)) return;
                const image = characterImageIdentity(portraitImage.src);
                if (!image)
                    return;
                session?.interact({ characterId: character.id, image, x: point?.x ?? null, y: point?.y ?? null });
            };
            portraitImage.addEventListener("click", event => {
                if (event.detail === 0) {
                    activate(null);
                    return;
                }
                const point = visibleCharacterImagePoint(portraitImage, event.clientX, event.clientY);
                if (point)
                    activate(point);
                else
                    this.layers.forwardTransparentClick(this.deps.root, event);
            });
            portraitImage.addEventListener("keydown", event => {
                if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
                    event.preventDefault();
                    activate(null);
                }
            });
        }
        this.deps.root.querySelector("main")?.insertAdjacentHTML("beforeend", shoeInfoDialog);
        this.handScroll.mount(this.deps.root, state);
        wireActions(this.deps.root, this.requestDispatch);
        this.deps.root.querySelector<HTMLButtonElement>("[data-copy-debug]")?.addEventListener("click", () => { const text = this.deps.root.querySelector<HTMLTextAreaElement>("#debug-json")?.value ?? ""; void navigator.clipboard?.writeText(text); });
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-skill-blocked]").forEach((button) => button.addEventListener("click", () => this.deps.enqueueNotification("技能被禁用")));
        this.deps.attachFullscreenListener();
        this.deps.syncFullscreenButton();
        this.deps.syncAbilityNoticePosition();
        this.deps.root.querySelector<HTMLButtonElement>("[data-exit-encounter]")?.addEventListener("click", () => this.deps.exitEncounter?.());
        this.deps.root.querySelector<HTMLButtonElement>("[data-fullscreen]")?.addEventListener("click", this.deps.toggleFullscreen);
        this.skillDrawer = mountSkillDrawer(this.deps.root, skillPosition, totalSkills, open => { this.skillDrawerOpen = open; });
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-skill-info]").forEach((button) => button.addEventListener("click", () => {
            const skill = getPlayerSkillDefinition(button.dataset.skillInfo ?? "", state.abilities.instances.find(instance => instance.instanceId === button.dataset.skillInfoInstance)?.level);
            const dialog = this.deps.root.querySelector<HTMLDialogElement>("#skill-info-dialog");
            if (!skill || !dialog)
                return;
            const kind = this.deps.root.querySelector("#skill-info-kind");
            const body = dialog.querySelector("[data-skill-info-body]");
            const status = this.deps.root.querySelector("#skill-info-status");
            if (kind) kind.textContent = skillMetadata(skill);
            if (body) {
                const source = skill.unlock ? getCharacterMetadata(skill.unlock.opponentId) : undefined;
                body.innerHTML = skillSheetMarkup(skill, { titleId: "skill-info-title" })
                    + (source ? `<p class="skill-info-source">来自 ${escapeHtml(source.name)}</p>` : "");
            }
            if (status) {
                const selectedInstance = state.abilities.instances.find((instance) => instance.instanceId === button.dataset.skillInfoInstance)
                    ?? state.abilities.instances.find((instance) => instance.definitionId === skill.id && instance.owner === "player");
                const instanceTtl = selectedInstance?.ttl;
                const ttl = instanceTtl ?? (skill.ttl ? { type: skill.ttl.type, remaining: skill.ttl.amount } : undefined);
                const ttlText = ttl ? ttl.type === "triggers" ? `，剩余 ${ttl.remaining} 次触发` : `，剩余 ${ttl.remaining} 轮` : "";
                const remainingUses = selectedInstance?.remainingUses ?? skill.uses;
                status.textContent = skill.category === "active"
                    ? skill.uses > 1 ? `主动技能牌：剩余 ${remainingUses} 次发动；归零后消耗此实例` : "主动技能牌：使用后消耗此实例"
                    : `被动技能牌：占用牌库位置并持续生效${ttlText}`;
            }
            dialog.showModal();
        }));
        this.deps.root.querySelector<HTMLButtonElement>("[data-skill-close]")?.addEventListener("click", () => this.deps.root.querySelector<HTMLDialogElement>("#skill-info-dialog")?.close());
        this.deps.root.querySelector<HTMLButtonElement>("[data-shoe-info]")?.addEventListener("click", () => this.deps.root.querySelector<HTMLDialogElement>("#shoe-info-dialog")?.showModal());
        this.deps.root.querySelector<HTMLButtonElement>("[data-shoe-info-close]")?.addEventListener("click", () => this.deps.root.querySelector<HTMLDialogElement>("#shoe-info-dialog")?.close());
        const nextDisplayPanel = this.deps.root.querySelector<HTMLElement>(".display-panel");
        if (nextDisplayPanel) {
            nextDisplayPanel.dataset.matchSeed = state.seed;
            const scroller = nextDisplayPanel.querySelector<HTMLElement>(".display-scroll");
            if (scroller) scroller.scrollTop = displayScrollTop;
            this.deps.syncAbilityNoticePosition();
        }
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-display-key]").forEach((button) => button.addEventListener("click", () => {
            const display = displays.find((entry) => entry.key === button.dataset.displayKey);
            const dialog = this.deps.root.querySelector<HTMLDialogElement>("#display-info-dialog");
            if (!display || !dialog)
                return;
            dialog.querySelector("#display-info-title")!.textContent = display.name;
            const current = dialog.querySelector("#display-info-current")!;
            current.innerHTML = displayContentMarkup(display);
            current.setAttribute("aria-label", displayText(display));
            dialog.querySelector("#display-info-description")!.textContent = display.description;
            dialog.showModal();
        }));
        this.deps.root.querySelector<HTMLButtonElement>("[data-display-close]")?.addEventListener("click", () => this.deps.root.querySelector<HTMLDialogElement>("#display-info-dialog")?.close());
        this.deps.restoreDialogue(dialogue, key, snapshot);
    };
    devHud = (state: MatchState): string => {
        if (!import.meta.env.DEV || !new URLSearchParams(window.location.search).has("debug"))
            return "";
        const ai = state.lastAiDecision;
        const text = JSON.stringify({ gameVersion: this.deps.save.gameVersion, seed: state.seed, round: state.roundIndex, phase: state.round.phase, currentActor: state.round.currentActor, relevantMatchState: state, recentActionsOrEvents: state.history.slice(-8), lastAction: this.deps.lastAction, lastDomainEvent: this.deps.lastDomainEvent, aiDecision: ai }, null, 2);
        const profile = state.aiProfile;
        return `<details class="dev-hud" open><summary>开发者面板</summary><dl><dt>种子</dt><dd>${state.seed}</dd><dt>轮次 / 阶段</dt><dd>${state.roundIndex} / ${phaseLabel(state.round.phase)}</dd><dt>当前行动者</dt><dd>${state.round.currentActor === "player" ? "玩家" : state.round.currentActor === "opponent" ? this.deps.currentCharacter.name : "—"}</dd><dt>牌库剩余</dt><dd>${state.shoe.cards.length - state.shoe.cursor}</dd><dt>玩家真实手牌</dt><dd>${state.player.hand.cards.map(cardLabel).join(" ")}</dd><dt>对手真实手牌</dt><dd>${state.opponent.hand.cards.map(cardLabel).join(" ")}</dd><dt>玩家 / 对手子弹</dt><dd>${state.roulette.player.bullets} / ${state.roulette.opponent.bullets}</dd><dt>AI 参数 P / A / B / C</dt><dd>${profile.P} / ${profile.A} / ${profile.B} / ${profile.C}</dd><dt>Rmatch / Rplay</dt><dd>${state.aiNoise.match.toFixed(3)} / ${state.aiNoise.play.toFixed(3)}</dd><dt>技能阈值 bySkill</dt><dd>${ai?.bySkill ?? "—"}</dd><dt>上次手牌值 / 阈值 T</dt><dd>${ai ? `${ai.handValue} / ${ai.threshold.toFixed(3)}` : "—"}</dd><dt>上次子弹差 Bp - Ba</dt><dd>${ai?.bulletDifference ?? "—"}</dd><dt>对手上次决策</dt><dd>${decisionLabel(ai?.action)}</dd><dt>上次行动</dt><dd>${this.deps.lastAction ? ACTION_LABELS[this.deps.lastAction.type] : "—"}</dd><dt>上次领域事件</dt><dd>${this.deps.lastDomainEvent ? EVENT_LABELS[this.deps.lastDomainEvent] : "—"}</dd></dl><button class="quiet-button" data-copy-debug>复制调试状态</button><textarea id="debug-json" readonly hidden>${escapeHtml(text)}</textarea></details>`;
    };
}
