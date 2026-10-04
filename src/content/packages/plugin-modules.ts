import { z } from "zod";
import { getCharacterMetadata, loadCharacter } from "../characters";
import { haptics } from "../../presentation/haptic-service";
import { gameAudio } from "../../audio/game-audio";
import { PLUGIN_MODULE_API_VERSION } from "./plugin-version";
import { sha256 } from "../storage/encoding";
import type { ContentPackageAccess, ContentSource } from "./content-source";
import { HocpkgPortablePathSchema } from "./schema";
import type { HocpkgResourceHandler } from "./resources";
import type { PluginHostApi, PluginModule, PluginRegistration } from "./plugin-contracts";

export const PluginModuleResourceSchema = z.object({
  module: HocpkgPortablePathSchema.refine((path) => path.endsWith(".js")),
  style: HocpkgPortablePathSchema.refine((path) => path.endsWith(".css")),
  provides: z.array(z.string().regex(/^plugin\.[a-z][a-z0-9-]*$/))
}).strict().refine((value) => new Set(value.provides).size === value.provides.length, "插件提供的资源类型不得重复");

export interface LoadedPluginModules {
  readonly handlers: readonly HocpkgResourceHandler[];
  readonly registrations: readonly { readonly packageId: string; readonly registration: PluginRegistration }[];
  release(): void;
}

function declaredFile(access: ContentPackageAccess, path: string, mediaType: string): void {
  if (!access.manifest.files.some((file) => file.path === path && file.mediaType === mediaType)) {
    throw new Error(`插件文件未声明或 MIME 类型不符：${access.packageId}#${path}`);
  }
}

async function verifiedBytes(access: ContentPackageAccess, path: string, mediaType: string): Promise<Uint8Array> {
  declaredFile(access, path, mediaType);
  if (!access.readFile) throw new Error("内容来源不支持读取插件模块");
  const file = access.manifest.files.find((candidate) => candidate.path === path)!;
  const bytes = await access.readFile(path);
  if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) {
    throw new Error(`插件文件完整性校验失败：${access.packageId}#${path}`);
  }
  return bytes;
}

export async function createPackageEffect(access: ContentPackageAccess, path: string, signal: AbortSignal, releases: Array<() => void>) {
  HocpkgPortablePathSchema.parse(path);
  const file = access.manifest.files.find((candidate) => candidate.path === path);
  if (!file?.mediaType.startsWith("audio/")) throw new Error(`音效未声明或 MIME 类型不符：${path}`);
  const bytes = await verifiedBytes(access, path, file.mediaType);
  if (signal.aborted) throw new Error("插件已经释放");
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: file.mediaType }));
  const effect = gameAudio.createEffect(url, () => URL.revokeObjectURL(url));
  releases.push(() => effect.dispose());
  return effect;
}

export async function loadPluginModules(source: ContentSource): Promise<LoadedPluginModules> {
  const handlers: HocpkgResourceHandler[] = [];
  const registrations: { packageId: string; registration: PluginRegistration }[] = [];
  const releases: Array<() => void> = [];
  const claimed = new Set<string>();
  const activated = new Set<string>();
  try {
    for (const access of await source.packages()) {
      for (const descriptor of access.manifest.resources.filter((resource) => resource.type === "plugin.module")) {
        if (descriptor.apiVersion !== PLUGIN_MODULE_API_VERSION || descriptor.requires.length !== 0) continue;
        let moduleUrl: string | undefined;
        const assets: Array<() => void> = [];
        const lifetime = new AbortController();
        assets.push(() => lifetime.abort());
        let style: HTMLStyleElement | undefined;
        try {
          const entryBytes = await verifiedBytes(access, descriptor.entry, "application/json");
          const payload = PluginModuleResourceSchema.parse(JSON.parse(new TextDecoder().decode(entryBytes)));
          const moduleBytes = new Uint8Array(await verifiedBytes(access, payload.module, "text/javascript"));
          moduleUrl = URL.createObjectURL(new Blob([moduleBytes], { type: "text/javascript" }));
          const imported = await import(/* @vite-ignore */ moduleUrl) as PluginModule;
          if (typeof imported.register !== "function") throw new Error("插件模块缺少 register 导出");
          const host: PluginHostApi = {
            getCharacterMetadata,
            loadCharacter,
            haptics: { play: (pattern, options = {}) => haptics.play(pattern, {
              signal: options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
            }) },
            audio: {
              createEffect: (path) => createPackageEffect(access, path, lifetime.signal, assets)
            },
            async resolveAsset(path) {
              declaredFile(access, path, access.manifest.files.find((file) => file.path === path)?.mediaType ?? "");
              const resolved = await access.resolveAsset(path);
              if (resolved.release) assets.push(() => resolved.release?.());
              return resolved.url;
            }
          };
          const registration = await imported.register(host);
          if (!registration || typeof registration.createRuntime !== "function" || !Array.isArray(registration.handlers)) throw new Error("插件注册结果无效");
          const provided = new Set(payload.provides);
          for (const handler of registration.handlers) {
            if (!provided.has(handler.type) || claimed.has(handler.type)) throw new Error(`插件资源处理器冲突：${handler.type}`);
          }
          const css = new TextDecoder().decode(await verifiedBytes(access, payload.style, "text/css"));
          style = document.createElement("style");
          style.dataset.pluginPackage = access.packageId;
          style.textContent = css;
          document.head.append(style);
          for (const handler of registration.handlers) { claimed.add(handler.type); handlers.push(handler); }
          registrations.push({ packageId: access.packageId, registration });
          activated.add(`${access.packageId}#${descriptor.id}`);
          const ownUrl = moduleUrl;
          const ownStyle = style;
          releases.push(() => { ownStyle.remove(); URL.revokeObjectURL(ownUrl); assets.forEach((release) => release()); });
        } catch (error) {
          style?.remove();
          if (moduleUrl) URL.revokeObjectURL(moduleUrl);
          assets.forEach((release) => release());
          console.warn(`插件模块不可用：${access.packageId}#${descriptor.id}`, error);
        }
      }
    }
    handlers.unshift({
      type: "plugin.module",
      apiVersions: [PLUGIN_MODULE_API_VERSION],
      parse(payload, context) {
        const packageId = `${context.manifest.identity.authorId}/${context.manifest.identity.packageName}`;
        if (!activated.has(`${packageId}#${context.descriptor.id}`)) throw new Error("插件模块未激活");
        return PluginModuleResourceSchema.parse(payload);
      }
    });
    return {
      handlers,
      registrations,
      release() { releases.splice(0).forEach((release) => release()); }
    };
  } catch (error) {
    releases.splice(0).forEach((release) => release());
    throw error;
  }
}
