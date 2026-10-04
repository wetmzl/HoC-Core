export interface GameDialogChoice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly style?: "primary" | "danger" | "secondary";
}

let nextDialogId = 0;

/** A styled game dialog. Closing it by Escape or the close button selects nothing. */
export function chooseGameDialog<T extends string>(
  title: string,
  message: string,
  choices: readonly GameDialogChoice<T>[]
): Promise<T | null> {
  const dialog = document.createElement("dialog");
  const headingId = `game-dialog-title-${++nextDialogId}`;
  dialog.className = "modal game-dialog";
  dialog.dataset.gameDialog = "";
  dialog.setAttribute("aria-labelledby", headingId);
  dialog.innerHTML = `<button type="button" class="modal-close" data-game-dialog-close aria-label="关闭弹窗">×</button><h2 id="${headingId}"></h2><p data-game-dialog-message></p><div class="game-dialog-actions"></div>`;
  dialog.querySelector<HTMLElement>("h2")!.textContent = title;
  dialog.querySelector<HTMLElement>("[data-game-dialog-message]")!.textContent = message;
  const actions = dialog.querySelector<HTMLElement>(".game-dialog-actions")!;
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${choice.style ?? "secondary"}-button`;
    button.dataset.gameDialogChoice = choice.value;
    button.textContent = choice.label;
    actions.append(button);
  }
  document.body.append(dialog);
  return new Promise<T | null>((resolve) => {
    dialog.addEventListener("close", () => {
      const selection = choices.find((choice) => choice.value === dialog.returnValue);
      dialog.remove();
      resolve(selection?.value ?? null);
    }, { once: true });
    dialog.querySelector<HTMLButtonElement>("[data-game-dialog-close]")!.addEventListener("click", () => dialog.close());
    actions.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-game-dialog-choice]");
      if (button) dialog.close(button.dataset.gameDialogChoice);
    });
    dialog.showModal();
  });
}

export async function confirmGameDialog(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return await chooseGameDialog(title, message, [
    { value: "confirm", label: confirmLabel, style: "danger" },
    { value: "cancel", label: "取消" }
  ]) === "confirm";
}

export async function alertGameDialog(title: string, message: string): Promise<void> {
  await chooseGameDialog(title, message, [{ value: "ok", label: "知道了", style: "primary" }]);
}
