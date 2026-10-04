import { readFile } from "node:fs/promises";
import { bootstrapContent } from "../content/packages/content-loader";
import { ABILITY_CATALOG_VERSION, ABILITY_DEFINITIONS, STATUS_DEFINITIONS, installAbilityRegistry } from "../core/abilities/registry";
import ownerLoadPenalty from "./fixtures/ability-mechanisms/ai-skills/owner-load-penalty.json" with { type: "json" };
import copperSeal from "./fixtures/ability-mechanisms/ai-skills/copper-seal.json" with { type: "json" };
import handChangeObserver from "./fixtures/ability-mechanisms/ai-skills/hand-change-observer.json" with { type: "json" };
import actionAdviceMechanic from "./fixtures/ability-mechanisms/ai-skills/action-advice-mechanic.json" with { type: "json" };
import rivalBustLoad from "./fixtures/ability-mechanisms/ai-skills/rival-bust-load.json" with { type: "json" };
import turnSkipMechanic from "./fixtures/ability-mechanisms/ai-skills/turn-skip-mechanic.json" with { type: "json" };
import copperSealStatus from "./fixtures/ability-mechanisms/statuses/copper-seal-sealed.json" with { type: "json" };

export async function publicFileFetch(input: RequestInfo | URL): Promise<Response> {
  const rawUrl = String(input);
  const pathname = rawUrl.startsWith("/") ? rawUrl.split("?", 1)[0] : new URL(rawUrl).pathname;
  try {
    const body = await readFile(new URL(`../../public${pathname}`, import.meta.url));
    const contentType = pathname.endsWith(".json") ? "application/json" : "application/octet-stream";
    return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export async function installBuiltinContentForTests(): Promise<void> {
  await bootstrapContent({ fetch: publicFileFetch as typeof fetch });
  installAbilityRegistry(
    [...ABILITY_DEFINITIONS, ownerLoadPenalty, copperSeal, handChangeObserver, actionAdviceMechanic, rivalBustLoad, turnSkipMechanic],
    [...STATUS_DEFINITIONS, copperSealStatus],
    ABILITY_CATALOG_VERSION
  );
}
