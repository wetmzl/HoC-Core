# 官方剧情包素材与许可

本包为 Core 全年龄独立剧情包，剧情与声明资源遵循项目 GPL-3.0-only 许可。开场与「下一位对手」正文采用用户定稿；按后续要求省略旁白姓名并移除三处场景提示外层的中括号，其他文字保持。所有运行时媒体均为包内文件，不依赖其他内容包的媒体路径。

## 剧情专用全身 PNG

角色原作者：ZipZipPipe。2026-11-15 使用内置 imagegen 对照作者完整原图改绘为透明全身立绘并制作表情差分。保留原设服装、鞋子、耳朵／龙角、尾巴与龙翼；DeepSeek 采用深蓝白长裙女仆，Llama 采用奶白连帽衫与长裙、羊驼拖鞋，ChatGPT 采用白紫开衩长礼裙。这些文件是 AI 改绘，不是作者亲绘的新差分；也不再是对局包半身 PNG 的副本。

| 包内文件 | 原设来源 | 差分 |
| --- | --- | --- |
| `actors/deepseek-relaxed.png` | 作者《AI娘化》p00 | 轻松 |
| `actors/deepseek-mocking.png` | 同上，同一全身基础稿 | 温和笑意 |
| `actors/deepseek-innocent.png` | 同上，同一全身基础稿 | 无辜、尚未意识到闯祸 |
| `actors/deepseek-flustered.png` | 同上，同一全身基础稿 | 慌张、歉意 |
| `actors/deepseek-conflicted.png` | 同上，同一全身基础稿 | 困扰 |
| `actors/deepseek-playful.png` | 同上，同一全身基础稿 | 俏皮眨眼 |
| `actors/llama-relaxed.png` | 作者《AI娘化》p13 | 轻松 |
| `actors/chatgpt-relaxed.png` | 作者《AI娘化》p03 | 轻松 |
| `actors/chatgpt-mocking.png` | 同上，同一全身基础稿 | 克制的调侃微笑 |

