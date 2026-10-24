/**
 * Chapter summaries via the Host `llm` service.
 *
 * Token discipline: the text sent per chapter is capped locally, the prompt is
 * one fixed template, the reply is a fixed JSON object, and the course summary
 * only sees earlier key_points — never the source text again.
 */
import { anchorQuery } from './domain.js'
import { pointText } from './verify.js'
export const CHAPTER_PROMPT_VERSION = 5
const MAX_CHAPTER_CHARS = 3600

const SYSTEM = [
  '你是大学课程助教。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
  'JSON 结构：{"chapter": string, "key_points": [{"text": string, "evidence": string}], "important": string[], "difficult": string[], "keywords": string[]}',
  '要求：key_points 3-6 条，每条不超过 40 字，必须来自给定原文，不要编造案例；important/difficult 各 0-2 条；',
  'evidence 必须是原文里「连续出现」的片段（至少 10 个字），逐字照抄，不要改写、不要加省略号、不要拼接；',
  '找不到原文片段支撑的要点就不要写，宁少写几条；',
  '原文信息不足时（例如整页只有图），就用原文里实际出现的词写短句，不要用通用教科书理论补全。',
  'keywords 2-4 个，用「学科领域 + 具体概念」的组合词，直接在 B 站能搜到该章网课（例如「计算机系统 缓存 命中率」「国际贸易 政策评估」），不要用「论证逻辑」这类通用方法论词。',
  '如果给出了「课程领域」，keywords 必须以该领域词开头（例如 C++ 课就写「C++ 异常处理」），严禁写成其它语言（Python/Java 等）。',
].join('\n')

const SUMMARY_SYSTEM = '你是大学课程助教。用中文写一段不超过 300 字的全课程总结，不要标题、不要列表、不要 Markdown。'

function collect(stream) {
  return (async () => {
    let text = ''
    let finish = null
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish && finish.kind === 'error') {
      throw new Error(finish.failure?.message || '模型调用失败')
    }
    if (finish && finish.kind === 'aborted') throw new Error('模型调用已中断')
    if (!text.trim()) throw new Error('模型没有返回内容')
    return text
  })()
}

function tryParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** Close a JSON document truncated by maxTokens so partial summaries survive. */
function repairJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  const s = text.slice(start)
  const stack = []
  let inStr = false
  let esc = false
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    out += c
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') {
      stack.pop()
      if (!stack.length) break
    }
  }
  if (inStr) out += '"'
  const close = (src) => {
    let tail = ''
    for (let i = stack.length - 1; i >= 0; i--) tail += stack[i] === '{' ? '}' : ']'
    return src + tail
  }
  const direct = tryParse(close(out.replace(/[,\s]+$/, '')))
  if (direct) return direct
  // still truncated inside a token (e.g. `"key_po`): drop tokens from the end
  for (let cut = out.length - 1; cut > 20; cut -= 8) {
    const slice = out.slice(0, cut).replace(/[,\s]+$/, '')
    const parsed = tryParse(close(slice))
    if (parsed) return parsed
  }
  return null
}

function parseJson(raw) {
  const cleaned = String(raw)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  let value = tryParse(cleaned)
  if (!value) {
    const from = cleaned.indexOf('{')
    const to = cleaned.lastIndexOf('}')
    if (from >= 0 && to > from) value = tryParse(cleaned.slice(from, to + 1))
  }
  if (!value) value = repairJson(cleaned)
  if (!value || typeof value !== 'object') return null
  const arr = (v, max) =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[；;\n]/) : [])
      .map((x) => String(x || '').replace(/^[-*•\d.、\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, max)
  // key_points carry a mandatory quote; legacy caches may still hold plain strings
  const points = (Array.isArray(value.key_points ?? value.keyPoints ?? value.points) ? value.key_points ?? value.keyPoints ?? value.points : [])
    .map((p) => {
      if (p && typeof p === 'object') {
        return { text: String(p.text || p.point || '').trim(), evidence: String(p.evidence || p.quote || '').trim() }
      }
      return { text: String(p || '').replace(/^[-*•\d.、\s]+/, '').trim(), evidence: '' }
    })
    .filter((p) => p.text)
    .slice(0, 8)
  return {
    chapter: String(value.chapter || ''),
    key_points: points.length ? points : arr(value.key_points ?? value.keyPoints ?? value.points, 8).map((text) => ({ text, evidence: '' })),
    important: arr(value.important ?? value.key ?? value.focus, 4),
    difficult: arr(value.difficult ?? value.hard ?? value.challenge, 4),
    keywords: arr(value.keywords ?? value.keyword ?? value.tags, 5),
    // read-only compatibility: older prompts asked the model to self-report
    unsupported_idx: Array.isArray(value.unsupported_idx)
      ? value.unsupported_idx
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 0 && n < 8)
      : null,
  }
}

