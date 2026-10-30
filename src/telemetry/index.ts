import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { version } from "../../package.json";
import { IndexedDbSaveStorageDriver } from "../persistence/dexie-repository";
import { CapacitorFileSaveStorageDriver } from "../persistence/capacitor-driver";
import { getCharacterMetadata } from "../content/characters/catalog";
import { TelemetryClient } from "./client";
import type { ClientMetadata } from "./types";

let active: TelemetryClient | undefined, initialized = false;
const packages = new Map<string, { package_id: string; package_version: string }>();
export function telemetryConfigured(): boolean { return Boolean(import.meta.env.VITE_HOC_TELEMETRY_ENDPOINT?.trim()); }
export function setTelemetryPackages(entries: Readonly<Record<string, { package_id: string; package_version: string }>>): void {
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
    active = new TelemetryClient({ endpoint, environment: environment as "production" | "test" | "development",
      gameVersion: version, buildId: (import.meta.env.VITE_HOC_BUILD_ID ?? "").slice(0, 80), client: clientMetadata(),
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
  if (!telemetryConfigured()) return "";
  return `<label class="setting"><input type="checkbox" data-setting="telemetryEnabled" ${gameTelemetry()?.enabled ? "checked" : ""} aria-describedby="telemetry-description"> 匿名玩法统计</label><p class="setting-description" id="telemetry-description">向我们上传匿名化的对战摘要，帮助我们更好优化游戏！如果对此在意的话，可以关闭此选项</p>`;
}
