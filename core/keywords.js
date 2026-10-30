/**
 * Keyword capture: the model is one source of terms, not the only one.
 *
 * The old path took whatever keywords the model returned, cleaned out generic
 * phrases and stopped there. If the model answered 「主要内容」 or only one term,
 * the chapter had nothing searchable. This module fuses four sources and lets the
 * cheap local ones fill the gaps:
 *
 *   model    the chapter prompt's keywords            weight 3
 *   heading   chapter title and sub-headings           2.5
 *   corpus    TF-IDF terms that occur in this chapter  2 (+0.3 when the term also
 *             appears in other chapters, i.e. course vocabulary)
 *   acronym   IEEE754 / ASCII / x86-64                 1.5
 *
 * Everything passes `cleanTerm`, so generic words and numbering never survive.
 */
import { cleanKeywords, cleanTerm, tfidfTerms } from './terms.js'

const MODEL_WEIGHT = 3
const HEADING_WEIGHT = 2.5
const LOCAL_WEIGHT = 2
const LOCAL_BOOST = 0.3
const ACRONYM_WEIGHT = 2.6

/** Function words that TF-IDF happily ranks and nobody searches for. */
const LOCAL_STOP = new Set([
  '不同', '表示', '包括', '可以', '使用', '进行', '通过', '以及', '因此', '其中',
  '我们', '这些', '那些', '一个', '一样', '就是', '还是', '而且', '但是', '如果',
  '时候', '问题', '情况', '方面', '内容', '部分', '方式', '方法', '结果', '过程',
])

const keyOf = (text) => String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

/** Acronyms and versioned names survive translation; the model often drops them. */
function acronymsOf(text) {
  const out = new Set()
  for (const match of String(text || '').matchAll(/\b(?:[A-Z]{2,}[0-9]*|x86(?:-64)?|[A-Za-z]+\d{2,})\b/g)) {
    if (match[0].length >= 2) out.add(match[0])
  }
  return [...out]
}

function headingTerms(chapter) {
  const raw = [chapter?.title, ...(chapter?.subs || [])].filter(Boolean)
  const terms = []
  for (const line of raw) {
    // "3.1 程序转换概述：从 C 到汇编" → two candidates
    for (const part of String(line).split(/[：:、，,——/|]+/)) {
      const term = cleanTerm(part)
      if (term) terms.push(term)
    }
  }
  return terms
}

/**
 * @param {{ chapter: object, text: string, corpus?: string[], modelKeywords?: string[], limit?: number }} input
 * @returns {Array<{ term: string, score: number, source: string }>}
 */
export function extractKeywords({ chapter, text, corpus = [], modelKeywords = [], limit = 4 } = {}) {
  const body = String(text || '')
  const candidates = []
  const push = (term, score, source) => {
    const value = cleanTerm(term)
    if (!value) return
    candidates.push({ term: value, score, source })
  }

  for (const term of cleanKeywords(modelKeywords, 6)) push(term, MODEL_WEIGHT, 'model')
  for (const term of headingTerms(chapter).slice(0, 8)) push(term, HEADING_WEIGHT, 'heading')

  const local = tfidfTerms([body, ...(corpus || [])], { topK: 60 })
  for (const term of local) {
    if (!body.includes(term)) continue // must actually be in this chapter
    const shared = (corpus || []).filter((doc) => String(doc || '').includes(term)).length
    if (LOCAL_STOP.has(term)) continue
    push(term, LOCAL_WEIGHT + (shared >= 2 ? LOCAL_BOOST : 0), 'corpus')
  }
  // acronyms bypass cleanTerm: "x86-64" has a one-letter latin run and would be
  // dropped by the generic length rule, yet it is exactly the kind of term a
  // Bilibili search needs
  for (const term of acronymsOf(body)) candidates.push({ term, score: ACRONYM_WEIGHT, source: 'acronym' })

  // one entry per normalised key, best score wins, model phrasing preferred
  const byKey = new Map()
  for (const item of candidates) {
    const key = keyOf(item.term)
    if (!key || key.length < 2) continue
    const previous = byKey.get(key)
    if (!previous || item.score > previous.score) byKey.set(key, item)
  }
  const ranked = [...byKey.values()].sort(
    (a, b) => b.score - a.score || (b.term.length > a.term.length ? 1 : -1),
  )

  // drop a term that another chosen term already contains: 「计算机系统 补码」 makes
  // a separate 「补码」 redundant in the same chapter
  // Diversity cap: three acronyms from one slide is a worse keyword list than two
  // acronyms plus the chapter heading. The model's own terms are not capped.
  const chosen = []
  const perSource = new Map()
  for (const item of ranked) {
    if (chosen.length >= limit) break
    const key = keyOf(item.term)
    if (chosen.some((other) => keyOf(other.term).includes(key) || key.includes(keyOf(other.term)))) continue
    const used = perSource.get(item.source) || 0
    if (item.source !== 'model' && used >= 2) continue
    perSource.set(item.source, used + 1)
    chosen.push(item)
  }

  // a chapter still needs something searchable: fall back to the plain headings
  if (chosen.length < 2) {
    for (const term of headingTerms(chapter)) {
      const key = keyOf(term)
      if (!key || chosen.some((other) => keyOf(other.term).includes(key))) continue
      chosen.push({ term, score: HEADING_WEIGHT, source: 'heading' })
      if (chosen.length >= 2) break
    }
  }
  return chosen.slice(0, limit)
}

/** Convenience wrapper for the pipeline: terms only. */
export function captureKeywords(input) {
  return extractKeywords(input).map((item) => item.term)
}
