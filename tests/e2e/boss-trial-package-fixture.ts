import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import manifest from "../fixtures/boss-trial-manifest.json" with { type: "json" };

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** Test-only embedded overlay, installed before the application builds its lobby actions. */
export async function installBossTrialPackage(page: Page, sourceIndex?: any): Promise<void> {
  const trial = await readFile(new URL("../fixtures/boss-trial.json", import.meta.url));
  await page.route("**/characters/boss-challenge-dev/*", async route => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    if (file === "hocpkg-info.json") await route.fulfill({ json: manifest });
    else if (file === "challenge.json") await route.fulfill({ body: trial, contentType: "application/json" });
    else await route.fallback();
  });
  await page.route("**/characters/packages.json", async route => {
    const index = structuredClone(sourceIndex ?? await (await route.fetch()).json());
    index.packages.push({ manifest: "boss-challenge-dev/hocpkg-info.json", packageId: "hoc-core/boss-challenge-dev",
      version: manifest.identity.version, contentDigest: digest(manifest), bytes: trial.byteLength });
    delete index.releaseDigest;
    index.releaseDigest = digest(index);
    await route.fulfill({ json: index });
  });
}
