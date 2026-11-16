import { z } from "zod";
import { PLUGIN_MAIN_MENU_QUOTE_API_VERSION, PLUGIN_UI_API_VERSION } from "./plugin-version";
import type { MountedScreen } from "../../runtime/contracts";

export type PluginUiSlot = "main-menu.secondary" | "main-menu.tools";

/** A fresh page context; no host root, mutable save or shared resource manager. */
export interface PluginUiPageContext {
  readonly container: HTMLDivElement;
  navigateToMenu(): Promise<void>;
  alert(title: string, message: string): Promise<void>;
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
}

export interface PluginUiAction {
  /** Unique within this runtime contribution, independent of other packages. */
  readonly id: string;
  readonly slot: PluginUiSlot;
  readonly label: string;
  readonly description?: string;
  /** Plain text symbol. The host owns button markup and styles. */
  readonly icon?: string;
  /** Ascending; ties retain module load order. Defaults to 100. */
  readonly order?: number;
  mount(context: PluginUiPageContext, signal: AbortSignal): MountedScreen | Promise<MountedScreen>;
}

const actionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(80),
  slot: z.enum(["main-menu.secondary", "main-menu.tools"]),
  label: z.string().trim().min(1).max(80),
  description: z.string().max(160).optional(),
  icon: z.string().max(16).optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
  mount: z.custom<PluginUiAction["mount"]>(value => typeof value === "function")
}).strict();

export function validatePluginUiActions(actions: unknown, apiVersion: number): readonly PluginUiAction[] | undefined {
  if (actions === undefined) return undefined;
  if (apiVersion < PLUGIN_UI_API_VERSION) throw new Error("UI 接入点必须使用插件 API 8");
  const parsed = z.array(actionSchema).max(32).parse(actions);
  const ids = new Set<string>();
  for (const action of parsed) {
    if (ids.has(action.id)) throw new Error(`UI 入口 ID 重复：${action.id}`);
    ids.add(action.id);
  }
  return parsed;
}

/** Host-rendered lines; no HTML, DOM access or package-specific presentation. */
export interface PluginMainMenuQuote {
  /** Empty lines explicitly hide the quotation. */
  readonly lines: readonly { readonly text: string; readonly emphasis?: boolean }[];
}

export function validatePluginMainMenuQuote(quote: unknown, apiVersion: number): PluginMainMenuQuote | undefined {
  if (quote === undefined) return undefined;
  if (apiVersion < PLUGIN_MAIN_MENU_QUOTE_API_VERSION) throw new Error("主菜单名言必须使用插件 API 13");
  const mainMenuQuoteSchema = z.object({
    lines: z.array(z.object({
      text: z.string().trim().min(1).max(500),
      emphasis: z.boolean().optional()
    }).strict()).max(8)
  }).strict();
  return mainMenuQuoteSchema.parse(quote);
}

/** Later contributions override earlier ones; undefined leaves the current value alone. */
export function collectMainMenuQuote(contributions: readonly { readonly mainMenuQuote?: PluginMainMenuQuote }[]): PluginMainMenuQuote | undefined {
  return contributions.reduce<PluginMainMenuQuote | undefined>((quote, contribution) => contribution.mainMenuQuote ?? quote, undefined);
}

/** Matches resource-manager priority: saved order first, remaining package IDs ascending. */
export function selectMainMenuQuote(
  modules: readonly { readonly packageId: string; readonly contribution: { readonly mainMenuQuote?: PluginMainMenuQuote } }[],
  order: readonly string[]
): PluginMainMenuQuote | undefined {
  const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  const ordered = [...modules].sort((a, b) => rank(a.packageId) - rank(b.packageId) || a.packageId.localeCompare(b.packageId));
  return ordered.find(module => module.contribution.mainMenuQuote !== undefined)?.contribution.mainMenuQuote;
}
