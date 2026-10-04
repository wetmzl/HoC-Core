import { z } from "zod";

export const HOCPKG_FORMAT = "house-of-chances-hocpkg" as const;
export const HOCPKG_FORMAT_VERSION = 1 as const;

const portableSegment = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const portablePathPattern = new RegExp(`^(?:${portableSegment}/)*${portableSegment}$`);
const identifierPattern = /^[a-z0-9][a-z0-9_-]*$/;
const resourceIdPattern = /^[a-z0-9][a-z0-9:_-]*$/;
const resourceTypePattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const uniqueStrings = (message: string) => z.array(z.string().min(1)).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

export const HocpkgPortablePathSchema = z.string().max(240).refine(
  (path) => portablePathPattern.test(path) && !path.split("/").some((segment) => segment === "." || segment === ".."),
  "路径必须是安全、相对且可移植的包内路径"
);

export const HocpkgSemverSchema = z.string().regex(semverPattern, "version 必须是合法 SemVer");
export const HocpkgDigestSchema = z.string().regex(sha256Pattern, "sha256 必须是 64 位小写十六进制摘要");

const identitySchema = z.object({
  authorId: z.string().regex(identifierPattern, "authorId 必须是安全标识"),
  packageName: z.string().regex(identifierPattern, "packageName 必须是安全标识"),
  version: HocpkgSemverSchema
}).strict();

const creatorSchema = z.object({
  displayName: z.string().trim().min(1),
  roles: uniqueStrings("creator roles 必须唯一").pipe(z.array(z.string().regex(resourceIdPattern, "creator role 必须是安全标识")).min(1)),
  url: z.string().url().refine((url) => url.startsWith("https://") || url.startsWith("http://"), "creator url 只允许 http/https").optional()
}).strict();

const metadataSchema = z.object({
  title: z.string().trim().min(1),
  license: z.string().optional(),
  description: z.string().trim().min(1),
  coverImage: HocpkgPortablePathSchema.optional(),
  tags: uniqueStrings("metadata tags 必须唯一").pipe(z.array(z.string().regex(resourceIdPattern, "tag 必须是安全标识"))),
  creators: z.array(creatorSchema).min(1)
}).strict();

export const HocpkgResourceDescriptorSchema = z.object({
  id: z.string().regex(resourceIdPattern, "resource id 必须是安全标识"),
  type: z.string().regex(resourceTypePattern, "resource type 必须是命名空间类型"),
  apiVersion: z.number().int().positive(),
  entry: HocpkgPortablePathSchema.refine((path) => path.endsWith(".json"), "resource entry 必须指向 JSON 文件"),
  requires: uniqueStrings("resource requires 必须唯一").pipe(z.array(z.string().regex(resourceIdPattern, "requires 必须引用安全资源 ID")))
}).strict();

export const HocpkgFileSchema = z.object({
  path: HocpkgPortablePathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: HocpkgDigestSchema,
  mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[A-Za-z0-9=._ -]+)?$/i, "mediaType 必须是合法 MIME 类型")
}).strict();

