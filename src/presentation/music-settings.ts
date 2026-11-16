import { gameAudio } from "../audio/game-audio";
import type { MusicPriority } from "../audio/music-contracts";

const labels: Record<MusicPriority, string> = { core: "游戏默认", background: "普通背景", faction: "阵营", character: "角色", override: "全局覆盖", conditional: "条件切歌", temporary: "临时插曲" };

export function mountMusicSettings(root: HTMLElement, writeOrder: (order: readonly string[]) => Promise<void>, signal: AbortSignal): void {
  const section = document.createElement("details"); section.className = "music-settings";
  const heading = document.createElement("summary"); heading.textContent = "音乐与音乐包";
  const current = document.createElement("p"); current.setAttribute("role", "status"); current.dataset.musicCurrent = "";
  const hint = document.createElement("p"); hint.className = "setting-description";
  hint.textContent = "同级音乐优先使用排在前面的包。条件切歌和临时插曲结束后自动恢复背景音乐。";
  const list = document.createElement("ol"); list.className = "music-package-order"; list.dataset.musicPackageOrder = "";
  const diagnostics = document.createElement("div"); diagnostics.className = "setting-description"; diagnostics.dataset.musicCandidates = "";
  const message = document.createElement("p"); message.setAttribute("role", "status");
  section.append(heading, current, hint, list, diagnostics, message); root.append(section);
  let saving = false;
  const render = () => {
    if (signal.aborted) return;
    const status = gameAudio.musicDirector.status();
    const sourceName = (packageId: string) => status.packages.find(entry => entry.id === packageId)?.title;
    current.textContent = status.current ? `当前音乐：${status.current.title}${sourceName(status.current.packageId) ? ` · ${sourceName(status.current.packageId)}` : ""} · ${labels[status.current.priority]}` : "等待播放音乐";
    diagnostics.replaceChildren();
    for (const candidate of status.candidates) {
      const line = document.createElement("p");
      line.textContent = `${candidate.title}${sourceName(candidate.packageId) ? ` · ${sourceName(candidate.packageId)}` : ""} · ${labels[candidate.priority]}${status.failedTracks.includes(candidate.track) ? "（播放失败，已跳过）" : ""}`;
      diagnostics.append(line);
    }
    const unavailable = status.failedTracks.filter(track => !status.candidates.some(candidate => candidate.track === track));
    if (unavailable.length) { const line = document.createElement("p"); line.textContent = `${unavailable.length} 首音乐暂时不可用，已使用后续曲目。`; diagnostics.append(line); }
    if (saving) return;
    list.replaceChildren();
    status.packages.forEach((entry, index) => {
      const item = document.createElement("li");
      const name = document.createElement("span"); name.textContent = entry.title;
      const buttons = document.createElement("span"); buttons.className = "music-order-buttons";
      for (const [offset, label] of [[-1, "上移"], [1, "下移"]] as const) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.className = "secondary-button";
        button.setAttribute("aria-label", `${label}${entry.title}`);
        button.disabled = index + offset < 0 || index + offset >= status.packages.length;
        button.addEventListener("click", async () => {
          if (saving) return;
          const order = status.packages.map(entry => entry.id);
          [order[index], order[index + offset]] = [order[index + offset], order[index]];
          saving = true; message.textContent = "正在保存音乐顺序…";
          const dialog = root.closest("dialog");
          const disabled = new Map([...((dialog ?? root).querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select"))].map(node => [node, node.disabled]));
          disabled.forEach((_, node) => { node.disabled = true; });
          try { await writeOrder(order); if (!signal.aborted) message.textContent = "音乐顺序已保存。"; }
          catch { if (!signal.aborted) message.textContent = "音乐顺序保存失败，请重试。"; }
          finally { disabled.forEach((value, node) => { node.disabled = value; }); saving = false; render(); }
        }, { signal });
        buttons.append(button);
      }
      item.append(name, buttons); list.append(item);
    });
    if (!status.packages.length) { const item = document.createElement("li"); item.textContent = "尚未启用独立音乐包"; list.append(item); }
  };
  gameAudio.musicDirector.subscribeStatus(render, signal);
}
