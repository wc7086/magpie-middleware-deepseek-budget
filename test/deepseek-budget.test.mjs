// 测试 magpie 调用钩子的方式：一个请求一个 ctx，body 是 agent 协议的对象，
// 返回 undefined 表示「按原样发送」。见 magpie docs/subsystems/gateway-middleware.md。
import test from "node:test"
import assert from "node:assert/strict"

import { onRequest, onProvider, estimateTokens, defaults } from "../deepseek-budget.middleware.js"

// 让算术可见的选项：1 个 ASCII 字符 1 token、中文 2 token、不加安全系数、
// 不计消息开销，窗口 1000、厂商输出上限 900。
const MATH = {
  asciiTokensPerChar: 1,
  cjkTokensPerChar: 2,
  safetyFactor: 1,
  messageOverheadTokens: 0,
  imageTokens: 300,
  contextWindow: 1000,
  maxOutputTokens: 900,
}

function makeCtx(extra = {}) {
  const rejects = []
  const ctx = {
    protocol: "chat",
    model: "deepseek-flash",
    stream: false,
    path: "/v1/chat/completions",
    options: {},
    state: {},
    reject(status, message) {
      rejects.push({ status, message })
    },
    ...extra,
  }
  return Object.assign(ctx, { rejects })
}

function userMessage(chars, role = "user") {
  return { messages: [{ role, content: "a".repeat(chars) }] }
}

test("官方数字与文档一致", () => {
  assert.equal(defaults.contextWindow, 1048576)
  assert.equal(defaults.maxOutputTokens, 393216)
  assert.equal(defaults.nonThinkingMaxTokens, 8192)
  assert.equal(defaults.thinkingMaxTokens, 65536)
  assert.equal(defaults.maxEffortMaxTokens, 131072)
  assert.equal(defaults.imageTokens, 1024)
})

test("非 deepseek 模型完全不动", () => {
  const body = { model: "gpt-5", ...userMessage(5000), max_tokens: 900 }
  const ctx = makeCtx({ model: "gpt-5", options: MATH })
  assert.equal(onRequest(body, ctx), undefined)
  assert.equal(body.max_tokens, 900)
  assert.equal(ctx.rejects.length, 0)
})

test("估算输入 + max_tokens 未超窗口时不改写", () => {
  const body = { model: "deepseek-flash", ...userMessage(100), max_tokens: 900 }
  const ctx = makeCtx({ options: MATH })
  assert.equal(onRequest(body, ctx), undefined)
  assert.equal(body.max_tokens, 900)
})

test("超窗口时把 max_tokens 压到预算内", () => {
  const body = { model: "deepseek-flash", ...userMessage(400), max_tokens: 900 }
  const ctx = makeCtx({ options: MATH })
  assert.equal(onRequest(body, ctx), body)
  // 窗口 1000 - 输入 400 = 600
  assert.equal(body.max_tokens, 600)
  assert.equal(ctx.rejects.length, 0)
})

test("只下调，不上调已有的 max_tokens", () => {
  const body = { model: "deepseek-flash", ...userMessage(100), max_tokens: 50 }
  const ctx = makeCtx({ options: MATH })
  assert.equal(onRequest(body, ctx), undefined)
  assert.equal(body.max_tokens, 50)
})

test("未带 max_tokens 时按思考模式默认值判断，需要时补上字段", () => {
  // 预算 600，思考模式默认 64K 装不下，降到 600
  const body = { model: "deepseek-flash", ...userMessage(400) }
  const ctx = makeCtx({ options: MATH })
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.max_tokens, 600)
})

test("未带 max_tokens 且预算充足时不添加字段", () => {
  const body = { model: "deepseek-flash", ...userMessage(100) }
  const ctx = makeCtx({
    options: { ...MATH, contextWindow: 100000, maxOutputTokens: 393216 },
  })
  assert.equal(onRequest(body, ctx), undefined)
  assert.equal("max_tokens" in body, false)
})

