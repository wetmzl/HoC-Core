import { openUiDialog, closeUiDialog } from "./presentation/dialog-motion";
import { getContentStartupFailure, type ContentStartupFailure } from "./content/packages/startup-error";

export interface StartupErrorExplanation {
  readonly title: string;
  readonly explanation: string;
  readonly steps: readonly string[];
  readonly failure?: ContentStartupFailure;
  readonly details: string;
}

function diagnosticText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    const message = error.message;
    if (!messages.some(existing => existing.includes(message))) messages.push(message);
    error = error.cause;
  }
  return messages.join("\n\n原因：");
}

export function explainStartupError(error: unknown): StartupErrorExplanation {
  const details = diagnosticText(error);
  const failure = getContentStartupFailure(error);
  const result = (title: string, explanation: string, steps: readonly string[]): StartupErrorExplanation => ({ title, explanation, steps, failure, details });
  if (failure?.reason === "api-version-unsupported") {
    const plugin = failure.resourceType === "plugin.module";
    const subject = plugin ? "插件" : "内容包";
    const supported = failure.supportedApiVersions ?? [];
    const version = failure.apiVersion;
    if (supported.length && version !== undefined && version < Math.min(...supported)) {
      return result(`这个${subject}太旧了`, `这个${subject}使用的是旧接口（API），和现在的游戏对不上。`, [
        `先下载这个${subject}的新版，再到“资源管理”里导入。`,
        `如果作者没有新版，可以按作者的说明，使用它支持的旧版游戏。`,
        `想先玩？到“资源管理”里停用这个${subject}。`
      ]);
    }
    if (supported.length && version !== undefined && version > Math.max(...supported)) {
      return result("先把游戏更新一下", `这个${subject}需要更新的接口（API），现在的游戏还不认识它。`, [
        "先更新 HoC 客户端，再试一次“开始游戏”。",
        `暂时不能更新？请换用适合当前游戏的旧版${subject}。`,
        `想先玩？到“资源管理”里停用这个${subject}。`
      ]);
    }
    return result(`${subject}和游戏版本对不上`, `现在的游戏不支持这个${subject}使用的接口（API）。`, [
      `查看${subject}作者的说明，使用相互兼容的游戏和${subject}版本。`,
      `也可以先到“资源管理”里停用它，再开始游戏。`
    ]);
  }
  if (failure?.reason === "dependency-cycle") {
    return result("这个包里的内容互相卡住了", "包里的内容都在等对方先准备好，谁也没法先开始。这叫“依赖循环”。", [
      "到“资源管理”里先停用这个包，就可以试着玩其他内容。",
      "下载并导入作者修好的新版，再重新启用。",
      "如果没有新版，请联系包作者，告诉他这个包出现了依赖循环。"
    ]);
  }
  if (failure?.reason === "manifest-invalid") {
    return result("这个包的配置有问题", "包里的一些设置对不上，游戏没法按它的说明运行。", [
      "先下载并导入这个包的新版。",
      "如果还是不行，请联系包作者，说明这个包无法启动。",
      "想先玩？到“资源管理”里停用这个包。"
    ]);
  }
  if (failure?.reason === "payload-invalid") {
    return result("这个包里的内容读不懂", "有个文件写坏了，或它的写法不适合现在的游戏，所以暂时无法开始。", [
      "重新下载完整的包，再到“资源管理”里导入。",
      "如果还是不行，请联系包作者，说明这个包里的内容无法读取。",
      "想先玩？到“资源管理”里停用这个包。"
    ]);
  }
  if (failure?.reason === "dependency-unavailable" || failure?.reason === "handler-missing") {
    return result("这个包缺少能一起用的内容", "它需要的角色、技能或插件没有准备好，现在还不能一起运行。", [
      "按包作者的说明，导入并启用配套的内容。",
      "检查这些包是否适合当前游戏版本；不确定时，请询问包作者。",
      "也可以先在“资源管理”里停用这个包。"
    ]);
  }
  if (error instanceof Error && (error.name === "ContentPackageIntegrityError" || /内容.*(?:缺失|摘要不符|大小不符|完整性)/.test(details))) {
    return result("有些文件不见了或损坏了", "游戏没有读到完整的内容，暂时不能开始。", [
      "重新下载原来的完整包，再到“资源管理”里导入。",
      "如果是游戏自带的内容，请更新或重新安装客户端。操作前先备份存档。",
      "也可以先停用有问题的外部包，再试一次。"
    ]);
  }
  return result("游戏暂时没有准备好", "这次没能开始游戏。你可以先检查刚添加的内容，再试一次。", [
    "到“资源管理”里检查刚添加的包，试着先停用它们。",
    "如果还是不行，请联系包作者或游戏开发者，说明是在开始游戏时失败。"
  ]);
}

