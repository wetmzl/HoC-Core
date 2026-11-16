import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { version } from "../../package.json";
import { IndexedDbSaveStorageDriver } from "../persistence/dexie-repository";
import { CapacitorFileSaveStorageDriver } from "../persistence/capacitor-driver";
import { getCharacterMetadata } from "../content/characters/catalog";
import { TelemetryClient } from "./client";
import type { ClientMetadata } from "./types";

let active: TelemetryClient | undefined, initialized = false;
const packages = new Map<string, { package_id: string; package_version: string; package_name?: string }>();
let achievementCatalog: readonly { readonly key: string; readonly definition: { readonly revision: number } }[] = Object.freeze([]);
/** Keep current activation metadata even while consent is off; only the client decides what may queue. */
export function setTelemetryAchievementCatalog(entries: readonly { readonly key: string; readonly definition: { readonly revision: number } }[]): void {
  achievementCatalog = Object.freeze(entries.map(entry => Object.freeze({ key: entry.key, definition: Object.freeze({ revision: entry.definition.revision }) })));
  void gameTelemetry()?.recordAchievementCatalog(achievementCatalog).catch(() => undefined);
}
export function telemetryConfigured(): boolean { return Boolean(import.meta.env.VITE_HOC_TELEMETRY_ENDPOINT?.trim()); }
export function setTelemetryPackages(entries: Readonly<Record<string, { package_id: string; package_version: string; package_name?: string }>>): void {
  packages.clear(); for (const [id, value] of Object.entries(entries)) packages.set(id, value);
}
function clientMetadata(): ClientMetadata {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /(?:Edg|Chrome|Firefox|Version)\/(\d+)/.exec(ua);
  return { type: Capacitor.isNativePlatform() ? "android" : typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches ? "pwa" : "web",
    os: /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "unknown",
    browser: /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chromium" : /Safari\//.test(ua) ? "Safari" : "unknown",
    browser_major: browser?.[1] ?? "", locale: (typeof navigator === "undefined" ? "" : navigator.language).slice(0, 32) };
}
export function gameTelemetry(): TelemetryClient | undefined {
  if (initialized) return active;
  initialized = true;
  const endpoint = import.meta.env.VITE_HOC_TELEMETRY_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  const environment = import.meta.env.VITE_HOC_TELEMETRY_ENVIRONMENT ?? (import.meta.env.DEV ? "development" : "production");
  if (!["production", "test", "development"].includes(environment)) return undefined;
  try {
    active = new TelemetryClient({ endpoint, fallbackEndpoint: import.meta.env.VITE_HOC_TELEMETRY_FALLBACK_ENDPOINT?.trim() || undefined,
      environment: environment as "production" | "test" | "development",
      gameVersion: version, buildId: (import.meta.env.VITE_HOC_BUILD_ID ?? "").slice(0, 80), client: clientMetadata(),
      getAchievementCatalog: () => achievementCatalog,
      driver: Capacitor.isNativePlatform() ? new CapacitorFileSaveStorageDriver(undefined, undefined, `telemetry/${environment}`, true)
        : new IndexedDbSaveStorageDriver(`house-of-chances-telemetry-${environment}`),
      opponent: id => ({ id, name: getCharacterMetadata(id)?.name ?? id, ...packages.get(id) }) });
    const client = active;
    if (typeof window !== "undefined") window.addEventListener("online", () => client.kick());
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { void client.setVisible(!document.hidden).catch(() => undefined); });
    if (Capacitor.isNativePlatform()) void App.addListener("appStateChange", ({ isActive }) => { void client.setVisible(isActive).catch(() => undefined); }).catch(() => undefined);
    return active;
  } catch { console.warn("玩法统计不可用，游戏照常运行。"); return undefined; }
}
export function telemetrySettingsMarkup(): string {
  return `<label class="setting launcher-telemetry-toggle"><input type="checkbox" data-launcher-telemetry disabled> 匿名玩法统计</label><p class="status-line" data-telemetry-status role="status"></p>`;
}

/** Loading consent must not enqueue app_started or require a running game. */
export function mountTelemetryControls(root: HTMLElement): () => void {
  const input = root.querySelector<HTMLInputElement>("[data-launcher-telemetry]");
  const status = root.querySelector<HTMLElement>("[data-telemetry-status]");
  if (!input || !status) return () => {};
  const events = new AbortController();
  const client = gameTelemetry();
  if (!client) { input.title = "当前客户端未启用统计服务"; return () => {}; }
  const initialize = async () => {
    try {
      await client.ready();
      if (events.signal.aborted) return;
      input.checked = client.enabled; input.disabled = false;
    } catch { if (!events.signal.aborted) status.textContent = "无法读取统计偏好，请关闭设置后重试。"; }
  };
  input.addEventListener("change", async () => {
    input.disabled = true; status.textContent = "正在保存…";
    try { await client.setEnabled(input.checked); if (!events.signal.aborted) status.textContent = "统计偏好已保存。"; }
    catch { if (!events.signal.aborted) status.textContent = "统计偏好保存失败，请重试。"; }
    finally { if (!events.signal.aborted) { input.checked = client.enabled; input.disabled = false; } }
  }, { signal: events.signal });
  void initialize();
  return () => events.abort();
}
