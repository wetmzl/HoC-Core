# 基本构建

使用 Node.js 22（桌面工具链至少 22.12.0），从本仓库根目录执行：

```bash
npm ci
npm test
npm run build
npm run preview
```

Web/PWA 静态产物位于 `dist/`，可部署到静态托管服务。涉及交互时在本机运行 `npm run test:e2e`。构建不包含托管平台配置或站点统计标识。

内嵌内容构建为 `embedded/content.json` 描述与 `embedded/<摘要>/` 散文件目录，不生成 hocpkg 安装容器，也不在首次启动时复制到用户内容仓库。启动只读取描述和必要插件代码，图片、音频按需获取。内嵌身份由构建索引确定，允许启停和播放集管理，不允许正常删除。

离线缓存入口及设置区只在 Web/PWA 显示；Android 等 Capacitor 原生平台直接读取随包资源，不显示这些界面。

PWA 预缓存应用外壳、代码、许可与启动描述；媒体由运行时按需缓存。启动器“离线设置”和游戏设置中的“下载完整资源”可主动缓存全部内嵌资源、皮肤及共享媒体，支持取消、重试与清除下载缓存。完整离线状态同时要求资源和应用外壳就绪。清除下载缓存不删除存档、用户导入内容或归档。`npm run test:pwa` 在本机验证未全量下载即可启动，以及完整下载后清除 HTTP 缓存、断网启动和恢复牌局；浏览器测试不进入 CI。

发行方可设置 `HOC_EMBEDDED_SOURCE`，从独立作者资源目录读取 `packages.json` 和其列出的内容，复用资源转换管线。清单可设置 `defaultEnabled` 内容 ID 数组，控制全新安装的默认组合；省略时默认启用全部内嵌内容。空集合也可构建，玩家导入可用角色后才能开始游戏。已有用户的启停状态和播放集优先，不自动加入新增内容。源码中的 hocpkg 作者清单仍可供外部内容导出复用，运行时内嵌分发不依赖其容器格式。

客户端更新或导入时发现用户仓库与内嵌索引的完整内容 ID 冲突，会提示清理；选择否或关闭弹窗则归档禁用旧副本。归档可导出、删除，不可直接启用。历史已知包身份映射继续支持；迁移保留播放集、插件顺序和玩家存档，匹配目标摘要的旧资源可复用为内嵌缓存。只有迁移提交成功后才回收旧副本。

内容 JSON 在递归校验前限制为最多 64 层、100000 个节点、单集合 10000 项、单字符串 2097152 个 UTF-16 码元。Manifest 的文件、资源、作者、标签、角色职责与依赖列表各限 4096 项；超限输入被拒绝，不截断后继续安装。已有存档格式和游戏版本不因校验依赖升级而改变。

## 图片构建模式

仓库中的图片源资源保留 PNG。构建在临时目录生成图片、资源正文与分发描述，不改写源文件，不缩放画布。默认输出有损 WebP，质量为 92，透明通道无损；可选择无损 WebP 或保留原始 PNG 字节：

```bash
npm run build                              # 有损 WebP，质量 92
npm run build -- --images lossy --quality 85
npm run build -- --images lossless
npm run build -- --images png
npm run build:packages -- --images lossless
```

`build:packages` 生成 `dist/packages/*.hocpkg`、`dist/packages/HoC-official.zip` 与图片构建记录。Web 的记录为 `dist/image-build.json`。`--quality` 取 1–100 的整数，仅影响有损模式；无损不是质量 100 的有损 WebP。也可设置 `HOC_IMAGE_MODE=lossy|lossless|png`、`HOC_IMAGE_QUALITY=92`，命令行优先。Android Web 构建支持相同参数。

角色封面与其他包内 PNG 一同按所选模式编码，默认有损 WebP；PNG 角色卡导出时才将封面转换为 PNG 载体，包内媒体保持原编码。固定图片存档封面、网页/PWA/Android 图标继续使用要求的 PNG/ICO/SVG 格式。其他包图片的路径、MIME、大小和摘要随编码同步更新。不同模式保持包身份和版本，内容 revision 随图片变化；已安装内容通过资源管理器显式导入替换，网页升级不重置玩家进度。

Core 提供 `hoc-core/image-build` 构建接口（`scripts/image-build.mjs`），供依赖公开内容契约的工具调用 `imageOptions`、`buildPackage` 或 `buildPackageTree`。调用者提供内容目录、索引条目与编码配置；接口不依赖其他内容仓库。只需本仓库依赖，编码器由锁定的 sharp 版本提供，不要求另装系统 cwebp。

## 音频导出

