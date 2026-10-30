/**
 * Coverage audit: did every section of a chapter produce at least one key point?
 *
 * Confidence (`verify.js`) answers "is this quote real"; coverage answers "did we
 * miss half the chapter". They are different failures: a chapter can be perfectly
 * faithful and still silently drop three sections.
 */
import { normalizeForMatch } from './verify.js'
import { splitSections } from './sections.js'

/**
 * @param {{ chapter: object, text: string, summary: object|null }} input
 * @returns {{ total:number, covered:number, ratio:number, missing:string[] }}
 */
export function auditCoverage({ chapter, text, summary }) {
  const sections = splitSections(chapter, text)
  if (sections.length <= 1) return { total: sections.length, covered: sections.length, ratio: 1, missing: [] }
  const points = Array.isArray(summary?.key_points) ? summary.key_points : []
  if (!points.length) {
    return { total: sections.length, covered: 0, ratio: 0, missing: sections.map((s) => s.title) }
  }
  const pointText = points.map((p) => normalizeForMatch(`${p.text || ''} ${p.evidence || ''}`)).join('\n')
  const missing = []
  const covered = []
  for (const section of sections) {
    const title = normalizeForMatch(section.title).slice(0, 10)
    const body = normalizeForMatch(section.text)
    const byTitle = title.length >= 3 && pointText.includes(title)
    // a point that quotes this section is the strongest form of coverage
    const byQuote = points.some((point) => {
      const evidence = normalizeForMatch(point.evidence || '')
      return evidence.length >= 6 && body.includes(evidence)
    })
    if (byTitle || byQuote) covered.push(section.title)
    else missing.push(section.title)
  }
  return {
    total: sections.length,
    covered: covered.length,
    ratio: sections.length ? covered.length / sections.length : 1,
    missing,
  }
}

/**
 * Roll per-chapter audits into one course-level number.
 * @param {Array<{ index:number, title:string, coverage: object|null }>} chapters
 */
export function summarizeCoverage(chapters) {
  let total = 0
  let covered = 0
  const missing = []
  for (const chapter of chapters || []) {
    const audit = chapter?.coverage
    if (!audit || !audit.total) continue
    total += audit.total
    covered += audit.covered
    for (const title of audit.missing || []) missing.push({ chapter: chapter.index, title })
  }
  return { total, covered, ratio: total ? covered / total : 1, missing }
}

/** One line for the report header. */
export function describeCoverage(coverage) {
  if (!coverage?.total) return ''
  const percent = Math.round(coverage.ratio * 100)
  const head = `要点覆盖：${coverage.covered}/${coverage.total} 节（${percent}%）`
  if (!coverage.missing.length) return head
  const shown = coverage.missing.slice(0, 4).map((item) => `第${item.chapter}章「${item.title}」`)
  const more = coverage.missing.length > 4 ? ` 等 ${coverage.missing.length} 节` : ''
  return `${head}；未覆盖：${shown.join('、')}${more}`
}
