# House of Chances

Android 竖屏优先的单机游戏，结合黑杰克、累积式俄罗斯轮盘、技能卡与角色叙事。可独立构建 Web/PWA 与 Android 应用。

## 本地运行

使用 Node.js 22，以及提供 `libopus` 的 FFmpeg（`ffmpeg` 和 `ffprobe` 均需在 PATH 中）：

```bash
npm ci
npm run dev
npm run packages:check
npm test
npm run build
# 涉及交互时在本机运行
npm run test:e2e
# 本机验证构建后的 PWA 离线启动和牌局恢复
npm run test:pwa
```

内嵌内容按目录直接读取，媒体默认按需下载；可在设置中下载完整离线资源。用户导入内容继续使用 hocpkg／ZIP／PNG。

构建输出为 `dist/`；基本 Web 与 Android 部署见 [部署说明](docs/deployment.md)。

## 匿名玩法统计

正式 Web/PWA 与 Android 构建通过 `.env.production`、`.env.capacitor` 默认启用匿名玩法统计，新安装默认开启。用户在设置中保存的关闭选择继续生效。开发和测试模式默认不配置接收地址。

发行方可在构建时覆盖 `VITE_HOC_TELEMETRY_ENDPOINT`，指向兼容协议 v1 的 HTTPS 接收地址，并设置 `VITE_HOC_TELEMETRY_ENVIRONMENT`（`production`、`test` 或 `development`）和 `VITE_HOC_BUILD_ID`。将接收地址显式设为空字符串时不启动遥测。

配置后，游戏发送启动信息与每场完整对战摘要，包含客户端类别、版本、对手及内容包版本、结果、回合、枪械和技能计数。没有账号、硬件指纹、玩家昵称或完整存档。安装身份和离线队列独立保存在本机，不随游戏存档分享；用户可在设置中关闭匿名玩法统计并清除待发送记录。

对战摘要由统一流程组织器生成，覆盖普通对战与不写入本地战绩的流程节点。网络错误异步重试，不阻塞游戏；接收服务须按事件身份去重。统计是尽力交付的客户端数据，不用于权威成绩或奖励判定。

## 许可证与署名

本项目原创程序代码使用 **GNU General Public License v3.0（GPL-3.0-only）**，完整条款见 [LICENSE](LICENSE)。依赖库及保留第三方许可声明的文件继续遵循各自许可证。

角色包 `claude/backgrounds/` 内的两张场景背景是下述 CC0 资源的原样副本；角色原画继续沿用原作者和许可证。

内嵌角色包（`public/characters/chatgpt/`、`claude/`、`deepseek/`、`gemini/`、`llama/`）中的图片使用 **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0，署名—非商业性使用—相同方式共享）**，原作者为 **ZipZipPipe**。网页与应用图标（`public/favicon.ico`、`public/favicon.svg`、`public/icons/`），以及 `android/app/src/main/res/` 下的 `ic_launcher*.png` 和 `splash.png`，基于 DeepSeek 角色美术经 AI 改绘为 Q 版铁盆造型，再缩放、补边及裁切，同样使用该许可证。完整条款见 [角色美术许可证](public/licenses/CC-BY-NC-SA-4.0.txt)。使用或改编这些图片时须保留作者署名和许可信息，标明修改，并遵守非商业性使用及相同方式共享条件。

默认存档分享封面 `public/assets/save-share-cover.png` 参考上述五位角色美术，经 AI 改绘为五位 Q 版角色合照、调整背景与缩放，沿用 **CC BY-NC-SA 4.0**，保留 ZipZipPipe 的角色美术署名。

五位内嵌角色的 `cover.png` 为基于原角色美术重新绘制动作、合成固定模糊机柜背景的1254×1254封面，角色改绘保留 ZipZipPipe 的署名与 CC BY-NC-SA 4.0 许可。封面与焦点由角色皮肤的表现资源声明，供大厅、个人档案与挑战预览使用；逐包改绘说明见各自 `ART-CREDITS.md`。

官方插件封面 `public/characters/character-tap/cover.png` 与 `public/characters/debug-engine/cover.png` 参考 DeepSeek 角色美术，经 AI 改绘为黑底 Q 版插画并缩放，沿用 **CC BY-NC-SA 4.0**，原作者为 **ZipZipPipe**；插件程序代码仍为 GPL-3.0-only，逐包说明见各自的 `ART-CREDITS.md`。

其余项目美术为 AI 生成，使用 **CC0 1.0 Universal**：包括 `public/assets/` 中除上述存档分享封面外的图片、`public/characters/official-built-in-skills/` 、`public/characters/official-built-in-talents/` 中的图片，以及 `public/characters/official-factions/intelligent-core.png` 共享阵营徽标。CC0 适用于项目在这些资源中享有的权利；另有第三方许可声明的文件遵循原声明。完整条款见 [CC0 声明](public/licenses/CC0-1.0.txt)。

