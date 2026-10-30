import { describe, expect, it } from "vitest";
import { selectLauncherBackground, stepLauncherBackground, type LauncherBackground } from "./launcher-backgrounds";

const backgrounds: readonly LauncherBackground[] = [
  { id: "first", version: "1", title: "第一版", imageUrl: "/first.png" },
  { id: "second", version: "2", title: "第二版", imageUrl: "/second.png" },
  { id: "third", version: "3", title: "第三版", imageUrl: "/third.png" }
];

describe("启动器版本背景选择基础设施", () => {
  it("按稳定 ID 选择背景，而不依赖版本排列", () => {
    expect(selectLauncherBackground("second", backgrounds)).toBe(backgrounds[1]);
    expect(selectLauncherBackground("second", [...backgrounds].reverse())).toBe(backgrounds[1]);
  });

  it("旧 ID 已移除或未指定时回退到首项", () => {
    expect(selectLauncherBackground("removed", backgrounds)).toBe(backgrounds[0]);
    expect(selectLauncherBackground(undefined, backgrounds)).toBe(backgrounds[0]);
    expect(stepLauncherBackground("removed", "previous", backgrounds)).toBe(backgrounds[0]);
  });

  it("上一张和下一张在首尾循环，且不改写清单", () => {
    const frozen = Object.freeze([...backgrounds]);
    expect(stepLauncherBackground("first", "previous", frozen)).toBe(backgrounds[2]);
    expect(stepLauncherBackground("third", "next", frozen)).toBe(backgrounds[0]);
    expect(stepLauncherBackground("second", "previous", frozen)).toBe(backgrounds[0]);
    expect(stepLauncherBackground("second", "next", frozen)).toBe(backgrounds[2]);
  });

  it("单张保持当前背景，空清单不产生无效项", () => {
    const single = backgrounds.slice(0, 1);
    expect(stepLauncherBackground("first", "next", single)).toBe(backgrounds[0]);
    expect(stepLauncherBackground("first", "previous", single)).toBe(backgrounds[0]);
    expect(selectLauncherBackground("first", [])).toBeUndefined();
    expect(stepLauncherBackground("first", "next", [])).toBeUndefined();
  });
});
