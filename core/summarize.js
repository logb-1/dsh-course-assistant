/**
 * Chapter summaries via the Host `llm` service.
 *
 * Token discipline: the text sent per chapter is capped locally, the prompt is
 * one fixed template, the reply is a fixed JSON object, and the course summary
 * only sees earlier key_points — never the source text again.
 */
import { anchorQuery } from './domain.js'
import { normalizeForMatch, pointText } from './verify.js'
import { splitSections } from './sections.js'
import { parseJsonObject } from './json-repair.js'
import {
  FRAMEWORK_SYSTEM,
  REVIEW_MAX_CHARS,
  REVIEW_MAX_TOKENS,
  REVIEW_SYSTEM,
  buildReviewPrompt,
  parseReview,
  reviewKeyPoints,
  reviewPitfalls,
} from './review.js'
export const CHAPTER_PROMPT_VERSION = 6
const MAX_CHAPTER_CHARS = 3600

const SYSTEM = [
  '你是大学课程助教。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
  'JSON 结构：{"title": string, "chapter": string, "key_points": [{"text": string, "evidence": string}], "important": string[], "difficult": string[], "keywords": string[]}',
  'title 是本章的标题：4-24 字，用课件里的术语，不要带「第 N 章」编号、不要用「主要内容」「本章」这类通用词；它会被直接放进目录。',
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

function parseJson(raw) {
  const value = parseJsonObject(raw)
  if (!value) return null
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
    // a sectioned chapter can legitimately produce more than six points; the
    // prompt asks for one per section, capped at 12
    .slice(0, 12)
  return {
    title: String(value.title || value.chapter_title || '').trim(),
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

export function selectPassages(text, max = MAX_CHAPTER_CHARS, options = {}) {
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
  // offsets let a passage be attributed to a section
  let cursor = 0
  const offsets = passages.map((passage) => {
    const at = body.indexOf(passage, cursor)
    cursor = at >= 0 ? at + passage.length : cursor
    return at >= 0 ? at : cursor
  })
  const sections = Array.isArray(options.sections) ? options.sections : []
  const sectionIndexAt = (offset) => {
    let found = 0
    for (let i = 0; i < sections.length; i += 1) {
      if (sections[i].from <= offset) found = i
      else break
    }
    return found
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
  // Every section gets one slot first: a section with few repeated terms used to
  // score near zero and vanish from the summary entirely.
  if (sections.length > 1) {
    const best = new Map()
    for (const item of scored) {
      const at = sectionIndexAt(offsets[item.index])
      const previous = best.get(at)
      if (!previous || item.score > previous.score) best.set(at, item)
    }
    const budget = Math.max(600, Math.floor(max * 0.55))
    for (const item of [...best.values()].sort((a, b) => a.index - b.index)) {
      if (used >= budget) break
      const cost = item.passage.length + 2
      if (used + cost > max) continue
      chosen.push(item)
      picked.add(item.index)
      used += cost
    }
  }
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

function bigramSet(text) {
  const clean = normalizeForMatch(text)
  const out = new Set()
  for (let i = 0; i + 2 <= clean.length; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

function similar(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const left = bigramSet(a)
  const right = bigramSet(b)
  if (!left.size || !right.size) return false
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / Math.min(left.size, right.size) >= 0.7
}

/**
 * Merge per-section summaries: same chapter, but each call only saw one section,
 * so duplicates are real (the same definition can appear twice) and the merged
 * list must stay readable.
 */
export function mergeSectionSummaries(parts, { chapter, sourceChars = 0, sections = 0 } = {}) {
  const points = []
  for (const part of parts) {
    for (const point of part.key_points || []) {
      const text = String(point.text || '').trim()
      if (!text) continue
      const key = normalizeForMatch(text)
      if (points.some((existing) => similar(normalizeForMatch(existing.text), key))) continue
      points.push({ text, evidence: String(point.evidence || '').trim() })
    }
  }
  const union = (field) => {
    const seen = new Set()
    const out = []
    for (const part of parts) {
      for (const value of part[field] || []) {
        const key = normalizeForMatch(value)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(value)
      }
    }
    return out
  }
  return {
    chapter: chapter?.title || parts[0]?.chapter || '',
    key_points: points.slice(0, 12),
    important: union('important').slice(0, 4),
    difficult: union('difficult').slice(0, 4),
    keywords: union('keywords').slice(0, 5),
    unsupported_idx: null,
    partial: points.length === 0,
    sourceChars,
    keptChars: parts.reduce((n, part) => n + (part.keptChars || 0), 0),
    sectionCalls: parts.length,
    sectionTotal: sections,
  }
}

export function truncate(text, max = MAX_CHAPTER_CHARS, options = {}) {
  return selectPassages(text, max, options)
}

export async function summarizeChapter({ llm, provider, model, courseTitle, chapter, text, outline, domain, signal, maxTokens, passageRatio = 1, coverageMode = 'auto' }) {
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
  // Split first, then select: every section keeps at least one passage even when
  // its vocabulary is too plain to win on TF-IDF.
  const sections = splitSections(chapter, source)

  // thorough: one model call per (largest) section, merged locally. A single
  // 3.6k window makes the model choose which sections to skip; this way every
  // section is read by something, at the cost of up to four calls.
  if (coverageMode === 'thorough' && sections.length >= 2 && source.length > MAX_CHAPTER_CHARS) {
    const picks = [...sections].sort((a, b) => b.chars - a.chars).slice(0, 4)
    const parts = []
    for (const section of picks) {
      try {
        parts.push(
          await summarizeChapter({
            llm,
            provider,
            model,
            courseTitle,
            chapter: { ...chapter, title: section.title, subs: [] },
            text: section.text,
            outline,
            domain,
            signal,
            maxTokens,
            coverageMode: 'auto',
          }),
        )
      } catch {}
    }
    if (parts.length) return mergeSectionSummaries(parts, { chapter, sourceChars: source.length, sections: sections.length })
  }

  const body = truncate(source, Math.max(600, Math.round(MAX_CHAPTER_CHARS * passageRatio)), { sections })
  const prompt = [
    `课程名：${courseTitle}`,
    domain ? `课程领域：${domain.name}（本章 keywords 必须以「${domain.name}」开头）` : '',
    outlineLine,
    `本章：第 ${chapter.index} 章 ${chapter.title}`,
    sections.length > 1 && coverageMode !== 'fast'
      ? `本章分 ${sections.length} 个小节：${sections
          .slice(0, 12)
          .map((s) => s.title)
          .join(' / ')}。请为每个小节至少给 1 条要点（总数 3-12 条），没有考点的小节在 skipped_sections 里列名。`
      : chapter.subs?.length
        ? `本节标题：${chapter.subs.slice(0, 8).join(' / ')}`
        : '',
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
 * Review-document variant of summarizeChapter (reportStyle: 'review').
 *
 * Same transport and retries, different contract: the model returns modules,
 * knowledge points, examples and exercises instead of six bullets. The legacy
 * fields are derived locally from the review, so evidence checks, coverage audit,
 * keyword extraction and the Bilibili search keep working unchanged.
 *
 * `pageText` is the chapter with 【第 N 页】 markers in front of every page: it is
 * what lets the model cite a real page instead of guessing one.
 */
export async function summarizeChapterReview({
  llm,
  provider,
  model,
  courseTitle,
  chapter,
  text,
  pageText,
  outline,
  domain,
  signal,
  maxTokens,
  pageRange,
}) {
  const source = String(text ?? chapter.text ?? '')
  const marked = String(pageText || '') || source
  const sections = splitSections(chapter, source)
  const body = truncate(marked, REVIEW_MAX_CHARS, { sections })
  const prompt = buildReviewPrompt({ courseTitle, chapter, body, sections, outline, domain, pageRange })
  const raw = await collect(
    llm.stream({
      provider,
      model,
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      // a retry may only raise the budget: the brief ladder's 3600 would
      // truncate every review answer
      maxTokens: Math.max(Number(maxTokens) || 0, REVIEW_MAX_TOKENS),
      temperature: 0.25,
      signal,
    }),
  )
  const review = parseReview(raw, { chapter, pages: chapter.pages })
  if (!review) throw new Error(`模型未返回可解析的复习资料 JSON（前 120 字：${String(raw).slice(0, 120)}）`)
  const keywords = anchorKeywords(filterKeywords(review.keywords), domain)
  return {
    chapter: review.chapter || chapter.title,
    style: 'review',
    review,
    key_points: reviewKeyPoints(review),
    important: (review.summary.remember || []).slice(0, 4),
    difficult: reviewPitfalls(review),
    keywords: keywords.length ? keywords : anchorKeywords(filterKeywords([chapter.title]), domain),
    unsupported_idx: null,
    sourceChars: source.length,
    keptChars: body.length,
  }
}

/**
 * Course-level review framing: overall theme, learning goals and the summary.
 * One extra call for the whole course; failure falls back to the brief path.
 */
export async function summarizeCourseReview({ llm, provider, model, courseTitle, chapters, signal }) {
  const lines = chapters.map((c) => {
    const names = c.summary?.review
      ? c.summary.review.modules.flatMap((m) => m.points.map((p) => p.name)).slice(0, 8).join('、')
      : (c.summary?.key_points || []).map(pointText).join('；').slice(0, 120)
    return `第 ${c.index} 章 ${c.title}${names ? `：${names}` : ''}`
  })
  const prompt = [`课程名：${courseTitle}`, '章节目录与各章要点：', ...lines, '', '请按系统提示的 JSON 结构输出课程复习框架。'].join('\n')
  const raw = await collect(
    llm.stream({
      provider,
      model,
      system: FRAMEWORK_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 2400,
      temperature: 0.3,
      signal,
    }),
  )
  const value = parseJsonObject(raw)
  if (!value) throw new Error('复习框架 JSON 解析失败')
  const goals = (Array.isArray(value.goals) ? value.goals : []).map((g) => String(g || '').trim()).filter(Boolean).slice(0, 6)
  return {
    theme: String(value.theme || '').trim().slice(0, 200),
    goals,
    summary: String(value.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400),
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
}const GENERIC_KEYWORD = /^(摘要|一页摘要|目录|参考文献|附录|小结|总结|概述|引言|前言|致谢|封面|标题页|正文|本章|全文)$/

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
