import { expect, test } from "@playwright/test";

test("organizer persists a guard summary offline and preserves one result across delivery retries", async ({ page }, info) => {
  test.skip(!process.env.VITE_HOC_TELEMETRY_ENDPOINT, "Requires a configured telemetry test build");
  const live = process.env.HOC_TELEMETRY_LIVE === "1";
  let offline = true;
  const received: any[] = [];
  await page.route("**/v1/events", async route => {
    if (route.request().method() === "OPTIONS") return route.continue();
    if (offline) return route.abort("internetdisconnected");
    const body = route.request().postDataJSON(); received.push(...body.events);
    if (live) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).rejected).toEqual([]);
      return route.fulfill({ response });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": route.request().headers().origin ?? "http://127.0.0.1:4186" }, body: JSON.stringify({
      accepted: body.events.map((event: any) => event.event_id), duplicates: [], rejected: []
    }) });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave } = await load("/src/persistence/boot.ts");
    const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
    const { singleMatchFlow, flowSnapshot } = await load("/src/runtime/encounter-snapshot.ts");
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    const match = gameReducer(createMatch("browser-telemetry-guard", { opponentId: "llama", opponentAiSkills: [] }), { type: "ESCAPE_MATCH" });
    const run = singleMatchFlow(match);
    run.definition.nodes[0].recordResult = "never";
    await repository.saveLongTerm(save); await repository.saveRuntime(flowSnapshot(run, match));
  });
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator(".summary-shell")).toBeVisible();
  const pending = () => page.evaluate(async () => {
    const { gameTelemetry } = await import(/* @vite-ignore */ "/src/telemetry/index.ts");
    await gameTelemetry()!.flush(); return gameTelemetry()!.pendingCount;
  });
  await expect.poll(pending).toBe(2);
  await page.reload();
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator(".summary-shell")).toBeVisible();
  await expect.poll(pending).toBe(3);
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(pending).toBe(0);
  const unique = [...new Map(received.map(event => [event.event_id, event])).values()];
  const matches = unique.filter(event => event.event_type === "match_finished");
  expect(matches).toHaveLength(1);
  expect(matches[0].data).toMatchObject({ opponent: { id: "llama" }, outcome: "escaped", restored: true, incomplete: true });
  expect(matches[0].data.opponent.package_version).toBeTruthy();
  const launches = unique.filter(event => event.event_type === "app_started");
  expect(launches).toHaveLength(2);
  expect(new Set(launches.map(event => event.installation_id)).size).toBe(1);
  expect(new Set(launches.map(event => event.session_id)).size).toBe(2);
  await page.locator('[data-summary-action="lobby"]').click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  const save = await page.evaluate(async () => (await import(/* @vite-ignore */ "/src/persistence/factory.ts")).createPersistenceService().loadLongTerm());
  expect(save!.history).toHaveLength(0);
  await page.locator('[data-open="settings"]').click();
  await page.locator('[data-setting="telemetryEnabled"]').uncheck();
  await expect(page.locator('[data-setting="telemetryEnabled"]')).toBeEnabled();
  await expect.poll(() => page.evaluate(async () => (await import(/* @vite-ignore */ "/src/telemetry/index.ts")).gameTelemetry()!.enabled)).toBe(false);
  await page.screenshot({ path: info.outputPath("telemetry-settings.png"), fullPage: true });
  await info.attach("telemetry-events", { body: Buffer.from(JSON.stringify(received, null, 2)), contentType: "application/json" });
});
