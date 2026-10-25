// magpie 网关中间件：当请求实际发往 DeepSeek 模型时，保证
// 「估算输入 token + 生效的 max_tokens」不超过模型上下文窗口。
//
// 官方口径（2026-10-26 读取 https://api-docs.deepseek.com）：
//   - context_window = 1,048,576，字段说明为 "counting both input and output tokens"；
//   - max_output_tokens = 393,216（max_tokens 的取值上限）；
//   - 未设置 max_tokens 时：非思考模式默认 8K、思考模式默认 64K、
//     reasoning_effort=max 时默认 128K；
//   - 1 个英文字符约 0.3 token、1 个中文字符约 0.6 token；每张图片最多 1024 token。
//
// 网关进程里没有 tokenizer，只有文档给出的字符比例，所以估算偏保守：
// 宁可少给一点输出预算，也不要让请求因为上下文超限被上游拒绝。
// 只下调 max_tokens，绝不上调；输入本身已超窗口时无法靠输出预算修复。

export const defaults = Object.freeze({
  contextWindow: 1048576,
  maxOutputTokens: 393216,
  nonThinkingMaxTokens: 8192,
  thinkingMaxTokens: 65536,
  maxEffortMaxTokens: 131072,
  asciiTokensPerChar: 0.3,
  cjkTokensPerChar: 0.6,
  messageOverheadTokens: 4,
  imageTokens: 1024,
  safetyFactor: 1.2,
  minOutputTokens: 1,
  modelMatch: "deepseek",
})

// 请求参数与结构标记不是提示内容，不按字符计 token。
// 只跳过叶子参数；thinking / reasoning / output_config / generationConfig
// 里的 responseSchema 等仍在请求内容里，要照常计入。
const NOT_CONTENT_KEYS = {
  model: true,
  role: true,
  type: true,
  stream: true,
  stream_options: true,
  max_tokens: true,
  max_completion_tokens: true,
  max_output_tokens: true,
  reasoning_effort: true,
  temperature: true,
  top_p: true,
  top_k: true,
  stop: true,
  tool_choice: true,
  parallel_tool_calls: true,
  metadata: true,
}

// 各 agent 协议里输出上限所在的字段；第一个是本协议通常使用的字段。
const OUTPUT_FIELDS = {
  anthropic: ["max_tokens"],
  chat: ["max_tokens", "max_completion_tokens"],
  responses: ["max_output_tokens"],
  gemini: ["generationConfig.maxOutputTokens"],
}

function settings(ctx) {
  const given = (ctx && ctx.options) || {}
  const out = {}
  for (const name in defaults) {
    const fallback = defaults[name]
    const value = given[name]
    if (typeof fallback === "number") {
      const n = Number(value)
      out[name] =
        value !== undefined && value !== null && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback
    } else {
      out[name] = typeof value === "string" && value.trim() !== "" ? value : fallback
    }
  }
  return out
}

function protocolOf(ctx, body) {
  if (ctx && typeof ctx.protocol === "string" && ctx.protocol !== "") return ctx.protocol.toLowerCase()
  if (body && typeof body === "object") {
    if (body.input !== undefined || body.instructions !== undefined || body.max_output_tokens !== undefined) {
      return "responses"
    }
    if (body.contents !== undefined || body.generationConfig !== undefined) return "gemini"
  }
  return "chat"
}

function getPath(obj, path) {
  let at = obj
  for (const key of path.split(".")) {
    if (!at || typeof at !== "object") return undefined
    at = at[key]
  }
  return at
}

function hasPath(obj, path) {
  let at = obj
  for (const key of path.split(".")) {
    if (!at || typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, key)) return false
    at = at[key]
  }
  return true
}

function setPath(obj, path, value) {
  const keys = path.split(".")
  let at = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (!at[key] || typeof at[key] !== "object") at[key] = {}
    at = at[key]
  }
  at[keys[keys.length - 1]] = value
}

// readOutput 找请求里显式给出的输出上限，记下它所在的字段。
// 字段存在但不是有效的非负数字时返回 malformed：这种请求不改写，避免把
// 一个畸形值「修」成更大的值。
function readOutput(body, protocol) {
  const fields = OUTPUT_FIELDS[protocol] || OUTPUT_FIELDS.chat
  for (const path of fields) {
    if (!hasPath(body, path)) continue
    const value = getPath(body, path)
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return { path: path, value: value }
    return { path: path, malformed: true }
  }
  return undefined
}

function writeOutput(body, protocol, current, value) {
  const fields = OUTPUT_FIELDS[protocol] || OUTPUT_FIELDS.chat
  setPath(body, current ? current.path : fields[0], value)
}

// effortOf 读请求里的思考强度；none 表示非思考模式。
// thinking.type=disabled 与 Gemini 的 thinkingBudget=0 优先：它们明确关掉思考，
// 即使同时带了 reasoning_effort。DeepSeek 把 ultra 归为 max。
function effortOf(body) {
  if (body.thinking && typeof body.thinking === "object" && body.thinking.type === "disabled") return "none"
  const gemini = body.generationConfig && body.generationConfig.thinkingConfig
  if (gemini && (gemini.thinkingBudget === 0 || gemini.thinkingBudget === "0")) return "none"
  const candidates = [
    body.reasoning_effort,
    body.reasoning && body.reasoning.effort,
    body.output_config && body.output_config.effort,
  ]
  for (const value of candidates) {
    if (typeof value === "string" && value !== "") {
      const effort = value.toLowerCase()
      return effort === "ultra" ? "max" : effort
    }
  }
  return ""
}

