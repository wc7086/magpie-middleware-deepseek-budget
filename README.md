# magpie-middleware-deepseek-budget

magpie 网关中间件（JS，运行在网关进程的 moejs 里）：当请求实际发往 **DeepSeek** 模型时，保证

```
估算输入 token + max_tokens ≤ 1,048,576
```

超出时把 `max_tokens` 压到预算内；只下调，不上调。

## 官方口径

以下数字与说明于 2026-10-26 读取自 DeepSeek 官方 API 文档：

| 项目 | 值 | 出处 |
| --- | --- | --- |
| 上下文窗口 `context_window` | **1,048,576**（输入与输出**合计**） | [List Models](https://api-docs.deepseek.com/api/list-models/)：*"The total token capacity of the context window, counting both input and output tokens."* |
| 输出上限 `max_output_tokens` | **393,216**（384K） | 同上；[Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)：*"The value must be between 1 and 384K (393216)."* |
| 未设置 `max_tokens` 时的默认值 | 非思考 **8K**、思考 **64K**、`reasoning_effort: "max"` 时 **128K** | Create Chat Completion |
| 思考模式 | 默认开启，默认强度 `high`；`{"thinking":{"type":"disabled"}}` 关闭，`reasoning_effort` 取 `low`/`high`/`max` | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) |
| 字符与 token 的换算 | 1 个英文字符 ≈ 0.3 token；1 个中文字符 ≈ 0.6 token；以 API 返回的 `usage` 为准 | [Token Usage](https://api-docs.deepseek.com/quick_start/token_usage) |
| 图片 | 每张图最多 **1024** token，按尺寸缩放 | [Vision](https://api-docs.deepseek.com/guides/vision) |
| 在售模型 | `deepseek-flash`、`deepseek-v4-pro`，两者窗口同为 1,048,576 | List Models / [Pricing](https://api-docs.deepseek.com/quick_start/pricing/) |

官方没有提供 `count_tokens` 接口，但提供了离线 tokenizer；网关中间件里拿不到 tokenizer，
所以这里按文档给出的字符比例**估算**，并乘一个安全系数。

## 计算方式

1. **估算输入 token**：遍历请求体里的字符串内容（消息、系统提示词、工具声明、工具结果、历史思考内容……）：
   - ASCII 字符 × `asciiTokensPerChar`（默认 0.3）
   - 非 ASCII 字符 × `cjkTokensPerChar`（默认 0.6）
   - 每条消息 + `messageOverheadTokens`（默认 4）
   - 图片块按张计 `imageTokens`（默认 1024，文档给的上限；base64 正文不计字符）
   - 求和后 × `safetyFactor`（默认 1.2），向上取整
2. **取生效的输出上限**：请求显式给出的 `max_tokens`（或各协议的对应字段）；
   没给就按思考模式取默认值（8K / 64K / 128K）。
3. **判定与改写**：输入估算 + 生效上限 > `contextWindow` 时，
   `max_tokens = floor(min(生效上限, maxOutputTokens, contextWindow - 输入估算))`。
   - 结果永远不大于原值，所以已有的限制不会被放宽。
   - 显式 `max_tokens` 超过厂商上限 393,216 时也会被压回。
   - 输入估算本身已经吃掉窗口、连最小输出都放不下时：`onRequest` 用 `ctx.reject(400, …)` 明确报错；
     `onProvider` 阶段无法拒绝，压到 `minOutputTokens` 并写一行日志（上游通常接受 1，只回 1 个 token）。

**为什么乘 1.2**：0.3 / 0.6 是文档给的平均值；代码、密集标点的 token/字符比更高。
安全系数让估算偏保守，避免请求因上下文超限被上游拒绝。代价是阈值随之提前：
未显式给 `max_tokens`、按思考模式默认 64K 计算时，估算输入约 820K 起开始压缩
（判定式是「估算输入 + 生效上限 > 窗口」，显式 `max_tokens` 越大，压缩起点越早），
约 873K 起拒绝——真实 token 略低于 1M 的请求可能被提前压缩或拒绝。
更在意输出长度可以把系数调到 1.0；如果仍收到上游的上下文超限错误，再把它调高。

## 钩子

| 钩子 | 作用 |
| --- | --- |
| `onRequest` | 路由前按 agent 请求的模型名（`body.model`，退回 `ctx.model`）判断，能拒绝请求 |
| `onProvider` | 每次尝试某个供应商前，按**实际模型**（`ctx.provider.model` / `id` / `account`，不按显示名 `name`）判断，覆盖客户端用别名或模型映射的情况 |

`onProvider` 拿到的 body 是 `onRequest` 处理后的版本，同一请求重复计算是幂等的。
两个钩子都失败开放：估算抛错只记日志，请求按原样发送。

## 支持的协议

中间件按 `ctx.protocol` 找输出上限字段，改写后由 magpie 翻译成上游协议：

| `ctx.protocol` | 字段 |
| --- | --- |
| `anthropic` | `max_tokens` |
| `chat` | `max_tokens`（只有 `max_completion_tokens` 时写回该字段） |
| `responses` | `max_output_tokens` |
| `gemini` | `generationConfig.maxOutputTokens`（缺 `generationConfig` 时按需创建） |

## 选项

在「插件 → 已安装 → 选项」里编辑 JSON，或用
`magpie plugin options magpie-middleware-deepseek-budget '<json>'`（按 git 安装时用安装时给出的路径，
名字取包里的 `name`）。未设置的项使用默认值：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `contextWindow` | `1048576` | 上下文窗口（输入 + 输出） |
| `maxOutputTokens` | `393216` | 厂商允许的最大 `max_tokens` |
| `nonThinkingMaxTokens` | `8192` | 非思考模式默认输出上限 |
| `thinkingMaxTokens` | `65536` | 思考模式默认输出上限 |
| `maxEffortMaxTokens` | `131072` | `reasoning_effort: "max"` 时的默认值 |
| `asciiTokensPerChar` | `0.3` | ASCII 字符的 token 估算比例 |
| `cjkTokensPerChar` | `0.6` | 非 ASCII（含中文）字符的估算比例 |
| `messageOverheadTokens` | `4` | 每条消息的结构开销 |
| `imageTokens` | `1024` | 每张图片的 token（文档上限） |
| `safetyFactor` | `1.2` | 估算结果的安全系数 |
| `minOutputTokens` | `1` | 至少保留的输出 token |
| `modelMatch` | `"deepseek"` | 模型名匹配串（不区分大小写的子串） |

## 安装

```sh
git clone <本仓库>
magpie plugin add ./deepseek-budget.middleware.js
# 或者按包安装：magpie plugin add <本仓库目录>
```

中间件不需要 `node_modules`，也不使用 `fetch`、定时器或 Node API，符合 magpie 网关中间件的运行约束。
装好后在「插件 → 网关中间件」中确认已启用（`magpie` 的 `middleware` 插件必须开启，否则所有中间件都不会运行）。

## 验证

```sh
node --test
```

33 个用例覆盖：四协议的字段与改写、deepseek 识别（含别名与 `onProvider`）、只降不升、
缺省 `max_tokens` 的默认值、思考模式默认值与 `thinking`/`thinkingBudget` 的优先级、默认系数的端到端估算、
CJK/ASCII 比例、工具声明与工具结果、历史 thinking / reasoning_content、`responseSchema`、图片与 base64、
幂等性、非数字 `max_tokens` 不改写、输入超窗口的拒绝与降级、非 deepseek 不触碰、畸形请求体失败开放。

估算耗时：Node 上 100 万字符约 2ms；网关的钩子预算（`onRequest` 250ms）内还要算上 moejs 的 JSON 解析开销。

## 已知局限

- **是估算，不是 tokenizer**：比例来自官方文档的平均值；密集代码和随机串会偏高。
  需要精确值时只能离线跑 DeepSeek 的 tokenizer，或以上游返回的 `usage` 为准。
- **只调 `max_tokens`**：输入本身超过窗口时无法修复，只能拒绝；在 `onProvider` 阶段不能拒绝，
  会把 `max_tokens` 压到最小值（上游通常接受 `max_tokens=1`，于是只回 1 个 token，而不是报错）。
- **偏差方向**：估算偏保守（安全系数）时，真实 token 还不到 1M 的请求可能被提前压缩或拒绝；
  估算偏乐观（密集代码）时，略超 1M 的请求可能放过，由上游返回上下文超限错误。
- **图片按上限计**：文档只给每张 1024 的上限，没有公开的尺寸公式；文档/PDF 块也按一张图片计
  （DeepSeek 只收图片，这类请求本来会被上游拒绝）。
- **纯 base64 文本**（不是图片块）会按字符比例低估；图片块里的 base64 不会被计入。
- **思考内容是否算进 `max_tokens`**：DeepSeek 文档没有明说；这里按「算进」处理，与「思考模式默认 64K /
  128K」的说法一致。
- **畸形的输出上限字段**（例如 `max_tokens: "100"` 或 `null`）不改写，请求按原样发送；
  这时候上界由 DeepSeek 自己把关。

## 与现有中间件的关系

2026-10-26 在 GitHub 搜过现成实现：社区的 `param-override` 可以静态设置或按条件覆盖 `max_tokens`，
`model-map` 做模型重定向，另有 `image-slim`（压缩历史图片）等中间件，但没有按「输入估算 + 输出上限 ≤ 窗口」
动态计算的实现；本仓库补的就是这一类。
