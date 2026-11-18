import { stripHeadingNumber } from './titles.js'

/**
 * Structure diagram for the PDF report.
 *
 * The Markdown report already carries an indented tree and a Mermaid block, but
 * neither survives conversion to a printable PDF. This module turns the same
 * outline (course → chapters → section headings) into a small, deterministic
 * card layout that is drawn with vector primitives, so it stays sharp at any
 * zoom and needs no browser, image rasteriser or JavaScript runtime.
 *
 * Deliberately boring: cards in a grid, one bus line, straight connectors.
 * A radial "mind map" looks nicer in screenshots but turns into spaghetti once
 * a course has more than about eight chapters.
 */

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function usable(text) {
  const value = clip(text, 40)
  if (!value) return ''
  // page furniture that slipped into section titles
  if (/^(幻灯片|slide)\s*\d+/i.test(value)) return ''
  if (/^\d+$/.test(value)) return ''
  return value
}

/**
 * @param {{ courseTitle?: string, chapters?: object[], plan?: object[] }} input
 */
export function buildStructure({ courseTitle, chapters = [], plan = [] }) {
  const blocked = new Set((plan || []).filter((step) => step.blocked).map((step) => step.index))
  const nodes = []
  for (const [position, chapter] of (chapters || []).entries()) {
    const index = Number.isFinite(chapter.index) ? chapter.index : position + 1
    const title = usable(stripHeadingNumber(chapter.title) || chapter.title)
    if (!title) continue
    const seen = new Set()
    const concepts = []
    for (const sub of chapter.subs || []) {
      const value = usable(sub)
      const key = value.toLowerCase()
      if (!value || seen.has(key) || value === title) continue
      seen.add(key)
      concepts.push(value)
      if (concepts.length >= 3) break
    }
    nodes.push({ index, title, concepts, blocked: blocked.has(index) })
  }
  return {
    courseTitle: clip(courseTitle || '课程', 60),
    nodes,
    stats: {
      chapters: nodes.length,
      concepts: nodes.reduce((total, node) => total + node.concepts.length, 0),
      blocked: nodes.filter((node) => node.blocked).length,
    },
  }
}

function columnsFor(count) {
  if (count <= 3) return 1
  if (count <= 8) return 2
  return 3
}

/**
 * Draw the diagram starting at (x, y). Adds pages via `doc.addPage()` when the
 * cards do not fit; the caller owns the surrounding headings and captions.
 *
 * @returns {{ pages: number, height: number }}
 */
export function drawStructure(doc, model, { x, y, width, bottom, title = '' } = {}) {
  const nodes = model?.nodes || []
  if (!nodes.length) return { pages: 0, height: 0 }

  const cols = columnsFor(nodes.length)
  const gapX = 12
  const gapY = 12
  const cardW = (width - gapX * (cols - 1)) / cols
  const cardH = 104
  const pad = 8
  const rootH = 34
  const busGap = 20
  let page = 0

  const startPage = () => {
    page += 1
    if (page > 1) {
      doc.addPage()
      y = doc.page.margins.top
      if (title) {
        doc.fontSize(9).fillColor('#6b7280').text(`${title}（续）`, x, y, { width })
        y += 16
      }
    }
    return y
  }

  let cursor = startPage()

  // Root box. Only on the first page: continuation pages start from the cards
  // directly, otherwise the schema repeats without adding information.
  if (page === 1) {
    const rootW = Math.min(360, width)
    const rootX = x + (width - rootW) / 2
    doc.roundedRect(rootX, cursor, rootW, rootH, 8).fillAndStroke('#eff6ff', '#93c5fd')
    doc
      .fontSize(10.5)
      .fillColor('#1e3a8a')
      .text(model.courseTitle || '课程', rootX + 10, cursor + 9, { width: rootW - 20, height: rootH - 14, ellipsis: true })
    cursor += rootH + busGap
  }

  const rowsPerPage = Math.max(1, Math.floor((bottom - cursor + gapY) / (cardH + gapY)))
  const perPage = rowsPerPage * cols

  for (let i = 0; i < nodes.length; i += 1) {
    const positionOnPage = i % perPage
    if (positionOnPage === 0 && i > 0) {
      cursor = startPage()
      doc.moveTo(x, cursor - 6).lineTo(x + width, cursor - 6).lineWidth(0.5).strokeColor('#e5e7eb').stroke()
    }
    const row = Math.floor(positionOnPage / cols)
    const col = positionOnPage % cols
    const cardX = x + col * (cardW + gapX)
    const cardY = cursor + row * (cardH + gapY)
    const centerX = cardX + cardW / 2

    // Connectors: root → first row as elbows, then a hairline between stacked
    // cards of the same column. They show reading order, not dependencies.
    if (page === 1 && row === 0 && i < perPage) {
      const rootBottom = cursor - busGap
      const rootCenter = x + width / 2
      const elbowY = rootBottom + busGap / 2
      doc.moveTo(rootCenter, rootBottom).lineTo(rootCenter, elbowY).lineTo(centerX, elbowY).lineTo(centerX, cardY)
      doc.lineWidth(0.9).strokeColor('#cbd5e1').stroke()
    } else if (row > 0) {
      doc.moveTo(centerX, cardY - gapY + 3).lineTo(centerX, cardY - 3).lineWidth(0.8).strokeColor('#dbe3ee').stroke()
    }

    const accent = nodes[i].blocked ? '#b45309' : '#1d4ed8'
    doc.roundedRect(cardX, cardY, cardW, cardH, 6).fillAndStroke(nodes[i].blocked ? '#fffbeb' : '#f9fafb', nodes[i].blocked ? '#fcd34d' : '#d1d5db')
    doc
      .fontSize(8)
      .fillColor('#9ca3af')
      .text(`第 ${nodes[i].index} 章${nodes[i].blocked ? ' · 前置未满足' : ''}`, cardX + pad, cardY + pad, { width: cardW - 2 * pad })
    doc
      .fontSize(9.5)
      .fillColor('#111827')
      .text(nodes[i].title, cardX + pad, cardY + pad + 12, { width: cardW - 2 * pad, height: 30, ellipsis: true, lineGap: 1 })
    let lineY = cardY + pad + 46
    for (const concept of nodes[i].concepts) {
      doc.fontSize(7.5).fillColor('#4b5563').text(`· ${concept}`, cardX + pad, lineY, { width: cardW - 2 * pad, height: 13, ellipsis: true })
      lineY += 14
    }
    if (!nodes[i].concepts.length) {
      doc.fontSize(7.5).fillColor('#9ca3af').text('（无小节标题）', cardX + pad, lineY, { width: cardW - 2 * pad })
    }
    doc.moveTo(cardX + pad, cardY + cardH - 9).lineTo(cardX + pad + 18, cardY + cardH - 9).lineWidth(1.6).strokeColor(accent).stroke()
  }

  const usedRows = Math.ceil(nodes.length / cols)
  return { pages: page, height: usedRows * (cardH + gapY) - gapY + (page === 1 ? rootH + busGap : 0) }
}
