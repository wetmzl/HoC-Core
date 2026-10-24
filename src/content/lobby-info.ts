export const LOBBY_INFO_URLS = {
  organizerPixiv: new URL("https://www.pixiv.net/users/70434774")
} as const;

export type LobbyInfoPageId = "about" | "community" | "credits";

export interface LobbyInfoPage {
  id: LobbyInfoPageId;
  title: string;
  eyebrow: string;
  buttonLabel: string;
  content: string;
}

function externalLink(label: string, url: URL): string {
  return `<a href="${url.href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export const LOBBY_INFO_PAGES: readonly LobbyInfoPage[] = [
  {
    id: "about",
    title: "关于我们",
    eyebrow: "House of Chances // 项目说明",
    buttonLabel: "关于我们",
    content: `<p>《House of Chances》是一个由爱好者维护的免费、非商业游戏项目。</p><p>游戏目前提供 网页预览，但是由于浏览器权限问题，你可能会在没有通知的情况下被浏览器清空你的存档或插件与角色资源，所以更推荐使用客户端游玩。</p><p>与此同时，这也是一个人手相当紧张的项目。程序、测试、策划、文案，以及不断冒出来的奇怪 Bug，都需要有人处理。很多内容目前由很少的人同时兼任完成，而游戏扩张的速度往往比我们的生产能力更快。</p><p>所以，如果你愿意写几句对白、测试一个机制、报告一个 Bug，甚至只是认真玩几局以后告诉我们“这里不好玩”，都会对我们帮助非常大！</p><p>感谢您体验《House of Chances》！</p>`
  },
  {
    id: "community",
    title: "讨论与交流",
    eyebrow: "House of Chances // 社区入口",
    buttonLabel: "讨论与交流",
    content: `<p>如有问题或建议，可通过下方联系方式反馈。</p><p>联系主催：</p><p>${externalLink("pixiv", LOBBY_INFO_URLS.organizerPixiv)}<br>这里不仅欢迎创作者，也欢迎所有对《House of Chances》感兴趣的玩家。</p><p>你可以来聊角色、机制、构筑和平衡，也可以分享一次离谱的对局、报告 Bug、提出建议，或者单纯看看大家在做什么。</p><p>欢迎提交角色对白、机制与玩法建议。我们会根据项目进度评估和安排。</p>`
  },
  {
    id: "credits",
    title: "致谢名单",
    eyebrow: "House of Chances // 鸣谢",
    buttonLabel: "致谢名单",
    content: `<p>《House of Chances》能够走到这里，离不开所有愿意把时间、想法和耐心留在这里的人。</p><p>感谢所有参与角色写作、测试、校对的每一位贡献者，也感谢所有留下反馈、发现问题、提出奇怪构筑，认真玩过这个游戏的人。</p><p>谢谢你们让HoC项目继续运转！</p>`
  }
] as const;
