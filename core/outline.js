/**
 * Outline identification: file structure → chapters (章 → 节).
 *
 * Precedence (cheapest source first):
 *   1. the file's own bookmarks/outline (PDF /Outlines, md headings, docx heading styles)
 *   2. slide-title / numbering patterns (第N章, § N ·, 一、, x.y)
 *   3. a fixed-page chunking fallback, so a report is always produced
 * The model is never asked to find the structure — only to summarize text we
 * already grouped locally.
 */
import { cleanTerm, isGeneric, tfidfTerms } from './terms.js'
import { cjkRatioOf, cleanTitle, hasChapterPrefix, titleScore } from './titles.js'

const CHAPTER_RE = /^(?:第\s*[一二三四五六七八九十百\d]+\s*[章节讲部]|chapter\s*\d+|part\s*[一二三四五六七八九十\d]+)/i
const SECTION_MARK_RE = /^§\s*(\d{1,2})\s*[·:：\-–—]\s*(.+)$/
const CN_TOP_RE = /^[★☆\s•·\-—]*[一二三四五六七八九十]+\s*[、.．]\s*\S/
const CH_TOP_RE = /^[★☆\s•·\-—]*第\s*[一二三四五六七八九十百\d]+\s*[章节讲部]\s*\S/
const CHUNK_PAGES = 5
const MAX_CHAPTERS = 22
const MAX_CHAPTER_CHARS = 14000
/** A chapter shorter than this is folded into its neighbour (titles, not pages, split). */
const MIN_CHAPTER_CHARS = 500
/** Only start a new chapter once the current one is long enough to be worth it. */
const TITLE_CHANGE_CHARS = 1200

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

const charsOf = (pages) => pages.reduce((n, p) => n + (p.text || '').length, 0)

/** A page title is usable when it passes the vetoes in core/titles.js. */
const usableTitle = (page) => {
  const t = cleanTitle(page?.title)
  if (!t) return ''
  // normalisePageTitles already scored this page with the document context
  // (Chinese-vs-code ratio); trust that instead of re-scoring blind
  const scored = Number(page?.titleScore)
  if (Number.isFinite(scored) && scored > 0) return scored >= 0.55 ? t : ''
  return titleScore(t).score >= 0.55 ? t : ''
}


function cap(text) {
  const t = String(text || '').trim()
  return t.length > MAX_CHAPTER_CHARS ? `${t.slice(0, MAX_CHAPTER_CHARS)}\n…（后略）` : t
}

function sectionLabel(line) {
  const t = norm(line)
  if (!t) return null
  const m = SECTION_MARK_RE.exec(t)
  if (m) return { num: Number(m[1]), name: m[2].trim() }
  return null
}

/* ------------------------------ from pages ------------------------------ */

/* ------------------------- structural signals ------------------------- */

/** PowerPoint sections: the author's own chapter boundaries. */
function chaptersFromSections(doc) {
  const sections = doc.sections || []
  const pages = doc.pages || []
  if (sections.length < 2 || !pages.length) return null
  const out = []
  for (const section of sections) {
    const own = (section.pages || []).map((n) => pages[n - 1]).filter(Boolean)
    if (!own.length) continue
    out.push({
      title: section.name || chapterTitleFor(own, out.length),
      source: 'sections',
      pages: own.map((p) => p.index),
      subs: own.map((p) => p.title).filter(Boolean),
      text: cap(own.map((p) => p.text).join('\n\n')),
    })
  }
  return out.length >= 2 ? out : null
}

/** Slides using the deck's own "section header" layout. */
function chaptersFromSectionHead(doc) {
  const pages = doc.pages || []
  const starts = []
  pages.forEach((page, i) => {
    if (page.layout === 'secHead') starts.push(i)
  })
  if (starts.length < 2) return null
  if (starts[0] > 0) starts.unshift(0)
  return starts.map((from, k) => {
    const slice = pages.slice(from, k + 1 < starts.length ? starts[k + 1] : pages.length)
    return {
      title: chapterTitleFor(slice, k),
      source: 'section-head',
      pages: slice.map((p) => p.index),
      subs: slice.map((p) => p.title).filter(Boolean),
      text: cap(slice.map((p) => p.text).join('\n\n')),
    }
  })
}

/**
 * Dense PDFs: a page whose largest text is far above the document median is a
 * chapter opening. Conservative on purpose — a false boundary is worse than a
 * missed one, so a candidate must be short, well above the median and not
 * adjacent to the previous candidate.
 */
