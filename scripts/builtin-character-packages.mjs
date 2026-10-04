import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const charactersRoot = join(root, "public", "characters");
const manifestName = "hocpkg-info.json";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const canonicalJson = (value) => JSON.stringify(normalize(value));
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, normalize(entry)]));
};
const digestJson = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const portable = join(prefix, entry.name).split(sep).join("/");
    if (entry.isDirectory()) files.push(...await listFiles(path, portable));
    else if (entry.isFile()) files.push(portable);
  }
  return files;
}

function mediaType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  throw new Error(`无法确定 MIME 类型：${path}`);
}

async function manifestFiles(packageRoot) {
  const paths = (await listFiles(packageRoot)).filter((path) => path !== manifestName);
  return Promise.all(paths.map(async (path) => {
    const bytes = await readFile(join(packageRoot, path));
    return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: mediaType(path) };
  }));
}

async function syncManifests(check) {
  const indexPath = join(charactersRoot, "packages.json");
  const index = await json(indexPath);
  let changed = false;
  const packages = [];
  for (const entry of index.packages) {
    const relativeManifest = entry.manifest;
    const manifestPath = join(charactersRoot, relativeManifest);
    const current = await json(manifestPath);
    const next = { ...current, files: await manifestFiles(dirname(manifestPath)) };
    if (stableJson(current) !== stableJson(next)) {
      changed = true;
      if (!check) await writeFile(manifestPath, stableJson(next));
      else console.error(`Manifest 需要更新：${relativeManifest}`);
    }
    const manifest = check ? next : await json(manifestPath);
    const canonicalManifest = { ...manifest, files: [...manifest.files].sort((left, right) => left.path.localeCompare(right.path)) };
    packages.push({
      manifest: relativeManifest,
      packageId: `${manifest.identity.authorId}/${manifest.identity.packageName}`,
      version: manifest.identity.version,
      contentDigest: digestJson(canonicalManifest),
      bytes: manifest.files.reduce((total, file) => total + file.bytes, 0)
    });
  }
  const release = {
    format: index.format,
    formatVersion: 2,
    abilityCatalogVersion: index.abilityCatalogVersion,
    defaultCharacterId: index.defaultCharacterId,
    playerSkillOrder: index.playerSkillOrder,
    packages
  };
  const nextIndex = { ...release, releaseDigest: digestJson(release) };
  if (stableJson(index) !== stableJson(nextIndex)) {
    changed = true;
    if (!check) await writeFile(indexPath, stableJson(nextIndex));
    else console.error("内嵌包索引需要更新：packages.json");
  }
  if (check && changed) process.exitCode = 1;
}

const command = process.argv[2];
if (command === "sync") await syncManifests(false);
else if (command === "check") await syncManifests(true);
else throw new Error("用法：node scripts/builtin-character-packages.mjs <sync|check>");
