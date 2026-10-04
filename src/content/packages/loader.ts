import type { HocpkgManifest, HocpkgResourceDescriptor } from "./schema";
import type { HocpkgResourceHandler } from "./resources";

export type HocpkgResourceState = "active" | "dormant" | "blocked" | "invalid";
export type HocpkgResourceReason = "handler-missing" | "api-version-unsupported" | "dependency-unavailable" | "payload-invalid";

export interface HocpkgResourceResult {
  readonly descriptor: HocpkgResourceDescriptor;
  readonly state: HocpkgResourceState;
  readonly reason?: HocpkgResourceReason;
  readonly value?: unknown;
  readonly error?: string;
}

export interface LoadHocpkgResourcesOptions {
  readonly handlers: readonly HocpkgResourceHandler[];
  readonly packageBaseUrl?: string;
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
      const blocked: HocpkgResourceResult = { descriptor, state: "blocked", reason: "dependency-unavailable" };
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
      const dormant: HocpkgResourceResult = { descriptor, state: "dormant", reason: "api-version-unsupported" };
      results.set(descriptor.id, dormant);
      return dormant;
    }
    try {
      const payload = await options.readJson(descriptor.entry, descriptor);
      const dependenciesById = new Map(dependencies.map((dependency) => [dependency.descriptor.id, dependency.value]));
      const packageBaseUrl = options.packageBaseUrl ?? "/";
      const value = await handler.parse(payload, {
        manifest,
        descriptor,
        packageBaseUrl,
        dependencies: dependenciesById,
        resolvePath: options.resolvePath ?? ((path) => resolveHocpkgPath(packageBaseUrl, path))
      });
      const active: HocpkgResourceResult = { descriptor, state: "active", value };
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
