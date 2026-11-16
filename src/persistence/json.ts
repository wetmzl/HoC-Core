import { CURRENT_GAME_VERSION, SaveValidationError, validateLongTermSave, type LongTermSave } from "./schema";
import { createSaveFileWriter, type SaveExportMethod, type SaveFileWriter } from "./file-exchange";
import { recoverLongTermSave } from "./recover-save";
import { imageToPng } from "../platform/image-png";
import { validateStorySave, type StorySave } from "../runtime/story-checkpoint";
import { NotebookSaveSchema, validateNotebookSave, type NotebookSave } from "./character-records";

export type { SaveExportMethod } from "./file-exchange";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const SAVE_CHUNK_TYPE = "svJS";

export const SAVE_TRANSFER_FORMAT = "hoc-story-transfer";
export const SAVE_TRANSFER_VERSION = 1;
export const NOTEBOOK_TRANSFER_FORMAT = "hoc-notebook-transfer";
export const NOTEBOOK_TRANSFER_VERSION = 1;
export interface SaveTransfer { readonly longTerm: LongTermSave; readonly story: StorySave | null; readonly notebook?: NotebookSave | null }

export function exportSaveJson(save: LongTermSave, story?: unknown, notebook?: unknown): string {
  const longTerm = validateLongTermSave({ ...save, gameVersion: CURRENT_GAME_VERSION });
  return JSON.stringify({ ...longTerm,
    ...(story === undefined || story === null ? {} : { storyTransfer: { format: SAVE_TRANSFER_FORMAT, formatVersion: SAVE_TRANSFER_VERSION, story: validateStorySave(story) } }),
    ...(notebook === undefined || notebook === null ? {} : { notebookTransfer: { format: NOTEBOOK_TRANSFER_FORMAT, formatVersion: NOTEBOOK_TRANSFER_VERSION, notebook: validateNotebookSave(notebook) } })
  }, null, 2);
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function readChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function pngChunks(bytes: Uint8Array): readonly { offset: number; end: number; type: string }[] {
  if (!isPng(bytes)) throw new Error("Selected cover is not a PNG image");
  const chunks: { offset: number; end: number; type: string }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("PNG image is truncated");
    const type = readChunkType(bytes, offset);
    chunks.push({ offset, end, type });
    offset = end;
    if (type === "IEND") return chunks;
  }
  throw new Error("PNG image is missing its IEND chunk");
}

/** Embeds validated durable-save JSON in a private ancillary PNG chunk. */
export function embedSaveInPng(png: Uint8Array, save: LongTermSave, story?: unknown, notebook?: unknown): Uint8Array {
  const chunks = pngChunks(png);
  const saveChunk = makePngChunk(SAVE_CHUNK_TYPE, new TextEncoder().encode(exportSaveJson(save, story, notebook)));
  const retained = chunks.filter((chunk) => chunk.type !== SAVE_CHUNK_TYPE);
  const outputLength = PNG_SIGNATURE.length + retained.reduce((total, chunk) => total + chunk.end - chunk.offset, 0) + saveChunk.length;
  const output = new Uint8Array(outputLength);
  output.set(PNG_SIGNATURE);
  let outputOffset = PNG_SIGNATURE.length;
  for (const chunk of retained) {
    if (chunk.type === "IEND") {
      output.set(saveChunk, outputOffset);
      outputOffset += saveChunk.length;
    }
    output.set(png.subarray(chunk.offset, chunk.end), outputOffset);
    outputOffset += chunk.end - chunk.offset;
  }
  return output;
}

export function extractSaveJsonFromPng(png: Uint8Array): string {
  const chunk = pngChunks(png).find((candidate) => candidate.type === SAVE_CHUNK_TYPE);
  if (!chunk) throw new Error("这张图片中没有可导入的存档。");
  return new TextDecoder().decode(png.subarray(chunk.offset + 8, chunk.end - 4));
}