function chaptersFromHeadingSize(doc) {
  const pages = (doc.pages || []).filter((p) => p.heading?.size > 0)
  if (pages.length < 8) return null
  const sorted = pages.map((p) => p.heading.size).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  if (!median) return null
  const starts = []
  pages.forEach((page, i) => {
    const heading = page.heading
    if (heading.size < median * 1.45) return
    const text = String(heading.text || '').trim()
    if (text.length < 2 || text.length > 40) return
    if (starts.length && i - starts[starts.length - 1] < 3) return
    starts.push(i)
  })
  if (starts.length < 2 || starts.length > MAX_CHAPTERS) return null
  if (starts[0] > 0) starts.unshift(0)
  return starts.map((from, k) => {
    const slice = pages.slice(from, k + 1 < starts.length ? starts[k + 1] : pages.length)
    return {
      title: chapterTitleFor(slice, k),
      source: 'font-size',
      pages: slice.map((p) => p.index),
      subs: slice.map((p) => p.title).filter(Boolean),
      text: cap(slice.map((p) => p.text).join('\n\n')),
    }
  })
}

/** Explicit per-page section marks (§ 03 · 理论框架); null when they are rare. */
function chaptersFromSectionMarks(doc) {
  const pages = doc.pages || []
  const marks = pages.map((p) => {
    for (const line of String(p.text || '').split('\n').slice(0, 6)) {
      const hit = sectionLabel(line)
      if (hit) return hit
    }
    return null
  })
  const marked = marks.filter(Boolean)
  if (marked.length < Math.max(2, Math.ceil(pages.length * 0.4))) return null
  const groups = []
  for (let i = 0; i < pages.length; i++) {
    const mark = marks[i]
    const key = mark ? mark.num : groups.length ? groups[groups.length - 1].key : -1
    const last = groups[groups.length - 1]
    if (last && last.key === key) {
      last.pages.push(pages[i])
      if (mark && !last.name) last.name = mark.name
    } else {
      groups.push({ key, name: mark?.name || '', pages: [pages[i]] })
    }
  }
  return groups.map((g, i) => ({
    title: g.name || chapterTitleFor(g.pages, i),
    source: g.key >= 0 ? `§ ${String(g.key).padStart(2, '0')}` : '',
    pages: g.pages.map((p) => p.index),
    subs: g.pages.map((p) => p.title).filter(Boolean),
    text: cap(g.pages.map((p) => p.text).join('\n\n')),
  }))
}

function chaptersFromPages(doc) {
  const pages = doc.pages || []
  // 1) explicit per-page section marks (§ 03 · 理论框架)
  const byMarks = chaptersFromSectionMarks(doc)
  if (byMarks) return byMarks

  // 2) chapter-like slide titles (第3章 / Chapter 3)
  // A header repeated on every page must NOT open a chapter per page: only a
  // title that differs from the previous one marks a boundary.
  const starts = []
  let lastTitle = ''
  pages.forEach((p, i) => {
    const title = norm(p.title)
    if (CHAPTER_RE.test(title) && title !== lastTitle) {
      starts.push(i)
      lastTitle = title
    }
  })
  if (starts.length >= 2) {
    const groups = []
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k]
      const to = k + 1 < starts.length ? starts[k + 1] : pages.length
      groups.push(pages.slice(from, to))
    }
    if (starts[0] > 0) groups[0] = [...pages.slice(0, starts[0]), ...groups[0]]
    return groups.map((g, i) => ({
      title: chapterTitleFor(g, i),
      source: '',
      pages: g.map((p) => p.index),
      subs: g.map((p) => p.title).filter(Boolean),
      text: cap(g.map((p) => p.text).join('\n\n')),
    }))
  }

  // 3) chunk by fixed page count
  const groups = []
  for (let i = 0; i < pages.length; i += CHUNK_PAGES) groups.push(pages.slice(i, i + CHUNK_PAGES))
  return groups.map((g, i) => ({
    title: chapterTitleFor(g, i),
    source: '',
    pages: g.map((p) => p.index),
    subs: g.map((p) => p.title).filter(Boolean),
    text: cap(g.map((p) => p.text).join('\n\n')),
  }))
}

/**
 * Sparse, slide-like documents: accumulate pages until a chapter is long enough
 * and name it after the first line of its first page. Fixed 5-page chunks drift
 * away from the deck's own section boundaries, and one page per chapter makes
 * hundreds of tiny summaries.
 */
