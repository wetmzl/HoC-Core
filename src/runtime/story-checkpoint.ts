import type { PublicEventBatch, PublicEventScopes } from "../core/events/public-events";
import type { StoryRun } from "../core/story/types";
import { boundedStoryJson, StoryRunSchema } from "../core/story/schema";
import { z } from "zod";

export const STORY_SAVE_FORMAT = "hoc-story-save" as const;
export const STORY_SAVE_SCHEMA_VERSION = 1 as const;
export const STORY_SAVE_LIMITS = Object.freeze({ queue: 256, ledger: 100_000, diagnostics: 32 });
export interface StoryDiagnostic { readonly id: string; readonly sceneId: string; readonly code: "queue-full" | "ledger-full" | "request-invalid"; readonly message: string }
export interface StoryRequest {
  readonly id: string;
  readonly sceneId: string;
  readonly packageId: string;
  readonly digest: string;
  /** Every scene reachable by call is fixed to the accepted content version. */
  readonly sources: Readonly<Record<string, string>>;
  readonly bindingId?: string;
  readonly scopes: PublicEventScopes;
  readonly scope: "global" | "match" | "flow";
  readonly priority: number;
  readonly order: number;
  readonly event?: PublicEventBatch;
  readonly recheck?: boolean;
}
export interface StoryPlayback { readonly request: StoryRequest; readonly run: StoryRun }
export interface StoryCompletion {
  readonly id: string; readonly sceneId: string; readonly status: StoryRun["status"]; readonly result?: StoryRun["result"];
  readonly choices?: StoryRun["choices"]; readonly variables?: StoryRun["variables"]; readonly receipts?: StoryRun["receipts"];
}
export interface StorySave {
  readonly format: typeof STORY_SAVE_FORMAT;
  readonly schemaVersion: typeof STORY_SAVE_SCHEMA_VERSION;
  readonly sequence: number;
  readonly queue: readonly StoryRequest[];
  readonly active: StoryPlayback | null;
  readonly once: readonly string[];
  readonly seen: readonly string[];
  readonly completed: readonly StoryCompletion[];
  readonly suspended?: boolean;
  readonly diagnostics?: readonly StoryDiagnostic[];
}
export function emptyStorySave(): StorySave {
  return { format: STORY_SAVE_FORMAT, schemaVersion: STORY_SAVE_SCHEMA_VERSION, sequence: 0, queue: [], active: null, once: [], seen: [], completed: [] };
}
const identity = z.string().min(1).max(1024);
const scopes = z.object({ game: identity.optional(), program: identity.optional(), match: identity.optional(), round: identity.optional(), "rule-window": identity.optional() }).strict();
const eventBatch = boundedStoryJson(z.object({ id: identity, restored: z.boolean(),
  facts: z.array(z.object({ apiVersion: z.literal(1), id: identity, type: identity, scopes,
    data: z.record(z.string(), z.json()), origin: z.record(z.string(), z.json()).optional() }).strict()).max(4096),
  context: z.record(z.string(), z.json()).optional() }).strict());
export const StoryRequestSchema = z.object({ id: identity, sceneId: identity, packageId: identity, digest: identity,
  sources: z.record(identity, identity), bindingId: identity.optional(), scopes, scope: z.enum(["global", "match", "flow"]),
  priority: z.number().finite(), order: z.number().int().nonnegative().safe(), event: eventBatch.optional(), recheck: z.boolean().optional() }).strict();
export const StorySaveSchema: z.ZodType<StorySave> = z.object({ format: z.literal(STORY_SAVE_FORMAT), schemaVersion: z.literal(STORY_SAVE_SCHEMA_VERSION),
  sequence: z.number().int().nonnegative().safe(), queue: z.array(StoryRequestSchema).max(STORY_SAVE_LIMITS.queue),
  active: z.object({ request: StoryRequestSchema, run: StoryRunSchema }).strict().nullable(),
  once: z.array(identity).max(STORY_SAVE_LIMITS.ledger), seen: z.array(identity).max(STORY_SAVE_LIMITS.ledger),
  completed: z.array(z.object({ id: identity, sceneId: identity, status: z.enum(["running", "waiting", "completed", "skipped", "interrupted", "failed"]),
    result: z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()]).optional(),
    choices: z.array(z.object({ sceneId: identity, nodeId: identity, optionId: identity }).strict()).max(4096).optional(),
    variables: z.record(z.string().max(100), z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()])).optional(),
    receipts: z.array(z.object({ id: identity, result: z.record(z.string().max(100), z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()])).optional() }).strict()).max(4096).optional()
  }).strict()).max(STORY_SAVE_LIMITS.ledger), suspended: z.boolean().optional(),
  diagnostics: z.array(z.object({ id: identity, sceneId: identity, code: z.enum(["queue-full", "ledger-full", "request-invalid"]), message: z.string().max(1024) }).strict()).max(STORY_SAVE_LIMITS.diagnostics).optional()
}).strict().superRefine((save, context) => {
  const ids = [...save.queue.map(request => request.id), ...(save.active ? [save.active.request.id] : [])];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "剧情请求身份重复" });
  if (save.active && save.active.request.id !== save.active.run.id) context.addIssue({ code: "custom", message: "剧情运行身份不匹配" });
}) as z.ZodType<StorySave>;
/** Story has its own schema record; no migration rewrites the released game save contracts. */
export function validateStorySave(input: unknown): StorySave {
  if (input === null || input === undefined) return emptyStorySave();
  const parsed = StorySaveSchema.safeParse(input);
  if (!parsed.success) throw new Error("剧情存档结构或版本不可读取，原记录已保留");
  return parsed.data;
}