// defaultOutputTokens 是请求未带输出上限时，DeepSeek 自己采用的默认值。
function defaultOutputTokens(body, s) {
  const effort = effortOf(body)
  if (effort === "none") return s.nonThinkingMaxTokens
  if (effort === "max") return s.maxEffortMaxTokens
  return s.thinkingMaxTokens
}

function isDataUri(str) {
  return str.length > 16 && str.slice(0, 5) === "data:" && str.indexOf(";base64,") !== -1
}

// isImagePart 认各协议的图片块：Anthropic 的 image/source、Chat 的 image_url、
// Responses 的 input_image、Gemini 的 inlineData。图片按张计 token，正文不计字符。
function isImagePart(value) {
  if (typeof value.type === "string") {
    const type = value.type.toLowerCase()
    if (type === "image" || type === "input_image" || type === "image_url") return true
  }
  if (value.image_url !== undefined) return true
  if (value.inlineData !== undefined || value.inline_data !== undefined) return true
  if (value.fileData !== undefined || value.file_data !== undefined) return true
  if (value.source && typeof value.source === "object") {
    if (value.source.type === "base64" || value.source.type === "url") return true
  }
  return false
}

function stringUnits(str, s) {
  let ascii = 0
  let other = 0
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) ascii += 1
    else other += 1
  }
  return ascii * s.asciiTokensPerChar + other * s.cjkTokensPerChar
}

function countContent(value, acc, s) {
  if (typeof value === "string") {
    if (isDataUri(value)) acc.images += 1
    else acc.units += stringUnits(value, s)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) countContent(value[i], acc, s)
    return
  }
  if (!value || typeof value !== "object") return
  if (isImagePart(value)) {
    acc.images += 1
    return
  }
  for (const key in value) {
    if (NOT_CONTENT_KEYS[key]) continue
    if (Object.prototype.hasOwnProperty.call(value, key)) countContent(value[key], acc, s)
  }
}

function messageCount(body) {
  if (!body || typeof body !== "object") return 0
  let n = 0
  if (Array.isArray(body.messages)) n += body.messages.length
  if (Array.isArray(body.input)) n += body.input.length
  if (Array.isArray(body.contents)) n += body.contents.length
  return n
}

function estimate(body, s) {
  const acc = { units: 0, images: 0 }
  countContent(body, acc, s)
  const raw = acc.units + acc.images * s.imageTokens + messageCount(body) * s.messageOverheadTokens
  return Math.ceil(raw * s.safetyFactor)
}

// estimateTokens 是给测试与排查用的估算入口，与钩子里的算法相同。
export function estimateTokens(body, options) {
  return estimate(body, settings({ options: options }))
}

function adjust(body, ctx, canReject) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const s = settings(ctx)
  const protocol = protocolOf(ctx, body)
  const minOutput = Math.max(1, Math.floor(s.minOutputTokens))
  const prompt = estimate(body, s)
  const current = readOutput(body, protocol)
  if (current && current.malformed) return undefined
  const effective = current ? current.value : defaultOutputTokens(body, s)
  const budget = Math.floor(s.contextWindow - prompt)

  if (budget < minOutput) {
    if (canReject) {
      ctx.reject(
        400,
        "deepseek 上下文预算不足：估算输入约 " +
          prompt +
          " tokens，已超过上下文窗口 " +
          s.contextWindow +
          "，仅调整 max_tokens 无法修复；请缩短上下文或减少附件",
      )
      return undefined
    }
    writeOutput(body, protocol, current, minOutput)
    console.log(
      "[deepseek-budget] 输入估算 " + prompt + " tokens 已超出窗口 " + s.contextWindow + "，max_tokens 压到 " + minOutput,
    )
    return body
  }

  const ceiling = Math.min(effective, s.maxOutputTokens, budget)
  const next = Math.max(minOutput, Math.floor(ceiling))
  if (next >= effective) return undefined

  writeOutput(body, protocol, current, next)
  console.log("[deepseek-budget] 输入估算 " + prompt + " tokens：max_tokens " + effective + " → " + next)
  return body
}

function namesDeepSeek(value, s) {
  return typeof value === "string" && value.toLowerCase().indexOf(s.modelMatch.toLowerCase()) !== -1
}

// onRequest 在路由前按 agent 请求的模型名判断；能拒绝请求。
export function onRequest(body, ctx) {
  try {
    const c = ctx || {}
    const asked =
      (body && typeof body === "object" && typeof body.model === "string" && body.model) ||
      (typeof c.model === "string" ? c.model : "")
    if (!namesDeepSeek(asked, settings(c))) return undefined
    return adjust(body, c, true)
  } catch (err) {
    console.log("[deepseek-budget] onRequest 失败，按原样发送: " + (err && err.message ? err.message : err))
    return undefined
  }
}

// onProvider 在请求即将发给某个供应商时运行，按该供应商的实际模型判断，
// 覆盖 agent 用别名或模型映射的情况；此时不能拒绝请求。
export function onProvider(body, ctx) {
  try {
    const c = ctx || {}
    const s = settings(c)
    const provider = c.provider || {}
    // 只看结构化字段：provider.name 是显示名，可能只是「My DeepSeek Proxy」这类叫法。
    const actual = [provider.model, provider.id, provider.account]
    let matched = false
    for (const name of actual) {
      if (namesDeepSeek(name, s)) {
        matched = true
        break
      }
    }
    if (!matched) return undefined
    return adjust(body, c, false)
  } catch (err) {
    console.log("[deepseek-budget] onProvider 失败，按原样发送: " + (err && err.message ? err.message : err))
    return undefined
  }
}
