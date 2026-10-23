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

const CHAPTER_RE = /^(?:第\s*[一二三四五六七八九十百\d]+\s*[章节讲部]|chapter\s*\d+|part\s*[一二三四五六七八九十\d]+)/i
const SECTION_MARK_RE = /^§\s*(\d{1,2})\s*[·:：\-–—]\s*(.+)$/
const CHUNK_PAGES = 5
const MAX_CHAPTERS = 22
const MAX_CHAPTER_CHARS = 14000

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

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

function chaptersFromPages(doc) {
  const pages = doc.pages
  // 1) explicit per-page section marks (§ 03 · 理论框架)
  const marks = pages.map((p) => {
    for (const line of p.text.split('\n').slice(0, 6)) {
      const hit = sectionLabel(line)
      if (hit) return hit
    }
    return null
  })
  const marked = marks.filter(Boolean)
  if (marked.length >= Math.max(2, Math.ceil(pages.length * 0.4))) {
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

  // 2) chapter-like slide titles (第3章 / Chapter 3)
  const starts = []
  pages.forEach((p, i) => {
    if (CHAPTER_RE.test(norm(p.title))) starts.push(i)
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
      title: norm(g[0].title) || chapterTitleFor(g, i),
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
    const raw = norm(first.title || '') || norm(String(first.text || '').split('\n')[0])
    const title = cleanChapterTitle(raw) || `第 ${out.length + 1} 部分`
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

function chapterTitleFor(pages, i) {  const t = norm(pages[0]?.title)
  if (t && t.length <= 40) return t
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

function chaptersFromText(text, docTitle) {
  const lines = String(text || '').split('\n')
  const chapters = []
  let current = null
  let preamble = []
  const open = (title) => {
    current = { title, source: '', pages: [], subs: [], lines: [] }
    chapters.push(current)
  }
  for (const line of lines) {
    const t = line.trim()
    const level = headingLevelOf(t)
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
    if (slideLike) {
      const byNumber = chaptersFromSectionNumbers(doc)
      chapters = byNumber?.length >= 2 ? byNumber : chaptersByChars(doc)
    }
    if (!chapters && doc.outline?.length) {
      // A deck can carry one or two bookmarks for dozens of pages; trusting that
      // collapses the outline, so short bookmark lists only win on short files.
      const fromMarks = chaptersFromPdfOutline(doc)
      if (fromMarks.length >= 3 || pages.length < 12) chapters = fromMarks
    }
    if (!chapters && doc.blocks?.length) chapters = chaptersFromBlocks(doc)
    if (!chapters && doc.pages?.length) {
      // Slide decks exported to PDF: page titles are mixed strings like
      // "幻灯片 3: 10.1 异常处理". Group pages by the section number instead of
      // falling back to fixed 5-page chunks, which collapses a 54-page deck into
      // one chapter.
      const byNumber = chaptersFromSectionNumbers(doc)
      if (byNumber?.length >= 2) chapters = byNumber
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
        const byText = chaptersFromText(docFullText(doc), doc.title).filter((c) => c.text.length > 200)
        if (byText.length >= 3) chapters = byText
      }
      if (!chapters) chapters = chaptersFromPages(doc)
    }
    if (!chapters && doc.text) chapters = chaptersFromText(doc.text, doc.title)
    if (!chapters) chapters = chaptersFromText('', doc.title)
    if (docs.length > 1) {
      for (const ch of chapters) ch.title = `${doc.title}｜${ch.title}`
    }
    all.push(...chapters)
  }
  const chapters = mergeCover(mergeSmall(all), docs)
  const courseTitle =
    docs.length === 1 ? docs[0].title || '课程' : docs.map((d) => d.title).filter(Boolean).join(' + ')
  return {
    courseTitle: courseTitle || '课程',
    chapters: chapters.map((c, i) => ({
      ...c,
      index: i + 1,
      title: cleanChapterTitle(c.title) || `第 ${i + 1} 部分`,
    })),
    tree: buildTree(chapters.map((c) => ({ ...c, title: cleanChapterTitle(c.title) }))),
  }
}

/**
 * A title slide is not a chapter: a cover page yields a one-line "chapter" and
 * the model has nothing to summarize, so fold it into the following chapter.
 */
function mergeCover(chapters, docs) {
  if (chapters.length < 2) return chapters
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
