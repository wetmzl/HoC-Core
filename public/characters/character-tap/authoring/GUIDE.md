# 角色拍一拍：事件 API 1／区域附件 API 2

这个独立包提供 `hoc-core/character-tap#tap` API 1 事件。停用插件后角色仍可加载；规则中其他可用的事件订阅继续有效。对白资源必须使用 `game.character-dialogue` API 2。插件引用不写入 Manifest 的 `requires`。

在角色对白中添加规则：

```json
{
  "id": "tap-example",
  "on": [{ "type": "hoc-core/character-tap#tap", "apiVersion": 1 }],
  "when": {
    "all": [
      { "primitive": "hoc-core/character-tap#consecutive-count", "apiVersion": 1, "args": {}, "test": { "range": { "min": 2 } } },
      { "primitive": "core.random", "apiVersion": 1, "args": { "key": "tap-response" }, "test": { "range": { "max": 0.5, "maxInclusive": false } } }
    ]
  },
  "poolId": "TAP"
}
```

随机数范围为 `[0,1)`；同一事件和 key 共享同一次抽签。未命中规则保持上一条对白和打字进度。仅没有可显示对白时使用 fallback 池。规则默认以 `dialogue-event` 抽取台词。不同规则按照文件顺序选择第一条。

六个原语版本均为 1，除 `region` 支持可选 `{ "id": "区域ID" }` 参数外，其余参数均为 `{}`：`round-count` 是当前回合次数，`consecutive-count` 是上次非拍一拍对白事件以来次数，`total-count` 是本牌局次数。有效点击即计数，包括没有匹配对白的点击。`x`、`y` 是实际显示图片原图内容盒的归一化坐标；`region` 是作者区域 ID。后三者仅在拍一拍事件可用，键盘激活返回 null。`full-portrait`（显示名称“全立绘”）是固定内置区域，每次有效立绘点击都属于它。`region` 不传参数时返回首个命中的自定义区域；未命中自定义区域则返回 `full-portrait`。传入 `{ "id": "full-portrait" }` 时，即使同时命中其他标定区域，也返回 `full-portrait`；查询其他 ID 时，仅在该 ID 是首个命中区域时返回它，否则为 null。三个计数可在其他对白事件读取。

附件 `plugin.character-tap` API 2 的默认入口可用 `plugins/character-tap.json`，其 `requires` 只引用同包 `game.character-match` 的资源 ID。正文格式：

```json
{
  "characterResourceId": "match",
  "regions": ["upper", "triangle"],
  "images": [{
    "image": "relaxed.png",
    "regions": [
      { "id": "upper", "shape": "rectangle", "x": 0, "y": 0, "width": 1, "height": 0.5 },
      { "id": "triangle", "shape": "polygon", "points": [{ "x": 0, "y": 0.5 }, { "x": 1, "y": 0.5 }, { "x": 0.5, "y": 1 }] }
    ]
  }]
}
```

先在顶层 `regions` 声明区域 ID；图片标定的 `id` 只能引用已经声明的 ID，同一 ID 可在不同图片上复用。区域 `full-portrait` 固定存在、不得重新声明或覆盖。`regions` 与 `images` 可以是空数组，角色无需附件也可使用全立绘区域。对白仍订阅统一的 `tap` 事件，再用 `region` 原语筛选，例如 `"test": { "eq": "upper" }` 或 `"args": { "id": "full-portrait" }, "test": { "eq": "full-portrait" }`。

所有坐标必须在 `[0,1]` 内；矩形不能退化，多边形不能退化或自交。边界包含，重叠时按照区域文件顺序选择第一个。图片必须在同包 files 声明并使用安全相对路径。基础立绘、思考图和规则覆盖图分别标定；首个自定义区域未命中时，主区域为 `full-portrait`；键盘没有点击坐标，区域查询仍为 null。`regions.schema.json` 使用公开的、无需执行插件代码的几何校验关键字 `x-normalized-region`；`x-enumFrom: "/regions"` 在根文档中校验区域引用，无需运行插件。旧附件 API 1 需按此格式重新打包；事件和原语仍是 API 1。

进入牌桌即可激活，所有牌桌阶段均有效，包括 AI 行动等待、回合结算、轮盘准备与结果，以及对局结束后的牌桌停留阶段。具体台词、立绘和回应条件由角色包声明；插件不按阶段或胜负过滤。每次点击或 Enter/Space 激活是一个新事件。图片原图内容盒外的点击无效。无冷却。刷新保留回合和总次数，连续次数清零；恢复正常牌局对白，不恢复拍一拍显示。计数与事件序号在包隔离的本机表现存储中保存，不属于存档导出；已结束对局在离开其会话时清理，以保持结束后点击的事件身份连续。

`neutral.hocpkg` 是可以导入的中性角色包，演示可选订阅和区域附件。正式角色需由作者自行添加规则和区域。
