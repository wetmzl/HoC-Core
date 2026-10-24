import { z } from "zod";
import { canonicalBuiltinPackageId } from "../packages/builtin-authors";
import { HocpkgSemverSchema } from "../packages/schema";

const packageId = z.string().regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/);
const entry = z.object({ packageId, version: HocpkgSemverSchema.optional() }).strict();
const v1Document = z.object({ format: z.literal("house-of-chances-playlist"), formatVersion: z.literal(1), name: z.string().trim().max(80), packages: z.array(entry).max(1000) }).strict();
const v1Library = z.object({ format: z.literal("house-of-chances-playlist-library"), formatVersion: z.literal(1), generation: z.number().int().nonnegative(), state: z.enum(["prepared", "committed"]), playlists: z.array(z.object({ id: z.string().uuid(), document: v1Document }).strict()), checksum: z.string() }).strict();

function migrateBuiltinReferences(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const document = value as { packages?: unknown; pluginOrder?: unknown };
  if (!Array.isArray(document.packages) || !Array.isArray(document.pluginOrder)) return value;
  const entries = document.packages as Array<{ packageId?: unknown }>;
  const explicitIds = new Set(entries.map((entry) => entry?.packageId));
  const packages = entries.filter((entry) => typeof entry?.packageId !== "string" ||
    canonicalBuiltinPackageId(entry.packageId) === entry.packageId || !explicitIds.has(canonicalBuiltinPackageId(entry.packageId)))
    .map((entry) => typeof entry?.packageId === "string" ? { ...entry, packageId: canonicalBuiltinPackageId(entry.packageId) } : entry);
  const explicitOrder = new Set(document.pluginOrder);
  const pluginOrder = document.pluginOrder.filter((id) => typeof id !== "string" ||
    canonicalBuiltinPackageId(id) === id || !explicitOrder.has(canonicalBuiltinPackageId(id)))
    .map((id) => typeof id === "string" ? canonicalBuiltinPackageId(id) : id);
  return { ...value, packages, pluginOrder };
}

export function migratePlaylistDocument(value: unknown, fallbackOrder: readonly string[] = []): unknown {
  if (typeof value !== "object" || value === null) return value;
  if ((value as { formatVersion?: unknown }).formatVersion === 1) {
    const parsed = v1Document.parse(value);
    return migrateBuiltinReferences({ ...parsed, formatVersion: 2, pluginOrder: [...fallbackOrder] });
  }
  return migrateBuiltinReferences(value);
}

export function migratePlaylistLibrary(value: unknown, fallbackOrder: readonly string[] = []): unknown {
  if (typeof value !== "object" || value === null) return value;
  const library = (value as { formatVersion?: unknown }).formatVersion === 1
    ? { ...v1Library.parse(value), formatVersion: 2, currentId: null }
    : value as { playlists?: unknown };
  if (!Array.isArray(library.playlists)) return value;
  return { ...library, playlists: library.playlists.map((entry: { document: unknown }) => ({ ...entry, document: migratePlaylistDocument(entry.document, fallbackOrder) })) };
}
