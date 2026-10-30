import { z } from "zod";
import { ProgramTemplateSchema } from "../../core/flow/program-templates";

/** A character selects a package-local program or one of the host's typed templates. */
export const CharacterRuntimeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("flow"), resourceId: z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/) }).strict(),
  z.object({ type: z.literal("template"), template: ProgramTemplateSchema }).strict()
]);
export type CharacterRuntime = z.input<typeof CharacterRuntimeSchema>;
