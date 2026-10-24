import { z } from "zod";
import { boundedContentJson } from "./json-budget";
import { HocpkgPortablePathSchema } from "./schema";
import { assertAuthoringSchema, validateAuthoringValue, type AuthoringSchema } from "./authoring-schema";
import { PLUGIN_CREDITS_API_VERSION } from "./plugin-version";
const schema = z.custom<AuthoringSchema>((value) => { try { assertAuthoringSchema(value); return true; } catch { return false; } }, "字段 Schema 无效或含不支持的关键字");
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
export type PluginSettingValue = z.infer<typeof scalar>;
export const PluginSettingsDeclarationSchema = z.object({
  version: z.number().int().positive(),
  fields: z.array(z.object({
    id: z.string().regex(/^[a-z][a-zA-Z0-9_-]*$/), label: z.string().min(1), description: z.string().min(1),
    hidden: z.boolean().optional(), group: z.string().min(1).optional(), order: z.number().int().optional(),
    apply: z.enum(["immediate", "restart"]), default: scalar, schema
  }).strict()).min(1)
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.fields.forEach((field, i) => {
    if (ids.has(field.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", i, "id"], message: "设置 ID 重复" });
    ids.add(field.id);
    if (!["string", "number", "integer", "boolean"].includes(String(field.schema.type))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", i, "schema"], message: "设置只支持字符串、数字、整数和布尔值" });
    if (field.schema.enum && (field.schema.enum as unknown[]).some(v => !scalar.safeParse(v).success)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", i, "schema"], message: "设置枚举只支持标量" });
    if (validateAuthoringValue(field.schema, field.default).length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", i, "default"], message: "默认值不符合 Schema" });
  });
});
export const PluginCharacterExtensionDeclarationSchema = z.object({
  type: z.string().regex(/^plugin\.[a-z][a-z0-9-]*$/), apiVersion: z.number().int().positive(),
  title: z.string().min(1), description: z.string().min(1),
  schema: HocpkgPortablePathSchema, guide: HocpkgPortablePathSchema,
  examples: z.array(HocpkgPortablePathSchema).min(1)
}).strict();
export type PluginSettingsDeclaration = z.infer<typeof PluginSettingsDeclarationSchema>;
export type PluginSettingField = PluginSettingsDeclaration["fields"][number];
export type PluginCharacterExtensionDeclaration = z.infer<typeof PluginCharacterExtensionDeclarationSchema>;
export interface PluginSettingsApi {
  set?(values: Readonly<Record<string, PluginSettingValue>>): Promise<void>;
  get(id: string): PluginSettingValue | undefined;
  subscribe(listener: (values: Readonly<Record<string, PluginSettingValue>>) => void): () => void;
}
export const PluginSettingsDataSchema = z.record(z.string(), z.object({ version: z.number().int().positive(), values: z.record(z.string(), scalar) }).strict());
export type PluginSettingsData = z.infer<typeof PluginSettingsDataSchema>;

export const DialoguePrimitiveDeclarationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), apiVersion: z.number().int().positive(),
  title: z.string().min(1), description: z.string().min(1), returnType: z.enum(["string", "number", "boolean"]),
  parameters: schema, dependencies: z.array(z.enum(["phase", "round", "history", "hands", "roulette", "abilities", "match", "event"])).min(1)
}).strict();

export const DialogueEventDeclarationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), apiVersion: z.number().int().positive(),
  title: z.string().min(1), description: z.string().min(1), data: schema
}).strict();
export const PresentationDeclarationSchema = z.object({ apiVersion: z.number().int().positive(), schema, initial: z.unknown() }).strict().superRefine((v, ctx) => {
  if (validateAuthoringValue(v.schema, v.initial).length) ctx.addIssue({ code: "custom", message: "初始表现数据不符合 Schema" });
});
export const PluginCreditsDeclarationSchema = z.object({
  paragraphs: z.array(z.array(z.object({
    text: z.string().min(1),
    href: z.string().url().refine(value => /^https?:\/\//i.test(value), "致谢链接必须使用 HTTP 或 HTTPS").optional()
  }).strict()).min(1)).min(1)
}).strict();
export type PluginCreditsDeclaration = z.infer<typeof PluginCreditsDeclarationSchema>;
export function assertPluginCreditsVersion(apiVersion: number, credits: PluginCreditsDeclaration | undefined): void {
  if (credits && apiVersion < PLUGIN_CREDITS_API_VERSION) throw new Error("致谢声明必须使用插件 API 7");
}
export const PluginModuleResourceSchema = boundedContentJson(z.object({
  module: HocpkgPortablePathSchema.refine((path) => path.endsWith(".js")),
  style: HocpkgPortablePathSchema.refine((path) => path.endsWith(".css")),
  provides: z.array(z.string().regex(/^plugin\.[a-z][a-z0-9-]*$/)),
  settings: PluginSettingsDeclarationSchema.optional(),
  characterExtensions: z.array(PluginCharacterExtensionDeclarationSchema).optional(),
  dialoguePrimitives: z.array(DialoguePrimitiveDeclarationSchema).optional(),
  dialogueEvents: z.array(DialogueEventDeclarationSchema).optional(),
  presentationState: PresentationDeclarationSchema.optional(),
  credits: PluginCreditsDeclarationSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (new Set(value.provides).size !== value.provides.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "插件提供的资源类型不得重复" });
  if (new Set((value.dialoguePrimitives ?? []).map(p => p.id)).size !== (value.dialoguePrimitives ?? []).length) ctx.addIssue({ code: "custom", message: "对白原语 ID 重复" });
  if (new Set((value.dialogueEvents ?? []).map(e => e.id)).size !== (value.dialogueEvents ?? []).length) ctx.addIssue({ code: "custom", message: "对白事件 ID 重复" });
  const extensions = value.characterExtensions ?? [];
  if (new Set(extensions.map(e => `${e.type}@${e.apiVersion}`)).size !== extensions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "角色扩展契约重复" });
  for (const extension of extensions) if (!value.provides.includes(extension.type)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "角色扩展必须属于 provides" });
}));


/** Data-only declaration shared with persistence without exposing its platform drivers. */
export interface PresentationDeclaration { readonly apiVersion: number; readonly schema: import("./authoring-schema").AuthoringSchema; readonly initial?: unknown }
