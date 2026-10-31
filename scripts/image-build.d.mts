import type { AudioBuildRecord } from './audio-build.mjs';
import type { Plugin } from 'vite';
import type { BuiltinPackageIndex, HocpkgManifest } from '../src/content/packages/schema';
export interface ImageOptions {
  mode: 'lossy' | 'lossless' | 'png';
  quality: number;
  cacheDir?: string;
  audioCacheDir?: string;
}
export interface ImageBuildRecord {
  source: string;
  output: string;
  sourceSha256: string;
  sha256: string;
  sourceBytes: number;
  bytes: number;
  retainedPng: boolean;
}
export interface BuiltImagePackage {
  manifest: HocpkgManifest;
  files: Record<string, Buffer>;
  images: ImageBuildRecord[];
  audio: AudioBuildRecord[];
  entry: BuiltinPackageIndex['packages'][number];
}
export function imageOptions(args?: string[], env?: NodeJS.ProcessEnv): ImageOptions & { forwarded: string[] };
export function rewriteImageText(text: string, paths: Map<string, string>): string;
export function buildPackage(charactersRoot: string, entry: BuiltinPackageIndex['packages'][number], options: ImageOptions): Promise<BuiltImagePackage>;
export function buildPackageTree(charactersRoot: string, options: ImageOptions): Promise<{ packages: BuiltImagePackage[]; index: BuiltinPackageIndex }>;
export function buildEmbeddedContent(tree: { packages: BuiltImagePackage[]; index: BuiltinPackageIndex }): { files: Record<string, Buffer>; downloads: Array<{ url: string; bytes: number; sha256: string; mediaType: string }>; content: unknown };
export function imageBuildPlugin(): Plugin;