音效按原作品分别使用 **CC BY 4.0** 或 **CC0 1.0**，逐文件的标题、原作者、来源、许可证与转码／裁切说明见 [音频署名清单](public/AUDIO-CREDITS.txt)；CC BY 4.0 完整条款见 [许可证](public/licenses/CC-BY-4.0.txt)。

大厅背景音乐为 Erik Satie 作曲、Kevin MacLeod 编曲与演奏的《Gymnopedie No. 1》；牌局背景音乐为 Claude Debussy 作曲、Laurens Goedhart 演奏的《Clair de lune》。两份录音使用 **CC BY 3.0 Unported**，源文件已转码压缩为 MP3，构建时派生 80 kbps Opus；来源及修改说明见 [音频署名清单](public/AUDIO-CREDITS.txt)，完整条款见 [录音许可证](public/licenses/CC-BY-3.0.txt)。

代码、美术和音频的许可证分别适用。依赖组件的完整许可文本与署名见 [第三方声明](public/THIRD-PARTY-NOTICES.txt)。随 Web 与 Android Web 构建分发的声明见 [NOTICE.txt](public/NOTICE.txt) 和 [AUDIO-CREDITS.txt](public/AUDIO-CREDITS.txt)。

## 插件公共入口

运行 `npm run build:sdk` 生成可独立安装的开发 SDK，产物和 SHA-256 位于 `dist/sdk-artifacts/`。SDK 的开发版本由 `sdk/package.json` 明确维护，独立于游戏版本；构建此包不会发布游戏。消费者安装并锁定生成的 `.tgz` 后，可直接在 Node 或打包器中使用以下入口，无需读取游戏源码或构建工具的安装目录：

- `hoc-core/plugin-api`：插件类型与通用界面工具。
- `hoc-core/authoring-api`：包校验和 `createCharacterPackageDraft()`；草稿需补充对白与媒体后打包。
- `hoc-core/capabilities`：资源 API、插件 API 和能力目录版本。
- `hoc-core/package-tools`：清单、MIME、摘要与归档；`hocpkg check <目录>` 校验包索引，`hocpkg sync <目录>` 更新索引。
- `hoc-core/image-build`：图片、音频与包构建。
- `hoc-core/audio-build`：80 kbps BGM／64 kbps 音效的 Opus 编码，已有 Opus 原字节保留。

`npm run test:sdk` 在独立临时目录安装 SDK，验证 Node、类型声明、包制作与导出边界。`npm run build:packages` 单独生成官方 `.hocpkg`，供内容发行方按版本和摘要锁定。Web 构建会重建 `dist`，需要同时交付时先构建 Web，再构建 SDK 和官方包。

`hoc-core/plugin-api` 提供运行时插件接口；`hoc-core/authoring-api` 提供不依赖 DOM 的包与角色校验、基础角色草稿及插件创作契约读取。模块 API 2／3／4 继续支持；API 4／5 可声明可选只读原语，API 5 可声明对白事件和独立表现状态。角色使用 `game.character-match` API 4，通过同包 `game.character-dialogue` API 2 提供事件订阅、有序条件规则和必填 fallback。事件未命中保留当前显示，无显示时才使用 fallback；旧对白 API 1 与角色 API 3 包需要重新打包导入。API 3 起可携带声明式玩家设置与角色扩展的 Schema、指南、完整示例。字段文档由对应插件包自带，创作工具无需执行插件代码。

内嵌独立插件 `hoc-core/character-tap` 默认启用，通过通用角色交互接口提供拍一拍事件、计数和可选区域原语；停用不影响角色加载。区域 Schema、指南和中性示例随包提供于 `public/characters/character-tap/authoring/`。

内嵌 `hoc-core/official-factions` 独立内容包提供“智能核心”阵营及共享徽标。角色包使用 `game.character-match` API 7 的 `metadata.faction` 声明 `authorId/packageName#resourceId`，由 `presentation.faction` API 1 资源提供名称和包内徽标。阵营资源不可用或停用时角色仍可正常对局和读档；旧本地 `metadata.badge` 继续兼容。

## 内容契约升级

当前能力目录为 `abilities-v50`，`game.player-skill`、`game.ai-skill` 和 `game.talent` 使用 API 4。旧复合操作和旧技能资源 API 已停止支持；内容作者须改用状态赋值、牌张变换、候选获牌、技能来源选择与类型值比较。`acquire-card` 可显式设置 `reportResult: true` 报告衍生牌结果。旧未完成牌局需要重新开始，长期进度继续按既有恢复规则读取。