Web/PWA、Android Web 与 `build:packages` 统一在构建阶段派生 Opus；开发预览继续读取源音频。仓库中的 WAV、MP3、Vorbis 及已有 Opus 均保留原始字节。构建通过 ffprobe 检测实际编码，已有 Opus（包括 `.ogg`）按原文件名、原字节复制；其他音频导出为 `.opus`，MIME 为 `audio/ogg`。路径中有独立 `bgm/` 目录的背景音乐使用 80 kbps 受约束 VBR，其他音效使用 64 kbps VBR；不变调、不裁剪、不混合声道。

安装带 `libopus` 编码器的 FFmpeg，使 `ffmpeg`、`ffprobe` 在 PATH 中可用，例如 macOS 使用 `brew install ffmpeg`，Ubuntu 使用 `sudo apt-get install ffmpeg`。缺少工具或输入损坏时构建失败，不能静默交付未压缩音频。编码缓存位于 `node_modules/.cache/hoc-audio/`，按源摘要、编码参数和 FFmpeg 构建版本区分；固定工具链的冷构建与缓存构建产生一致音频字节。

构建同步改写 JS/JSON/CSS 中的完整路径、Manifest 的 MIME／大小／SHA-256、包内容 revision 与索引。资源引用须为完整字符串或 JSON 值；不能在插件中动态拼接将要改后缀的文件名。源目录和包身份／版本保持不变。PWA 预缓存包含 `.opus`。Web 的逐文件记录为 `dist/audio-build.json`，独立官方包记录为 `dist/packages/audio-build.json`；已有 Opus 的记录标为 `retainedOpus: true`。

`hoc-core/image-build` 的 `buildPackage`／`buildPackageTree` 同时处理图片与音频，`audioCacheDir` 可指定音频缓存目录；图片选择 `png` 也仍按上述规则导出音频。`hoc-core/audio-build` 导出同一中性编码器与记录类型，供独立工具使用。第三方资源的作品、作者、来源和许可归属不因导出编码改变，源路径与输出路径对应关系见构建记录。

## Electron 桌面版

桌面构建沿用同一源码、图片与音频管线，需要 Node.js 22.12.0+、FFmpeg 和本项目依赖，不要求 Android SDK。渲染页面使用浏览器版 IndexedDB／OPFS，关闭 Node.js 集成，仅通过受限桥接提供固定应用更新操作。内嵌资源随应用交付，首次启动即可离线使用；桌面模式不生成 Service Worker，也不显示网页的离线下载按钮。

```bash
npm ci
npm run test:electron
npm run electron:start              # 构建并启动当前平台桌面版
npm run electron:pack               # 生成当前平台解包目录
npm run electron:dist               # 生成当前平台分发文件
npm run electron:dist -- --platform win --arch x64
npm run electron:dist -- --platform win --arch arm64 --format zip
npm run electron:dist -- --platform mac --arch arm64
npm run electron:dist -- --platform linux --arch x64
npm run electron:dist -- --platform linux --arch arm64
# 仅在本机图形会话运行，不进入 GitHub CI
npm run test:electron:e2e
```

默认架构为当前主机架构；`--arch` 支持 `x64` 和 `arm64`。默认分发格式为 Windows NSIS 安装程序＋ZIP、macOS DMG＋ZIP、Linux AppImage＋tar.gz；`--format` 可选择该平台的一种格式。macOS 需在 macOS 主机构建；Windows 可以在 Linux 上交叉生成 ZIP，交叉生成 NSIS 另需 Wine，否则构建入口提前报错并提示改用 ZIP。跨平台构建不编辑或签名 Windows 可执行文件的资源。原生 Windows 构建保留正常的图标和版本资源处理。

Web 中间产物位于 `output/electron/web/`，最小运行应用位于 `output/electron/app/`，分发文件位于 `output/electron/artifacts/<平台>-<架构>/`，随附 `SHA256SUMS` 与构建来源 `delivery.json`。版本读取 `package.json`，构建不会自动递增版本、创建标签或发布 Release。只分发压缩包／安装包与所需说明，不能把解包目录或私有构建报告误作源码附件。Electron／Chromium 自带的许可文件须保留。

桌面版固定使用 `hoc://app/` 来源，数据保存在系统应用数据目录下的 `HoC-Core/`，与网页、Android 存储相互独立；迁移进度使用现有存档导出／导入。桌面导出使用 Blob 下载，由 Electron 的系统保存对话框接管，不依赖网页文件选择 API 对自定义来源的支持。覆盖安装须保持应用身份、来源和数据目录，不能随版本号改变它们。`HOC_ELECTRON_USER_DATA_DIR` 可指定隔离测试目录。NSIS 卸载不主动删除用户数据。

