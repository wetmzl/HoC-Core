import { SaveValidationError, validateLongTermSave, type LongTermSave } from "./schema";
import { createSaveFileWriter, type SaveExportMethod, type SaveFileWriter } from "./file-exchange";

export type { SaveExportMethod } from "./file-exchange";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const SAVE_CHUNK_TYPE = "svJS";

export function exportSaveJson(save: LongTermSave): string {
  return JSON.stringify(validateLongTermSave(save), null, 2);
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
export function embedSaveInPng(png: Uint8Array, save: LongTermSave): Uint8Array {
  const chunks = pngChunks(png);
  const saveChunk = makePngChunk(SAVE_CHUNK_TYPE, new TextEncoder().encode(exportSaveJson(save)));
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

export async function importSave(input: string | File): Promise<LongTermSave> {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    const bytes = new Uint8Array(await input.arrayBuffer());
    text = isPng(bytes) ? extractSaveJsonFromPng(bytes) : new TextDecoder().decode(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new SaveValidationError("long-term", "Invalid save JSON: unable to parse file", text); }
  return validateLongTermSave(parsed);
}

interface FileSystemOpenHandle { getFile(): Promise<File>; }
interface FileSystemWindow {
  showOpenFilePicker?: (options?: unknown) => Promise<readonly FileSystemOpenHandle[]>;
}

export async function downloadSaveImage(save: LongTermSave, coverImageUrl: string, filename = "house-of-chances-save.png", writer: SaveFileWriter = createSaveFileWriter()): Promise<SaveExportMethod> {
  const response = await fetch(coverImageUrl);
  if (!response.ok) throw new Error(`Unable to load save cover image (${response.status})`);
  const png = embedSaveInPng(new Uint8Array(await response.arrayBuffer()), save);
  const pngBuffer = new ArrayBuffer(png.byteLength);
  new Uint8Array(pngBuffer).set(png);
  return writer.write(new Blob([pngBuffer], { type: "image/png" }), filename, "PNG image save", { "image/png": [".png"] });
}

export async function downloadSaveJson(save: LongTermSave, filename = "house-of-chances-save.json", writer: SaveFileWriter = createSaveFileWriter()): Promise<SaveExportMethod> {
  return writer.write(new Blob([exportSaveJson(save)], { type: "application/json" }), filename, "JSON save", { "application/json": [".json"] });
}

export async function downloadRawSave(input: unknown, filename = "house-of-chances-unmigrated-save.json", writer: SaveFileWriter = createSaveFileWriter()): Promise<SaveExportMethod> {
  const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  if (text === undefined) throw new Error("No original save data is available to export");
  return writer.write(new Blob([text], { type: "application/json" }), filename, "JSON save", { "application/json": [".json"] });
}

export async function openSaveWithFileSystemAccess(): Promise<LongTermSave> {
  const host = globalThis as unknown as FileSystemWindow;
  if (!host.showOpenFilePicker) throw new Error("File System Access API is unavailable; choose a save file instead");
  const handles = await host.showOpenFilePicker({
    multiple: false,
    types: [{ description: "图片或 JSON 存档", accept: { "image/png": [".png"], "application/json": [".json"] } }]
  });
  if (handles.length === 0) throw new Error("No save file selected");
  return importSave(await handles[0].getFile());
}
