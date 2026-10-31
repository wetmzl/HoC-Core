import { DialogueEventRegistry } from "../../dialogue/events";
import { DialoguePrimitiveRegistry } from "../../dialogue/registry";
import { getCharacterMetadata, loadCharacter } from "../characters";
import { haptics } from "../../presentation/haptic-service";
import { gameAudio } from "../../audio/game-audio";
import { SUPPORTED_PLUGIN_MODULE_API_VERSIONS } from "./plugin-version";
import { assertPluginCreditsVersion, PluginModuleResourceSchema, type PluginCreditsDeclaration } from "./plugin-declarations";
import { PluginSettingsSession } from "./plugin-settings";
import { authoringPresentationAllows, assertAuthoringSchema, assertAuthoringValue, type AuthoringSchema } from "./authoring-schema";
import { sha256 } from "../storage/encoding";
import type { ContentPackageAccess, ContentSource } from "./content-source";
import { HocpkgPortablePathSchema } from "./schema";
import type { HocpkgResourceHandler } from "./resources";
import type { PluginHostApi, PluginModule, PluginRegistration } from "./plugin-contracts";

import { validatePluginUiActions } from "./plugin-ui";
import { bindPluginTutorialIdentity } from "./plugin-tutorials";

export { PluginModuleResourceSchema } from "./plugin-declarations";

