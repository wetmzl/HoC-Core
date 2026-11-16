/** Rasterize a share-image carrier without changing installed source assets. */
export async function imageToPng(bytes: Uint8Array, mediaType: string): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建封面图片。");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法导出封面 PNG。")), "image/png"));
    return new Uint8Array(await png.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}