原作：[ZipZipPipe《AI娘化》](https://www.pixiv.net/artworks/148186519)，[作者主页](https://www.pixiv.net/users/18604994)。原图通过公开镜像取得，并按其目录摘要核对；本次无法直接打开 Pixiv 页面。原图 SHA-256：

- DeepSeek p00：`73264faff3511347b1b9668d5d937cbb3f2402f8bb03cc158fc8a81bfc2d077c`。
- Llama p13：`efe928d775e432353cd9067a54f4fe4cf5a5bf7a9dd3611b27fb9f2b3867a120`。
- ChatGPT p03：`c47948cd25efcf7ad4a5179288c8452445d57d6dfc379fb27ab6e809a6970157`。

DeepSeek 许可记录为 CC BY-NC-SA 4.0，条款见 `LICENSE-ART.md`。Llama 与 ChatGPT 的新原图目录记录为作者开放分享与再创作说明，未核实统一标准许可证，单独以 `LicenseRef-ZipZipPipe-Author-Sharing` 标识；详见 `LICENSE-AUTHOR-SHARING.md`，不据此宣称它们是 CC0 或新取得统一 CC 许可。

九张 1024×1536 原生透明 PNG 是本包独立构建源，清单记录各自字节数与 SHA-256，不依赖对局包媒体。构建按现有策略生成 WebP（质量 92，alphaQuality 100，保持分辨率与透明通道），源 PNG 不被覆盖。换发言人切换聚焦亮度与前后层级，已经上场的两人保持同框。

DeepSeek 的表情方向是热心、可爱而无辜：温和笑意去掉挑衅的眉眼；报余额归零等“好消息”时使用无辜表情，发现花掉预算时使用慌张表情，提出本地替代方案时恢复轻松。2026-11-15 本轮以既有全身 PNG 为编辑目标新增俏皮眨眼差分，并将 ChatGPT 的调侃表情调整为平和目光与克制微笑。原稿尺寸、长裙、物种特征和全身构图沿用。

## 内容包封面（2026-11-16）

`covers/official-story.png` 为 HoC-Core 使用内置 imagegen 独立生成的内容包封面，按 CC0 1.0 Universal 提供，完整条款见包内 `LICENSE-BACKGROUNDS.md`。图中为深绿牌桌、摊开的记录本、钢笔与纸牌，以低饱和色和柔和暖光呼应策展人记录聚会的剧情；没有人物或角色参考。

原生 1254×1254 PNG 原字节保留为本包构建源；构建按现有图片策略生成 WebP，不覆盖 PNG。此图仅绑定内容包的 `metadata.coverImage`，各段剧情档案继续使用下列角色封面。

## 剧情档案封面

封面仍为既有 Core PNG 的原样副本，沿用来源包现有署名和 CC BY-NC-SA 4.0 声明。

| 包内文件 | Core 源文件 |
| --- | --- |
| `cover.png` | `public/characters/deepseek/cover.png` |
| `covers/chatgpt.png` | `public/characters/chatgpt/cover.png` |

## 场景 PNG 原图

作者：HoC-Core（AI 生成）。许可证：CC0 1.0 Universal；完整条款见包内 `LICENSE-BACKGROUNDS.md`。牌室背景于 2026-11-14 根据开场剧情独立生成：暖光吊灯、长廊、深红地毯与深绿呢布牌桌，采用低亮度与克制细节；未使用角色参考。同日按用户反馈将圆形垂布桌修正为带黑色厚包边、庄家直边、玩家弧边、投注位、筹码槽与发牌器的 21 点牌桌，保留原生竖屏和暗色大厅构图。以下均为 Core PNG 原稿的原样副本，没有二次加工。

| 包内文件 | Core 源文件 |
| --- | --- |
| `backgrounds/table-hall-dark.png` | `public/assets/backgrounds/table-hall-dark.png` |
| `backgrounds/curator-office.png` | `public/assets/backgrounds/curator-office.png` |

开场办公室使用独立竖屏背景：百叶窗日光、木桌、打印稿与空茶杯。于 2026-11-14 使用内置 imagegen 独立生成，无人物或角色参考。初始舞台显式显示办公室，进入牌厅后切换深色牌厅原稿。剧情档案封面分别采用 DeepSeek 与 ChatGPT 既有角色封面，原作者及许可同上述角色美术。

## 第四段新增立绘（2026-11-15）

原作者 ZipZipPipe，来源仍为上述《AI娘化》。新增角色 Grok p07、Gemini p04、GLM p06、Qwen p12，Llama 手机姿态以已交付的 p13 全身改绘为基础。使用内置 imagegen 生成七张 1024×1536 RGBA PNG；全部为 AI 改绘，不是作者亲绘的新差分。Grok 不携带原设巨斧，以空手参加牌室聊天；其余保留对应原设服装、物种特征及道具。

| 文件 | 原设与用途 |
| --- | --- |
| `actors/grok-relaxed.png` | p07，空手争辩与起哄 |
| `actors/grok-flustered.png` | 同基础稿，羞恼抗议 |
| `actors/gemini-protesting.png` | p04，多模态猫猫抗议 |
| `actors/gemini-embarrassed.png` | 同基础稿，心虚与被评论调侃 |
| `actors/glm-relaxed.png` | p06，抱书温和辩解 |
| `actors/qwen-relaxed.png` | p12，折扇与手提包，温和笑意 |
| `actors/llama-phone.png` | p13 对应改绘，双手持手机播报留言 |

Grok 的 `actors/grok-relaxed.png`、`actors/grok-flustered.png`，GLM 的 `actors/glm-relaxed.png` 与 Qwen 的 `actors/qwen-relaxed.png` 沿用 CC BY-NC-SA 4.0，完整条款见 `LICENSE-ART.md`：用户于 2026-11-16 确认，ZipZipPipe 已给予这三位与 DeepSeek 等既有角色相同的口头许可和许可证。Gemini 与 Llama 本段新增图仍沿用 `LicenseRef-ZipZipPipe-Author-Sharing` 的作者分享／再创作说明，详见 `LICENSE-AUTHOR-SHARING.md`。生成 PNG 作为构建源保留，WebP 由正常构建生成。Claude 本段仅以留言出现，没有新增在场立绘。

## 第一章终幕新增立绘（2026-11-15）

使用内置 imagegen 编辑，新增三张原生 1024×1536 RGBA PNG：`actors/claude-proud.png`（高傲常态、整理袖口）、`actors/claude-phone.png`（看到手机消息后的短暂紧张）、`actors/llama-knowing.png`（收起手机后的微妙笑意）。保持完整服装与全身构图。Claude 直接参考 ZipZipPipe《AI娘化》p02，Llama 参考本包现有 `llama-relaxed.png`，不从半身图猜测下装。

三张均采用 `LicenseRef-ZipZipPipe-Author-Sharing` 记录原作分享状态，不扩展作者许可；沿用本包完整许可说明。原图由私有制作档案保存来源记录，游戏包不依赖档案目录。PNG 为构建源，WebP 由构建生成。

2026-11-15 按用户追加要求收敛 `actors/claude-phone.png`：保留原姿势、书、手机、全身服装与画布，仅改为垂眼、闭嘴的克制表情，保持优雅和距离感。使用内置 imagegen 编辑，署名及许可沿用上述来源记录。