test("reasoning_effort=max 按 128K 默认判断", () => {
  const options = { ...MATH, contextWindow: 100000, maxOutputTokens: 393216, messageOverheadTokens: 0 }
  // 预算 80000：思考默认 64K 装得下，max 默认 128K 装不下
  const thinking = { model: "deepseek-flash", ...userMessage(20000) }
  assert.equal(onRequest(thinking, makeCtx({ options })), undefined)
  const max = { model: "deepseek-flash", ...userMessage(20000), reasoning_effort: "max" }
  assert.equal(onRequest(max, makeCtx({ options })), max)
  assert.equal(max.max_tokens, 80000)
})

test("reasoning_effort=ultra 按 max 处理", () => {
  const options = { ...MATH, contextWindow: 100000, maxOutputTokens: 393216 }
  const body = { model: "deepseek-flash", ...userMessage(20000), reasoning_effort: "ultra" }
  assert.equal(onRequest(body, makeCtx({ options })), body)
  assert.equal(body.max_tokens, 80000)
})

test("thinking 关闭优先于 reasoning_effort", () => {
  const options = { ...MATH, contextWindow: 60000, maxOutputTokens: 393216 }
  // 预算 10000：关闭思考时默认 8K 装得下；若误按 max 的 128K 处理就会写 10000
  const body = {
    model: "deepseek-flash",
    ...userMessage(50000),
    thinking: { type: "disabled" },
    reasoning_effort: "max",
  }
  assert.equal(onRequest(body, makeCtx({ options })), undefined)
  assert.equal("max_tokens" in body, false)
})

