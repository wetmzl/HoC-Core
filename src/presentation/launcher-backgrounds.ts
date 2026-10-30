/** 每个版本可追加独立图片；当前启动器固定使用 CSS 默认图，尚未接入切换。 */
export interface LauncherBackground {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly imageUrl: string;
  readonly position?: string;
}

export const LAUNCHER_BACKGROUNDS: readonly LauncherBackground[] = [
  {
    id: "v0.2.0-beta1-ai-hall",
    version: "0.2.0-beta1",
    title: "卓越挑战者",
    imageUrl: "/assets/backgrounds/launcher-ai-hall.png",
    position: "center"
  }
];

/** 未指定或找不到 ID 时使用清单第一项；空清单不产生选择。 */
export function selectLauncherBackground(
  id?: string,
  backgrounds: readonly LauncherBackground[] = LAUNCHER_BACKGROUNDS
): LauncherBackground | undefined {
  return backgrounds.find((background) => background.id === id) ?? backgrounds[0];
}

/** 只计算相邻项，不启动定时器、不持久化、不改变界面。 */
export function stepLauncherBackground(
  currentId: string | undefined,
  direction: "previous" | "next",
  backgrounds: readonly LauncherBackground[] = LAUNCHER_BACKGROUNDS
): LauncherBackground | undefined {
  const index = backgrounds.findIndex((background) => background.id === currentId);
  if (index < 0) return backgrounds[0];
  const offset = direction === "next" ? 1 : -1;
  return backgrounds[(index + offset + backgrounds.length) % backgrounds.length];
}

/** 未来入口选中背景后可调用；当前没有运行时调用方。 */
export function applyLauncherBackground(element: HTMLElement, background: LauncherBackground): void {
  element.style.setProperty("--launcher-background-image", `url("${background.imageUrl}")`);
  element.style.setProperty("--launcher-background-position", background.position ?? "center");
}
