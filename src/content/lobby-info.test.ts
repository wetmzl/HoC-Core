import { describe, expect, it } from "vitest";
import { LOBBY_INFO_PAGES, LOBBY_INFO_URLS } from "./lobby-info";

describe("lobby information pages", () => {
  it("defines three independent pages", () => {
    expect(LOBBY_INFO_PAGES.map((page) => page.id)).toEqual(["about", "community", "credits"]);
  });

  it("keeps every external destination as an HTTPS URL object", () => {
    for (const url of Object.values(LOBBY_INFO_URLS)) {
      expect(url).toBeInstanceOf(URL);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("www.pixiv.net");
    }
  });

  it("includes the supplied copy and link destinations", () => {
    expect(LOBBY_INFO_PAGES.find((page) => page.id === "about")?.content).toContain("由爱好者维护的免费、非商业游戏项目");
    expect(LOBBY_INFO_PAGES.find((page) => page.id === "community")?.content).toContain("如有问题或建议，可通过下方联系方式反馈。");
    const credits = LOBBY_INFO_PAGES.find((page) => page.id === "credits")?.content;
    expect(credits).toContain("确定了整体写作基调，并独立完成多项角色文案");
    expect(credits).toContain("蝉時雨：参与游戏早期的测试与平衡性调整");
    expect(credits).toContain("oink：参与了游戏的早期测试，为游戏提供了第一批宝贵的反馈");
    expect(credits).toContain("选择匿名参与志愿者们：为游戏提出了不少的启发和微调意见");
    expect(credits).toContain("谢谢你们让HoC项目继续运转！");
  });

  it("does not publish the withdrawn QQ group", () => {
    const community = LOBBY_INFO_PAGES.find((page) => page.id === "community")?.content;
    expect(community).not.toContain("玩家交流 / 测试群");
    expect(Object.keys(LOBBY_INFO_URLS)).not.toContain("playerGroup");
  });
});
