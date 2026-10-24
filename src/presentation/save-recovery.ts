import { downloadRawSave } from "../persistence/json";
import type { LongTermSave } from "../persistence/schema";

/** Recovery payloads are opaque data: render labels only, and export originals on request. */
export function mountSaveRecovery(container: HTMLElement, save: LongTermSave): void {
  container.replaceChildren();
  if (!save.recovery) return;
  const heading = document.createElement("h3"); heading.textContent = "存档恢复记录";
  const explanation = document.createElement("p");
  explanation.textContent = "已尽量读取兼容的进度，不兼容部分保留在恢复前原件中。普通存档导出也会携带这些原件。";
  const labels: Record<string, string> = { profile: "玩家档案与卡组", settings: "游戏与插件设置", history: "对局历史", defeats: "击败记录", tutorialProgress: "教程进度", skipTutorial: "教程设置", schemaVersion: "存档版本", gameVersion: "游戏版本", createdAt: "创建时间", updatedAt: "更新时间" };
  const affected = [...new Set(save.recovery.issues.map(issue => labels[issue.split(/[.:]/)[0]] ?? "其他字段"))];
  const summary = document.createElement("p"); summary.textContent = `恢复时发现不兼容的项目：${affected.join("、") || "无"}。`;
  const status = document.createElement("p"); status.className = "status-line"; status.setAttribute("role", "status");
  const actions = document.createElement("div"); actions.className = "save-actions";
  save.recovery.originals.forEach((original, index) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "secondary-button";
    button.dataset.exportRecoveredOriginal = String(index);
    button.textContent = `导出恢复前原件${save.recovery!.originals.length > 1 ? ` ${index + 1}` : ""}`;
    button.addEventListener("click", () => {
      button.disabled = true;
      void downloadRawSave(original, `house-of-chances-original-${index + 1}.json`).then(() => { status.textContent = "原件已交给系统保存或分享。"; })
        .catch(() => { status.textContent = "原件导出失败，请重试。"; }).finally(() => { button.disabled = false; });
    });
    actions.append(button);
  });
  container.append(heading, explanation, summary, actions, status);
}
