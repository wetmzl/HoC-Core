import { bootLoad } from "./persistence/boot";
import { createPersistenceService } from "./persistence/factory";
import type { SaveRepository } from "./persistence/repository";
import { completeTutorial, THIRD_PARTY_CONTENT_WARNING_ID } from "./tutorials/tutorials";

export const THIRD_PARTY_CONTENT_WARNING_PARAGRAPHS = [
  "当前游戏已载入第三方资源包。",
  "第三方资源包不受 HoC Core 的维护与审核，由各自作者独立制作、维护和传播。能够导入或运行，不代表 HoC Core 对其内容、安全性或质量作出认可。",
  "请将这些资源包视为来源不明、未经审核的高风险内容。它们可能在没有任何预先提示的情况下，呈现露骨色情、血腥暴力、令人强烈不适的猎奇画面、侮辱与仇恨内容，也可能包含欺骗性设计、恶意脚本或其他有害行为。资源包的标题、封面及作者提供的说明，不能保证准确反映实际内容。",
  "HoC Core 无法保证载入第三方资源包后游戏仍能稳定运行。资源包可能导致规则异常、功能失效、游戏崩溃、存档损坏或进度丢失。",
  "如果你无法确认资源包的来源与内容，或不愿承担上述风险，请返回资源管理页面，停用相关资源包后再开始游戏。"
] as const;

/** This gate runs before importing any plugin code. Only a successfully saved confirmation unlocks it. */
export async function requireThirdPartyContentAcknowledgement(
  root: HTMLDivElement,
  repository: SaveRepository = createPersistenceService()
): Promise<boolean> {
  const save = await bootLoad(repository);
  if (save.tutorialProgress.completedIds.includes(THIRD_PARTY_CONTENT_WARNING_ID)) return true;
  const previousInert = root.inert;
  root.inert = true;
  const backdrop = document.createElement("div");
  backdrop.className = "third-party-content-warning-backdrop";
  backdrop.innerHTML = `<section id="third-party-content-warning" class="third-party-content-warning-modal" role="dialog" aria-modal="true" aria-labelledby="third-party-content-warning-title" aria-describedby="third-party-content-warning-copy"><p class="eyebrow">House of Chances</p><h1 id="third-party-content-warning-title">第三方内容警告</h1><div id="third-party-content-warning-copy">${THIRD_PARTY_CONTENT_WARNING_PARAGRAPHS.map((copy) => `<p>${copy}</p>`).join("")}</div><div class="third-party-content-warning-actions"><button type="button" class="secondary-button" data-cancel-third-party-content>返回资源管理</button><button type="button" class="primary-button" data-acknowledge-third-party-content>我已了解风险，继续游戏</button></div><p class="third-party-content-warning-status" role="status" aria-live="polite"></p></section>`;
  document.body.append(backdrop);
  const confirm = backdrop.querySelector<HTMLButtonElement>("[data-acknowledge-third-party-content]")!;
  const cancel = backdrop.querySelector<HTMLButtonElement>("[data-cancel-third-party-content]")!;
  const status = backdrop.querySelector<HTMLElement>(".third-party-content-warning-status")!;
  cancel.focus();
  const events = new AbortController();
  let saving = false;
  try {
    return await new Promise<boolean>((resolve) => {
      cancel.addEventListener("click", () => { if (!saving) resolve(false); }, { signal: events.signal });
      backdrop.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (!saving) resolve(false);
        }
      }, { signal: events.signal });
      confirm.addEventListener("click", () => {
        if (saving) return;
        saving = true;
        confirm.disabled = true;
        cancel.disabled = true;
        const progress = completeTutorial(save.tutorialProgress, THIRD_PARTY_CONTENT_WARNING_ID);
        void repository.saveLongTerm({ ...save, tutorialProgress: { completedIds: [...progress.completedIds] }, updatedAt: new Date().toISOString() })
          .then(() => resolve(true))
          .catch(() => {
            saving = false;
            confirm.disabled = false;
            cancel.disabled = false;
            status.textContent = "确认状态保存失败，请重试。";
            confirm.focus();
          });
      }, { signal: events.signal });
    });
  } finally {
    events.abort();
    backdrop.remove();
    root.inert = previousInert;
  }
}
