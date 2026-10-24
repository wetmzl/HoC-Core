import { describe, expect, it } from "vitest";
import { completeTutorial, completeTutorialsByTag, firstTutorialForCue, TUTORIAL_DEFINITIONS } from "./tutorials";

describe("tutorial catalog and progress", () => {
  it("offers a tutorial only after its real mechanism cue and only until completion", () => {
    const empty = { completedIds: [] };
    const tutorial = firstTutorialForCue("skill-draw-available", empty);
    expect(tutorial).toMatchObject({ id: "skill-draw-system", title: "技能抽卡系统", tags: ["skills"] });
    expect(tutorial?.pages[0]?.body).toContain("右下角的金色按钮");
    expect(firstTutorialForCue("skill-draw-available", completeTutorial(empty, tutorial!.id))).toBeNull();
    expect(firstTutorialForCue("skill-draw-available", empty, true)).toBeNull();
  });

  it("supports any positive page count and optional page resources", () => {
    for (const tutorial of TUTORIAL_DEFINITIONS) {
      expect(tutorial.pages.length).toBeGreaterThan(0);
      for (const page of tutorial.pages) expect(page.resources ?? []).toEqual(expect.any(Array));
    }
  });

  it("marks all tutorials sharing a tag without duplicating existing progress", () => {
    const completed = completeTutorialsByTag({ completedIds: [] }, "skills");
    expect(completed.completedIds).toEqual(["skill-draw-system"]);
    expect(completeTutorialsByTag(completed, "skills")).toBe(completed);
    expect(completeTutorialsByTag(completed, "missing-tag")).toBe(completed);
  });
});
