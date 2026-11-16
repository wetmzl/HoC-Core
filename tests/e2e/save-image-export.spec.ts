import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { embedSaveInPng } from "../../src/persistence/json";

for (const format of ["png", "webp"] as const) {
  test(`图片存档使用 ${format} 封面并保留可恢复进度`, async ({ page }) => {
    const source = sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 40, g: 100, b: 180, alpha: .6 } } });
    const cover = await (format === "png" ? source.png() : source.webp({ quality: 92 })).toBuffer();
    await page.goto("/");
    const result = await page.evaluate(async ({ bytes, format }) => {
      const { createDefaultSave } = await import(/* @vite-ignore */ "/src/persistence/boot.ts");
      const { downloadSaveImage, exportSaveJson, extractSaveJsonFromPng } = await import(/* @vite-ignore */ "/src/persistence/json.ts");
      const save = createDefaultSave(); save.profile.matchesPlayed = 7;
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: `image/${format}` }));
      let output: number[] = [], filename = "", mediaType = "";
      try {
        const method = await downloadSaveImage(save, url, "neutral-save.png", { async write(blob, name) {
          output = Array.from(new Uint8Array(await blob.arrayBuffer())); filename = name; mediaType = blob.type;
          return "blob-download";
        } });
        return { output, method, filename, mediaType, save: JSON.parse(exportSaveJson(save)), recovered: JSON.parse(extractSaveJsonFromPng(Uint8Array.from(output))) };
      } finally { URL.revokeObjectURL(url); }
    }, { bytes: Array.from(cover), format });
    expect(result.method).toBe("blob-download");
    expect(result.filename).toBe("neutral-save.png");
    expect(result.mediaType).toBe("image/png");
    expect(result.recovered).toEqual(result.save);
    expect(result.recovered.profile.matchesPlayed).toBe(7);
    const exported = Buffer.from(result.output);
    const metadata = await sharp(exported).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual(["png", 32, 24]);
    if (format === "png") expect(exported).toEqual(Buffer.from(embedSaveInPng(cover, result.save)));
    const actual = await sharp(exported).ensureAlpha().raw().toBuffer();
    const expected = await sharp(cover).ensureAlpha().raw().toBuffer();
    let difference = 0;
    for (let index = 0; index < actual.length; index++) difference = Math.max(difference, Math.abs(actual[index] - expected[index]));
    // Browser canvas and the independent image decoder can round alpha by one.
    expect(difference).toBeLessThanOrEqual(2);
  });
}
