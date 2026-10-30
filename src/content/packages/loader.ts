import type { HocpkgManifest, HocpkgResourceDescriptor } from "./schema";
import type { HocpkgResourceHandler } from "./resources";
import { assertContentJsonBudget } from "./json-budget";
import { assertPresentationReferencesAllowed, createPresentationResolver, type CharacterPresentation, type PresentationContext } from "./character-presentation";

export type HocpkgResourceState = "active" | "dormant" | "blocked" | "invalid";
export type HocpkgResourceReason = "handler-missing" | "api-version-unsupported" | "dependency-unavailable" | "payload-invalid";

export interface HocpkgResourceResult {
  readonly descriptor: HocpkgResourceDescriptor;
  readonly state: HocpkgResourceState;
  readonly reason?: HocpkgResourceReason;
  readonly value?: unknown;
  readonly error?: string;
  readonly presentation?: PresentationContext;
}

export interface LoadHocpkgResourcesOptions {
  /** Runtime access filter. Omit for authoring validation and previews of all variants. */
  readonly skinUnlocks?: Readonly<Record<string, boolean>>;
  readonly handlers: readonly HocpkgResourceHandler[];
  readonly packageBaseUrl?: string;
  readonly presentation?: PresentationContext;
  resolvePath?(path: string): string | Promise<string>;
  readJson(entry: string, descriptor: HocpkgResourceDescriptor): Promise<unknown>;
}

function normalizedPackageBaseUrl(value: string): URL {
  const base = new URL(value, "https://character-card.invalid/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

export function resolveHocpkgPath(packageBaseUrl: string, path: string): string {
  const base = normalizedPackageBaseUrl(packageBaseUrl);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) throw new Error(`资源路径越出角色包：${path}`);
  return packageBaseUrl.startsWith("/") ? `${resolved.pathname}${resolved.search}${resolved.hash}` : resolved.href;
}

export async function loadHocpkgResources(
  manifest: HocpkgManifest,
  options: LoadHocpkgResourcesOptions
): Promise<readonly HocpkgResourceResult[]> {
  const handlers = new Map(options.handlers.map((handler) => [handler.type, handler]));
  const descriptors = new Map(manifest.resources.map((descriptor) => [descriptor.id, descriptor]));
  const results = new Map<string, HocpkgResourceResult>();
  const pending = new Map<string, Promise<HocpkgResourceResult>>();

  const evaluate = async (descriptor: HocpkgResourceDescriptor): Promise<HocpkgResourceResult> => {
    const existing = results.get(descriptor.id);
    if (existing) return existing;
    const dependencies = await Promise.all(descriptor.requires.map((id) => loadOne(descriptors.get(id)!)));
    if (dependencies.some((dependency) => dependency.state !== "active")) {
      const blocked: HocpkgResourceResult = { descriptor, state: "blocked", reason: "dependency-unavailable", error: dependencies.find(d => d.state !== "active" && d.error)?.error };
      results.set(descriptor.id, blocked);
      return blocked;
    }
    const handler = handlers.get(descriptor.type);
    if (!handler) {
      const dormant: HocpkgResourceResult = { descriptor, state: "dormant", reason: "handler-missing" };
      results.set(descriptor.id, dormant);
      return dormant;
    }
    if (!handler.apiVersions.includes(descriptor.apiVersion)) {
      const dormant: HocpkgResourceResult = { descriptor, state: "dormant", reason: "api-version-unsupported", error: descriptor.type === "game.character-dialogue" ? "对白资源需要兼容的 API 2 或 3，请重新打包并导入角色包。" : undefined };
      results.set(descriptor.id, dormant);
      return dormant;
    }
    try {
      const payload = await options.readJson(descriptor.entry, descriptor);
      assertContentJsonBudget(payload);
      const dependenciesById = new Map(dependencies.map((dependency) => [dependency.descriptor.id, dependency.value]));
      const packageBaseUrl = options.packageBaseUrl ?? "/";
      const presentationDependencies = dependencies.filter(dependency => dependency.descriptor.type === "presentation.character");
      if (presentationDependencies.length > 1) throw new Error("一项资源只能依赖一份角色表现声明");
      const presentation = presentationDependencies[0]?.value as CharacterPresentation | undefined;
      const resolvePath = options.resolvePath ?? ((path: string) => resolveHocpkgPath(packageBaseUrl, path));
      const initialSkin = presentation?.skins[0].id;
      const requestedSkin = options.presentation?.skinId;
      const context = presentation ? { ...options.presentation, skinId: presentation.skins.find(skin => skin.id === requestedSkin
        && (options.skinUnlocks === undefined || skin.id === initialSkin || options.skinUnlocks[skin.id] === true))?.id ?? initialSkin } : undefined;
      if (descriptor.type !== "presentation.character") {
        const references = assertPresentationReferencesAllowed(payload, descriptor.type, path => handler.presentationAllows?.(path, descriptor.apiVersion) ?? false);
        if (references && !presentation) throw new Error("表现引用必须声明 presentation.character 依赖");
      }
      if (presentation && descriptor.type === "game.character-match" && descriptor.apiVersion < 13) throw new Error("皮肤角色需要 API 13");
      if (presentation && descriptor.type === "game.character-dialogue" && descriptor.apiVersion < 4) throw new Error("皮肤对白需要 API 4");
      const resolvedPayload = presentation ? await createPresentationResolver(presentation, context!, {
        resolvePath, onFallback: (resourceId, skinId, error) => console.warn("皮肤资源不可用，已回退至首项", { resourceId, skinId, error })
      })(payload) : payload;
      assertContentJsonBudget(resolvedPayload);
      const value = await handler.parse(resolvedPayload, {
        manifest,
        descriptor,
        packageBaseUrl,
        dependencies: dependenciesById,
        presentation: context,
        resolvePath
      });
      const active: HocpkgResourceResult = { descriptor, state: "active", value, ...(context ? { presentation: context } : {}) };
      results.set(descriptor.id, active);
      return active;
    } catch (error) {
      const invalid: HocpkgResourceResult = { descriptor, state: "invalid", reason: "payload-invalid", error: error instanceof Error ? error.message : String(error) };
      results.set(descriptor.id, invalid);
      return invalid;
    }
  };

  const loadOne = (descriptor: HocpkgResourceDescriptor): Promise<HocpkgResourceResult> => {
    const existing = results.get(descriptor.id);
    if (existing) return Promise.resolve(existing);
    const inFlight = pending.get(descriptor.id);
    if (inFlight) return inFlight;
    const task = evaluate(descriptor);
    pending.set(descriptor.id, task);
    return task;
  };

  await Promise.all(manifest.resources.map(loadOne));
  return manifest.resources.map((descriptor) => results.get(descriptor.id)!);
}
