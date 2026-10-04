import "./lobby-screen.css";
import { version, releaseName } from "../package.json";
import { LOBBY_INFO_PAGES, type LobbyInfoPageId } from "./content/lobby-info";
import type { CharacterMetadata } from "./content/characters";
import type { LongTermSave } from "./persistence/schema";

export type LobbyLayer = "menu" | "characters";

export interface LobbyScreenView {
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

function lobbyHeaderIcon(pageId: LobbyInfoPageId): string {
  if (pageId === "about") return `<span class="lobby-info-letter" aria-hidden="true">i</span>`;
  if (pageId === "community") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 3.5V5.5Z" /></svg>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20S4 15.3 4 9.4C4 6.4 7.7 4.8 10 7.2l2 2 2-2c2.3-2.4 6-0.8 6 2.2C20 15.3 12 20 12 20Z" /></svg>`;
}

function lobbyHeaderToolsMarkup(): string {
  const infoButtons = LOBBY_INFO_PAGES.map((page) => `<button type="button" class="icon-button lobby-round-button lobby-${page.id}-button" data-open="${page.id}" aria-label="打开${page.buttonLabel}">${lobbyHeaderIcon(page.id)}</button>`).join("");
  return `<nav class="lobby-header-tools" aria-label="项目信息与设置">${infoButtons}<button type="button" class="icon-button lobby-round-button lobby-settings-button" data-open="settings" aria-label="打开设置">⚙</button></nav>`;
}

function lobbyDialogsMarkup(save: LongTermSave): string {
  const infoDialogs = LOBBY_INFO_PAGES.map((page) => `<dialog id="${page.id}" class="modal lobby-info-modal" aria-labelledby="${page.id}-title"><button class="modal-close" data-close aria-label="关闭${page.title}">×</button><p class="eyebrow">${page.eyebrow}</p><h2 id="${page.id}-title">${page.title}</h2><div class="lobby-info-copy">${page.content}</div></dialog>`).join("");
  return `<dialog id="rules" class="modal"><button class="modal-close" data-close aria-label="关闭">×</button><h2>玩法说明</h2><p>你玩过21点吗？没玩过也没关系，这游戏简单到猫咪都能学会。</p><p>简单来说：你和对手玩黑杰克，输掉牌局的人，要往自己的轮盘里多加一发子弹——然后祈祷，扣下扳机。</p><p>游戏中，你和对手轮流行动。你可以选择要牌（Hit），继续抽一张牌；也可以选择停牌（Stand），保留当前点数。你的目标很简单：在不超过爆牌上限的情况下，让自己的点数尽可能高。爆牌上限通常是21点。一旦超过这个上限，恭喜，你直接输掉这一轮。</p><p>如果双方都没有爆牌，那么在两边都选择停牌后比较点数，点数更高的一方获胜。</p><p>（注：黑杰克的正常数字牌按牌面数字计算，J、Q、K都算10点；A则可以算作1点或11点，以对你更有利的方式计算。）</p><p>如果你的起手牌正好组成21点，就会触发“黑杰克”，并在获胜时获得额外奖励。</p><p>当然，如果只是老老实实赌博也太无聊了。你和对手都会拥有各种技能，它们可以改变抽牌、点数、胜负条件，甚至直接干涉牌局规则。合理搭配自己的技能，有时候比单纯拿到一手好牌更加重要。</p></dialog>${infoDialogs}<dialog id="skills" class="modal skills-modal" aria-labelledby="skills-title"><button class="modal-close" data-close aria-label="关闭">×</button><p class="eyebrow">策展人的收藏</p><h2 id="skills-title">技能与天赋</h2><div id="skill-content"></div></dialog><dialog id="skill-tag-info-dialog" class="modal skill-tag-info-dialog" aria-labelledby="skill-tag-info-title"><button class="modal-close" data-close aria-label="关闭流派说明">×</button><p class="eyebrow">流派说明</p><h2 id="skill-tag-info-title"></h2><p id="skill-tag-info-copy"></p></dialog><dialog id="skill-catalog" class="modal skill-catalog-modal" aria-labelledby="skill-catalog-title"><button class="modal-close" data-close aria-label="关闭技能大全">×</button><p class="eyebrow">策展人的收藏</p><h2 id="skill-catalog-title">技能大全</h2><p class="loadout-count">当前版本的全部技能与解锁状态。</p><div id="skill-catalog-content" class="loadout-list"></div></dialog><dialog id="profile" class="modal profile-modal"><button class="modal-close" data-close aria-label="关闭">×</button><div id="profile-content"></div></dialog><dialog id="settings" class="modal"><button class="modal-close" data-close aria-label="关闭">×</button><p class="eyebrow">古堡牌桌</p><h2>设置</h2><label class="setting"><input type="checkbox" data-setting="soundEnabled" ${save.settings.soundEnabled ? "checked" : ""}> 开启声音</label><label class="setting"><input type="checkbox" data-setting="reducedMotion" ${save.settings.reducedMotion ? "checked" : ""}> 减少动态效果</label><div class="save-actions"><label class="save-export-format"><span>导出格式</span><select data-export-format><option value="image">图片存档（推荐）</option><option value="json">JSON 文件</option></select></label><button class="secondary-button" data-export>导出存档</button><button class="secondary-button" data-import>从图片或 JSON 导入</button><button class="danger-button" data-reset>删除长期存档</button><input id="save-file" type="file" accept="image/png,.png,application/json,.json" hidden></div><p class="status-line" id="lobby-status"></p></dialog><dialog id="save-migration" class="modal" aria-labelledby="save-migration-title"><button class="modal-close" data-close aria-label="关闭迁移提示">×</button><p class="eyebrow">存档版本不合牌桌规矩</p><h2 id="save-migration-title">导入失败</h2><p id="save-migration-copy"></p><div class="save-actions"><button class="primary-button" data-migrate-import>迁移并导入</button><button class="secondary-button" data-export-import>导出原始存档</button><button class="secondary-button" data-close>暂不处理</button></div><p class="status-line" data-migration-status></p></dialog>`;
}

export function characterCardMarkup(character: CharacterMetadata, defeated = false): string {
  return `<article class="character-card ${defeated ? "is-defeated" : "is-guest"}" data-character-id="${escapeHtml(character.id)}"><div class="portrait"><img class="scaled-character-art" style="--character-art-scale:${character.portraitScales.selection}" src="${escapeHtml(character.previewImage)}" alt="${escapeHtml(character.name)}" loading="lazy" decoding="async" /></div><div class="character-copy"><p class="eyebrow">与会者 // ${escapeHtml(character.tier)}级</p><h2>${escapeHtml(character.name)}</h2><p>${escapeHtml(character.subtitle)}</p><button class="card-invite" data-invite-character="${escapeHtml(character.id)}">邀请 <span>→</span></button></div></article>`;
}

export function defeatedLoadMoreMarkup(remaining: number): string {
  if (remaining <= 0) return "";
  return `<button type="button" class="defeated-load-more" data-load-more-defeated aria-controls="defeated-character-list" aria-label="加载更多已击败宾客，剩余 ${remaining} 名"><span>继续下拉查看</span><small>剩余 ${remaining} 名</small><i aria-hidden="true">⌄</i></button>`;
}

export function renderLobbyMarkup(view: LobbyScreenView): string {
  const dialogs = lobbyDialogsMarkup(view.save);
  if (view.layer === "menu") {
    return `<main class="lobby-shell lobby-menu-shell"><header class="lobby-invitation"><span>Blackjack & Roulette</span>${lobbyHeaderToolsMarkup()}</header><section class="lobby-title-block" aria-labelledby="lobby-title"><h1 id="lobby-title">House of Chances</h1><div class="menu-subtitle"><strong>v${escapeHtml(version)}</strong> <strong>${escapeHtml(releaseName)}</strong></div><div class="menu-oath"><p>奉上自己的一切，包括自己的身体。</p><p>一点点的技巧和运气，以及全部的决心。</p><strong>祂终将有求必应。</strong></div></section><nav class="lobby-menu" aria-label="古堡主菜单"><button type="button" class="lobby-menu-button lobby-primary-action" data-enter-duel><span class="button-copy"><strong>对决</strong><small>选择一名与会者</small></span><span class="button-arrow" aria-hidden="true">›</span></button><div class="lobby-secondary-menu"><button type="button" class="lobby-menu-button lobby-secondary-action" data-open="rules"><strong>玩法说明</strong></button><button type="button" class="lobby-menu-button lobby-secondary-action" data-open="skills"><strong>技能与天赋</strong></button><button type="button" class="lobby-menu-button lobby-secondary-action" data-open-history><strong>历史记录</strong><small>${view.save.history.length} 局</small></button></div><button type="button" class="lobby-exit-button" data-exit-launcher>返回启动器</button></nav>${dialogs}</main>`;
  }
  const characterCards = view.guests.map((character) => characterCardMarkup(character)).join("");
  const defeatedCards = view.visibleDefeated.map((character) => characterCardMarkup(character, true)).join("");
  return `<main class="lobby-shell lobby-character-shell"><header class="topbar"><button class="icon-button" data-lobby-home aria-label="返回House of Chances主菜单">←</button><span class="topbar-balance" aria-hidden="true"></span></header><section class="hero selection-hero"><p class="kicker">回应邀请之人</p><h1>选择<br><em>与会者</em></h1><div class="hero-rule"><span></span><b>02</b><span></span></div></section><section class="guest-section" aria-labelledby="guest-title"><div class="guest-heading"><div><p class="kicker">等待入场</p><h2 id="guest-title">候场宾客</h2></div><button type="button" class="quiet-button" data-refresh-guests aria-label="刷新候场宾客">刷新</button></div><section class="character-list">${characterCards || `<div class="empty-history"><span>◇</span><p>暂时没有可赴约的宾客。</p></div>`}</section></section><section class="guest-section defeated-section" aria-labelledby="defeated-title"><div class="guest-heading"><div><p class="kicker">回想</p><h2 id="defeated-title">已击败宾客</h2></div></div><section id="defeated-character-list" class="character-list" aria-live="polite">${defeatedCards || `<div class="empty-history"><span>◇</span><p>你还没有击败过任意角色呢。</p></div>`}</section>${defeatedLoadMoreMarkup(view.defeatedRemaining)}</section><div class="lobby-tools"><span class="quiet-record">策展人记录 // ${view.save.profile.matchesPlayed}</span></div>${dialogs}</main>`;
}
