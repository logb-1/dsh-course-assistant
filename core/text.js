/**
 * Text cleanup + plain-text/markdown parsing.
 *
 * "先本地处理、后调用模型": page furniture (page numbers, running headers,
 * repeated slide template lines) is removed here so the model sees only content.
 */

const PAGE_NO = [
  /^第\s*\d{1,4}\s*页(\s*\/\s*共\s*\d+\s*页)?$/,
  /^\d{1,4}\s*\/\s*\d{1,4}$/,
  /^page\s*\d{1,4}(\s*of\s*\d+)?$/i,
  /^p\.?\s*\d{1,4}$/i,
  /^[-—–]\s*\d{1,4}\s*[-—–]$/,
]

const isPageNumber = (line) => PAGE_NO.some((re) => re.test(line.trim()))
const norm = (s) => s.replace(/\s+/g, ' ').trim()

function stripFurniture(pages, docTitle) {
  if (!pages.length) return pages
  const freq = new Map()
  for (const p of pages) {
    const seen = new Set()
    for (const line of p.text.split('\n')) {
      const n = norm(line)
      if (!n || n.length > 32 || seen.has(n)) continue
      seen.add(n)
      freq.set(n, (freq.get(n) || 0) + 1)
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5))
  const boiler = new Set([...freq].filter(([, c]) => c >= threshold).map(([l]) => l))
  if (docTitle) boiler.add(norm(docTitle))

  return pages.map((p) => {
    const lines = p.text.split('\n')
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const n = norm(raw)
      if (!n) continue
      const edge = i < 3 || i >= lines.length - 3
      if (edge && isPageNumber(n)) continue
      if (boiler.has(n)) continue
      if (out.length && norm(out[out.length - 1]) === n) continue
      out.push(raw.trimEnd())
    }
    return { ...p, text: out.join('\n') }
  })
}

/* ------------------------------ markdown ------------------------------ */

const SECTION_PATTERNS = [
  { re: /^第\s*([一二三四五六七八九十百\d]+)\s*章\s*(.*)$/, level: 1 },
  { re: /^第\s*([一二三四五六七八九十百\d]+)\s*(节|讲|部分)\s*(.*)$/, level: 2 },
  { re: /^([一二三四五六七八九十]+)\s*[、.．]\s*(.+)$/, level: 1 },
  { re: /^([（(])([一二三四五六七八九十\d]+)([)）])\s*(.+)$/, level: 2 },
  { re: /^(\d{1,2})\s*[、.．]\s+(\S.*)$/, level: 1 },
  { re: /^(\d{1,2}(?:\.\d{1,2}){0,3})\s+(\S.*)$/, level: 2 },
]

function patternHeading(line) {
  const t = line.trim()
  if (t.length > 48) return null
  for (const p of SECTION_PATTERNS) {
    if (p.re.test(t)) return { level: p.level, title: t }
  }
  return null
}

export function parseMarkdown(text, fileName) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let current = null
  const preamble = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const m = !inFence ? /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (m) {
      current = { level: m[1].length, title: m[2].trim(), text: [] }
      blocks.push(current)
      continue
    }
    if (current) current.text.push(line)
    else preamble.push(line)
  }
  return finishBlocks(blocks, preamble, fileName, 'md')
}

export function parsePlainText(text, fileName) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let current = null
  const preamble = []
  for (const line of lines) {
    const head = patternHeading(line)
    if (head && head.level <= 2) {
      current = { level: head.level, title: head.title, text: [] }
      blocks.push(current)
    } else if (current) current.text.push(line)
    else preamble.push(line)
  }
  return finishBlocks(blocks, preamble, fileName, 'txt')
}

function finishBlocks(blocks, preamble, fileName, kind) {
  const clean = blocks
    .map((b) => ({ level: b.level, title: b.title, text: b.text.join('\n').trim() }))
    .filter((b) => b.title)
  if (!clean.length) {
    return {
      kind,
      title: String(fileName || '').replace(/\.[^.]+$/, ''),
      pages: [],
      blocks: [{ level: 1, title: String(fileName || '').replace(/\.[^.]+$/, ''), text: preamble.join('\n').trim() }],
    }
  }
  if (preamble.join('').trim()) clean[0].text = `${preamble.join('\n').trim()}\n${clean[0].text}`.trim()
  return {
    kind,
    title: clean[0].title,
    pages: [],
    blocks: clean,
  }
}

/* ------------------------------ post-process ------------------------------ */

/** Strip furniture from slide/page docs; leaves block docs untouched. */
export function cleanDoc(doc) {
  if (doc.pages?.length) {
    // Keep pages that carry a picture even without text: that is exactly what
    // the OCR pass reads. Never renumber — `index` is the source page number and
    // both OCR placement and "（p.12）" would silently point at the wrong page.
    doc.pages = stripFurniture(doc.pages, doc.title).filter(
      (p) => p.text.trim().length > 0 || Number(p.images) > 0,
    )
  }
  if (doc.blocks?.length) {
    doc.blocks = doc.blocks
      .map((b) => ({ ...b, text: b.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() }))
      .filter((b) => b.title)
  }
  return doc
}

export function docText(doc) {
  if (doc.pages?.length) return doc.pages.map((p) => p.text).join('\n\n')
  if (doc.blocks?.length) return doc.blocks.map((b) => `${b.title}\n${b.text}`).join('\n\n')
  return ''
}

export { norm, patternHeading }