export interface LoadedPluginModules {
  readonly dialogueRegistry: DialoguePrimitiveRegistry;
  readonly eventRegistry: DialogueEventRegistry;
  readonly handlers: readonly HocpkgResourceHandler[];
  readonly registrations: readonly { readonly packageId: string; readonly title: string; readonly credits?: PluginCreditsDeclaration; readonly registration: PluginRegistration }[];
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

export async function loadPluginModules(source: ContentSource, settings = new PluginSettingsSession()): Promise<LoadedPluginModules> {
  const dialogueRegistry = new DialoguePrimitiveRegistry();
  const eventRegistry = new DialogueEventRegistry();
  const handlers: HocpkgResourceHandler[] = [];
  const registrations: { packageId: string; title: string; credits?: PluginCreditsDeclaration; registration: PluginRegistration }[] = [];
  const releases: Array<() => void> = [];
  const claimed = new Set<string>();
  const activated = new Set<string>();
  try {
    for (const access of await source.packages()) {
      for (const descriptor of access.manifest.resources.filter((resource) => resource.type === "plugin.module")) {
        if (!SUPPORTED_PLUGIN_MODULE_API_VERSIONS.some(v => v === descriptor.apiVersion) || descriptor.requires.length !== 0) continue;
        let moduleUrl: string | undefined;
        const assets: Array<() => void> = [];
        const lifetime = new AbortController();
        assets.push(() => lifetime.abort());
        let style: HTMLStyleElement | undefined;
        try {
          const entryBytes = await verifiedBytes(access, descriptor.entry, "application/json");
          const payload = PluginModuleResourceSchema.parse(JSON.parse(new TextDecoder().decode(entryBytes)));
          assertPluginCreditsVersion(descriptor.apiVersion, payload.credits);
          if (descriptor.apiVersion < 6 && payload.settings?.fields.some(field => field.hidden)) throw new Error("隐藏设置必须使用 API 6");
          if (descriptor.apiVersion < 5 && (payload.dialogueEvents || payload.presentationState)) throw new Error("事件与表现声明必须使用 API 5");
          if (descriptor.apiVersion < 4 && payload.dialoguePrimitives) throw new Error("声明对白原语必须使用 API 4");
          if (descriptor.apiVersion < 3 && (payload.settings || payload.characterExtensions)) throw new Error("插件声明设置或角色创作契约必须使用 API 3");
          const extensionSchemas = new Map<string, AuthoringSchema>();
          for (const extension of payload.characterExtensions ?? []) {
            const schemaBytes = await verifiedBytes(access, extension.schema, "application/json");
            const schema = JSON.parse(new TextDecoder().decode(schemaBytes));
            assertAuthoringSchema(schema);
            extensionSchemas.set(`${extension.type}@${extension.apiVersion}`, schema);
            // Creator guides/examples are not runtime inputs. Imported packages have
            // already been verified; directory assets are verified when requested.
            declaredFile(access, extension.guide, "text/markdown");
            for (const example of extension.examples) declaredFile(access, example, "application/zip");
          }
          if (payload.settings) assets.push(settings.register({ packageId: access.packageId, title: access.manifest.metadata.title, declaration: payload.settings }));
          const moduleBytes = new Uint8Array(await verifiedBytes(access, payload.module, "text/javascript"));
          moduleUrl = URL.createObjectURL(new Blob([moduleBytes], { type: "text/javascript" }));
          const imported = await import(/* @vite-ignore */ moduleUrl) as PluginModule;
          if (typeof imported.register !== "function") throw new Error("插件模块缺少 register 导出");
          const host: PluginHostApi = {
            settings: settings.forPackage(access.packageId, descriptor.apiVersion >= 6),
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
          if (descriptor.apiVersion < 4 && registration.dialoguePrimitives?.length) throw new Error("对白原语实现必须使用 API 4");
          assets.push(dialogueRegistry.registerPackage(access.packageId, payload.dialoguePrimitives ?? [], registration.dialoguePrimitives ?? []));
          if (registration.mountDialogueSource && (descriptor.apiVersion < 5 || !payload.presentationState)) throw new Error("对白来源必须使用 API 5 并声明表现 Schema");
          assets.push(eventRegistry.registerPackage(access.packageId, payload.dialogueEvents ?? []));
          const provided = new Set(payload.provides);
          for (const handler of registration.handlers) {
            if (!provided.has(handler.type) || claimed.has(handler.type)) throw new Error(`插件资源处理器冲突：${handler.type}`);
          }
          if (descriptor.apiVersion >= 3 && registration.handlers.some(handler => handler.apiVersions.some((version: number) => !(payload.characterExtensions ?? []).some(e => e.type === handler.type && e.apiVersion === version)))) throw new Error("API 3 角色扩展处理器必须提供对应版本的创作契约");
          const css = new TextDecoder().decode(await verifiedBytes(access, payload.style, "text/css"));
          style = document.createElement("style");
          style.dataset.pluginPackage = access.packageId;
          style.textContent = css;
          document.head.append(style);
          for (const handler of registration.handlers) {
            claimed.add(handler.type);
            handlers.push({ ...handler,
              presentationAllows: (path, apiVersion) => {
                const schema = extensionSchemas.get(`${handler.type}@${apiVersion}`);
                return !!schema && authoringPresentationAllows(schema, path);
              },
              parse(payload, context) {
              const schema = extensionSchemas.get(`${handler.type}@${context.descriptor.apiVersion}`);
              if (schema) assertAuthoringValue(schema, payload, { files: context.manifest.files, resources: context.manifest.resources, requires: context.descriptor.requires });
              return handler.parse(payload, context);
            } });
          }
          registrations.push({ packageId: access.packageId, title: access.manifest.metadata.title, credits: payload.credits, registration: {
            ...registration,
            createRuntime(extensions) {
              const runtime = registration.createRuntime(extensions);
              if (runtime.presentDialogue && descriptor.apiVersion < 9) throw new Error("对白表现回调必须使用 API 9");
              const uiActions = validatePluginUiActions(runtime.uiActions, descriptor.apiVersion);
              if (descriptor.apiVersion < 6 && (runtime.mountRuntime || runtime.initialAbilities)) throw new Error("运行时扩展必须使用 API 6");
              if (runtime.dialogueSource) throw new Error("对白来源必须由宿主绑定包身份");
              return bindPluginTutorialIdentity({ ...runtime, uiActions, dialogueSource: registration.mountDialogueSource ? {
                packageId: access.packageId, declaration: payload.presentationState!, signal: lifetime.signal,
                mount(context, signal) {
                  if (lifetime.signal.aborted) return;
                  return registration.mountDialogueSource!(context, AbortSignal.any([signal, lifetime.signal]));
                }
              } : undefined }, { packageId: access.packageId, apiVersion: descriptor.apiVersion });
            }
          } });
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
      apiVersions: [...SUPPORTED_PLUGIN_MODULE_API_VERSIONS],
      parse(payload, context) {
        const packageId = `${context.manifest.identity.authorId}/${context.manifest.identity.packageName}`;
        if (!activated.has(`${packageId}#${context.descriptor.id}`)) throw new Error("插件模块未激活");
        return PluginModuleResourceSchema.parse(payload);
      }
    });
    return {
      dialogueRegistry,
      eventRegistry,
      handlers,
      registrations,
      release() { releases.splice(0).forEach((release) => release()); registrations.length = 0; }
    };
  } catch (error) {
    releases.splice(0).forEach((release) => release());
    throw error;
  }
}