test("Gemini thinkingBudget=0 按非思考模式默认值判断", () => {
  const options = { ...MATH, contextWindow: 60000, maxOutputTokens: 393216 }
  const body = {
    model: "deepseek-flash",
    contents: [{ role: "user", parts: [{ text: "a".repeat(50000) }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  }
  assert.equal(onRequest(body, makeCtx({ protocol: "gemini", options })), undefined)
  assert.equal("maxOutputTokens" in body.generationConfig, false)
})

test("超过厂商输出上限的 max_tokens 被压到 384K", () => {
  const body = { model: "deepseek-flash", ...userMessage(10), max_tokens: 500000 }
  const ctx = makeCtx()
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.max_tokens, 393216)
})

test("anthropic 协议改写 max_tokens", () => {
  const body = {
    model: "deepseek-v4-pro",
    system: "sys",
    messages: [{ role: "user", content: "a".repeat(400) }],
    max_tokens: 900,
  }
  const ctx = makeCtx({ protocol: "anthropic", path: "/v1/messages", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  // 400 字符 + system 的 3 个字符 = 403，预算 597
  assert.equal(body.max_tokens, 597)
})

test("responses 协议改写 max_output_tokens", () => {
  const body = { model: "deepseek-v4-pro", input: "a".repeat(400), max_output_tokens: 900 }
  const ctx = makeCtx({ protocol: "responses", path: "/v1/responses", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.max_output_tokens, 600)
})

test("gemini 协议改写 generationConfig.maxOutputTokens", () => {
  const body = {
    model: "deepseek-flash",
    contents: [{ role: "user", parts: [{ text: "a".repeat(400) }] }],
    generationConfig: { maxOutputTokens: 900 },
  }
  const ctx = makeCtx({ protocol: "gemini", path: "/v1beta/models/x:generateContent", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.generationConfig.maxOutputTokens, 600)
})

test("gemini 缺少 generationConfig 时按需创建", () => {
  const body = {
    model: "deepseek-flash",
    contents: [{ role: "user", parts: [{ text: "a".repeat(400) }] }],
  }
  const ctx = makeCtx({ protocol: "gemini", path: "/v1beta/models/x:generateContent", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 600 })
})

test("chat 的 max_completion_tokens 也识别，并写回原字段", () => {
  const body = { model: "deepseek-flash", ...userMessage(400), max_completion_tokens: 900 }
  const ctx = makeCtx({ options: MATH })
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.max_completion_tokens, 600)
  assert.equal("max_tokens" in body, false)
})

test("onProvider 按实际供应商模型识别 deepseek", () => {
  const options = MATH
  const body = { model: "fast", ...userMessage(400), max_tokens: 900 }
  const ctx = makeCtx({
    model: "fast",
    provider: { id: "deepseek", name: "DeepSeek", model: "deepseek-v4-pro" },
    options,
  })
  assert.equal(onProvider(body, ctx), body)
  assert.equal(body.max_tokens, 600)
})

test("onProvider 不因客户端模型名误伤其他供应商", () => {
  const body = { model: "deepseek-flash", ...userMessage(400), max_tokens: 900 }
  const ctx = makeCtx({
    provider: { id: "openai", name: "OpenAI", model: "gpt-5" },
    options: MATH,
  })
  assert.equal(onProvider(body, ctx), undefined)
  assert.equal(body.max_tokens, 900)
})

test("输入本身超窗口：onRequest 返回 400，onProvider 压到最小值", () => {
  const tooBig = () => ({ model: "deepseek-flash", ...userMessage(1200), max_tokens: 900 })
  const reqCtx = makeCtx({ options: MATH })
  const reqBody = tooBig()
  assert.equal(onRequest(reqBody, reqCtx), undefined)
  assert.equal(reqCtx.rejects.length, 1)
  assert.equal(reqCtx.rejects[0].status, 400)
  assert.match(reqCtx.rejects[0].message, /1200/)

  const provCtx = makeCtx({
    provider: { id: "deepseek", model: "deepseek-v4-pro" },
    options: MATH,
  })
  const provBody = tooBig()
  assert.equal(onProvider(provBody, provCtx), provBody)
  assert.equal(provBody.max_tokens, 1)
  assert.equal(provCtx.rejects.length, 0)
})

test("图片按张计 token，base64 正文不计字符", () => {
  const body = {
    model: "deepseek-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(200000) } },
          { type: "text", text: "a".repeat(100) },
        ],
      },
    ],
    max_tokens: 900,
  }
  const ctx = makeCtx({ protocol: "anthropic", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  // 100 字符 + 1 张图 300 = 400，预算 600
  assert.equal(body.max_tokens, 600)
})

test("中文字符按 CJK 比例计 token", () => {
  // 窗口 1200：中文 500 字 = 500 token，预算 700，要压；
  // 英文 500 字 = 250 token，预算 950，max_tokens 900 装得下，不动。
  const options = { ...MATH, asciiTokensPerChar: 0.5, cjkTokensPerChar: 1, contextWindow: 1200, maxOutputTokens: 1500 }
  const cjk = { model: "deepseek-flash", messages: [{ role: "user", content: "中".repeat(500) }], max_tokens: 900 }
  assert.equal(onRequest(cjk, makeCtx({ options })), cjk)
  assert.equal(cjk.max_tokens, 700)

  const ascii = { model: "deepseek-flash", messages: [{ role: "user", content: "a".repeat(500) }], max_tokens: 900 }
  assert.equal(onRequest(ascii, makeCtx({ options })), undefined)
  assert.equal(ascii.max_tokens, 900)
})

test("按文档默认系数估算：600 个 ASCII 字符在 1000 窗口里只剩 779", () => {
  // 600 × 0.3 = 180，加 1 条消息的 4，再乘安全系数 1.2 → 221；1000 - 221 = 779
  const body = { model: "deepseek-flash", ...userMessage(600), max_tokens: 900 }
  const ctx = makeCtx({ options: { contextWindow: 1000 } })
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.max_tokens, 779)
})

test("generationConfig 里的 responseSchema 也计入输入", () => {
  // 正文 100 字符 + responseSchema 描述 400 字符 = 500，预算 500
  const body = {
    model: "deepseek-flash",
    contents: [{ role: "user", parts: [{ text: "a".repeat(100) }] }],
    generationConfig: { responseSchema: { description: "a".repeat(400) } },
  }
  const ctx = makeCtx({ protocol: "gemini", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.generationConfig.maxOutputTokens, 500)
})

test("工具声明与工具结果都计入输入", () => {
  const body = {
    model: "deepseek-flash",
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "a".repeat(200) }] }],
    tools: [{ name: "t", description: "a".repeat(200), input_schema: { type: "object" } }],
    max_tokens: 900,
  }
  const ctx = makeCtx({ protocol: "anthropic", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  // tool_use_id 1 + 结果 200 + 工具名 1 + 描述 200 = 402，预算 598
  assert.equal(body.max_tokens, 598)
})

test("历史 thinking 块计入输入", () => {
  const body = {
    model: "deepseek-v4-pro",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(300), signature: "sig" }] },
    ],
    max_tokens: 900,
  }
  const ctx = makeCtx({ protocol: "anthropic", options: MATH })
  assert.equal(onRequest(body, ctx), body)
  // "hi" 2 + thinking 300 + signature 3 = 305，预算 695
  assert.equal(body.max_tokens, 695)
})

