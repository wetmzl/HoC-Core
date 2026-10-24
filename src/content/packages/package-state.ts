import type { HocpkgIdentity, HocpkgManifest } from "./schema";

export function getHocpkgPackageId(identity: Pick<HocpkgIdentity, "authorId" | "packageName">): string {
  return `${identity.authorId}/${identity.packageName}`;
}

export function getHocpkgResourceKey(identity: Pick<HocpkgIdentity, "authorId" | "packageName">, resourceId: string): string {
  return `${getHocpkgPackageId(identity)}#${resourceId}`;
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

function parseSemver(version: string): ParsedSemver {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`非法 SemVer：${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split(".") ?? [] };
}

export function compareHocpkgVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ["major", "minor", "patch"] as const) if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export interface HocpkgPackageRevision {
  readonly manifest: HocpkgManifest;
  readonly contentDigest: string;
}

export type HocpkgPackageRelation = "different-package" | "same-content" | "update" | "downgrade" | "same-version-different-content";

export interface HocpkgPackageComparison {
  readonly relation: HocpkgPackageRelation;
  readonly warning?: string;
}

export function compareHocpkgPackages(current: HocpkgPackageRevision, candidate: HocpkgPackageRevision): HocpkgPackageComparison {
  if (getHocpkgPackageId(current.manifest.identity) !== getHocpkgPackageId(candidate.manifest.identity)) return { relation: "different-package" };
  const order = compareHocpkgVersions(candidate.manifest.identity.version, current.manifest.identity.version);
  if (order > 0) return { relation: "update" };
  if (order < 0) return { relation: "downgrade" };
  if (current.contentDigest === candidate.contentDigest) return { relation: "same-content" };
  return {
    relation: "same-version-different-content",
    warning: `包 ${getHocpkgPackageId(candidate.manifest.identity)} 的版本号未变化，但内容摘要不同；只能由玩家明确确认后覆盖。`
  };
}

export interface HocpkgObservedFile {
  readonly bytes: number;
  readonly sha256: string;
}

export interface HocpkgIntegrityIssue {
  readonly path: string;
  readonly kind: "missing" | "size-mismatch" | "digest-mismatch";
}

export function verifyHocpkgFileIntegrity(
  manifest: HocpkgManifest,
  observedFiles: Readonly<Record<string, HocpkgObservedFile>>
): readonly HocpkgIntegrityIssue[] {
  const issues: HocpkgIntegrityIssue[] = [];
  for (const file of manifest.files) {
    const observed = observedFiles[file.path];
    if (!observed) issues.push({ path: file.path, kind: "missing" });
    else if (observed.bytes !== file.bytes) issues.push({ path: file.path, kind: "size-mismatch" });
    else if (observed.sha256 !== file.sha256) issues.push({ path: file.path, kind: "digest-mismatch" });
  }
  return issues;
}
