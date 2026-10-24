# 基本构建

使用 Node.js 22，从本仓库根目录执行：

```bash
npm ci
npm test
npm run build
npm run preview
```

Web/PWA 静态产物位于 `dist/`，可部署到静态托管服务。涉及交互时在本机运行 `npm run test:e2e`。构建不包含托管平台配置或站点统计标识。

PWA 预缓存应用外壳、公共资源、许可声明，以及内嵌包索引和 Manifest；包正文与媒体由首次在线安装写入内容仓库，不重复加入预缓存。完成首次安装后可离线启动与恢复牌局。首次安装、恢复已删除的内嵌包或清除站点数据后重新安装仍需网络。`npm run test:pwa` 在本机重建生产 Web，清除普通 HTTP 缓存、保留内容仓库与 Service Worker 缓存后，验证离线资源管理、开局和重开恢复；浏览器测试不进入 CI。

内容 JSON 在递归校验前限制为最多 64 层、100000 个节点、单集合 10000 项、单字符串 2097152 个 UTF-16 码元。Manifest 的文件、资源、作者、标签、角色职责与依赖列表各限 4096 项；超限输入被拒绝，不截断后继续安装。已有存档格式和游戏版本不因校验依赖升级而改变。

## 图片构建模式

仓库中的图片源资源保留 PNG。构建在临时目录生成图片、资源正文、Manifest 与索引，不改写源文件，不缩放画布。默认输出有损 WebP，质量为 92，透明通道无损；可选择无损 WebP 或保留原始 PNG 字节：

```bash
npm run build                              # 有损 WebP，质量 92
npm run build -- --images lossy --quality 85
npm run build -- --images lossless
npm run build -- --images png
npm run build:packages -- --images lossless
```

`build:packages` 生成 `dist/packages/*.hocpkg`、`dist/packages/HoC-official.zip` 与图片构建记录。Web 的记录为 `dist/image-build.json`。`--quality` 取 1–100 的整数，仅影响有损模式；无损不是质量 100 的有损 WebP。也可设置 `HOC_IMAGE_MODE=lossy|lossless|png`、`HOC_IMAGE_QUALITY=92`，命令行优先。Android Web 构建支持相同参数。

角色封面保留 PNG，以兼容 PNG 角色卡导出；固定图片存档封面、网页/PWA/Android 图标继续使用要求的 PNG/ICO/SVG 格式。其他包图片的路径、MIME、大小和摘要随编码同步更新。不同模式保持包身份和版本，内容 revision 随图片变化；已安装内容通过资源管理器显式导入替换，网页升级不重置玩家进度。

Core 提供 `hoc-core/image-build` 构建接口（`scripts/image-build.mjs`），供依赖公开内容契约的工具调用 `imageOptions`、`buildPackage` 或 `buildPackageTree`。调用者提供内容目录、索引条目与编码配置；接口不依赖其他内容仓库。只需本仓库依赖，编码器由锁定的 sharp 版本提供，不要求另装系统 cwebp。

## 音频导出

Web/PWA、Android Web 与 `build:packages` 统一在构建阶段派生 Opus；开发预览继续读取源音频。仓库中的 WAV、MP3、Vorbis 及已有 Opus 均保留原始字节。构建通过 ffprobe 检测实际编码，已有 Opus（包括 `.ogg`）按原文件名、原字节复制；其他音频导出为 `.opus`，MIME 为 `audio/ogg`。路径中有独立 `bgm/` 目录的背景音乐使用 80 kbps 受约束 VBR，其他音效使用 64 kbps VBR；不变调、不裁剪、不混合声道。

安装带 `libopus` 编码器的 FFmpeg，使 `ffmpeg`、`ffprobe` 在 PATH 中可用，例如 macOS 使用 `brew install ffmpeg`，Ubuntu 使用 `sudo apt-get install ffmpeg`。缺少工具或输入损坏时构建失败，不能静默交付未压缩音频。编码缓存位于 `node_modules/.cache/hoc-audio/`，按源摘要、编码参数和 FFmpeg 构建版本区分；固定工具链的冷构建与缓存构建产生一致音频字节。

构建同步改写 JS/JSON/CSS 中的完整路径、Manifest 的 MIME／大小／SHA-256、包内容 revision 与索引。资源引用须为完整字符串或 JSON 值；不能在插件中动态拼接将要改后缀的文件名。源目录和包身份／版本保持不变。PWA 预缓存包含 `.opus`。Web 的逐文件记录为 `dist/audio-build.json`，独立官方包记录为 `dist/packages/audio-build.json`；已有 Opus 的记录标为 `retainedOpus: true`。

`hoc-core/image-build` 的 `buildPackage`／`buildPackageTree` 同时处理图片与音频，`audioCacheDir` 可指定音频缓存目录；图片选择 `png` 也仍按上述规则导出音频。`hoc-core/audio-build` 导出同一中性编码器与记录类型，供独立工具使用。第三方资源的作品、作者、来源和许可归属不因导出编码改变，源路径与输出路径对应关系见构建记录。

## Android

安装 JDK 21、Android SDK，并设置本机 SDK 路径。构建脚本优先使用 `JAVA_HOME`，也可探测 Homebrew OpenJDK 21 或 Android Studio JBR。

```bash
npm run build:android:web  # 仅构建 Android Web 资源
npm run android:sync      # 同步 Capacitor 工程
npm run android:build     # 默认生成 Release APK
npm run android:build:debug # 仅显式调试、冒烟测试使用
npm run android:open      # 用 Android Studio 打开工程
```

Release APK 位于 `android/app/build/outputs/apk/release/app-release-unsigned.apk`，须用外部保管的密钥签名后安装；不将签名凭据提交到仓库。显式 Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。Android 版本名与主菜单共用 `package.json` 的 `version`；数字 `versionCode` 独立用于 Android 更新排序。Release 关闭应用调试及 WebView 远程调试，生产 Web 构建不提供 URL 调试面板。

同步生成的 `android/app/src/main/assets/public/` 不能直接编辑。Android Web 构建不生成 PWA Service Worker。APK 编译不等于真机运行验收，存储恢复、前后台切换和触觉反馈须在设备上验证。

修改内嵌包后运行 `npm run packages:sync`，构建时通过 `packages:check` 校验完整性。已有非空用户内容仓库不会随应用升级自动覆盖为新内嵌包，包更新与存档变化须遵循现有安装和迁移流程。
