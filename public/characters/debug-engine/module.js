const DEFINITION_ID = "builtin-debug-control";
export function debugInstance(state) {
    return state.abilities.instances.find(instance => instance.definitionId === DEFINITION_ID);
}
export function debugValues(state) {
    const parameters = state && debugInstance(state)?.parameters;
    return {
        playerAdvantage: Number(parameters?.playerAdvantage ?? 0),
        aiAdvantage: Number(parameters?.aiAdvantage ?? 0),
        publicBustLimit: 21 + Number(parameters?.bustBonus ?? 0),
        playerBullets: state?.roulette.player.bullets ?? 0,
        aiBullets: state?.roulette.opponent.bullets ?? 0
    };
}
const fields = [
    ["playerAdvantage", "玩家点数优势"], ["aiAdvantage", "AI 点数优势"],
    ["publicBustLimit", "公共爆牌上限"], ["playerBullets", "玩家左轮装填数"], ["aiBullets", "AI 左轮装填数"]
];
/** Lives outside the redrawn game root so edits preserve the drawer and focus. */
export class DebugEnginePanel {
    options;
    controller = new AbortController();
    host = document.createElement("div");
    handle;
    panel;
    status;
    pointer;
    suppressClick = false;
    open = false;
    previousFocus;
    constructor(options) {
        this.options = options;
        this.host.className = "debug-engine-layer";
        this.host.innerHTML = `<button type="button" class="debug-engine-handle" data-debug-handle aria-label="展开调试引擎" aria-controls="debug-engine-panel" aria-expanded="false"><span></span></button><div class="debug-engine-backdrop" data-debug-backdrop hidden></div><section id="debug-engine-panel" class="debug-engine-panel" role="dialog" aria-modal="true" aria-labelledby="debug-engine-title" hidden><header><div><p>当前对决</p><h2 id="debug-engine-title">调试引擎</h2></div><button type="button" data-debug-close aria-label="收起调试引擎">×</button></header><div class="debug-engine-fields">${fields.map(([field, label]) => `<div class="debug-engine-row" data-debug-field="${field}"><button type="button" data-debug-delta="-10" aria-label="${label}减少10">−10</button><button type="button" data-debug-delta="-1" aria-label="${label}减少1">−1</button><div><span>${label}</span><output></output></div><button type="button" data-debug-delta="1" aria-label="${label}增加1">+1</button><button type="button" data-debug-delta="10" aria-label="${label}增加10">+10</button></div>`).join("")}</div><p class="debug-engine-status" role="status"></p><footer><span>修改仅在本场对决生效</span><button type="button" class="danger-button" data-debug-disable>关闭引擎</button></footer></section>`;
        this.handle = this.host.querySelector("[data-debug-handle]");
        this.panel = this.host.querySelector(".debug-engine-panel");
        this.status = this.host.querySelector(".debug-engine-status");
        document.body.append(this.host);
        const signal = this.controller.signal;
        this.host.addEventListener("click", event => {
            const button = event.target.closest("button");
            if (button === this.handle) {
                if (this.suppressClick && event.detail !== 0) {
                    this.suppressClick = false;
                    return;
                }
                this.suppressClick = false;
                this.setOpen(!this.open);
            }
            else if (button?.hasAttribute("data-debug-close") || event.target.hasAttribute("data-debug-backdrop"))
                this.setOpen(false);
            else if (button?.hasAttribute("data-debug-disable")) {
                button.disabled = true;
                void options.disable().catch(options.error).finally(() => { button.disabled = false; this.refresh(); });
            }
            else if (button?.dataset.debugDelta) {
                const field = button.closest("[data-debug-field]")?.dataset.debugField;
                options.adjust(field, Number(button.dataset.debugDelta));
                this.refresh();
            }
        }, { signal });
        document.addEventListener("pointerdown", event => {
            if (!options.enabled() || event.button !== 0 || document.querySelector("dialog[open]"))
                return;
            const inHeader = event.target.closest(".debug-engine-panel header, .debug-engine-handle");
            if (!inHeader && (this.open || event.clientY > this.handle.getBoundingClientRect().bottom))
                return;
            this.suppressClick = false;
            this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, open: this.open };
            // Capture only our handle/header, never steal other controls' taps.
            if (inHeader)
                event.target.setPointerCapture(event.pointerId);
        }, { signal });
        document.addEventListener("pointerup", event => {
            const start = this.pointer;
            this.pointer = undefined;
            if (!start || start.id !== event.pointerId)
                return;
            const dy = event.clientY - start.y;
            if (Math.abs(dy) < 36 || Math.abs(dy) <= Math.abs(event.clientX - start.x))
                return;
            if ((!start.open && dy > 0) || (start.open && dy < 0)) {
                this.suppressClick = true;
                this.setOpen(!start.open);
            }
        }, { signal });
        document.addEventListener("pointercancel", () => { this.pointer = undefined; }, { signal });
        document.addEventListener("keydown", event => {
            if (!this.open)
                return;
            if (event.key === "Escape") {
                event.preventDefault();
                this.setOpen(false);
            }
            if (event.key === "Tab") {
                const buttons = [...this.panel.querySelectorAll("button:not(:disabled)")];
                const first = buttons[0];
                const last = buttons.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                }
                else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        }, { signal });
        this.refresh();
    }
    isOpen() { return this.open; }
    setOpen(open) {
        open = open && this.options.enabled();
        if (open && document.querySelector("dialog[open]"))
            return;
        if (this.open === open)
            return;
        this.open = open;
        this.panel.hidden = !open;
        this.host.querySelector("[data-debug-backdrop]").hidden = !open;
        this.host.classList.toggle("is-open", open);
        this.handle.setAttribute("aria-expanded", String(open));
        this.handle.setAttribute("aria-label", `${open ? "收起" : "展开"}调试引擎`);
        this.options.gameRoot.inert = open;
        if (open) {
            this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
            this.panel.querySelector("[data-debug-close]").focus();
        }
        else if (this.previousFocus?.isConnected)
            this.previousFocus.focus({ preventScroll: true });
        this.options.openChanged(open);
    }
    refresh() {
        this.host.hidden = !this.options.enabled();
        if (this.host.hidden)
            this.setOpen(false);
        const state = this.options.state();
        const active = state?.status === "active" && state.scene === "match" && state.view === "table";
        const values = debugValues(active ? state : undefined);
        for (const [field] of fields) {
            const row = this.host.querySelector(`[data-debug-field="${field}"]`);
            row.querySelector("output").textContent = String(values[field]);
            row.querySelectorAll("button").forEach(button => {
                const delta = Number(button.dataset.debugDelta);
                const actor = field === "playerBullets" ? "player" : "opponent";
                button.disabled = !active || (field === "publicBustLimit" && delta < 0 && values[field] === 1)
                    || (field.endsWith("Bullets") && (delta < 0 ? values[field] === 0 : values[field] === state?.roulette[actor].capacity));
            });
        }
        this.status.textContent = active ? "点数与上限修正叠加技能效果；装填数即时生效。" : "开始对决后可编辑参数。";
    }
    dispose() {
        this.setOpen(false);
        this.controller.abort();
        this.host.remove();
    }
}
function binding(enabled) { return { definitionId: DEFINITION_ID, enabled, parameters: {} }; }
export function adjustDebug(game, field, delta) {
    const state = game.getMatch();
    if (!state || state.status !== "active" || state.scene !== "match" || state.view !== "table" || !debugInstance(state) || ![-10, -1, 1, 10].includes(delta))
        return;
    const values = debugValues(state);
    if (!Object.hasOwn(values, field))
        return;
    let value = values[field] + delta;
    if (field === "publicBustLimit")
        value = Math.max(1, value);
    const bullets = field === "playerBullets" || field === "aiBullets";
    if (bullets)
        value = Math.max(0, Math.min(state.roulette[field === "playerBullets" ? "player" : "opponent"].capacity, value));
    if (!Number.isSafeInteger(value) || value === values[field])
        return;
    if (bullets)
        game.invokeAbility(DEFINITION_ID, { playerBulletDelta: field === "playerBullets" ? value - values[field] : 0, aiBulletDelta: field === "aiBullets" ? value - values[field] : 0 });
    else
        game.configureAbility({ definitionId: DEFINITION_ID, enabled: true, parameters: { [field === "publicBustLimit" ? "bustBonus" : field]: field === "publicBustLimit" ? value - 21 : value } });
}
export function register(host) {
    const enabled = () => host.settings.get("enabled") === true;
    return { handlers: [], createRuntime() {
            return {
                initialAbilities: () => enabled() ? [binding(true)] : [],
                async mountRuntime(context, signal) {
                    const stored = context.getSave().settings;
                    if (!stored.pluginSettings?.["hoc-core/debug-engine"] && stored.debugEngineEnabled === true)
                        await host.settings.set({ enabled: true });
                    if (signal.aborted)
                        return;
                    let releasePause, taps = 0, lastTap = 0, pending = false, wasActive = false;
                    const error = error => { if (!signal.aborted)
                        void context.alert("调试引擎", error instanceof Error ? error.message : "保存设置失败，请重试。"); };
                    const panel = new DebugEnginePanel({ gameRoot: context.root, enabled, state: context.game.getMatch,
                        adjust: (field, delta) => { if (enabled())
                            adjustDebug(context.game, field, delta); },
                        disable: () => host.settings.set({ enabled: false }), error,
                        openChanged: open => { releasePause?.(); releasePause = open ? context.game.pauseAutoActions() : undefined; }
                    });
                    const sync = () => {
                        const state = context.game.getMatch();
                        const active = state?.status === "active" && state.scene === "match" && state.view === "table";
                        if (active && !!debugInstance(state) !== enabled())
                            context.game.configureAbility(binding(enabled()));
                        if (wasActive && !active)
                            panel.setOpen(false);
                        wasActive = active;
                        panel.refresh();
                    };
                    const offSettings = host.settings.subscribe(sync), offGame = context.game.subscribe(sync);
                    const offVersion = context.onVersionClick(() => {
                        if (pending || enabled() || signal.aborted)
                            return;
                        const now = performance.now();
                        taps = now - lastTap > 1000 ? 1 : taps + 1;
                        lastTap = now;
                        if (taps < 5)
                            return;
                        taps = 0;
                        pending = true;
                        void context.confirm("开启调试引擎", "开启调试引擎会极大影响游戏寿命，是否确认开启", "确认开启")
                            .then(confirmed => confirmed && !signal.aborted ? host.settings.set({ enabled: true }) : undefined)
                            .catch(error).finally(() => { pending = false; });
                    });
                    sync();
                    return () => { offSettings(); offGame(); offVersion(); panel.dispose(); releasePause?.(); };
                }
            };
        } };
}
