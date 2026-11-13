/**
 * Host-free `llm` service for the web build.
 *
 * Inside DeepSeek Harness the pipeline reaches the model through the Host's
 * `llm` service (`index.js#resolveLlm`), which streams `{type:'text-delta'}`
 * chunks and ends with `{type:'finish', reason}`. The web worker has no Host,
 * so this module re-implements the same tiny interface on top of any
 * OpenAI-compatible `/chat/completions` endpoint (DeepSeek, OpenAI, vLLM,
 * Ollama, …). Everything above it — prompts, JSON repair, retries — stays
 * untouched.
 *
 * Env fallbacks (used by `bin/run-job.mjs`):
 *   LLM_BASE_URL  default https://api.deepseek.com/v1
 *   LLM_API_KEY   required (also accepts DEEPSEEK_API_KEY)
 *   LLM_MODEL     default deepseek-chat
 *   LLM_PROVIDER  default deepseek
 */

const DEFAULT_BASE = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Turn the Host's content-part array into an OpenAI message string. */
export function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text || '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** Read one SSE payload into `{text, done, finishReason, usage}`. */
export function parseSseChunk(payload) {
  if (!payload || payload === '[DONE]') return { done: payload === '[DONE]' }
  let data
  try {
    data = JSON.parse(payload)
  } catch {
    return {}
  }
  const choice = data.choices?.[0]
  const text = choice?.delta?.content
  const finishReason = choice?.finish_reason || null
  return {
    text: typeof text === 'string' ? text : '',
    finishReason,
    usage: data.usage || null,
  }
}

function friendlyError(status, body) {
  let detail = ''
  try {
    detail = JSON.parse(body)?.error?.message || ''
  } catch {}
  if (!detail) detail = String(body || '').replace(/\s+/g, ' ').slice(0, 300)
  const hint =
    status === 401 || status === 403
      ? '（检查 LLM_API_KEY 是否有效、是否过期）'
      : status === 402
        ? '（账户余额不足）'
        : status === 429
          ? '（触发了限流，稍后重试或降低并发）'
          : ''
  return `模型接口 ${status}${hint}：${detail || '无响应内容'}`
}

/**
 * @param {object} options
 * @param {string} options.baseUrl   OpenAI-compatible root, e.g. https://api.deepseek.com/v1
 * @param {string} options.apiKey
 * @param {string} [options.provider] label used in cache keys / report headers
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {Record<string,string>} [options.headers]
 */
export function createHttpLlm({
  baseUrl = process.env.LLM_BASE_URL || DEFAULT_BASE,
  apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  provider = process.env.LLM_PROVIDER || 'deepseek',
  model = process.env.LLM_MODEL || DEFAULT_MODEL,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  if (!apiKey) throw new Error('缺少模型 API key：请设置环境变量 LLM_API_KEY（或 DEEPSEEK_API_KEY）')
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch，无法调用模型接口')

  const root = String(baseUrl).replace(/\/+$/, '')
  const endpoint = /\/chat\/completions$/.test(root) ? root : `${root}/chat/completions`

  async function* stream(options = {}) {
    const messages = []
    if (options.system) messages.push({ role: 'system', content: String(options.system) })
    for (const message of options.messages || []) {
      messages.push({ role: message.role || 'user', content: flattenContent(message.content) })
    }
    const body = {
      model: options.model || model,
      messages,
      stream: true,
      temperature: options.temperature ?? 0.2,
      max_tokens: Number(options.maxTokens) || 2600,
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...headers,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('模型调用超时或已取消')
      throw new Error(`模型接口不可达：${error?.message || error}`)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(friendlyError(response.status, text))
    }
    if (!response.body) throw new Error('模型接口没有返回流式内容')

    const decoder = new TextDecoder()
    let buffer = ''
    let finishReason = null
    let usage = null
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const parsed = parseSseChunk(line.slice(5).trim())
        if (parsed.done) {
          finishReason = finishReason || 'stop'
          continue
        }
        if (parsed.text) yield { type: 'text-delta', text: parsed.text }
        if (parsed.finishReason) finishReason = parsed.finishReason
        if (parsed.usage) usage = parsed.usage
      }
    }
    yield {
      type: 'finish',
      reason: { kind: finishReason === 'length' ? 'length' : 'stop' },
      usage,
    }
  }

  return { provider, model, endpoint, stream }
}
