import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import { drawStructure } from './diagram.js'

/**
 * Markdown → PDF renderer.
 *
 * The old export went Markdown → docx → LibreOffice → PDF, which needed the
 * desktop host, produced an unstyled document and dropped the Mermaid diagram
 * entirely. This renderer lays the report out directly with pdfkit: A4, a CJK
 * font subset shipped in the repo, a cover, a hand-drawn structure diagram and
 * the usual report furniture (tables, callouts, page numbers).
 *
 * Scope is deliberately the subset of Markdown this project emits. It is not a
 * general Markdown engine: no HTML, no footnotes, no nested block quotes.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FONT_PATH = path.join(HERE, '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf')
export const FONT_LICENSE_PATH = path.join(HERE, '..', 'assets', 'fonts', 'OFL.txt')

export function pdfFontAvailable() {
  return existsSync(FONT_PATH)
}

const PAGE = { width: 595.28, height: 841.89 }
const MARGIN = 56
const CONTENT_W = PAGE.width - MARGIN * 2
const TOP = MARGIN
const BOTTOM = PAGE.height - MARGIN

const INK = '#111827'
const BODY = '#1f2937'
const MUTED = '#6b7280'
const FAINT = '#9ca3af'
const ACCENT = '#1d4ed8'
const RULE = '#e5e7eb'
const PANEL = '#f8fafc'
const WARN = '#b45309'

const BODY_SIZE = 10
const BODY_GAP = 5.5

function cleanInline(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // the bundled subset has no emoji; keep the meaning with text marks
    .replace(/⚠️?/g, '※')
    .replace(/✅/g, '√')
    .replace(/❌/g, '×')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Box-drawing characters are outside the font subset; ASCII keeps the tree aligned. */
function foldTreeGlyphs(text) {
  return String(text)
    .replace(/├─/g, '|-')
    .replace(/└─/g, '`-')
    .replace(/│/g, '| ')
    .replace(/[─━]/g, '-')
    .replace(/[┌┐┘┴┬┼]/g, '+')
}

function isTableDivider(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^\|?[\s:|-]+\|?$/.test(trimmed) && trimmed.split('|').length >= 2
}

function isTableStart(lines, index) {
  const line = lines[index] || ''
  return line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])
}