function chaptersByChars(doc) {
  const pages = doc.pages || []
  if (pages.length < 8) return null
  const total = pages.reduce((n, p) => n + (p.text || '').length, 0)
  if (total / pages.length >= 260) return null // dense text: normal chaptering applies
  const target = 700
  const out = []
  let current = []
  let length = 0
  const flush = () => {
    if (!current.length) return
    const first = current[0]
    // an empty title is fine here: informativeTitle() falls back to sub-headings
    // and TF-IDF terms, which is better than a raw first line ("bad_all")
    const title = usableTitle(first) || ''
    out.push({
      index: out.length + 1,
      title,
      pages: current.map((p) => p.index),
      subs: current.map((p) => p.title).filter(Boolean),
      text: current.map((p) => p.text).join('\n\n'),
      source: 'slides',
    })
    current = []
    length = 0
  }
  for (const page of pages) {
    current.push(page)
    length += (page.text || '').length
    if (length >= target) flush()
  }
  flush()
  return out.length ? out : null
}

/**
 * Slide decks with neither sections nor numbering: split where the *page title*
 * changes instead of every 700 characters.
 *
 * Fixed chunks are why a 67-slide deck came out as "课程导读 (p16–20)",
 * "课程导读 (p21–25)"… — the boundary had nothing to do with the slides. Here a
 * new chapter starts only on a real title change after the current one has enough
 * text, and chapters that end up too short are folded back.
 *
 * If fewer than 30% of pages have a usable title the signal is worthless (a PDF
 * with a broken text layer): return null so the fixed-chunk fallback takes over.
 */
function chaptersByTitleChange(doc) {
  const pages = doc.pages || []
  if (pages.length < 8) return null
  const total = charsOf(pages)
  // dense prose is chaptered by headings, not by page titles; slide exports can
  // carry a few hundred characters per page and still be page-structured
  if (total / pages.length >= 800) return null
  const titled = pages.filter((page) => usableTitle(page)).length
  if (titled / pages.length < 0.3) return null

  const groups = []
  let current = null
  for (const page of pages) {
    const title = usableTitle(page)
    if (!current) {
      current = { title: title || '', pages: [page] }
      groups.push(current)
      continue
    }
    if (title && title !== current.title && charsOf(current.pages) >= TITLE_CHANGE_CHARS) {
      current = { title, pages: [page] }
      groups.push(current)
    } else {
      current.pages.push(page)
      if (!current.title && title) current.title = title
    }
  }

  // fold short or identically-named neighbours into the previous chapter
  const merged = []
  for (const group of groups) {
    const prev = merged[merged.length - 1]
    const same = prev && titleKey(prev.title) === titleKey(group.title)
    if (prev && (charsOf(group.pages) < MIN_CHAPTER_CHARS || same)) {
      prev.pages.push(...group.pages)
      prev.subs.push(...group.pages.map((p) => p.title).filter(Boolean))
      prev.text = cap(`${prev.text}\n\n${group.pages.map((p) => p.text).join('\n\n')}`)
      continue
    }
    merged.push({
      title: group.title,
      pages: [...group.pages],
      subs: group.pages.map((p) => p.title).filter(Boolean),
      text: cap(group.pages.map((p) => p.text).join('\n\n')),
    })
  }
  if (merged.length < 2 || merged.length > MAX_CHAPTERS) return null
  return merged.map((group, i) => ({
    title: group.title || chapterTitleFor(group.pages, i),
    source: 'title-change',
    pages: group.pages.map((p) => p.index),
    subs: group.subs,
    text: group.text,
  }))
}

/**
 * Slide-deck PDFs label each page with a section number ("10.1 异常处理").
 * Grouping pages by the major number turns a 54-page deck into chapters instead
 * of one blob — the failure mode where every page title is "幻灯片 3: 10.1 …".
 */