Electron 原生运行时可通过 `npm run electron:install` 单独下载；启动和本地桌面测试会自动调用它。Electron 运行文件是开发依赖，目标客户端无需安装 Node.js、FFmpeg 或开发工具。桌面模式默认不配置统计接收地址，CSP 不允许外部连接；启用远端统计时须另行配置接收地址和限定的 CSP 连接来源。

GitHub 的 `Electron Packages` 工作流仅手动触发，默认分别构建六种平台／架构组合，也可选择 `mac-arm64` 单独构建 Apple Silicon 包。工作流上传 Actions 附件，不自动创建 Release，也不运行浏览器或桌面 E2E。macOS 默认使用 ad-hoc 签名，修复运行时加固修改造成的原签名失效；通过 `CSC_NAME` 或 `CSC_LINK` 可显式提供分发签名身份。构建会验证 macOS 签名完整性、可执行架构与归档，但未配置 Apple 公证，不能将静态校验称为安装或运行验收。Windows 检出禁用自动行尾转换，保持包清单与资源摘要一致。

## Android

安装 JDK 21、Android SDK，并设置本机 SDK 路径。构建脚本优先使用 `JAVA_HOME`，也可探测 Homebrew OpenJDK 21 或 Android Studio JBR。

```bash
npm run build:android:web  # 仅构建 Android Web 资源
npm run android:sync      # 同步 Capacitor 工程
npm run android:build     # 默认生成 Release APK
npm run android:build:debug # 仅显式调试、冒烟测试使用
npm run android:build:bossdev # 独立包名的 Boss 开发试玩版，可与正式版共存
npm run android:open      # 用 Android Studio 打开工程
```

Release APK 位于 `android/app/build/outputs/apk/release/app-release-unsigned.apk`，须用外部保管的密钥签名后安装；不将签名凭据提交到仓库。显式 Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。Android 版本名与主菜单共用 `package.json` 的 `version`；数字 `versionCode` 独立用于 Android 更新排序。Release 关闭应用调试及 WebView 远程调试，生产 Web 构建不提供 URL 调试面板。

同步生成的 `android/app/src/main/assets/public/` 不能直接编辑。Android Web 构建不生成 PWA Service Worker。APK 编译不等于真机运行验收，存储恢复、前后台切换和触觉反馈须在设备上验证。

修改内嵌包后运行 `npm run packages:sync`，构建时通过 `packages:check` 校验完整性。已有非空用户内容仓库不会随应用升级自动覆盖为新内嵌包，包更新与存档变化须遵循现有安装和迁移流程。

Boss 开发 variant 使用 `io.github.wetmzl.blackjack.bossdev` 与名称“命运牌桌·Boss开发”，输出 `android/app/build/outputs/apk/bossdev/app-bossdev.apk`，由本机 debug key 签名。其文件提供器、存档和内容仓库与正式版隔离，允许 WebView 调试；不得作为 Release 交付。正式版应用 ID 与 Release 配置不变。

### 原生客户端应用更新

Android 与 Windows／macOS／Linux 桌面客户端在启动器后台优先读取 `https://hoc-core-updates.pages.dev/channels/<stable|latest>.json`，不阻塞启动；“设置”内选择更新通道，启动器右上角提供“设置”和“应用更新”图标入口。默认选择“稳定版”，只接收正式发布；“最新版”包含 beta 等预发布版本，按版本号比较而不是上传时间排序。有效目录中的 `release: null` 或当前版本为最终检查结果，不查询备用源。两个通道都不会降级，稳定版不会改选预发布版。选择仅保存在本机，独立于游戏存档与播放集。网页／PWA 仍随站点更新，不安装原生应用包。

自动检查按通道分别间隔 24 小时，失败退避 1 小时，手动检查可跳过间隔。自动提示只在启动器空闲时出现，进入游戏后不弹出。玩家同意后才下载，支持取消；下载与 SHA-256 校验完成后，由玩家点击“继续安装”。离线、限流、缺少发布或缺少对应平台附件不会影响进入游戏。最新版扫描发布列表分页（每页最多 100 条、最多 10 页），超出上限会提示检查未完成，不把不完整列表当作最新版。

Pages 网络故障或 HTTP 403／404／408／429／5xx 时，检查才使用公开 GitHub Release API；API 限流、服务异常或网络故障时继续使用公开网页。稳定版跟随 `/releases/latest` 的真实重定向，无稳定版时保留当前版本；最新版分页读取发布目录，按 SemVer 选最高版本，再确认该 Release 的预发布标记。网页目录最多读取 10 页，必须读到空页才能确认完整；结构变化、重复页或超出上限均报检查未完成，不把不完整列表当作最新。每页／发布正文最多 4 MiB，仅取纯文本，不执行脚本或加载正文资源。所有请求匿名，不携带玩家或开发仓库令牌。

