import { Capacitor } from "@capacitor/core";
import { characterPreviewStyle } from "./presentation/character-preview";
import { characterEncounterCapabilities } from "./content/characters/encounter-capabilities";
import { profileDialogMarkup } from "./presentation/profile-controller";
import "./lobby-screen.css";
import "./presentation/character-badge.css";
import { version, releaseName } from "../package.json";
import { LOBBY_INFO_PAGES } from "./content/lobby-info";
import type { CharacterMetadata } from "./content/characters";
import type { LongTermSave } from "./persistence/schema";
import { DEFAULT_MUSIC_VOLUME } from "./audio/music-volume";
import { telemetrySettingsMarkup } from "./telemetry";

export type LobbyLayer = "menu" | "characters";

export interface LobbyScreenView {
  readonly menuActions: readonly import("./presentation/main-menu-actions").MainMenuAction[];
  readonly pluginCredits?: readonly import("./content/packages/plugin-credits").PluginCreditsSection[];
  readonly save: LongTermSave;
  readonly layer: LobbyLayer;
  readonly guests: readonly CharacterMetadata[];
  readonly defeated: readonly CharacterMetadata[];
  readonly visibleDefeated: readonly CharacterMetadata[];
  readonly defeatedRemaining: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}

function menuSlotMarkup(actions: LobbyScreenView["menuActions"], slot: import("./content/packages/plugin-ui").PluginUiSlot): string {
  return actions.filter(action => action.slot === slot && !action.portraitEntry).map(action => {
    const attrs = Object.entries(action.attributes ?? {}).map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(" ");
    const tools = slot === "main-menu.tools";
    const icon = action.iconMarkup ?? (action.icon ? `<span aria-hidden="true">${escapeHtml(action.icon)}</span>` : tools ? `<span aria-hidden="true">${escapeHtml(action.label.slice(0, 1))}</span>` : "");
    return `<button type="button" class="${tools ? "icon-button lobby-round-button" : "lobby-menu-button lobby-secondary-action"} ${escapeHtml(action.className ?? "")}" data-ui-action="${escapeHtml(action.id)}" ${attrs} aria-label="${escapeHtml(action.label)}" title="${escapeHtml(action.description ?? action.label)}">${icon}${tools ? "" : `<strong>${escapeHtml(action.label)}</strong>${action.description ? `<small>${escapeHtml(action.description)}</small>` : ""}`}</button>`;
  }).join("");
}

function pluginCreditsMarkup(sections: NonNullable<LobbyScreenView["pluginCredits"]>): string {
  return sections.map(section => `<section class="plugin-credits" data-plugin-credits="${escapeHtml(section.packageId)}"><h3>${escapeHtml(section.title)}</h3>${section.paragraphs.map(paragraph => `<p>${paragraph.map(span => span.href ? `<a href="${escapeHtml(span.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(span.text)}</a>` : escapeHtml(span.text)).join("")}</p>`).join("")}</section>`).join("");
}