/**
 * Long chapters used to be cut as "first 80% + last 18%", which hides the middle
 * (a 14k-char chapter showed ~3.6k and dropped ~10k entirely).
 *
 * Instead: split into passages, score them with TF-IDF over character bigrams
 * and greedily keep the most informative ones within the budget, then restore
 * document order. Zero extra model calls; pure local.
 */
function bigramsOf(text) {
  const clean = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')
  const out = []
  for (let i = 0; i + 2 <= clean.length; i += 1) out.push(clean.slice(i, i + 2))
  return out
}

function splitPassages(text) {
  const paras = String(text || '')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (paras.length >= 4) return paras
  const sentences = String(text || '')
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  return sentences.length >= 4 ? sentences : paras
}

export function selectPassages(text, max = MAX_CHAPTER_CHARS) {
  const body = String(text || '').trim()
  if (body.length <= max) return body
  const passages = splitPassages(body)
  if (passages.length < 4) {
    // nothing to choose from: keep both ends rather than losing everything
    const head = body.slice(0, Math.floor(max * 0.8))
    const tail = body.slice(-Math.floor(max * 0.18))
    return `${head}\n…（中间略）…\n${tail}`
  }
  const gramsOf = passages.map(bigramsOf)
  const df = new Map()
  const total = new Map()
  for (const grams of gramsOf) {
    const seen = new Set()
    for (const gram of grams) {
      total.set(gram, (total.get(gram) || 0) + 1)
      if (!seen.has(gram)) {
        seen.add(gram)
        df.set(gram, (df.get(gram) || 0) + 1)
      }
    }
  }
  // a term present in every passage carries no information (idf ≈ 0); a term
  // seen once is usually a number or a typo. Score only the middle band.
  const N = passages.length
  const usable = (gram) => {
    const f = df.get(gram) || 1
    return f >= 2 && f <= N * 0.8
  }
  const scored = passages.map((passage, index) => {
    const grams = gramsOf[index].filter(usable)
    if (!grams.length) return { passage, index, score: 0 }
    let sum = 0
    for (const gram of grams) {
      const tf = total.get(gram) || 1
      const idf = Math.log(1 + N / (df.get(gram) || 1))
      sum += tf * idf
    }
    return { passage, index, score: sum / grams.length }
  })
  const chosen = []
  const picked = new Set()
  let used = 0
  // the opening states what the chapter is about, the closing often summarises it
  for (const anchor of [scored[0], scored[scored.length - 1]]) {
    if (!anchor || picked.has(anchor.index)) continue
    const cost = anchor.passage.length + 2
    if (used + cost > max) continue
    chosen.push(anchor)
    picked.add(anchor.index)
    used += cost
  }
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (picked.has(item.index)) continue
    const cost = item.passage.length + 2
    if (used + cost > max) continue
    chosen.push(item)
    picked.add(item.index)
    used += cost
  }
  chosen.sort((a, b) => a.index - b.index)
  const text2 = chosen.map((c) => c.passage).join('\n\n')
  return chosen.length < passages.length ? `${text2}\n…（已按相关性节选 ${chosen.length}/${passages.length} 段）…` : text2
}

export function truncate(text, max = MAX_CHAPTER_CHARS) {
  return selectPassages(text, max)
}