function splitRow(line) {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  const cells = []
  let current = ''
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (char === '\\' && value[i + 1] === '|') {
      current += '|'
      i += 1
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function parseBlocks(markdown) {
  // generator comments (scoring notes, timings) are notes to humans reading the
  // source, not report content
  const lines = String(markdown || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }

    if (/^```/.test(line)) {
      const language = line.replace(/^```/, '').trim()
      const body = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push({ type: 'code', language, text: body.join('\n') })
      continue
    }

    if (/^\s*<details/i.test(line)) {
      while (i < lines.length && !/<\/details>/i.test(lines[i])) i += 1
      i += 1
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: cleanInline(heading[2]) })
      i += 1
      continue
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i])
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      const items = []
      while (i < lines.length) {
        const match = /^(\s*)[-*+]\s+(.*)$/.exec(lines[i])
        if (!match) break
        const depth = Math.min(1, Math.floor(match[1].length / 2))
        items.push({ depth, text: cleanInline(match[2]) })
        i += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      const items = []
      while (i < lines.length) {
        const match = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i])
        if (!match) break
        const depth = Math.min(1, Math.floor(match[1].length / 2))
        items.push({ depth, marker: match[2], text: cleanInline(match[3]) })
        i += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(cleanInline(lines[i].replace(/^\s*>\s?/, '')))
        i += 1
      }
      blocks.push({ type: 'quote', text: body.join(' ') })
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    const paragraph = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^```|^\s*>|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*<details/i.test(lines[i]) && !isTableStart(lines, i)) {
      paragraph.push(cleanInline(lines[i]))
      i += 1
    }
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
    else i += 1
  }

  return blocks
}

class Renderer {
  constructor(doc, { courseTitle, subtitle }) {
    this.doc = doc
    this.courseTitle = courseTitle
    this.subtitle = subtitle
    this.y = TOP
  }

  newPage() {
    this.doc.addPage()
    this.y = TOP
  }

  ensure(height) {
    if (this.y + height > BOTTOM) {
      this.newPage()
      return true
    }
    return false
  }

  flow(text, { size = BODY_SIZE, color = BODY, gap = BODY_GAP, x = MARGIN, width = CONTENT_W, align = 'left', lineGap = 3, firstLine = 0 } = {}) {
    const doc = this.doc
    doc.fontSize(size).fillColor(color)
    const height = doc.heightOfString(text, { width: width - firstLine, lineGap })
    if (height <= BOTTOM - TOP) this.ensure(height + gap)
    doc.text(text, x + firstLine, this.y, { width: width - firstLine, align, lineGap })
    this.y = doc.y + gap
  }

  heading(level, text) {
    const size = level === 2 ? 15 : level === 3 ? 11.5 : 10.5
    const color = level === 2 ? INK : level === 3 ? '#1f2937' : MUTED
    const before = level === 2 ? 16 : 10
    const after = level === 2 ? 7 : 4
    const doc = this.doc
    doc.fontSize(size).fillColor(color)
    const height = doc.heightOfString(text, { width: CONTENT_W })
    const lookahead = level === 2 ? 140 : level === 3 ? 70 : 36
    if (this.y + before + height + after + lookahead > BOTTOM) this.newPage()
    else this.y += before
    if (level === 2) {
      doc.moveTo(MARGIN, this.y).lineTo(MARGIN + 28, this.y).lineWidth(2).strokeColor(ACCENT).stroke()
      this.y += 6
    }
    doc.text(text, MARGIN, this.y, { width: CONTENT_W })
    this.y = doc.y + after
    try {
      doc.outline.addItem(text)
    } catch {
      /* bookmarks are a nicety; never fail the document for them */
    }
  }

  paragraph(text) {
    this.flow(text)
  }

  list(block) {
    for (const item of block.items) {
      const indent = item.depth * 14
      const doc = this.doc
      doc.fontSize(BODY_SIZE).fillColor(item.depth ? MUTED : BODY)
      const width = CONTENT_W - indent - 16
      const height = doc.heightOfString(item.text, { width, lineGap: 3 })
      if (this.y + height > BOTTOM) this.newPage()
      if (block.ordered) {
        doc.fillColor(item.depth ? MUTED : FAINT).text(`${item.marker}.`, MARGIN + indent, this.y, { width: 16, lineBreak: false })
      } else {
        // a vector dot survives every font subset; the glyph does not always
        doc.circle(MARGIN + indent + 3.5, this.y + 4.5, item.depth ? 1.3 : 1.8).fill(item.depth ? FAINT : '#6b7280')
      }
      doc.fillColor(item.depth ? '#4b5563' : BODY).text(item.text, MARGIN + indent + 16, this.y, { width, lineGap: 3 })
      this.y = doc.y + 2.5
    }
    this.y += 2
  }

  quote(text) {
    const doc = this.doc
    doc.fontSize(9).fillColor('#4b5563')
    const height = doc.heightOfString(text, { width: CONTENT_W - 18, lineGap: 2.5 })
    const box = height + 10
    if (this.y + box > BOTTOM) this.newPage()
    doc.rect(MARGIN, this.y, 2.5, box).fill('#c7d2fe')
    doc.text(text, MARGIN + 11, this.y + 5, { width: CONTENT_W - 18, lineGap: 2.5 })
    this.y += box + 4
  }

  code(text) {
    const doc = this.doc
    const folded = foldTreeGlyphs(text)
    const lines = folded.split('\n')
    const body = []
    for (const line of lines) {
      // hard-wrap long lines by character count; code points beat byte length here
      const chunk = 78
      for (let i = 0; i < Math.max(1, line.length); i += chunk) body.push(line.slice(i, i + chunk))
    }
    const rendered = body.join('\n')
    doc.fontSize(8.2).fillColor('#334155')
    const height = doc.heightOfString(rendered, { width: CONTENT_W - 18, lineGap: 2 })
    if (height + 16 <= BOTTOM - TOP) this.ensure(height + 16 + 6)
    const boxHeight = Math.min(height + 16, BOTTOM - TOP)
    doc.roundedRect(MARGIN, this.y, CONTENT_W, boxHeight, 4).fillAndStroke(PANEL, RULE)
    // fillAndStroke repaints the current fill colour: reset before the text or
    // the code becomes invisible (light text on a light panel)
    doc.fillColor('#334155')
    doc.text(rendered, MARGIN + 9, this.y + 8, { width: CONTENT_W - 18, lineGap: 2, height: boxHeight - 16 })
    this.y += boxHeight + 7
  }

  rule() {
    this.ensure(10)
    this.doc.moveTo(MARGIN, this.y + 3).lineTo(MARGIN + CONTENT_W, this.y + 3).lineWidth(0.6).strokeColor(RULE).stroke()
    this.y += 11
  }

  table(block) {
    const doc = this.doc
    const columns = block.header.length
    const font = 8.4
    doc.fontSize(font)

    const padding = 5
    const header = block.header.map(cleanInline)
    let widths = []
    for (let c = 0; c < columns; c += 1) {
      let widest = doc.widthOfString(header[c] || '', { width: 200 })
      for (const row of block.rows) widest = Math.max(widest, Math.min(220, doc.widthOfString(cleanInline(row[c] || ''), { width: 220 })))
      widths.push(Math.min(200, widest + padding * 2))
    }
    const total = widths.reduce((a, b) => a + b, 0)
    if (total > CONTENT_W) {
      const scale = CONTENT_W / total
      widths = widths.map((w) => Math.max(44, w * scale))
      const adjusted = widths.reduce((a, b) => a + b, 0)
      if (adjusted > CONTENT_W) widths[widths.length - 1] -= adjusted - CONTENT_W
    }

    // a URL column is useless when squeezed: give it whatever width is left over
    const spare = CONTENT_W - widths.reduce((a, b) => a + b, 0)
    if (spare > 2) {
      const urlColumn = block.rows.reduce(
        (found, row) => (found >= 0 ? found : row.findIndex((cell) => /^https?:\/\//.test(String(cell || '').trim()))),
        -1,
      )
      if (urlColumn >= 0) widths[urlColumn] += spare
    }

    const xOf = []
    let x = MARGIN
    for (const width of widths) {
      xOf.push(x)
      x += width
    }

    const fit = (text, maxWidth) => {
      if (doc.widthOfString(text) <= maxWidth) return text
      let low = 0
      let high = text.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (doc.widthOfString(`${text.slice(0, mid)}…`) <= maxWidth) low = mid
        else high = mid - 1
      }
      return `${text.slice(0, low)}…`
    }

    const cellDisplay = (value, columnWidth) => {
      const raw = cleanInline(value || '')
      if (!/^https?:\/\//.test(raw)) return raw
      // the full URL stays clickable; the printed form only needs to identify it
      try {
        const url = new URL(raw)
        return fit(`${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`, Math.max(24, columnWidth))
      } catch {
        return fit(raw, Math.max(24, columnWidth))
      }
    }

    const measure = (row) => {
      let height = 0
      doc.fontSize(font)
      for (let c = 0; c < columns; c += 1) {
        const cell = cellDisplay(row[c], widths[c] - padding * 2)
        height = Math.max(height, doc.heightOfString(cell, { width: widths[c] - padding * 2, lineGap: 2 }))
      }
      return height + padding * 2
    }

    const drawRow = (row, { head = false } = {}) => {
      const height = measure(row)
      if (this.y + height > BOTTOM) {
        this.newPage()
        drawRow(header, { head: true })
      }
      if (head) doc.rect(MARGIN, this.y, CONTENT_W, height).fill('#f1f5f9')
      const top = this.y
      doc.fontSize(font)
      for (let c = 0; c < columns; c += 1) {
        const raw = cleanInline(row[c] || '')
        const link = /^https?:\/\//.test(raw) ? raw : undefined
        doc.fillColor(head ? '#0f172a' : '#374151').text(cellDisplay(row[c], widths[c] - padding * 2), xOf[c] + padding, top + padding, {
          width: widths[c] - padding * 2,
          lineGap: 2,
          link,
        })
      }
      this.y = top + height
      doc.moveTo(MARGIN, this.y).lineTo(MARGIN + CONTENT_W, this.y).lineWidth(0.5).strokeColor(RULE).stroke()
    }

    if (this.y + 30 > BOTTOM) this.newPage()
    drawRow(header, { head: true })
    for (const row of block.rows) drawRow(row)
    this.y += 7
  }

  structure(model) {
    const doc = this.doc
    doc.fontSize(15).fillColor(INK)
    const heading = '课程结构图'
    this.ensure(28)
    doc.text(heading, MARGIN, this.y, { width: CONTENT_W })
    this.y = doc.y + 4
    doc.fontSize(8.5).fillColor(MUTED).text(
      `${model.stats.chapters} 章 · ${model.stats.concepts} 个要点${model.stats.blocked ? ` · ${model.stats.blocked} 个前置缺口` : ''}。线条表示课程顺序，不代表知识点依赖。`,
      MARGIN,
      this.y,
      { width: CONTENT_W },
    )
    this.y = doc.y + 12
    drawStructure(doc, model, { x: MARGIN, y: this.y, width: CONTENT_W, bottom: BOTTOM, title: heading })
    // the caller starts body text on a fresh page; see buildPdf()
  }
}

function renderCover(doc, { courseTitle, subtitle, meta }) {
  const docTop = TOP
  doc.rect(0, 0, PAGE.width, 6).fill(ACCENT)
  doc.fontSize(9).fillColor(MUTED).text('课程助手 · COURSE ASSISTANT', MARGIN, docTop + 18, { width: CONTENT_W, characterSpacing: 0.6 })
  doc.moveTo(MARGIN, docTop + 36).lineTo(MARGIN + 72, docTop + 36).lineWidth(2).strokeColor(ACCENT).stroke()

  const title = cleanInline(courseTitle || '课程报告')
  doc.fontSize(24).fillColor(INK)
  const titleHeight = doc.heightOfString(title, { width: CONTENT_W, lineGap: 5 })
  doc.text(title, MARGIN, docTop + 78, { width: CONTENT_W, lineGap: 5 })
  let y = docTop + 78 + titleHeight + 10

  if (subtitle) {
    doc.fontSize(12).fillColor(ACCENT).text(subtitle, MARGIN, y, { width: CONTENT_W })
    y = doc.y + 6
  }

  y += 18
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(0.6).strokeColor(RULE).stroke()
  y += 14

  doc.fontSize(9.5).fillColor(MUTED)
  for (const line of meta || []) {
    doc.text(line, MARGIN, y, { width: CONTENT_W, lineGap: 2 })
    y = doc.y + 3
  }

  const note = '本报告由课程助手根据课件自动整理。引用页码指课件原始页；生成式内容可能有误，请以课件与教师讲解为准。'
  doc.fontSize(8.5).fillColor(FAINT).text(note, MARGIN, PAGE.height - 150, { width: CONTENT_W, lineGap: 3 })
  doc.fontSize(8).fillColor(FAINT).text('Noto Sans SC · SIL Open Font License 1.1', MARGIN, PAGE.height - 84, { width: CONTENT_W })
}

function addFooters(doc, { courseTitle }) {
  const range = doc.bufferedPageRange()
  const total = range.count
  for (let i = 0; i < total; i += 1) {
    doc.switchToPage(range.start + i)
    if (i === 0) continue
    // pdfkit pushes text that crosses the bottom margin onto a new page; the
    // footer lives inside that margin on purpose, so lift the limit for it.
    const bottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.moveTo(MARGIN, PAGE.height - 42).lineTo(MARGIN + CONTENT_W, PAGE.height - 42).lineWidth(0.4).strokeColor(RULE).stroke()
    doc.fontSize(7.8).fillColor(FAINT)
    doc.text(cleanInline(courseTitle || '课程报告'), MARGIN, PAGE.height - 34, { width: CONTENT_W - 130, lineBreak: false, ellipsis: true })
    doc.text(`第 ${i + 1} 页 / 共 ${total} 页`, MARGIN + CONTENT_W - 130, PAGE.height - 34, { width: 130, align: 'right', lineBreak: false })
    doc.page.margins.bottom = bottom
  }
}

/**
 * Render Markdown into a PDF buffer.
 *
 * @param {object} input
 * @param {string} input.markdown
 * @param {string} [input.courseTitle]
 * @param {string} [input.subtitle]
 * @param {string[]} [input.meta]
 * @param {object|null} [input.structure] result of buildStructure()
 * @returns {Promise<Buffer>}
 */
export async function buildPdf({ markdown, courseTitle = '课程报告', subtitle = '', meta = [], structure = null }) {
  if (!pdfFontAvailable()) {
    throw new Error(`缺少中文字体：${FONT_PATH}`)
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: TOP, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    autoFirstPage: false,
    info: { Title: cleanInline(courseTitle), Author: '课程助手', Creator: 'dsh-course-assistant' },
  })

  const chunks = []
  const done = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  doc.registerFont('Body', FONT_PATH)
  doc.font('Body')

  doc.addPage()
  renderCover(doc, { courseTitle, subtitle, meta })

  const renderer = new Renderer(doc, { courseTitle, subtitle })
  if (structure && structure.nodes?.length) {
    doc.addPage()
    renderer.y = TOP
    renderer.structure(structure)
    // the diagram reserves the rest of its page: body text starts fresh, never
    // flowing around the last row of cards
    doc.addPage()
    renderer.y = TOP
  }

  const blocks = parseBlocks(markdown)
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (block.level === 1) {
        // the cover carries the report title; a leading H1 would only duplicate it
        continue
      }
      renderer.heading(block.level, block.text)
    } else if (block.type === 'paragraph') {
      renderer.paragraph(block.text)
    } else if (block.type === 'list') {
      renderer.list(block)
    } else if (block.type === 'quote') {
      renderer.quote(block.text)
    } else if (block.type === 'code') {
      renderer.code(block.text)
    } else if (block.type === 'table') {
      renderer.table(block)
    } else if (block.type === 'rule') {
      renderer.rule()
    }
  }

  addFooters(doc, { courseTitle })
  doc.end()
  return done
}

export const __test__ = { parseBlocks, cleanInline, splitRow, isTableDivider }
