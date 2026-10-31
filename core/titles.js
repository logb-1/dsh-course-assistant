/**
 * Title hygiene for pages, chapters and the course itself.
 *
 * Every downstream feature reads these strings: the table of contents, the report
 * title and its filename, the Bilibili query (chapter titles are the weakest query
 * term), the mind map and the dashboard. The parsers, however, can only offer
 * *candidates* — a PDF text layer often starts a page with "8.0", a code line or
 * half a sentence, and a deck's title placeholder may be a breadcrumb repeated on
 * eight slides ("课程导读").
 *
 * So titles are scored, never trusted:
 *   • hard vetoes — pure numbers, code, truncated fragments, boilerplate;
 *   • soft penalties — repeated furniture, long Latin runs in a Chinese deck;
 *   • a placeholder title keeps a small bonus, so a good slide title still wins.
 *
 * Everything here is local and deterministic: no model call, and the result is
 * visible in `tools/try-outline.mjs`.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const CODE =
  /^\s*(?:\/\/|\/\*|#\s*(?:include|define)\b)|[{};=<>#]|\bprintf\s*\(|\bstd\s*::|\busing\s+namespace\b|\b(?:public|private|protected)\s*:|"\s*<<|\w+\s*\(|\w+\s*::\w+/
const BARE_NUMBER = /^[\d\s.·\-–—、()（）]+$/
const LEAD_PUNCT = /^[，,、：:；;）)】\]」』"'“”》]/
const TRUNC_TAIL = /[，,、：:；;（(【\[「『《"'“”]$/
const FRAGMENT_TAIL = /[的和与及或在是为对把被从向于]$/
const BOILERPLATE =
  /^(?:前言|序言|导言|使用说明|说明|目录|目\s*录|封面|标题页|正文|摘要|小结|总结|参考文献|附录|致谢|contents?|preface|index)$/i
/** A cover-page heading: real chapters are never called "前言与使用说明". */
const COVER_HEADING = /^(?:前言|序言|导言|使用说明|说明)(?:与|和|及|、)?(?:使用说明|说明|目录)?$/
/** An email address, URL or file name is contact data, never a title. */
const CONTACT = /@|https?:\/\/|www\.|\b[\w-]+\.(?:com|cn|org|net|edu|io)\b/i
const CHAPTER_PREFIX = /^\s*第\s*[一二三四五六七八九十百\d]+\s*[章节讲部]\s*[：:、.．\-–—]?\s*/

/** Count of CJK ideographs (used for every "is this Chinese enough" decision). */
export function countCJK(text) {
  return (String(text ?? '').match(CJK) || []).length
}

/** Strip what is never part of a title: slide numbers, bullets, annotations. */
export function cleanTitle(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  t = t.replace(/^(?:幻灯片|slide)\s*\d{1,4}\s*[:：.、\-–—]?\s*/i, '')
  t = t.replace(/^[★☆·•*\-–—\s]+/, '')
  // "第 3 章 xxx（PPT 共 360+ 页，投入 40% 时间）" → "第 3 章 xxx"
  t = t.replace(/[（(][^（）()]{0,40}(?:投入|时间|占比|PPT|ppt)[^（）()]{0,40}[）)]\s*$/, '')
  // the page-range suffix mergeSameTitle appends for duplicate titles
  t = t.replace(/[（(]\s*p?\d+\s*[–-]\s*\d+\s*[）)]\s*$/, '')
  t = t.trim()
  if (/^(?:第\s*\d{1,4}\s*页|page\s*\d{1,4}|\d{1,4})$/i.test(t)) return ''
  return t
}

/** "一、考情分析" → "考情分析" (for lists that add their own numbering). */
export function stripHeadingNumber(title) {
  return stripChapterPrefix(String(title ?? '').replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, ''))
}

/** "第 3 章 程序的转换" → "程序的转换" (for headings that add their own number). */
export function stripChapterPrefix(title) {
  const t = String(title ?? '').trim()
  return t.replace(CHAPTER_PREFIX, '').trim()
}

export function hasChapterPrefix(title) {
  return CHAPTER_PREFIX.test(String(title ?? ''))
}

const HARD_REASONS = new Set([
  'empty',
  'bare-number',
  'code',
  'lead-punct',
  'truncated',
  'too-long',
  'boilerplate',
  'too-short',
  'contact',
])

/**
 * @param {string} text candidate title (will be cleaned first)
 * @param {{repeat?:number, docCjkRatio?:number, placeholderSource?:boolean}} [context]
 * @returns {{score:number, reasons:string[]}}
 *   score 0 means "never use this"; >= 0.55 is a usable title.
 */
