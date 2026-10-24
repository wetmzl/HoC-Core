import copyRevisions from "../test/fixtures/skill-copy-revisions.json";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import audit from "../test/fixtures/dialogue-events-migration.json";
import type { DialogueRule } from "./types";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
it("migrates all five built-in roles without changing pools, source anchors, media or skills", () => {
  for (const entry of audit.characters) {
    const root = `public/characters/${entry.character}`;
    const manifest = JSON.parse(readFileSync(`${root}/hocpkg-info.json`, "utf8")), dialogue = JSON.parse(readFileSync(`${root}/resources/dialogue.json`, "utf8"));
    expect(manifest.resources.find((r: { type: string }) => r.type === "game.character-dialogue").apiVersion).toBe(2);
    // Preserve the historical migration audit while allowing later, explicitly authored additions.
    const { CHARACTER_TAP: _tap, CHARACTER_TAP_DEFEATED: _defeatedTap, CHARACTER_TAP_ROULETTE: _rouletteTap, ...originalPools } = dialogue.pools;
    const originalRules = dialogue.rules.filter((rule: DialogueRule) => !["character-tap", "character-tap-defeated", "character-tap-roulette"].includes(rule.id));
    expect(originalRules).toHaveLength(23); expect(Object.keys(originalPools)).toHaveLength(21);
    expect(sha(JSON.stringify(originalPools))).toBe(entry.poolsSha256);
    expect(sha(JSON.stringify(originalRules.map(({ on: _on, ...rule }: DialogueRule) => rule)))).toBe(entry.rulesSha256);
    for (const [path, digest] of Object.entries({ ...entry.mediaSha256, ...entry.resourcesSha256 })) {
      const bytes = readFileSync(`${root}/${path}`);
      // Victory rewards, directory badges and table anchors were authored after this migration. Preserve the
      // original audit and continue protecting every other character field.
      const copyRevision = copyRevisions[`${entry.character}/${path}` as keyof typeof copyRevisions];
      let baselineBytes = bytes;
      if (copyRevision) {
        const definition = JSON.parse(bytes.toString());
        expect(definition).toMatchObject(copyRevision.after);
        definition.description = copyRevision.before.description;
        delete definition.usage;
        baselineBytes = Buffer.from(`${JSON.stringify(definition, null, 2)}\n`);
      }
      let original: string | Uint8Array = baselineBytes;
      if (path === "resources/character-match.json") {
        const body = JSON.parse(bytes.toString());
        const { badge: _badge, faction: _faction, ...metadata } = body.metadata;
        expect(body.definition.tablePortrait).toEqual({ anchorY: 1 });
        const { tablePortrait: _tablePortrait, ...definition } = body.definition;
        original = `${JSON.stringify({ ...body, metadata, definition, rewardSkillResourceIds: [] }, null, 2)}\n`;
      }

      expect(sha(original), `${entry.character}/${path}`).toBe(digest);
    }
  }
});
