import { describe, expect, it } from "vitest";
import { ABILITY_DEFINITIONS } from "./registry";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function productionTypeScript(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScript(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [readFileSync(path, "utf8")] : [];
  }).join("\n");
}

describe("ability architecture boundaries", () => {
  it("keeps concrete skill identifiers out of match orchestration and the generic interpreter", () => {
    const match = productionTypeScript(join(CORE_ROOT, "match"));
    const interpreter = ["engine.ts", "conditions.ts", "effects.ts", "runtime.ts", "card-zone-adapter.ts", "roulette-adapter.ts"]
      .map((file) => readFileSync(join(CORE_ROOT, "abilities", file), "utf8")).join("\n");
    for (const { id } of ABILITY_DEFINITIONS) {
      expect(match, `match layer contains ${id}`).not.toContain(id);
      expect(interpreter, `generic interpreter contains ${id}`).not.toContain(id);
    }
    expect(interpreter).not.toMatch(/(?:if|switch)\s*\([^)]*definitionId[^)]*\)/);
  });

  it("contains no character-id literal branch in core production code", () => {
    const core = productionTypeScript(CORE_ROOT);
    expect(core).not.toMatch(/(?:characterId|opponentId)\s*={2,3}\s*["'][a-z0-9-]+["']/);
  });
});
