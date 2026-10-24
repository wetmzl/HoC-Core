export interface AudioBuildRecord {
  source: string;
  output: string;
  sourceCodec: string;
  retainedOpus: boolean;
  kbps: number | null;
  vbr: 'constrained' | 'on' | null;
  encoder: string | null;
  sourceBytes: number;
  bytes: number;
  sourceSha256: string;
  sha256: string;
}
export const AUDIO_ENCODING: Readonly<{ codec: 'opus'; bgmKbps: 80; effectKbps: 64; bgmVbr: 'constrained'; effectVbr: 'on' }>;
export function isAudioPath(path: string): boolean;
export function buildAudio(bytes: Uint8Array, source: string, options?: { cacheDir?: string }): Promise<{ bytes: Uint8Array; record: AudioBuildRecord }>;
