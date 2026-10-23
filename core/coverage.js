/**
 * Syllabus coverage: which of the exam-outline points a report actually covers.
 *
 * Pure text matching (tokens shared with the BM25 search), no model call: the
 * output is a per-chapter hit list plus the points nothing covered, which is the
 * useful signal for revision ("这一章考了 8 个点，你只总结了 5 个").
 */
import { tokenize } from './search.js'

const MIN_ITEM_CHARS = 6

/** Turn a syllabus document into atomic points. */
export function parseSyllabus(text, { ignore = [] } = {}) {
  const skipped = new Set(ignore.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•·\d.、)（(]+/, '').trim())
    .filter(Boolean)
  const items = []
  for (const line of lines) {
    if (/^(#|第[一二三四五六七八九十\d]+[章节]|chapter|appendix|附录)/i.test(line) && line.length < 12) continue
    if (skipped.has(line.toLowerCase())) continue
    const parts = line.length > 60 ? line.split(/[；;。]/).map((s) => s.trim()) : [line]
    for (const part of parts) {
      if (part.length < MIN_ITEM_CHARS) continue
      if (skipped.has(part.toLowerCase())) continue
      items.push(part.slice(0, 120))
    }
  }
  return [...new Set(items)]
}

function chapterProfile(chapter) {
  const summary = chapter.summary || {}
  const texts = [
    chapter.title,
    ...(summary.keywords || []),
    ...(summary.key_points || []).map((p) => (typeof p === 'string' ? p : p.text)),
    ...(summary.important || []),
    ...(summary.difficult || []),
  ]
  return new Set(tokenize(texts.filter(Boolean).join(' ')))
}

function countHits(profile, tokens) {
  let hit = 0
  for (const token of tokens) if (profile.tokens.has(token)) hit += 1
  return hit
}

/**
 * @param {Array} chapters job chapters
 * @param {string[]} items syllabus points
 * @param {{threshold?:number}} [options]
 * @returns {{total:number, covered:number, ratio:number, uncovered:string[],
 *            byChapter:Array<{index:number,title:string,covered:string[],ratio:number}>,
 *            unmatched:Array<{item:string,best:number}>}}
 */
export function coverage(chapters, items, { threshold = 0.35 } = {}) {
  const profiles = (chapters || []).map((chapter) => ({ chapter, tokens: chapterProfile(chapter) }))
  const byChapter = profiles.map(({ chapter }) => ({ index: chapter.index, title: chapter.title, covered: [], ratio: 0 }))
  const uncovered = []
  const unmatched = []

  for (const item of items || []) {
    const tokens = new Set(tokenize(item))
    if (!tokens.size) continue
    let best = -1
    let bestScore = 0
    profiles.forEach((profile, i) => {
      let hit = 0
      for (const token of tokens) if (profile.tokens.has(token)) hit += 1
      const score = hit / tokens.size
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    })
    // one shared word ("均衡") is not coverage: require at least two matches
    if (best >= 0 && bestScore >= threshold && tokens.size > 0 && countHits(profiles[best], tokens) >= 2) {
      byChapter[best].covered.push(item)
    } else {
      uncovered.push(item)
      unmatched.push({ item, best: Math.round(bestScore * 100) / 100 })
    }
  }

  const total = (items || []).length
  for (const row of byChapter) row.ratio = total ? Math.round((row.covered.length / total) * 100) / 100 : 0
  const covered = total - uncovered.length
  return {
    total,
    covered,
    ratio: total ? Math.round((covered / total) * 100) / 100 : 0,
    uncovered,
    byChapter,
    unmatched,
  }
}