Pages 候选附件的 `chunk_manifest_url` 必须精确对应所选标签和标准文件名；清单采用 `schemaVersion: 1`，固定完整大小、SHA-256、GitHub 原直链及连续分片顺序。每片最大 24 MiB，只接受同一 Pages 下 `/assets/chunks/<sha256>.part`。客户端下载到本机持久断点目录，逐片验证大小与摘要后落盘，再按序重组并验证完整附件；取消、断网或进程退出后重试，复核并复用已有完整片，只补缺失或损坏片。Android 分片存于应用 files 目录，桌面存于用户数据目录，独立于游戏存档和内容。

下载始终固定用户选中的标签、文件名、完整大小与摘要。同版本同文件换摘要会被本机身份记录拒绝。Pages 分片暂不可用时，只向同一 GitHub 附件请求对应字节 Range，并要求精确的 206／Content-Range 和原分片摘要；没有可用分片清单时可下载同一完整附件并校验。目录、地址、顺序、大小、摘要或 APK 身份异常会停止操作，不借备用源绕过。失败不写入可安装记录，不删除其他已验证分片、已有可用安装包、游戏存档或内容。

网页兜底仅接受同一 Release 中 `SHA256SUMS` 精确列出的平台附件，再通过固定 GitHub 直链的 HEAD 响应确认大小；清单最多 128 KiB，缺失、格式错误、重复文件、无效大小或超出原有下载上限都会阻止更新。下载与安装仍复核完整文件摘要，Android 继续校验包名、签名、版本和系统兼容性。请求均设置超时并限制 HTTPS 主机；Pages 不接受重定向，GitHub 保留受限附件重定向。分发服务使用静态 Pages，不需要 Functions、R2、自有域名或管理 Web UI。

手动检查仍保留 `releases.atom` 的只读日志能力，原生端报告限流时可显示“最近发布日志”；Atom 最多读取 1 MiB，只用于纯文本展示，不能据此下载或安装，不改变所选通道。

| 平台／格式 | 安装行为 |
| --- | --- |
| Android APK | 再次校验摘要、包名、签名、版本与系统兼容性后打开系统安装器；首次可能需要允许此来源安装应用 |
| Windows EXE | 打开 NSIS 安装程序，按系统提示完成；必要时退出当前客户端 |
| macOS DMG | 打开安装镜像，提示退出当前应用并拖入“应用程序”替换；不绕过 Gatekeeper 或签名检查 |
| Linux AppImage | 同目录写入并校验新文件，原子替换当前 AppImage 后重启；当前文件为符号链接或目录不可写时提示手动处理 |
| Windows／macOS ZIP、Linux tar.gz | 打开已校验附件所在文件夹，提示退出应用并解压替换 |

桌面按平台与架构匹配附件；Windows 优先 EXE，其次 ZIP；macOS 优先 DMG，其次 ZIP；AppImage 客户端只接收 AppImage，解包 Linux 客户端接收 tar.gz。下载仅接受固定 Pages 分片与指定仓库的 GitHub Release HTTPS 地址；桌面安装前再次复核 SHA-256。桌面 preload 只暴露固定的更新状态、检查、下载、取消、安装及进度事件；主进程限制主窗口调用，不开放任意 URL、路径、文件或通用 IPC。开发模式不下载或安装公开更新。桌面存档来源 `hoc://app/` 与系统用户目录 `HoC-Core/` 保持稳定。

发布附件必须保留 GitHub 提供的 SHA-256 摘要。APK 标签使用 `vX.Y.Z` 或 `vX.Y.Z-beta.N` 等版本号（也支持现有 `beta2` 命名），附件名为 `HoC-Core-<版本>.apk`，最大 256 MiB；每次分发须递增 `package.json` 的 `androidVersionCode` 并沿用应用身份和签名。桌面附件沿用 `HoC-Core-<版本>-<平台>-<架构>.<格式>`，AppImage 的 x64 架构名兼容 `x86_64` 与 `x64`，单个附件最大 1 GiB。数字预发布序号应使用 `beta.N`，以遵循 SemVer 的数值排序。

Android 定制分发仍可通过 Gradle `-PhocUpdatesEnabled=false` 关闭公开更新；其他应用身份不能使用公开 APK 覆盖。`-PhocVersionCode=...` 和 `-PhocVersionName=...` 可覆盖本地测试构建信息。应用更新不改变内容、存档与播放集流程；构建和更新检查均不会创建标签或发布 Release。