function lobbyDialogsMarkup(save: LongTermSave, credits: NonNullable<LobbyScreenView["pluginCredits"]>): string {
  const musicVolume = save.settings.musicVolume ?? DEFAULT_MUSIC_VOLUME;
  const infoDialogs = LOBBY_INFO_PAGES.map((page) => `<dialog id="${page.id}" class="modal lobby-info-modal" aria-labelledby="${page.id}-title"><button class="modal-close" data-close aria-label="关闭${page.title}">×</button><p class="eyebrow">${page.eyebrow}</p><h2 id="${page.id}-title">${page.title}</h2><div class="lobby-info-copy">${page.content}${page.id === "credits" ? pluginCreditsMarkup(credits) : ""}</div></dialog>`).join("");
  return `${save.recovery ? `<p class="status-line" role="status" data-save-recovery-notice>存档恢复记录已保留，可在设置中查看说明和导出原件。</p>` : ""}<dialog id="rules" class="modal"><button class="modal-close" data-close aria-label="关闭">×</button><h2>玩法说明</h2><p>你玩过21点吗？没玩过也没关系，这游戏简单到猫咪都能学会。</p><p>简单来说：你和对手玩黑杰克，输掉牌局的人，要往自己的轮盘里多加一发子弹——然后祈祷，扣下扳机。</p><p>游戏中，你和对手轮流行动。你可以选择要牌（Hit），继续抽一张牌；也可以选择停牌（Stand），保留当前点数。你的目标很简单：在不超过爆牌上限的情况下，让自己的点数尽可能高。爆牌上限通常是21点。超过上限会标记爆牌，但你仍可行动，双方停牌后才结算。</p><p>结算顺序是：天然黑杰克、爆牌、点数比较。只有一方拥有天然黑杰克时，该方直接获胜；双方都有则平局。双方都没有天然黑杰克时，再判定爆牌：只有一方爆牌则该方失败，双方爆牌则平局。双方都未爆牌时，应用技能点数加成后比较点数，点数更高的一方获胜，相同则平局。</p><p>（注：黑杰克的正常数字牌按牌面数字计算，J、Q、K都算10点；A则可以算作1点或11点，以对你更有利的方式计算。）</p><p>结算时最终两张手牌为A与10/J/Q/K，就构成“天然黑杰克”，优先于爆牌和任何点数加成结算。多张牌组成的21点不算天然黑杰克。天然黑杰克获胜时，败者基础装填2发子弹；策展人获胜还可获得2次技能抽卡。</p><p>当然，如果只是老老实实赌博也太无聊了。你和对手都会拥有各种技能，它们可以改变抽牌、点数、胜负条件，甚至直接干涉牌局规则。合理搭配自己的技能，有时候比单纯拿到一手好牌更加重要。</p></dialog>${infoDialogs}<dialog id="skills" class="modal skills-modal" aria-labelledby="skills-title"><button class="modal-close" data-close aria-label="关闭">×</button><p class="eyebrow">策展人的收藏</p><h2 id="skills-title">技能与天赋</h2><div id="skill-content"></div></dialog>${profileDialogMarkup()}<dialog id="settings" class="modal"><button class="modal-close" data-close aria-label="关闭">×</button><p class="eyebrow">古堡牌桌</p><h2>设置</h2><label class="setting"><input type="checkbox" data-setting="soundEnabled" ${save.settings.soundEnabled ? "checked" : ""}> 开启声音</label><label class="setting music-volume-setting"><span>音乐音量 <span data-music-volume-value aria-hidden="true">${Math.round(musicVolume * 100)}%</span></span><input type="range" data-setting="musicVolume" aria-label="音乐音量" aria-describedby="music-volume-description" min="0" max="1" step="0.01" value="${musicVolume}"><small id="music-volume-description">大厅与牌局音乐；拖动即时试听，松开自动保存。0% 为静音。</small></label><label class="setting"><input type="checkbox" data-setting="reducedMotion" ${save.settings.reducedMotion ? "checked" : ""}> 减少动态效果</label><label class="setting"><input type="checkbox" data-setting="autoSkipAfterStand" aria-describedby="stand-setting-description" ${(save.settings.autoSkipAfterStand ?? true) ? "checked" : ""}> Stand 后自动跳过回合</label><p class="setting-description" id="stand-setting-description">关闭后，停牌仍可使用技能或再次 Stand，但不能要牌。新牌局生效。</p>${telemetrySettingsMarkup()}${Capacitor.isNativePlatform() ? "" : "<div data-embedded-offline></div>"}<div data-plugin-settings-form></div><div data-save-recovery></div><div class="save-actions"><label class="save-export-format"><span>导出格式</span><select data-export-format><option value="image">图片存档（推荐）</option><option value="json">JSON 文件</option></select></label><button class="secondary-button" data-export>导出存档</button><button class="secondary-button" data-import>从图片或 JSON 导入</button><button class="danger-button" data-reset>删除长期存档</button><input id="save-file" type="file" accept="image/png,.png,application/json,.json" hidden></div><p class="status-line" id="lobby-status"></p></dialog><dialog id="save-import-error" class="modal" aria-labelledby="save-import-error-title"><button class="modal-close" data-close aria-label="关闭导入提示">×</button><p class="eyebrow">存档版本不合牌桌规矩</p><h2 id="save-import-error-title">导入失败</h2><p id="save-import-error-copy"></p><div class="save-actions"><button class="secondary-button" data-export-import>导出原始存档</button><button class="secondary-button" data-close>暂不处理</button></div><p class="status-line" data-import-error-status></p></dialog>`;
}

