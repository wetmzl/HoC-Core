import { describe, expect, it } from "vitest";
import { ContentStartupError } from "./content/packages/startup-error";
import { explainStartupError } from "./startup-error-dialog";

function apiError(version: number, supported = [2, 3, 4]) {
  return new ContentStartupError("原始 API 报错，不应被丢弃", {
    reason: "api-version-unsupported", packageId: "test/plugin", packageTitle: "测试插件",
    resourceType: "plugin.module", apiVersion: version, supportedApiVersions: supported
  });
}

describe("startup failure guidance", () => {
  it("distinguishes an old plugin, a newer plugin, and a gap in supported versions", () => {
    const old = explainStartupError(apiError(1));
    expect(old.title).toContain("太旧");
    expect(old.steps.join()).toContain("插件的新版");
    expect(old.steps.join()).toContain("旧版游戏");
    expect(old.steps.join()).not.toContain("先更新 HoC 客户端");
    const newer = explainStartupError(apiError(5));
    expect(newer.steps.join()).toContain("先更新 HoC 客户端");
    expect(newer.steps.join()).toContain("旧版插件");
    expect(explainStartupError(apiError(3, [2, 4])).title).toContain("版本对不上");
    expect(newer.details).toBe("原始 API 报错，不应被丢弃");
  });

  it.each(["manifest-invalid", "payload-invalid", "dependency-unavailable", "handler-missing", "dependency-cycle"])("offers recovery for %s and preserves package context through causes", reason => {
    const source = new ContentStartupError("原始报错", { reason, packageId: "test/content", packageTitle: "测试内容" });
    const info = explainStartupError(new Error("外层报错", { cause: source }));
    expect(info.failure?.packageId).toBe("test/content");
    expect(info.steps.join()).toMatch(/停用/);
    expect(info.details).toBe("外层报错\n\n原因：原始报错");
    expect(info.steps.join()).not.toContain("详细报错");
    expect(info.explanation).not.toContain(reason);
    if (reason === "dependency-cycle") expect(info.explanation).toContain("都在等对方");
  });

  it("keeps fallback and integrity errors readable without guessing an API direction", () => {
    expect(explainStartupError(new Error("未知失败")).steps.join()).toContain("游戏开发者");
    const error = new Error("content digest mismatch"); error.name = "ContentPackageIntegrityError";
    expect(explainStartupError(error).title).toContain("文件");
    expect(explainStartupError(error).steps.join()).toContain("备份存档");
  });
});
