/**
 * Term hygiene: what may be used as a search word or a chapter title.
 *
 * Bilibili search is relevance-ranked, not exact, so a generic phrase like
 * 「主要内容」 always returns something — usually an English or 语文 summary
 * video. The fix is to never search with, or name a chapter after, a phrase that
 * carries no subject matter.
 */
import { tokenize } from './search.js'

/** Phrases that look like content but say nothing about the subject. */
export const GENERIC_TERMS = new Set([
  '主要内容',
  '本章小结',
  '本章要点',
  '内容提要',
  '本章内容',
  '概述',
  '引言',
  '前言',
  '目录',
  '习题',
  '思考题',
  '作业',
  '课程介绍',
  '学习目标',
  '教学目标',
  '参考文献',
  '小结',
  '总结',
  '回顾',
  '复习',
  'qa',
  'q&a',
  '谢谢',
  '正文',
  '本章',
  '第一节',
  '第二部分',
])

const NUMBERING = /^(?:第\s*[一二三四五六七八九十百\d]+\s*[章节讲部篇]|[（(]\s*[一二三四五六七八九十\d]+\s*[)）]|[一二三四五六七八九十]+\s*[、.．]|\d+(?:[.．]\d+)*\s*[、.．)）]?)\s*/

/** Remove "四、" "3." "2.2." "第 3 章" "（一）" "(1)" prefixes. */
export function stripNumbering(text) {
  let value = String(text || '').trim()
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(NUMBERING, '').trim()
    if (next === value) break
    value = next
  }
  return value
}

const keyOf = (text) => String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

export function isGeneric(text) {
  const key = keyOf(text)
  return !key || GENERIC_TERMS.has(key)
}

/**
 * @returns {string} a searchable title, or '' when nothing is left.
 */
export function cleanTerm(text) {
  let value = stripNumbering(text)
  value = value
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s:：·\-–—、]+|[\s:：·\-–—、]+$/g, '')
    .trim()
  if (!value) return ''
  if (isGeneric(value)) return ''
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (value.match(/[a-z]{2,}/gi) || []).length
  // one CJK char or a lone letter is not a term
  if (cjk < 2 && latin < 1) return ''
  return value.length > 40 ? value.slice(0, 40) : value
}

export function cleanKeywords(list, limit = 4) {
  const out = []
  const seen = new Set()
  for (const raw of list || []) {
    const term = cleanTerm(typeof raw === 'string' ? raw : raw?.text)
    if (!term) continue
    const key = keyOf(term)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= limit) break
  }
  return out
}

/**
 * TF-IDF over the course's own chapters; the fallback summary uses this when the
 * model is unavailable, so keywords still describe the chapter instead of
 * echoing a page header.
 *
 * @param {string[]} documents one string per chapter
 * @returns {string[]} terms, best first
 */
export function tfidfTerms(documents, { topK = 30 } = {}) {
  const docs = (documents || []).filter(Boolean)
  if (!docs.length) return []
  const df = new Map()
  const tf = docs.map((doc) => {
    const counts = new Map()
    for (const token of tokenize(doc)) counts.set(token, (counts.get(token) || 0) + 1)
    for (const token of counts.keys()) df.set(token, (df.get(token) || 0) + 1)
    return counts
  })
  const scored = new Map()
  docs.forEach((doc, i) => {
    for (const [token, count] of tf[i]) {
      if (token.length < 2) continue
      if (GENERIC_TERMS.has(keyOf(token))) continue
      if (!/[\u4e00-\u9fff]|[a-z]{2,}/i.test(token)) continue
      const idf = Math.log(1 + docs.length / (df.get(token) || 1))
      scored.set(token, (scored.get(token) || 0) + count * idf)
    }
  })
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, topK)
}

/** Best 2-3 terms for one chapter, preferring ones absent from its own title. */
export function topTermsFor(text, corpus, count = 3) {
  const terms = tfidfTerms([text, ...(corpus || [])], { topK: 60 })
  return terms
    .filter((term) => !String(text || '').slice(0, 40).includes(term))
    .slice(0, count)
}
