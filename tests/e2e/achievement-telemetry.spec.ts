import { expect, test } from "@playwright/test";
import { gunzipSync } from "node:zlib";

test("catalog activation and committed unlocks use compact durable telemetry without revealing hidden presentation", async ({ page }, info) => {
  test.skip(!process.env.VITE_HOC_TELEMETRY_ENDPOINT, "Requires an isolated telemetry test endpoint");
  const requests: { encoding: string; bytes: number; decodedBytes: number; events: any[] }[] = [];
  await page.route("**/v1/events", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "Access-Control-Allow-Origin": route.request().headers().origin ?? "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Content-Encoding"
    } });
    const raw = route.request().postDataBuffer()!;
    const encoding = route.request().headers()["content-encoding"] ?? "identity";
    const decoded = encoding === "gzip" ? gunzipSync(raw) : raw;
    const { events } = JSON.parse(decoded.toString());
    requests.push({ encoding, bytes: raw.length, decodedBytes: decoded.length, events });
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": route.request().headers().origin ?? "*" },
      body: JSON.stringify({ accepted: events.map((event: any) => event.event_id), duplicates: [], rejected: [], achievement_events: 1 }) });
  });
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { loadEmbeddedContent, prepareContentRuntime, activateContentRuntime } = await load("/src/content/packages/content-loader.ts");
    const { loadHocpkgResources } = await load("/src/content/packages/loader.ts");
    const { createHocpkgResourceHandlers } = await load("/src/content/packages/resources.ts");
    const { buildContentRegistry } = await load("/src/content/packages/content-registry.ts");
    const api = await load("/src/authoring-api.ts");
    const { gameTelemetry } = await load("/src/telemetry/index.ts");
    const { flushCommittedAchievementTelemetry } = await load("/src/runtime/achievement-telemetry.ts");
    const { IndexedDbSaveStorageDriver } = await load("/src/persistence/dexie-repository.ts");
    const loaded = await loadEmbeddedContent({ fetch: window.fetch.bind(window) });
    const topic = { type: "example.achievement", apiVersion: 1 };
    const catalog = api.StandardAchievementCatalogSchema.parse({ achievements: Array.from({ length: 100 }, (_, i) => ({
      id: `goal-${i}`, revision: 1, name: `SECRET_TITLE_${i}`, description: `SECRET_DESCRIPTION_${i}`, cover: "cover.png", hidden: true,
      tracking: { scope: "profile", tracks: [{ id: "n", on: [topic], progress: { type: "count" } }],
        completeWhen: { type: "scalar-compare", left: { type: "metric", id: "n" }, operator: "gte", right: i === 0 ? 1 : 100 } }
    })) });
    const manifest = { format: "house-of-chances-hocpkg", formatVersion: 1,
      identity: { authorId: "example", packageName: "achievements", version: "1.0.0" },
      metadata: { title: "PRIVATE_PACKAGE_TITLE", description: "PRIVATE_PACKAGE_DESCRIPTION", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
      resources: [{ id: "main", type: "achievement.catalog", apiVersion: 1, entry: "achievements.json", requires: [] }],
      files: [{ path: "achievements.json", bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" }, { path: "cover.png", bytes: 1, sha256: "0".repeat(64), mediaType: "image/png" }], extensions: {} };
    const resources = await loadHocpkgResources(manifest, { handlers: createHocpkgResourceHandlers(), readJson: async () => catalog,
      resolvePath: () => "blob:SECRET_COVER_URL" });
    if (resources.some((resource: any) => resource.state !== "active")) throw new Error("Fixture catalog did not activate");
    const content = { ...loaded, packages: [...loaded.packages, { manifest, resources, resolvePath: () => "blob:SECRET_COVER_URL" }] };
    content.registry = buildContentRegistry(content.packages);
    const prepared = prepareContentRuntime(content);
    const initial = api.createAchievementLedger("browser-profile");
    const hidden = api.projectAchievementList(prepared.achievements, initial);
    if (hidden.hiddenCount !== 100 || hidden.rows.length) throw new Error("Hidden catalog leaked presentation");
    activateContentRuntime(prepared);
    activateContentRuntime(prepared);
    const telemetry = gameTelemetry()!;
    await telemetry.start();
    const driver = new IndexedDbSaveStorageDriver("achievement-checkpoint-browser-test");
    const port = api.createAchievementCommitPort({ initial, requiredConsumers: ["telemetry", "reward"],
      save: (checkpoint: any) => driver.writeSnapshot({ longTerm: checkpoint, runtime: null }) });
    const observation = { apiVersion: 1, streamId: "browser-profile", sequence: 0, at: "2026-11-10T00:00:00Z", topic,
      scopes: {}, debugUsed: false, values: {}, skillCards: {} };
    const evaluation = api.advanceAchievements(prepared.achievements, initial, observation, [{ topic, values: {}, skillCollections: [] }]);
    await port.submit(evaluation.ledger);
    await flushCommittedAchievementTelemetry(port, telemetry);
    const shown = api.projectAchievementList(prepared.achievements, port.committed.ledger);
    if (shown.hiddenCount !== 99 || shown.rows.length !== 1 || shown.rows[0].name !== "SECRET_TITLE_0") throw new Error("Committed unlock was not revealed");
    const stored = (await driver.readSnapshot()).longTerm;
    const restarted = api.createAchievementCommitPort({ initial: stored, requiredConsumers: ["telemetry", "reward"], save: (checkpoint: any) => driver.writeSnapshot({ longTerm: checkpoint, runtime: null }) });
    await flushCommittedAchievementTelemetry(restarted, telemetry);
    let rewards = 0;
    await restarted.drain("reward", async () => { rewards++; });
    if (rewards !== 1 || restarted.committed.pending.length) throw new Error("Reward delivery lost or duplicated");
    if (!api.meetsAchievementUnlockRequirement(restarted.committed.ledger, { type: "achievement-unlocked", key: "example/achievements#main/goal-0" })) throw new Error("Reward requirement did not observe durable unlock");
    await telemetry.drain();
    (window as any).__achievementTest = { telemetry, prepared };
    return { hidden, shown, rewards };
  });
  expect(result.hidden).toEqual({ rows: [], hiddenCount: 100 });
  expect(result.shown.hiddenCount).toBe(99);
  await expect.poll(() => requests.flatMap(request => request.events).filter(event => event.event_type === "achievements_loaded").length).toBeGreaterThan(0);
  await expect.poll(() => requests.flatMap(request => request.events).filter(event => event.event_type === "achievements_unlocked").length).toBe(1);
  await page.evaluate(async () => { const { telemetry, prepared } = (window as any).__achievementTest; await telemetry.recordAchievementCatalog(prepared.achievements); await telemetry.drain(); });
  const all = requests.flatMap(request => request.events);
  const loaded = all.filter(event => event.event_type === "achievements_loaded");
  expect(loaded.flatMap(event => event.data.items)).toHaveLength(100);
  expect(JSON.stringify(all)).not.toMatch(/SECRET_|PRIVATE_PACKAGE_|cover\.png|completeWhen|tracking/);
  expect(requests.some(request => request.encoding === "gzip" && request.bytes < request.decodedBytes)).toBe(true);
  await info.attach("achievement-telemetry", { body: Buffer.from(JSON.stringify(requests)), contentType: "application/json" });
});
