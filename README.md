# House of Chances

Android 竖屏优先的单机游戏，结合黑杰克、累积式俄罗斯轮盘、技能卡与角色叙事。可独立构建 Web/PWA 与 Android 应用。、

## 本地运行

使用 Node.js 22：

```bash
npm ci
npm run dev
npm run packages:check
npm test
npm run build
# 涉及交互时在本机运行
npm run test:e2e
```

GitHub CI 只运行单元测试与构建。构建输出为 `dist/`；基本 Web 与 Android 部署见 [部署说明](docs/deployment.md)。

## 许可证与署名

本项目原创程序代码使用 **GNU General Public License v3.0（GPL-3.0-only）**，完整条款见 [LICENSE](LICENSE)。依赖库及保留第三方许可声明的文件继续遵循各自许可证。

内嵌角色包（`public/characters/chatgpt/`、`claude/`、`deepseek/`、`gemini/`）中的图片使用 **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0，署名—非商业性使用—相同方式共享）**，原作者为 **ZipZipPipe**。网页与应用图标（`public/favicon.ico`、`public/favicon.svg`、`public/icons/`），以及 `android/app/src/main/res/` 下的 `ic_launcher*.png` 和 `splash.png`，基于 DeepSeek 角色美术经 AI 改绘为 Q 版铁盆造型，再缩放、补边及裁切，同样使用该许可证。完整条款见 [角色美术许可证](public/licenses/CC-BY-NC-SA-4.0.txt)。使用或改编这些图片时须保留作者署名和许可信息，标明修改，并遵守非商业性使用及相同方式共享条件。

其余项目美术为 AI 生成，使用 **CC0 1.0 Universal**：包括 `public/assets/` 中的图片、`public/characters/official-built-in-skills/` 和 `public/characters/official-built-in-talents/` 中的图片。CC0 适用于项目在这些资源中享有的权利；另有第三方许可声明的文件遵循原声明。完整条款见 [CC0 声明](public/licenses/CC0-1.0.txt)。

音效按原作品分别使用 **CC BY 4.0** 或 **CC0 1.0**，逐文件的标题、原作者、来源、许可证与转码／裁切说明见 [音频署名清单](public/AUDIO-CREDITS.txt)；CC BY 4.0 完整条款见 [许可证](public/licenses/CC-BY-4.0.txt)。

大厅背景音乐为 Erik Satie 作曲、Kevin MacLeod 编曲与演奏的《Gymnopedie No. 1》；牌局背景音乐为 Claude Debussy 作曲、Laurens Goedhart 演奏的《Clair de lune》。两份录音使用 **CC BY 3.0 Unported**，已转码压缩为 MP3；来源及修改说明见 [音频署名清单](public/AUDIO-CREDITS.txt)，完整条款见 [录音许可证](public/licenses/CC-BY-3.0.txt)。

代码、美术和音频的许可证分别适用。随 Web 与 Android Web 构建分发的声明见 [NOTICE.txt](public/NOTICE.txt) 和 [AUDIO-CREDITS.txt](public/AUDIO-CREDITS.txt)。