export async function summarizeChapter({ llm, provider, model, courseTitle, chapter, text, outline, domain, signal, maxTokens, passageRatio = 1 }) {
  // `chapter` is metadata only: the body must be passed explicitly, otherwise the
  // model summarises a title and every evidence quote fails to match.
  const source = String(text ?? chapter.text ?? '')
  const outlineLine = outline?.length
    ? `全课程目录（只用于判断本章定位，不要复述）：${outline
        .slice(0, 24)
        .map((t, i) => `${i + 1}.${t}`)
        .join(' ')}`
    : ''
  // A retry can shrink the input as well as raise the budget: a long chapter is
  // what makes a reasoning model return nothing at all.
  const body = truncate(source, Math.max(600, Math.round(MAX_CHAPTER_CHARS * passageRatio)))
  const prompt = [
    `课程名：${courseTitle}`,
    domain ? `课程领域：${domain.name}（本章 keywords 必须以「${domain.name}」开头）` : '',
    outlineLine,
    `本章：第 ${chapter.index} 章 ${chapter.title}`,
    chapter.subs?.length ? `本节标题：${chapter.subs.slice(0, 8).join(' / ')}` : '',
    '以下是该章原文（已去页眉页脚）：',
    '"""',
    body,
    '"""',
    '请按系统提示的 JSON 结构输出。',
  ]
    .filter(Boolean)
    .join('\n')

  const raw = await collect(
    llm.stream({
      provider,
      model,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      // a retry raises this: reasoning models sometimes spend the whole budget
      // and return no text at all
      maxTokens: Number(maxTokens) || 2600,
      temperature: 0.2,
      signal,
    }),
  )
  const parsed = parseJson(raw)
  if (!parsed) {
    throw new Error(`模型未返回可解析 JSON（前 120 字：${raw.slice(0, 120)}）`)
  }
  // A truncated/empty reply is repaired into a valid but hollow object: fill the
  // holes locally instead of publishing "本章未提取到有效要点".
  if (!parsed.key_points.length) {
    const local = localSummary({ ...chapter, text: source })
    parsed.key_points = local.key_points
    if (!parsed.important.length) parsed.important = []
    if (!parsed.difficult.length) parsed.difficult = []
    parsed.partial = true
  }
  const keywords = anchorKeywords(filterKeywords(parsed.keywords), domain)
  return {
    ...parsed,
    chapter: parsed.chapter || chapter.title,
    keywords: keywords.length ? keywords : anchorKeywords(localSummary(chapter).keywords, domain),
    // observability: how much of the chapter actually reached the model
    sourceChars: source.length,
    keptChars: body.length,
  }
}

/**
 * The model sometimes names the wrong language ("Python 异常处理" for a C++
 * chapter). Replace the foreign language token rather than prefixing it, so the
 * report and the Bilibili query both carry the course domain.
 */
export function anchorKeywords(list, domain) {
  if (!domain) return list
  return list.map((raw) => anchorQuery(raw, domain)).filter(Boolean)
}

const GENERIC_KEYWORD = /^(摘要|一页摘要|目录|参考文献|附录|小结|总结|概述|引言|前言|致谢|封面|标题页|正文|本章|全文)$/

function filterKeywords(list) {
  return (list || [])
    .map((k) => String(k || '').trim())
    .filter((k) => k.length >= 2 && k.length <= 20 && !GENERIC_KEYWORD.test(k))
    .slice(0, 4)
}

export async function summarizeCourse({ llm, provider, model, courseTitle, chapters, signal }) {
  const lines = chapters.map(
    (c) => `第 ${c.index} 章 ${c.title}：${(c.summary?.key_points || []).map(pointText).join('；').slice(0, 160)}`,
  )
  const prompt = [`课程名：${courseTitle}`, '各章要点：', ...lines, '', '请写全课程总结（≤300 字，中文）。'].join('\n')
  const raw = await collect(
    llm.stream({
      provider,
      model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 2600,
      temperature: 0.3,
      signal,
    }),
  )
  return raw.replace(/\s+/g, ' ').trim().slice(0, 400)
}

/** Bounded concurrency, preserving input order. */
export async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

/** Offline fallback so a report still appears when the model is unavailable. */
export function localSummary(chapter) {
  const strip = (s) =>
    String(s)
      .replace(/^[\s>*#\-•·\d.、）)]+/, '')
      .replace(/\*\*|`|__/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim()
  const lines = String(chapter.text || '')
    .split(/\n+/)
    .map(strip)
    .filter((l) => l.length >= 8 && l.length <= 80)
    .filter((l) => !/^(https?:|!\[)/.test(l))
  const points = []
  for (const line of lines) {
    if (points.length >= 5) break
    if (!points.includes(line)) points.push(line)
  }
  const keywords = [...new Set((chapter.subs || []).map((s) => s.replace(/[：:（(].*$/, '')).filter((s) => s.length >= 2 && s.length <= 12))].slice(0, 3)
  // no short line survived the filter (one long paragraph, OCR text): fall back to
  // the first sentences so the chapter still gets要点 instead of only its title
  const sentences = String(chapter.text || '')
    .split(/[。；!?！？\n]+/)
    .map(strip)
    .filter((s) => s.length >= 10)
    .map((s) => s.slice(0, 60))
  const base = points.length ? points : sentences.length ? sentences.slice(0, 3) : [chapter.title]
  const picked = base.map((text) => ({ text, evidence: text }))
  return {
    chapter: chapter.title,
    // the line came from the source verbatim, so it doubles as its own quote
    key_points: picked,
    important: [],
    difficult: [],
    keywords: keywords.length ? keywords : [chapter.title],
    offline: true,
  }
}