function chaptersFromSectionNumbers(doc) {
  const pages = doc.pages || []
  const entries = pages.map((p) => {
    const head = String(p.text || '').split('\n').slice(0, 6)
    const title = norm(p.title || '')
    let major = null
    let label = ''
    for (const line of [title, ...head]) {
      const trimmed = String(line || '').trim()
      // a section heading is short: body text like "61.4" must not create chapters
      if (!trimmed || trimmed.length > 40) continue
      const m = /^\s*(?:幻灯片\s*\d+\s*[:：]?\s*)?(\d{1,2})[.．](\d{1,2})\s*[、.．:：]?\s*(.*)$/.exec(trimmed)
      if (!m) continue
      const num = Number(m[1])
      if (num < 1 || num > 30 || Number(m[2]) > 30) continue
      const labelText = norm(m[3] || '')
      // a real heading carries words; "3 × 1 5 + 2.56" is body arithmetic
      if (labelText.replace(/[^\u4e00-\u9fff]/g, '').length < 2) continue
      major = num
      label = labelText.slice(0, 30)
      break
    }
    return { page: p, major, label }
  })
  const numbered = entries.filter((e) => e.major !== null)
  const majors = [...new Set(numbered.map((e) => e.major))]
  if (numbered.length < 3 || majors.length < 2) return null

  const groups = []
  let current = null
  for (const e of entries) {
    if (e.major === null) {
      if (current) current.pages.push(e.page)
      continue
    }
    if (!current || current.major !== e.major) {
      current = { major: e.major, label: e.label, pages: [e.page] }
      groups.push(current)
    } else {
      current.pages.push(e.page)
      if (!current.label && e.label) current.label = e.label
    }
  }
  return groups
    .filter((g) => g.pages.length)
    .map((g, i) => ({
      index: i + 1,
      title: g.label ? `第 ${g.major} 章 ${g.label}` : `第 ${g.major} 章`,
      pages: g.pages.map((p) => p.index),
      subs: g.pages.map((p) => p.title).filter(Boolean),
      text: g.pages.map((p) => p.text).join('\n\n'),
      source: 'numbering',
    }))
}

function chapterTitleFor(pages, i) {
  for (const page of pages || []) {
    const t = usableTitle(page)
    if (t) return t
  }
  return `第 ${i + 1} 部分`
}

/* ------------------------------ from blocks ------------------------------ */

function chaptersFromBlocks(doc) {
  const blocks = doc.blocks
  const tops = []
  let current = null
  for (const b of blocks) {
    if (b.level <= 1) {
      current = { title: b.title, text: [b.text], subs: [] }
      tops.push(current)
    } else if (current) {
      current.subs.push(b.title)
      current.text.push(`${b.title}\n${b.text}`)
    }
  }
  if (tops.length >= 2) {
    return tops.map((t) => ({
      title: t.title,
      source: '',
      pages: [],
      subs: t.subs,
      text: cap(t.text.join('\n\n')),
    }))
  }
  // single block: fall back to pattern splitting over the raw text
  const text = blocks.map((b) => `${b.title}\n${b.text}`).join('\n\n')
  return chaptersFromText(text, doc.title)
}

/* ------------------------------- from text ------------------------------- */

const SPLITTERS = [
  { level: 1, re: /^[★☆\s•·\-—]*第\s*[一二三四五六七八九十百\d]+\s*[章节讲部]\s*\S/ },
  { level: 1, re: /^[★☆\s•·\-—]*[一二三四五六七八九十]+\s*[、.．]\s*\S/ },
  { level: 1, re: /^[★☆\s•·\-—]*第\s*[一二三四五六七八九十百\d]+\s*部分\s*\S/ },
  { level: 2, re: /^[★☆\s•·\-—]*[（(][一二三四五六七八九十\d]+[)）]\s*\S/ },
  { level: 2, re: /^\d{1,2}(?:\.\d{1,2}){0,2}\s+[^\d\s].{0,40}$/ },
]

function headingLevelOf(line) {
  const t = line.trim()
  if (!t || t.length > 60) return 0
  if (/^[-*•·]\s/.test(t)) return 0 // a bullet is body text, not a heading
  const md = /^(#{1,4})\s+\S/.exec(t)
  if (md) return md[1].length <= 2 ? 1 : 2
  for (const s of SPLITTERS) if (s.re.test(t)) return s.level
  return 0
}

/** "★★★★★ 第 3 章 xxx（PPT 共 360+ 页，投入 40% 时间）" → "第 3 章 xxx" */
function cleanChapterTitle(title) {
  return String(title || '')
    .replace(/^[★☆\s·•\-—]+/, '')
    .replace(/[（(][^）)]*(投入|PPT|ppt)[^）)]*[）)]\s*$/, '')
    .replace(/^(幻灯片|slide)\s*\d+$/i, '')
    .trim()
}

/**
 * Is this line part of a table block rather than a heading?
 *
 * A "复习大纲" exported to PDF can contain a filename ↔ chapter mapping table:
 * `3_2_指令系统概述.pptx` on one line, `第 2 章 数据的机器级表示` on the next.
 * Treating those cells as headings produced chapters in the wrong order that
 * appeared twice. Only *structural* table evidence counts — a whole-line file
 * name or a markdown row — because prose is full of arrows and colons.
 */