export async function importSaveTransfer(input: string | File): Promise<SaveTransfer> {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    const bytes = new Uint8Array(await input.arrayBuffer());
    text = isPng(bytes) ? extractSaveJsonFromPng(bytes) : new TextDecoder().decode(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new SaveValidationError("long-term", "Invalid save JSON: unable to parse file", text); }
  const original = parsed;
  const recover = (value: unknown): LongTermSave => {
    try { return recoverLongTermSave(value); }
    catch (error) { throw new SaveValidationError("long-term", error instanceof Error ? error.message : "存档不可读取", original); }
  };
  let notebook: NotebookSave | undefined;
  if (parsed && typeof parsed === "object" && "notebookTransfer" in parsed) {
    const { notebookTransfer, ...rest } = parsed;
    const transfer = notebookTransfer as { format?: unknown; formatVersion?: unknown; notebook?: unknown } | null;
    if (!transfer || transfer.format !== NOTEBOOK_TRANSFER_FORMAT || transfer.formatVersion !== NOTEBOOK_TRANSFER_VERSION)
      throw new SaveValidationError("long-term", "不支持的人物记录传输版本", original);
    try { notebook = NotebookSaveSchema.parse(transfer.notebook); }
    catch { throw new SaveValidationError("long-term", "人物记录传输扩展不可读取", original); }
    parsed = rest;
  }
  if (parsed && typeof parsed === "object" && "storyTransfer" in parsed) {
    const { storyTransfer, ...longTerm } = parsed;
    if (!storyTransfer || typeof storyTransfer !== "object") throw new SaveValidationError("long-term", "剧情传输扩展不可读取", original);
    const transfer = storyTransfer as { format?: unknown; formatVersion?: unknown; story?: unknown };
    if (transfer.format !== SAVE_TRANSFER_FORMAT || transfer.formatVersion !== SAVE_TRANSFER_VERSION) throw new SaveValidationError("long-term", "不支持的存档传输版本", original);
    try { return { longTerm: recover(longTerm), story: validateStorySave(transfer.story), ...(notebook ? { notebook } : {}) }; }
    catch (error) { throw new SaveValidationError("long-term", error instanceof Error ? error.message : "剧情存档不可读取", original); }
  }
  return { longTerm: recover(parsed), story: null, ...(notebook ? { notebook } : {}) };
}

export async function importSave(input: string | File): Promise<LongTermSave> { return (await importSaveTransfer(input)).longTerm; }

export async function downloadSaveImage(save: LongTermSave, coverImageUrl: string, filename = "house-of-chances-save.png", writer: SaveFileWriter = createSaveFileWriter(), story?: unknown, notebook?: unknown): Promise<SaveExportMethod> {
  const response = await fetch(coverImageUrl);
  if (!response.ok) throw new Error(`Unable to load save cover image (${response.status})`);
  const cover = new Uint8Array(await response.arrayBuffer());
  const carrier = isPng(cover) ? cover : await imageToPng(cover, response.headers.get("content-type") ?? "application/octet-stream");
  const png = embedSaveInPng(carrier, save, story, notebook);
  const pngBuffer = new ArrayBuffer(png.byteLength);
  new Uint8Array(pngBuffer).set(png);
  return writer.write(new Blob([pngBuffer], { type: "image/png" }), filename, "PNG image save", { "image/png": [".png"] });
}

export async function downloadSaveJson(save: LongTermSave, filename = "house-of-chances-save.json", writer: SaveFileWriter = createSaveFileWriter(), story?: unknown, notebook?: unknown): Promise<SaveExportMethod> {
  return writer.write(new Blob([exportSaveJson(save, story, notebook)], { type: "application/json" }), filename, "JSON save", { "application/json": [".json"] });
}

export async function downloadRawSave(input: unknown, filename = "house-of-chances-unmigrated-save.json", writer: SaveFileWriter = createSaveFileWriter()): Promise<SaveExportMethod> {
  const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  if (text === undefined) throw new Error("No original save data is available to export");
  return writer.write(new Blob([text], { type: "application/json" }), filename, "JSON save", { "application/json": [".json"] });
}