/** Keep the original diagnostics, without explanatory small print. */
export function showStartupErrorDialog(error: unknown, options: { readonly onDisableAndRetry?: () => Promise<void | boolean> } = {}): Promise<"manage" | "retry" | null> {
  const info = explainStartupError(error);
  const dialog = document.createElement("dialog");
  dialog.className = "modal startup-error-dialog";
  dialog.dataset.startupError = "";
  dialog.setAttribute("aria-labelledby", "startup-error-title");
  dialog.setAttribute("aria-describedby", "startup-error-explanation");
  dialog.innerHTML = `<header class="startup-error-header"><p class="startup-error-kicker">OOPS!</p><h2 id="startup-error-title">这次没能开始游戏</h2><button type="button" class="modal-close" data-startup-error-close aria-label="关闭启动失败提示">×</button></header><div class="startup-error-content"><h3 data-startup-error-reason></h3><p id="startup-error-explanation"></p><div class="startup-error-package" hidden><span>需要检查的包</span><strong></strong></div><h3 class="startup-error-help">可以这样解决</h3><ol data-startup-error-steps></ol><p class="startup-error-action-error" role="alert" hidden></p><details class="startup-error-details"><summary>详细报错</summary><pre tabindex="0" aria-label="详细报错信息"></pre><button type="button" class="secondary-button" data-startup-error-copy>复制报错</button><span class="startup-error-copy-status" role="status" hidden></span></details></div><footer class="startup-error-actions"><button type="button" class="primary-button" data-startup-error-retry>禁用相关内容并重试</button><button type="button" class="secondary-button" data-startup-error-manage>去资源管理</button><button type="button" class="secondary-button" data-startup-error-close>返回启动器</button></footer>`;
  dialog.querySelector<HTMLElement>("[data-startup-error-reason]")!.textContent = info.title;
  dialog.querySelector<HTMLElement>("#startup-error-explanation")!.textContent = info.explanation;
  const list = dialog.querySelector<HTMLOListElement>("[data-startup-error-steps]")!;
  for (const step of info.steps) {
    const item = document.createElement("li"); item.textContent = step; list.append(item);
  }
  if (info.failure) {
    const item = dialog.querySelector<HTMLElement>(".startup-error-package")!;
    item.hidden = false;
    item.querySelector("strong")!.textContent = info.failure.packageTitle;
  }
  let diagnostic = info.details;
  const pre = dialog.querySelector("pre")!;
  pre.textContent = diagnostic;
  dialog.querySelector<HTMLButtonElement>("[data-startup-error-copy]")!.addEventListener("click", async () => {
    const status = dialog.querySelector<HTMLElement>(".startup-error-copy-status")!;
    status.hidden = false;
    try { await navigator.clipboard.writeText(diagnostic); status.textContent = "已复制"; }
    catch { status.textContent = "复制失败，请选中报错文字手动复制。"; }
  });
  const retry = dialog.querySelector<HTMLButtonElement>("[data-startup-error-retry]")!;
  let working = false;
  if (!options.onDisableAndRetry) {
    retry.remove();
    dialog.querySelector<HTMLButtonElement>("[data-startup-error-manage]")!.className = "primary-button";
  } else retry.addEventListener("click", async () => {
    if (working) return;
    working = true;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    buttons.forEach(button => { button.disabled = true; });
    retry.textContent = "正在禁用…";
    retry.setAttribute("aria-busy", "true");
    const status = dialog.querySelector<HTMLElement>(".startup-error-action-error")!;
    status.hidden = true;
    try {
      if (await options.onDisableAndRetry!() === false) return;
      await closeUiDialog(dialog, "retry");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = message === "至少需要保留一个启用的角色包。"
        ? "需要先启用另一个角色包，才能禁用这个包。"
        : "操作没有完成，请到资源管理检查后再试。";
      status.hidden = false;
      diagnostic += `\n\n禁用失败：${message}`;
      pre.textContent = diagnostic;
      status.scrollIntoView({ block: "nearest" });
    } finally {
      working = false;
      buttons.forEach(button => { button.disabled = false; });
      retry.textContent = "禁用相关内容并重试";
      retry.removeAttribute("aria-busy");
    }
  });
  dialog.addEventListener("cancel", event => { if (working) event.preventDefault(); });
  for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-startup-error-close]")) button.addEventListener("click", () => { void closeUiDialog(dialog); });
  dialog.querySelector<HTMLButtonElement>("[data-startup-error-manage]")!.addEventListener("click", () => { void closeUiDialog(dialog, "manage"); });
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue;
      dialog.remove(); resolve(value === "manage" || value === "retry" ? value : null);
    }, { once: true });
    openUiDialog(dialog);
  });
}