function inTableContext(lines, index) {
  const isFilename = (t) => /^[\w\u4e00-\u9fff\-. ()（）]+\.(?:pptx|pdf|docx?|xlsx?|txt)$/i.test(t)
  const isRow = (t) => /^\|.*\|$/.test(t)
  let hits = 0
  for (let k = Math.max(0, index - 3); k <= Math.min(lines.length - 1, index + 3); k += 1) {
    if (k === index) continue
    const t = String(lines[k] || '').trim()
    if (!t) continue
    if (isFilename(t) || isRow(t)) hits += 1
  }
  const self = String(lines[index] || '').trim()
  return isRow(self) || hits >= 1
}

function chaptersFromText(text, docTitle, options = {}) {
  const lines = String(text || '').split('\n')
  const chapters = []
  let current = null
  const preamble = []
  const open = (title) => {
    current = { title, source: '', pages: [], subs: [], lines: [] }
    chapters.push(current)
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const t = line.trim()
    let level = headingLevelOf(t)
    // PDF text extraction interleaves table cells with prose; a heading-looking
    // cell ("3_2_….pptx" / "第 2 章 …") is not a chapter. Markdown and docx keep
    // their real heading structure, so the heuristic only runs for PDF text.
    if (options.tabular && level > 0 && inTableContext(lines, i)) level = 0
    if (level === 1) {
      open(t.replace(/^#{1,4}\s*/, ''))
      continue
    }
    if (level === 2) {
      if (!current) open(docTitle)
      const sub = t.replace(/^#{1,4}\s*/, '')
      current.subs.push(sub)
      current.lines.push(sub)
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }

  const out = []
  let carry = []
  for (const c of chapters) {
    const body = c.lines.join('\n').trim()
    if (body.length <= 40) {
      carry.push(c.title)
      continue
    }
    out.push({
      title: c.title,
      source: '',
      pages: [],
      subs: [...carry, ...c.subs],
      text: cap(`${carry.join('\n')}\n${body}`.trim()),
    })
    carry = []
  }
  if (out.length) {
    if (preamble.join('').trim()) {
      out[0].text = cap(`${preamble.join('\n').trim()}\n\n${out[0].text}`)
    }
    return out
  }
  if (carry.length) out.push({ title: docTitle, source: '', pages: [], subs: carry, text: cap(carry.join('\n')) })

  // last resort: split the whole text in equal parts
  const body = String(text || '').trim()
  if (!body) return [{ title: docTitle, source: '', pages: [], subs: [], text: '' }]
  const parts = Math.max(1, Math.min(8, Math.ceil(body.length / 6000)))
  const size = Math.ceil(body.length / parts)
  return Array.from({ length: parts }, (_, i) => ({
    title: i === 0 ? docTitle : `${docTitle}（续 ${i}）`,
    source: '',
    pages: [],
    subs: [],
    text: cap(body.slice(i * size, (i + 1) * size)),
  }))
}

/* ------------------------------ from pdf toc ------------------------------ */

function chaptersFromPdfOutline(doc) {
  const top = doc.outline.filter((o) => o.level === 1)
  if (top.length < 2) return null
  const all = doc.outline
  const pageCount = doc.pages.length
  const groups = top.map((head, i) => {
    const next = top[i + 1]
    const from = head.page || 1
    const to = next?.page ? next.page - 1 : pageCount
    const subs = all
      .filter((o) => o.level > 1 && o.page >= from && o.page <= to)
      .map((o) => o.title)
    return {
      title: head.title,
      source: '',
      pages: doc.pages.filter((p) => p.index >= from && p.index <= to).map((p) => p.index),
      subs,
      text: cap(
        doc.pages
          .filter((p) => p.index >= from && p.index <= to)
          .map((p) => p.text)
          .join('\n\n'),
      ),
    }
  })
  return groups.filter((g) => g.text.length > 50)
}

/* -------------------------------- merge -------------------------------- */

const titleKey = (title) => norm(String(title || '')).replace(/^[#\s]+/, '').toLowerCase()

/**
 * A header repeated on every page (or a deck whose slides share a title) yields
 * N identically named chapters. Adjacent duplicates are one chapter; a duplicate
 * that appears later keeps its own chapter but gets its page range appended, so
 * "（续）" is never needed and the reader can tell them apart.
 */
function mergeSameTitle(chapters) {
  if (!chapters.length) return chapters
  // a real "same chapter" repeats its title on every page; a chunk that merely
  // starts with a repeated header but contains another heading must stay apart
  const uniform = (ch) => {
    const key = titleKey(ch.title)
    return (ch.subs || []).length > 0 && (ch.subs || []).every((s) => titleKey(s) === key)
  }
  const merged = []
  for (const chapter of chapters) {
    const prev = merged[merged.length - 1]
    if (prev && titleKey(prev.title) === titleKey(chapter.title) && uniform(prev) && uniform(chapter)) {
      prev.text = cap(`${prev.text}\n\n${chapter.text}`)
      prev.subs = [...new Set([...(prev.subs || []), ...(chapter.subs || [])])]
      prev.pages = [...(prev.pages || []), ...(chapter.pages || [])]
      continue
    }
    merged.push({ ...chapter, subs: [...(chapter.subs || [])], pages: [...(chapter.pages || [])] })
  }
  const seen = new Map()
  for (const chapter of merged) {
    const key = titleKey(chapter.title)
    const count = (seen.get(key) || 0) + 1
    seen.set(key, count)
    if (count > 1) {
      const pages = chapter.pages || []
      const suffix = pages.length ? `（p${Math.min(...pages)}–${Math.max(...pages)}）` : `（${count}）`
      chapter.title = `${chapter.title}${suffix}`
    }
  }
  return merged
}

function mergeSmall(chapters) {
  if (chapters.length <= 1) return chapters
  const out = []
  for (const ch of chapters) {
    const prev = out[out.length - 1]
    if (prev && (ch.text.length < 400 || prev.text.length < 400) && out.length + chapters.length > MAX_CHAPTERS) {
      prev.text = cap(`${prev.text}\n\n${ch.title}\n${ch.text}`)
      prev.subs.push(ch.title, ...ch.subs)
      prev.pages.push(...ch.pages)
      continue
    }
    out.push({ ...ch, subs: [...new Set(ch.subs.filter(Boolean))] })
  }
  if (out.length <= MAX_CHAPTERS) return out
  const step = Math.ceil(out.length / MAX_CHAPTERS)
  const packed = []
  for (let i = 0; i < out.length; i += step) {
    const slice = out.slice(i, i + step)
    packed.push({
      title: slice[0].title,
      source: slice[0].source,
      pages: slice.flatMap((s) => s.pages),
      subs: slice.flatMap((s) => s.subs),
      text: cap(slice.map((s) => s.text).join('\n\n')),
    })
  }
  return packed
}

/**
 * A chapter named after a page header ("主要内容"), a code line or half a sentence
 * is useless in the table of contents and poisonous as a search query. Fall back
 * to the first usable sub-heading, then the first informative line, then TF-IDF
 * terms from the chapter itself — never leave a fragment in place.
 */
function informativeTitle(chapter, index, docCjkRatio = 0) {
  const raw = String(chapter.title || '').trim()
  // the page-range suffix tells two same-named chapters apart; only the
  // quality test looks past it — the rendered title keeps it
  const base = raw.replace(/（p\d+[–-]\d+）\s*$/, '').replace(/（\d+）\s*$/, '').trim()
  const suffix = raw.slice(base.length)
  const cleanedBase = cleanTitle(cleanChapterTitle(base) || base)
  // "第 1 章 甲" is a legitimate title; only drop genuinely empty phrases
  if (cleanedBase && !isGeneric(base) && titleScore(cleanedBase, { docCjkRatio }).score >= 0.55) return `${cleanedBase}${suffix}`.trim()
  let bestSub = null
  for (const sub of chapter.subs || []) {
    const term = cleanTitle(cleanChapterTitle(sub) || sub)
    if (!term || isGeneric(term) || term.length > 40) continue
    const score = titleScore(term, { docCjkRatio }).score
    if (score >= 0.55 && (!bestSub || score > bestSub.score)) bestSub = { term, score }
  }
  if (bestSub) return `${bestSub.term}${suffix}`.trim()
  for (const line of String(chapter.text || '').split('\n')) {
    const term = cleanTitle(cleanTerm(line))
    if (term && term.length <= 40 && titleScore(term, { docCjkRatio }).score >= 0.55) return term
  }
  const terms = tfidfTerms([chapter.text || ''], { topK: 2 })
  if (terms.length) return terms.join(' ')
  return `第 ${index + 1} 部分`
}

/**
 * The course name, chosen instead of inherited.
 *
 * A PDF whose first page is a slide header gives "幻灯片 1"; a report-style docx
 * starts with "前言与使用说明"; a single-chapter file's title is really a chapter
 * heading. Candidates are scored and the filename is the last resort.
 */
function docTitleCandidates(doc) {
  const out = []
  if (doc.outline?.[0]?.title) out.push({ text: doc.outline[0].title, source: 'bookmark' })
  if (doc.title) out.push({ text: doc.title, source: 'parser' })
  const firstPageTitle = (doc.pages || []).map((p) => p.title).find((t) => cleanTitle(t))
  if (firstPageTitle) out.push({ text: firstPageTitle, source: 'page' })
  const stem = String(doc.fileName || doc.name || '').replace(/\.[^.]+$/, '')
  if (stem) out.push({ text: stem, source: 'filename' })
  return out
}

export function pickCourseTitle(docs, chapterCount = 0) {
  const text = (docs || []).map((doc) => (doc.pages || []).map((p) => p.text).join('\n') || doc.text || '').join('\n')
  const docCjkRatio = cjkRatioOf(text)
  const chosen = []
  for (const doc of docs || []) {
    let hit = null
    for (const candidate of docTitleCandidates(doc)) {
      const title = cleanTitle(candidate.text)
      if (!title) continue
      if (titleScore(title, { docCjkRatio }).score < 0.55) continue
      // a chapter heading is not a course title once the file really has chapters
      if (chapterCount >= 3 && hasChapterPrefix(title)) continue
      hit = { title, source: candidate.source }
      break
    }
    if (hit) chosen.push(hit)
  }
  if (!chosen.length) {
    const stem = String(docs?.[0]?.fileName || docs?.[0]?.name || '').replace(/\.[^.]+$/, '')
    return { title: stem || '课程', source: stem ? 'filename' : 'default' }
  }
  const sources = [...new Set(chosen.map((c) => c.source))]
  return { title: chosen.map((c) => c.title).join(' + '), source: sources.join('+') }
}

/** Chapter titles that still look wrong after cleanup, plus duplicates. */
export function outlineDiagnostics(chapters) {
  const fallback = []
  const bad = []
  const seen = new Map()
  for (const chapter of chapters) {
    const raw = String(chapter.title || '')
    if (/^第\s*\d+\s*部分$/.test(raw)) fallback.push(chapter.index)
    const base = raw.replace(/（p\d+[–-]\d+）\s*$/, '').trim()
    if (titleScore(base).score < 0.55) bad.push({ index: chapter.index, title: raw })
    seen.set(base, (seen.get(base) || 0) + 1)
  }
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([title]) => title)
  return { fallback, bad, duplicates, chapters: chapters.length }
}


/**
 * @param docs parsed documents (each { kind, title, pages, blocks, outline? })
 * @returns {{ courseTitle: string, chapters: Array, tree: Array }}
 */
export function buildOutline(docs) {
  const all = []
  for (const doc of docs) {
    let chapters = null
    // Sparse slide decks: bundle by text volume and trust the first line of each
    // page. Bookmarks on such files are per-slide noise that collapses to 1–2
    // chapters, and text-pattern splitting finds no headings at all.
    const pages = doc.pages || []
    const totalChars = pages.reduce((n, p) => n + (p.text || '').length, 0)
    const slideLike = pages.length >= 8 && totalChars / pages.length < 260
    // 1) PowerPoint sections and section-header layouts are explicit; 2) font size
    // is a strong signal on dense PDFs; 3) the heuristics below stay as fallback.
    if (doc.sections?.length >= 2) chapters = chaptersFromSections(doc)
    if (!chapters) chapters = chaptersFromSectionHead(doc)
    if (!chapters && slideLike) {
      const byMarks = chaptersFromSectionMarks(doc)
      if (byMarks) chapters = byMarks
      const byNumber = chapters ? null : chaptersFromSectionNumbers(doc)
      if (byNumber?.length >= 2) chapters = byNumber
      // titles that actually change beat a fixed 5-page chunk: the slides' own
      // topics become the chapter boundaries
      if (!chapters) chapters = chaptersByTitleChange(doc)
      if (!chapters) chapters = chaptersByChars(doc)
    }
    if (!chapters && !slideLike && doc.kind === 'pdf') chapters = chaptersFromHeadingSize(doc)
    if (!chapters && doc.outline?.length) {
      // A deck can carry one or two bookmarks for dozens of pages; trusting that
      // collapses the outline, so short bookmark lists only win on short files.
      const fromMarks = chaptersFromPdfOutline(doc)
      if (fromMarks.length >= 3 || pages.length < 12) chapters = fromMarks
    }
    if (!chapters && doc.blocks?.length) chapters = chaptersFromBlocks(doc)
    if (!chapters && doc.pages?.length) {
      // Slide decks exported to PDF: page titles are mixed strings like
      // "幻灯片 3: 10.1 异常处理". § marks and section numbers are explicit; a
      // changing page title is the next best boundary; fixed chunks are last.
      const byMarks = chaptersFromSectionMarks(doc)
      if (byMarks) chapters = byMarks
      const byNumber = chapters ? null : chaptersFromSectionNumbers(doc)
      if (byNumber?.length >= 2) chapters = byNumber
      if (!chapters) {
        const byTitle = chaptersByTitleChange(doc)
        if (byTitle?.length >= 2) chapters = byTitle
      }
      if (!chapters) {
        const byChars = chaptersByChars(doc)
        if (byChars?.length >= 2) chapters = byChars
      }
    }
    if (!chapters && doc.pages?.length) {
      // OCR pages carry a real first-line title, so page grouping beats text
      // patterns (OCR text has no reliable heading markers)
      const weak = doc.ocr ? false : doc.kind === 'pdf' || !pageTitlesStrong(doc.pages)
      if (weak) {
        const byText = chaptersFromText(docFullText(doc), doc.title, { tabular: doc.kind === 'pdf' }).filter((c) => c.text.length > 200)
        if (byText.length >= 3) chapters = byText
      }
      if (!chapters) chapters = chaptersFromPages(doc)
    }
    if (!chapters && doc.text) chapters = chaptersFromText(doc.text, doc.title)
    if (!chapters) chapters = chaptersFromText('', doc.title)
    // merge duplicates inside this document, before the multi-document prefix:
    // otherwise two decks that happen to share a last/first chapter title merge
    // across files
    chapters = mergeSameTitle(chapters)
    if (docs.length > 1) {
      for (const ch of chapters) ch.title = `${doc.title}｜${ch.title}`
    }
    all.push(...chapters)
  }
  const chapters = mergeCover(mergeSmall(all), docs)
  const picked = pickCourseTitle(docs, chapters.length)
  const docCjkRatio = cjkRatioOf(docs.map(docFullText).join('\n'))
  const titled = chapters.map((c, i) => ({ ...c, index: i + 1, title: informativeTitle(c, i, docCjkRatio) }))
  return {
    courseTitle: picked.title,
    courseTitleSource: picked.source,
    chapters: titled,
    diagnostics: outlineDiagnostics(titled),
    tree: buildTree(titled),
  }
}

/**
 * A title slide is not a chapter: a cover page yields a one-line "chapter" and
 * the model has nothing to summarize, so fold it into the following chapter.
 */
function mergeCover(chapters, docs) {
  if (chapters.length < 2) return chapters
  // only decks carry a title slide; for markdown/docx the first heading is a
  // real chapter and folding it into the next one deletes it
  if (!chapters.some((c) => (c.pages?.length || 0) > 0)) return chapters
  const first = chapters[0]
  const docTitle = docs[0]?.title || ''
  const sameTitle = docTitle && norm(first.title) === norm(docTitle)
  const singlePage = (first.pages?.length || 0) <= 1
  const coverish = sameTitle || (singlePage && first.text.length < 300 && (first.subs?.length || 0) <= 1)
  if (!coverish || first.text.length >= 1000) return chapters
  const next = chapters[1]
  next.text = cap(`${first.title}\n${first.text}\n\n${next.text}`)
  next.subs = [...new Set([first.title, ...(first.subs || []), ...(next.subs || [])])]
  next.pages = [...(first.pages || []), ...(next.pages || [])]
  return chapters.slice(1)
}

function buildTree(chapters) {
  return chapters.map((c, i) => ({ title: c.title, index: i + 1, subs: (c.subs || []).slice(0, 8) }))
}

function docFullText(doc) {
  if (doc.pages?.length) return doc.pages.map((p) => p.text).join('\n\n')
  if (doc.blocks?.length) return doc.blocks.map((b) => `${b.title}\n${b.text}`).join('\n\n')
  return doc.text || ''
}

/** Distinct, informative page titles are the cheapest structural signal. */
function pageTitlesStrong(pages) {
  const titles = pages.map((p) => norm(p.title)).filter((t) => t.length >= 3 && t.length <= 60)
  if (titles.length < Math.ceil(pages.length * 0.5)) return false
  return new Set(titles).size >= titles.length * 0.6
}
