import { describe, expect, it } from "vitest";
import { LOBBY_INFO_PAGES, LOBBY_INFO_URLS } from "./lobby-info";

describe("lobby information pages", () => {
  it("defines a single about page", () => {
    expect(LOBBY_INFO_PAGES.map((page) => page.id)).toEqual(["about"]);
  });

  it("uses the public release repository as the sole external destination", () => {
    expect(Object.values(LOBBY_INFO_URLS)).toHaveLength(1);
    expect(LOBBY_INFO_URLS.releaseRepository).toBeInstanceOf(URL);
    expect(LOBBY_INFO_URLS.releaseRepository.href).toBe("https://github.com/wetmzl/HoC-Core");
  });

  it("keeps the release link and source availability obligation after the selected copy", () => {
    const content = LOBBY_INFO_PAGES[0].content;
    expect(content).toContain('href="https://github.com/wetmzl/HoC-Core" target="_blank" rel="noopener noreferrer"');
    expect(content).toContain("提供源代码是本项目的义务。");
    expect(content).toContain("各发布版本的对应源代码可在上述仓库获取。");
    expect(content.match(/<a /g)).toHaveLength(1);
  });
});
