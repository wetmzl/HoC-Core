const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ContentDigestUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("当前环境无法校验内容数据，请重新打开游戏；若仍有问题，请检查浏览器或系统网页组件更新。", { cause });
    this.name = "ContentDigestUnavailableError";
  }
}

export function assertContentDigestAvailable(): void {
  try {
    if (typeof globalThis.crypto?.subtle?.digest === "function") return;
  } catch (error) {
    throw new ContentDigestUnavailableError(error);
  }
  throw new ContentDigestUnavailableError();
}

export function encodeText(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeText(value: Uint8Array): string {
  return decoder.decode(value);
}

export function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]));
  };
  return JSON.stringify(normalize(value));
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  let digest: ArrayBuffer;
  try {
    assertContentDigestAvailable();
    digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  } catch (error) {
    if (error instanceof ContentDigestUnavailableError) throw error;
    throw new ContentDigestUnavailableError(error);
  }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Json(value: unknown): Promise<string> {
  return sha256(encodeText(stableJson(value)));
}