test("历史 reasoning_content 与 thinking 块同样计入", () => {
  const body = {
    model: "deepseek-flash",
    messages: [{ role: "assistant", content: "x", reasoning_content: "a".repeat(200) }],
    max_tokens: 900,
  }
  const ctx = makeCtx({ options: MATH })
  assert.equal(onRequest(body, ctx), body)
  // "x" 1 + reasoning 200 = 201，预算 799
  assert.equal(body.max_tokens, 799)
})

test("默认系数下 5 万字符的 responseSchema 计 18000 token", () => {
  const body = { generationConfig: { responseSchema: { description: "a".repeat(50000) } } }
  // 50000 × 0.3 × 1.2 = 18000
  assert.equal(estimateTokens(body), 18000)
})

test("onRequest 之后 onProvider 重复计算是幂等的", () => {
  const body = { model: "deepseek-flash", ...userMessage(400), max_tokens: 900 }
  assert.equal(onRequest(body, makeCtx({ options: MATH })), body)
  assert.equal(body.max_tokens, 600)
  const providerCtx = makeCtx({ options: MATH, provider: { id: "deepseek", model: "deepseek-flash" } })
  assert.equal(onProvider(body, providerCtx), undefined)
  assert.equal(body.max_tokens, 600)
})

test("onProvider 不按供应商显示名匹配", () => {
  const body = { model: "gpt-5", ...userMessage(400), max_tokens: 900 }
  const ctx = makeCtx({
    provider: { id: "my-proxy", name: "My DeepSeek Proxy", model: "gpt-5" },
    options: MATH,
  })
  assert.equal(onProvider(body, ctx), undefined)
  assert.equal(body.max_tokens, 900)
})

test("max_tokens 不是数字时不改写", () => {
  const body = { model: "deepseek-flash", ...userMessage(400), max_tokens: "100" }
  const ctx = makeCtx({ options: MATH })
  assert.equal(onRequest(body, ctx), undefined)
  assert.equal(body.max_tokens, "100")
})

test("畸形请求体失败开放，不抛异常", () => {
  for (const body of [null, undefined, "text", 42, [], {}]) {
    const ctx = makeCtx({ options: MATH })
    assert.doesNotThrow(() => onRequest(body, ctx))
    assert.doesNotThrow(() => onProvider(body, ctx))
  }
})

test("没有 ctx.options 时使用文档默认值", () => {
  const body = { model: "deepseek-flash", ...userMessage(10), max_tokens: 500000 }
  const ctx = makeCtx({ options: undefined })
  assert.equal(onRequest(body, ctx), body)
  assert.equal(body.max_tokens, 393216)
})
