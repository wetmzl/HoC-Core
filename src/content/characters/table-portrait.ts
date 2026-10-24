import { z } from "zod";

const coordinate = z.number().finite().min(0).max(1);
/** Coordinates refer to the original image, before contain or scale. */
export function tablePortraitSchema(image: z.ZodType<string>) {
  return z.object({
    anchorY: coordinate,
    images: z.array(z.object({ image, anchorY: coordinate }).strict()).max(10000).optional()
  }).strict().superRefine((value, context) => {
    const paths = new Set<string>();
    for (const [index, entry] of (value.images ?? []).entries()) {
      if (paths.has(entry.image)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["images", index, "image"], message: "立绘定位图片重复" });
      paths.add(entry.image);
    }
  });
}

/** Runtime image references may be host-managed media URLs. */
export const TablePortraitSchema = tablePortraitSchema(z.string().min(1));
export type TablePortrait = z.infer<typeof TablePortraitSchema>;
export type TablePortraitImage = NonNullable<TablePortrait["images"]>[number];

export function tablePortraitPlacement(presentation: TablePortrait | undefined, image: string, baseUrl?: string) {
  const canonical = (value: string) => { try { return baseUrl ? new URL(value, baseUrl).href : value; } catch { return value; } };
  const override = presentation?.images?.find(entry => canonical(entry.image) === canonical(image));
  return { anchorY: override?.anchorY ?? presentation?.anchorY ?? 1 };
}
