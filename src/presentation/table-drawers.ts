import { createDetentDrawer } from "./detent-drawer";

export function mountSkillDrawer(root: HTMLElement, initial: number | "end", count: number, onChange: (open: boolean) => void) {
  const panel = root.querySelector<HTMLElement>(".skill-sidebar")!;
  const handle = panel.querySelector<HTMLButtonElement>(".skill-drawer-toggle")!;
  const viewport = panel.querySelector<HTMLElement>(".skill-drawer-viewport")!;
  const content = panel.querySelector<HTMLElement>(".skill-drawer-content")!;
  return createDetentDrawer({
    handle, axis: "x", direction: -1, initial,
    reducedMotion: () => document.body.classList.contains("reduced-motion"),
    stops: () => {
      const first = content.querySelector<HTMLElement>(".skill-tile");
      // The info button overhang is included, so the first column remains usable.
      return [0, ...(first ? [first.offsetLeft + first.offsetWidth + 15] : []), content.offsetWidth];
    },
    observe: [content],
    render: (position, settled) => {
      const open = position > .5;
      panel.style.width = `${Math.max(0, position)}px`;
      panel.style.transform = `translateX(${Math.max(0, -position)}px)`;
      panel.classList.toggle("is-open", open);
      viewport.inert = !open;
      // Only fully revealed columns can receive focus or clicks.
      content.querySelectorAll<HTMLElement>(".skill-tile").forEach(tile => {
        tile.inert = tile.offsetLeft + tile.offsetWidth > position + .5;
        tile.style.visibility = settled && tile.inert ? "hidden" : "";
      });
      handle.setAttribute("aria-expanded", String(open));
      handle.setAttribute("aria-label", `${open ? "收起" : "展开"}技能抽屉，共 ${count} 张，可拖动或用左右方向键调档`);
      handle.querySelector(".skill-drawer-arrow")!.textContent = open ? ">" : "<";
      (handle.querySelector(".skill-drawer-badge") as HTMLElement).hidden = open;
      onChange(Number(handle.dataset.drawerTarget) > .5);
    }
  });
}
