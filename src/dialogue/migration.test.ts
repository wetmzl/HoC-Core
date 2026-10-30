import previewRevisions from "../test/fixtures/character-preview-revisions.json";
import copyRevisions from "../test/fixtures/skill-copy-revisions.json";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import audit from "../test/fixtures/dialogue-events-migration.json";
import type { DialogueRule } from "./types";
import { readCharacterResourceFixture } from "../test/character-fixtures";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
it("migrates all five built-in roles without changing pools, source anchors, media or skills", () => {
  for (const entry of audit.characters) {
    const root = `public/characters/${entry.character}`;
    const manifest = JSON.parse(readFileSync(`${root}/hocpkg-info.json`, "utf8")), dialogue = readCharacterResourceFixture(entry.character, "resources/dialogue.json");
    expect(manifest.resources.find((r: { type: string }) => r.type === "game.character-dialogue").apiVersion).toBe(4);
    // Preserve the historical migration audit while allowing later, explicitly authored additions.
    const { CHARACTER_TAP: _tap, CHARACTER_TAP_DEFEATED: _defeatedTap, CHARACTER_TAP_ROULETTE: _rouletteTap, PLAYER_DEFEAT_PREVENTED: _playerPrevention, OPPONENT_DEFEAT_PREVENTED: _opponentPrevention, ...originalPools } = dialogue.pools;
    const originalRules = dialogue.rules.filter((rule: DialogueRule) => !["character-tap", "character-tap-defeated", "character-tap-roulette", "PLAYER_DEFEAT_PREVENTED", "OPPONENT_DEFEAT_PREVENTED"].includes(rule.id)).map((rule: DialogueRule) => {
      // Defeat prevention adds a guard to the two historical terminal-shot rules.
      if (!["PLAYER_TRIGGER_HIT", "OPPONENT_TRIGGER_HIT"].includes(rule.id) || !("all" in rule.when)) return rule;
      expect(rule.when.all.at(-1)).toEqual({ not: { primitive: "core.defeat-prevented", apiVersion: 1, args: { actor: rule.id === "PLAYER_TRIGGER_HIT" ? "player" : "opponent" }, test: { eq: true } } });
      return { ...rule, when: { all: rule.when.all.slice(0, -1) } };
    });
    expect(originalRules).toHaveLength(23); expect(Object.keys(originalPools)).toHaveLength(21);
    expect(sha(JSON.stringify(originalPools))).toBe(entry.poolsSha256);
    expect(sha(JSON.stringify(originalRules.map(({ on: _on, ...rule }: DialogueRule) => rule)))).toBe(entry.rulesSha256);
    for (const [path, digest] of Object.entries({ ...entry.mediaSha256, ...entry.resourcesSha256 })) {
      const bytes = readFileSync(`${root}/${path}`);
      const previewRevision = previewRevisions.characters[entry.character as keyof typeof previewRevisions.characters];
      if (path === "cover.png") {
        expect(sha(bytes)).toBe(previewRevision.coverSha256);
        continue;
      }
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
        const body = readCharacterResourceFixture(entry.character, path);
        delete body.presentationResourceId;
        for (const binding of body.aiSkills) {
          expect(binding.level).toBe(entry.character === "claude" ? 2 : 1);
          delete binding.level;
        }
        expect(body.metadata).toMatchObject(previewRevision.after);
        const { badge: _badge, faction: _faction, encounter: _encounter, previewFocus: _previewFocus, ...metadata } = body.metadata;
        // Preview calibration was explicitly authored later; validate it before restoring the historical projection.
        metadata.previewImage = previewRevision.before.previewImage;
        expect(body.definition.tablePortrait.anchorY).toBe(1);
        expect(body.definition.tablePortrait.images.every((image: { anchorY: number }) => image.anchorY === 1)).toBe(true);
        const { tablePortrait: _tablePortrait, ...definition } = body.definition;
        if (entry.character === "claude") {
          // The explicitly authored SS development revision changes tier, loadout and profile backgrounds.
          expect(metadata.tier).toBe("SS");
          expect(body.aiSkills).toHaveLength(4);
          expect(definition.profile.backgrounds).toHaveLength(2);
          metadata.tier = "S";
          delete definition.profile.backgrounds;
          body.aiSkills = ["claude-moment", "claude-safety-constitution"].map(id => ({ resourceId: `ai:${id}`, enabled: true, parameters: {} }));
        }
        original = `${JSON.stringify({ ...body, metadata, definition, rewardSkillResourceIds: [] }, null, 2)}\n`;
      }

      expect(sha(original), `${entry.character}/${path}`).toBe(digest);
    }
  }
});