export const HocpkgManifestSchema = z.object({
  $schema: z.string().min(1).optional(),
  format: z.literal(HOCPKG_FORMAT),
  formatVersion: z.literal(HOCPKG_FORMAT_VERSION),
  identity: identitySchema,
  metadata: metadataSchema,
  resources: z.array(HocpkgResourceDescriptorSchema).min(1),
  files: z.array(HocpkgFileSchema).min(1),
  extensions: z.record(z.unknown())
}).strict().superRefine((manifest, ctx) => {
  const resourceIds = new Map<string, number>();
  const entries = new Map<string, number>();
  const filePaths = new Map<string, number>();
  let characterMatchCount = 0;

  for (const [index, resource] of manifest.resources.entries()) {
    const previousId = resourceIds.get(resource.id);
    if (previousId !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources", index, "id"], message: `资源 ID 重复：${resource.id}` });
    else resourceIds.set(resource.id, index);
    const previousEntry = entries.get(resource.entry);
    if (previousEntry !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources", index, "entry"], message: `资源入口重复：${resource.entry}` });
    else entries.set(resource.entry, index);
    if (resource.type === "game.character-match") characterMatchCount += 1;
  }
  if (characterMatchCount > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources"], message: "每个角色卡包最多声明一个 game.character-match" });

  for (const [index, file] of manifest.files.entries()) {
    if (filePaths.has(file.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", index, "path"], message: `文件路径重复：${file.path}` });
    else filePaths.set(file.path, index);
  }

  if (manifest.metadata.coverImage) {
    const cover = manifest.files.find((file) => file.path === manifest.metadata.coverImage);
    if (!cover || !cover.mediaType.startsWith("image/")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata", "coverImage"], message: "包封面必须指向 files 中声明的图片" });
  }

  for (const [index, resource] of manifest.resources.entries()) {
    for (const [requiresIndex, dependency] of resource.requires.entries()) {
      if (!resourceIds.has(dependency)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources", index, "requires", requiresIndex], message: `依赖不存在：${dependency}` });
      if (dependency === resource.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources", index, "requires", requiresIndex], message: "资源不能依赖自身" });
    }
    const fileIndex = filePaths.get(resource.entry);
    if (fileIndex === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources", index, "entry"], message: `资源入口未在 files 中声明：${resource.entry}` });
    else if (manifest.files[fileIndex]?.mediaType !== "application/json") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", fileIndex, "mediaType"], message: "资源入口必须声明为 application/json" });
  }

  const state = new Map<string, "visiting" | "visited">();
  const visit = (id: string, trail: readonly string[]): void => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources"], message: `资源依赖不得成环：${[...trail, id].join(" -> ")}` });
      return;
    }
    state.set(id, "visiting");
    const index = resourceIds.get(id);
    if (index !== undefined) for (const dependency of manifest.resources[index]?.requires ?? []) if (resourceIds.has(dependency)) visit(dependency, [...trail, id]);
    state.set(id, "visited");
  };
  for (const id of resourceIds.keys()) visit(id, []);
});

export const BUILTIN_PACKAGE_INDEX_FORMAT = "house-of-chances-builtin-package-index" as const;
export const BuiltinPackageIndexSchema = z.object({
  format: z.literal(BUILTIN_PACKAGE_INDEX_FORMAT),
  formatVersion: z.literal(2),
  releaseDigest: HocpkgDigestSchema.optional(),
  abilityCatalogVersion: z.string().min(1),
  defaultCharacterId: z.string().regex(identifierPattern, "defaultCharacterId 必须是安全标识"),
  playerSkillOrder: uniqueStrings("playerSkillOrder 必须唯一").pipe(z.array(z.string().regex(identifierPattern, "playerSkillOrder 必须是安全标识")).min(1)),
  packages: z.array(z.object({
    manifest: HocpkgPortablePathSchema.refine((path) => path.endsWith("/hocpkg-info.json"), "内嵌包入口必须是 hocpkg-info.json"),
    packageId: z.string().regex(new RegExp(`^${identifierPattern.source.slice(1, -1)}/${identifierPattern.source.slice(1, -1)}$`), "packageId 必须是 authorId/packageName"),
    version: HocpkgSemverSchema,
    contentDigest: HocpkgDigestSchema,
    bytes: z.number().int().nonnegative()
  }).strict()).min(1)
}).strict().superRefine((index, ctx) => {
  const paths = new Set<string>();
  const packageIds = new Set<string>();
  for (const [entryIndex, entry] of index.packages.entries()) {
    if (paths.has(entry.manifest)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["packages", entryIndex, "manifest"], message: `内嵌包入口重复：${entry.manifest}` });
    paths.add(entry.manifest);
    if (packageIds.has(entry.packageId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["packages", entryIndex, "packageId"], message: `内嵌 packageId 重复：${entry.packageId}` });
    packageIds.add(entry.packageId);
  }
});

export type HocpkgManifest = z.infer<typeof HocpkgManifestSchema>;
export type HocpkgIdentity = HocpkgManifest["identity"];
export type HocpkgResourceDescriptor = HocpkgManifest["resources"][number];
export type HocpkgFile = HocpkgManifest["files"][number];
export type BuiltinPackageIndex = z.infer<typeof BuiltinPackageIndexSchema>;