function characterBadgeMarkup(character: CharacterMetadata): string {
  if (!character.badge) return "";
  return `<button type="button" class="character-badge" data-badge-label="${escapeHtml(character.badge.label)}" data-tier="${escapeHtml(character.tier)}" aria-label="${escapeHtml(character.badge.label)}，${escapeHtml(character.tier)}级"><span class="character-badge-face"><img src="${escapeHtml(character.badge.image)}" alt="" loading="lazy" decoding="async" /></span><span class="character-badge-sparkles" aria-hidden="true"></span></button><span class="character-badge-hint" role="status" hidden></span>`;
}

export function characterCardMarkup(character: CharacterMetadata, defeated = false, portraitAction?: LobbyScreenView["menuActions"][number]): string {
  const action = portraitAction ? `data-ui-action="${escapeHtml(portraitAction.id)}"` : `data-invite-character="${escapeHtml(character.id)}"`;
  const label = portraitAction ? "挑战" : characterEncounterCapabilities(character).invitationLabel;
  const skinButton = (character.appearance?.skins.length ?? 0) > 1 ? `<button type="button" class="character-skin-button" data-change-skin="${escapeHtml(character.id)}" aria-label="为${escapeHtml(character.name)}换装" title="换装"><svg viewBox="0 0 24 24" aria-hidden="true" stroke-linecap="round"><path d="M9 6a3 3 0 1 1 4.8 2.4L12 10v2" /><path d="m12 12 9 6a1 1 0 0 1-.55 1.83H3.55A1 1 0 0 1 3 18Z" /></svg></button>` : "";
  return `<article class="character-card ${portraitAction ? "boss-character-card" : defeated ? "is-defeated" : "is-guest"}" data-character-id="${escapeHtml(character.id)}">${skinButton}<div class="character-portrait-frame"><div class="portrait"><img class="scaled-character-art" style="${characterPreviewStyle(character)}--character-art-scale:${character.portraitScales.selection}" src="${escapeHtml(character.previewImage)}" alt="${escapeHtml(character.name)}" loading="lazy" decoding="async" /></div>${characterBadgeMarkup(character)}</div><div class="character-copy"><p class="eyebrow">${portraitAction ? "特殊对手" : "与会者"} // ${escapeHtml(character.tier)}级</p><h2>${escapeHtml(portraitAction?.portraitEntry?.label ?? character.name)}</h2><p>${escapeHtml(portraitAction?.portraitEntry?.subtitle ?? character.subtitle)}</p><button class="card-invite ${portraitAction ? "lobby-boss-entry is-unlocked" : ""}" ${action}>${label} <span>→</span></button></div></article>`;
}

function portraitEntryMarkup(action: LobbyScreenView["menuActions"][number]): string {
  if (action.portraitEntry?.unlocked) return characterCardMarkup(action.portraitEntry.character, false, action);
  if (action.portraitEntry && action.portraitEntry.current / action.portraitEntry.required <= 0.6) return "";
  const character = action.portraitEntry?.character;
  const badge = character?.badge;
  const eyes = character ? `<span class="lobby-boss-eyes" aria-hidden="true"><img style="${characterPreviewStyle(character)}" src="${escapeHtml(character.previewImage)}" alt="" decoding="async" /></span>` : "";
  const progress = action.portraitEntry ? `<span class="boss-unlock-progress" aria-label="${escapeHtml(action.description ?? "")}">${badge ? `<span class="boss-faction-icon"><img src="${escapeHtml(badge.image)}" alt="${escapeHtml(badge.label)}" /></span>` : '<span class="boss-faction-label">同阵营</span>'}<span>${action.portraitEntry.current}/${action.portraitEntry.required}</span></span>` : `<small>${escapeHtml(action.description ?? "挑战开启")}</small>`;
  return `<button class="lobby-boss-entry is-locked" data-ui-action="${escapeHtml(action.id)}" ${action.portraitEntry ? "disabled" : ""} aria-label="${escapeHtml(action.label)}，${escapeHtml(action.description ?? "挑战开启")}">${eyes}<span class="boss-entry-copy"><strong class="boss-entry-name">${escapeHtml(action.label)}</strong>${progress}<span class="boss-lock-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M6 8V5a4 4 0 0 1 8 0v3M4 8h12v10H4Z"/><path d="M10 11v4"/></svg></span></span></button>`;
}