export function titleScore(text, context = {}) {
  const t = cleanTitle(text)
  const reasons = []
  if (!t) return { score: 0, reasons: ['empty'] }
  if (BARE_NUMBER.test(t)) reasons.push('bare-number')
  if (CODE.test(t)) reasons.push('code')
  if (LEAD_PUNCT.test(t)) reasons.push('lead-punct')
  if (TRUNC_TAIL.test(t)) reasons.push('truncated')
  if (t.length > 40) reasons.push('too-long')
  if (CONTACT.test(t)) reasons.push('contact')
  if (BOILERPLATE.test(t) || COVER_HEADING.test(t)) reasons.push('boilerplate')
  const cjk = countCJK(t)
  const latinWord = /[A-Za-z]{3,}/.test(t)
  if (cjk < 3 && !latinWord) reasons.push('too-short')
  if (reasons.some((reason) => HARD_REASONS.has(reason))) return { score: 0, reasons }

  let score = 0.9
  if (cjk >= 4) score += 0.05
  if (t.length >= 6 && t.length <= 26) score += 0.05
  if (context.placeholderSource) score += 0.1
  const repeat = Number(context.repeat) || 0
  // a line repeated on many pages is furniture (breadcrumb / running head), not a title
  if (repeat >= 3) score -= Math.min(0.8, 0.12 * repeat)
  // in a Chinese deck a long all-Latin line is usually code or a citation, not a heading
  if ((Number(context.docCjkRatio) || 0) >= 0.05 && cjk === 0) score -= t.length > 8 ? 0.55 : 0.45
  // a heading almost never carries a full-width comma: that is a wrapped sentence
  if (/[，,]/.test(t)) score -= 0.55
  // long lines are sentences or bullets, not headings
  if (t.length > 24) score -= 0.2
  if (FRAGMENT_TAIL.test(t)) score -= 0.2
  // slide headings do not end a sentence; a trailing 。 means a wrapped sentence
  if (/。$/.test(t)) score -= 0.45
  // "搜索深度 ： 3" — a parameter line, not a heading
  if (/[：:]\s*\d+\s*$/.test(t)) score -= 0.3
  return { score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), reasons }
}

export function isTitleLike(text, context) {
  return titleScore(text, context).score >= 0.55
}

/** Share of CJK among non-space characters; decides "is this a Chinese document". */
export function cjkRatioOf(text) {
  const s = String(text ?? '').replace(/\s/g, '')
  return s ? countCJK(s) / s.length : 0
}

/** Every title candidate a page offers, best source first. */
function candidatesOf(page) {
  const out = []
  const push = (text, source) => {
    const cleaned = cleanTitle(text)
    if (!cleaned) return
    if (out.some((c) => c.text === cleaned)) return
    out.push({ text: cleaned, source })
  }
  push(page?.title, 'title')
  push(page?.heading?.text, 'heading')
  const lines = String(page?.text || '').split('\n')
  // a heading is near the top; scanning the whole page invites body sentences
  for (const line of lines.slice(0, 8)) push(line, 'line')
  return out
}

/**
 * Rewrite `page.title` for every page using the scored candidates.
 *
 * Idempotent: running it twice yields the same titles. It is called after parsing
 * (all formats) and again after OCR has replaced page text.
 *
 * @param {Array<{index:number,title:string,text:string,heading?:object}>} pages
 * @param {{minScore?:number}} [options]
 * @returns {{changed:number, unusable:number[]}}
 */
export function normalisePageTitles(pages, options = {}) {
  const list = Array.isArray(pages) ? pages : []
  const minScore = options.minScore ?? 0.55
  if (!list.length) return { changed: 0, unusable: [] }

  const docText = list.map((page) => page.text || '').join('\n')
  const docCjkRatio = cjkRatioOf(docText)
  const candidates = list.map(candidatesOf)

  // A candidate repeated on many pages is furniture; count it once per page.
  const counts = new Map()
  for (const pageCandidates of candidates) {
    for (const candidate of pageCandidates) counts.set(candidate.text, (counts.get(candidate.text) || 0) + 1)
  }

  let changed = 0
  const unusable = []
  list.forEach((page, i) => {
    let best = null
    for (const candidate of candidates[i]) {
      const { score, reasons } = titleScore(candidate.text, {
        repeat: counts.get(candidate.text) || 0,
        docCjkRatio,
        placeholderSource: candidate.source === 'title',
      })
      if (!best || score > best.score) best = { text: candidate.text, score, reasons }
    }
    const chosen = best && best.score >= minScore ? best.text : ''
    if ((page.title || '') !== chosen) changed += 1
    page.title = chosen
    page.titleSource = chosen ? best?.source : ''
    page.titleScore = best?.score ?? 0
    if (!chosen) unusable.push(page.index)
  })
  return { changed, unusable }
}

/**
 * Pick the best title for a page from its text alone (used when OCR replaced the
 * body and the old title no longer describes the page).
 */
export function bestPageTitle(page, context = {}) {
  const docCjkRatio = context.docCjkRatio ?? cjkRatioOf(page?.text || '')
  let best = null
  for (const candidate of candidatesOf(page)) {
    const { score } = titleScore(candidate.text, { docCjkRatio, placeholderSource: false })
    if (!best || score > best.score) best = { text: candidate.text, score }
  }
  return best && best.score >= 0.55 ? best.text : ''
}