export function defeatedLoadMoreMarkup(remaining: number): string {
  if (remaining <= 0) return "";
  return `<button type="button" class="defeated-load-more" data-load-more-defeated aria-controls="defeated-character-list" aria-label="加载更多已击败宾客，剩余 ${remaining} 名"><span>继续下拉查看</span><small>剩余 ${remaining} 名</small><i aria-hidden="true">⌄</i></button>`;
}

export function renderLobbyMarkup(view: LobbyScreenView): string {
  const dialogs = lobbyDialogsMarkup(view.save, view.pluginCredits ?? []);
  if (view.layer === "menu") {
    return `<main class="lobby-shell lobby-menu-shell"><header class="lobby-invitation"><span>Blackjack & Roulette</span><nav class="lobby-header-tools" data-ui-slot="main-menu.tools" aria-label="项目信息与设置">${menuSlotMarkup(view.menuActions, "main-menu.tools")}</nav></header><section class="lobby-title-block" aria-labelledby="lobby-title"><h1 id="lobby-title">House of Chances</h1><div class="menu-subtitle"><button type="button" class="menu-version" data-app-version aria-label="版本号 v${escapeHtml(version)}">v${escapeHtml(version)}</button> <strong>${escapeHtml(releaseName)}</strong></div><div class="menu-oath"><p>奉上自己的一切，包括自己的身体。</p><p>一点点的技巧和运气，以及全部的决心。</p><strong>祂终将有求必应。</strong></div></section><nav class="lobby-menu" aria-label="古堡主菜单"><button type="button" class="lobby-menu-button lobby-primary-action" data-enter-duel><span class="button-copy"><strong>对决</strong><small>选择一名与会者</small></span><span class="button-arrow" aria-hidden="true">›</span></button><div class="lobby-secondary-menu" data-ui-slot="main-menu.secondary">${menuSlotMarkup(view.menuActions, "main-menu.secondary")}</div><button type="button" class="lobby-exit-button" data-exit-launcher>返回启动器</button></nav>${dialogs}</main>`;
  }
  const characterCards = view.guests.map((character) => characterCardMarkup(character)).join("");
  const defeatedCards = view.visibleDefeated.map((character) => characterCardMarkup(character, true)).join("");
  return `<main class="lobby-shell lobby-character-shell"><header class="topbar"><button class="icon-button" data-lobby-home aria-label="返回House of Chances主菜单">←</button><span class="topbar-balance" aria-hidden="true"></span></header><nav class="lobby-boss-entries" aria-label="未完成的挑战">${view.menuActions.filter(action => action.portraitEntry).map(portraitEntryMarkup).join("")}</nav><section class="guest-section" aria-labelledby="guest-title"><div class="guest-heading"><div><p class="kicker">等待入场</p><h2 id="guest-title">候场宾客</h2></div><button type="button" class="quiet-button" data-refresh-guests aria-label="刷新候场宾客">刷新</button></div><section class="character-list">${characterCards || `<div class="empty-history"><span>◇</span><p>暂时没有可赴约的宾客。</p></div>`}</section></section><section class="guest-section defeated-section" aria-labelledby="defeated-title"><div class="guest-heading"><div><p class="kicker">回想</p><h2 id="defeated-title">已击败宾客</h2></div></div><section id="defeated-character-list" class="character-list" aria-live="polite">${defeatedCards || `<div class="empty-history"><span>◇</span><p>你还没有击败过任意角色呢。</p></div>`}</section>${defeatedLoadMoreMarkup(view.defeatedRemaining)}</section><div class="lobby-tools"><span class="quiet-record">策展人记录 // ${view.save.profile.matchesPlayed}</span></div>${dialogs}</main>`;
}
