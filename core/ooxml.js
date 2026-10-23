/**
 * OOXML (.pptx / .docx) → { pages, blocks, title }.
 *
 * Only the parts that carry course structure are read:
 *   pptx: presentation.xml + slides/*.xml (shape placeholders, run sizes, tables)
 *   docx: word/document.xml (paragraph styles, outline levels, tables)
 *
 * Structure conventions follow python-pptx (MIT, https://github.com/scanny/python-pptx)
 * and microsoft/markitdown (MIT, https://github.com/microsoft/markitdown).
 */
import { readZip } from './zip.js'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(s) {
  if (!s || s.indexOf('&') === -1) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[g] ?? m
  })
}

const squash = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()

/* ------------------------------- pptx ------------------------------- */

function parseRels(xml) {
  const map = new Map()
  for (const m of String(xml).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1]
    const id = /\bId="([^"]+)"/.exec(attrs)
    const target = /\bTarget="([^"]+)"/.exec(attrs)
    const type = /\bType="([^"]+)"/.exec(attrs)
    if (id && target) map.set(id[1], { target: target[1], type: type ? type[1] : '' })
  }
  return map
}

function resolvePart(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1)
  const parts = `${baseDir}/${target}`.split('/')
  const out = []
  for (const p of parts) {
    if (p === '.' || p === '') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

/** All paragraphs of one <p:sp>/<p:txBody> block, joined with newlines. */
function shapeParagraphs(xml) {
  const out = []
  for (const pm of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = ''
    const body = pm[1]
    for (const tok of body.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) {
      if (tok[1] === undefined) line += '\n'
      else line += decodeXml(tok[1])
    }
    if (line.trim()) out.push(line.trim())
  }
  return out
}

function shapeInfo(xml) {
  const ph = /<p:ph\b([^>]*)\/?>/.exec(xml)
  const phType = ph ? (/\btype="([^"]+)"/.exec(ph[1]) || [])[1] || 'body' : ''
  const sizes = [...xml.matchAll(/<a:rPr\b[^>]*\bsz="(\d+)"/g)].map((m) => Number(m[1]))
  const paras = shapeParagraphs(xml)
  return {
    phType,
    size: sizes.length ? Math.max(...sizes) : 0,
    paras,
    text: paras.join('\n'),
  }
}

function extractSlide(xml) {
  const shapes = []
  for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) shapes.push(shapeInfo(sp[0]))
  const tables = []
  for (const tbl of xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)) {
    for (const tr of tbl[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
      const cells = []
      for (const tc of tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)) {
        cells.push(shapeParagraphs(tc[0]).join(' '))
      }
      if (cells.some((c) => c)) tables.push(cells.join(' | '))
    }
  }
  const skip = new Set(['dt', 'ftr', 'sldNum'])
  const body = shapes.filter((s) => s.text && !skip.has(s.phType))
  const titled = body.find((s) => s.phType === 'title' || s.phType === 'ctrTitle')
  const biggest = [...body].sort((a, b) => b.size - a.size)[0]
  let title = ''
  if (titled) title = titled.paras[0] || ''
  if (!title && biggest && biggest.size >= 1600) title = biggest.paras[0] || ''
  const lines = []
  if (title) lines.push(title)
  for (const s of body) {
    for (const p of s.paras) {
      if (p === title && s === titled) continue
      lines.push(p)
    }
  }
  for (const t of tables) lines.push(t)
  const bodySizes = body
    .filter((s) => s !== titled && s.size > 0)
    .map((s) => s.size)
    .sort((a, b) => a - b)
  return {
    title: squash(title),
    text: lines.join('\n').trim(),
    titleSize: titled?.size || biggest?.size || 0,
    bodySize: bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 0,
  }
}

/** `secHead` marks a section-title slide in the deck's own layout. */
function slideLayoutType(zip, slidePart) {
  try {
    const base = slidePart.slice(slidePart.lastIndexOf('/') + 1)
    const relsXml = zip.text(`ppt/slides/_rels/${base}.rels`)
    if (!relsXml) return ''
    for (const rel of parseRels(relsXml).values()) {
      if (!/slideLayout/.test(rel.type || '')) continue
      const part = resolvePart('ppt/slides', rel.target)
      const xml = zip.text(part) || ''
      return (/<p:sldLayout\b[^>]*\btype="([^"]+)"/.exec(xml) || [])[1] || ''
    }
  } catch {}
  return ''
}

/** Sections written by PowerPoint 2010+ (`p14:sectionLst` in presentation.xml). */
function readSections(pres, rels) {
  const list = []
  const sectionRe = /<p14:section\b([^>]*)>([\s\S]*?)<\/p14:section>/g
  for (const m of pres.matchAll(sectionRe)) {
    const name = (/name="([^"]*)"/.exec(m[1]) || [])[1] || ''
    const ids = [...m[2].matchAll(/<p14:sldId\b[^>]*\bid="(\d+)"/g)].map((x) => x[1])
    list.push({ name: decodeXml(name), ids })
  }
  return list
}

function parsePptxSections(pres, rels, order) {
  const numeric = new Map()
  for (const m of pres.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"[^>]*\br:id="([^"]+)"/g)) {
    const rel = rels.get(m[2])
    if (rel) numeric.set(m[1], resolvePart('ppt', rel.target))
  }
  const sections = readSections(pres, rels)
    .map((section) => {
      const parts = section.ids.map((id) => numeric.get(id)).filter(Boolean)
      const pages = parts.map((part) => order.indexOf(part)).filter((i) => i >= 0).map((i) => i + 1)
      return { name: section.name, pages: [...new Set(pages)].sort((a, b) => a - b) }
    })
    .filter((s) => s.pages.length)
  return sections
}

export const __debug = { readSections, parsePptxSections }

export function parsePptx(buf, fileName) {
  const zip = readZip(buf)
  const pres = zip.text('ppt/presentation.xml') || ''
  const rels = parseRels(zip.text('ppt/_rels/presentation.xml.rels') || '')
  const order = []
  for (const m of pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const rel = rels.get(m[1])
    if (rel) order.push(resolvePart('ppt', rel.target))
  }
  if (!order.length) {
    order.push(
      ...zip
        .names()
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1])),
    )
  }
  const pages = []
  for (const name of order) {
    const xml = zip.text(name)
    if (!xml) continue
    const s = extractSlide(xml)
    if (!s.text) continue
    // speaker notes usually hold the full script; without them a slide deck
    // reads like a list of titles
    const notes = slideNotes(zip, name)
    const text = notes ? `${s.text}\n【备注】${notes}` : s.text
    pages.push({
      index: pages.length + 1,
      title: s.title,
      text,
      notes,
      layout: slideLayoutType(zip, name),
      titleSize: s.titleSize,
      bodySize: s.bodySize,
    })
  }
  const title = guessDeckTitle(pages, fileName)
  const sections = parsePptxSections(pres, rels, order)
  return { kind: 'pptx', title, pages, blocks: [], sections }
}

/** Notes slide text for one slide part, or '' when the deck has none. */
function slideNotes(zip, slidePart) {
  const base = slidePart.slice(slidePart.lastIndexOf('/') + 1)
  const relsXml = zip.text(`ppt/slides/_rels/${base}.rels`)
  if (!relsXml) return ''
  const rels = parseRels(relsXml)
  for (const rel of rels.values()) {
    if (!/notesSlide/.test(rel.type || '')) continue
    const part = resolvePart('ppt/slides', rel.target)
    const xml = zip.text(part)
    if (!xml) continue
    const lines = []
    for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
      const ph = /<p:ph\b([^>]*)\/?>/.exec(sp[0])
      const type = ph ? (/\btype="([^"]+)"/.exec(ph[1]) || [])[1] || 'body' : ''
      if (['sldNum', 'ftr', 'hdr', 'dt'].includes(type)) continue
      lines.push(...shapeParagraphs(sp[0]))
    }
    return squash(lines.join('\n'))
  }
  return ''
}

function guessDeckTitle(pages, fileName) {
  const first = pages[0]
  if (first && first.title) return first.title
  return String(fileName || '').replace(/\.[^.]+$/, '')
}

/* ------------------------------- docx ------------------------------- */

const HEADING_STYLE = /^(?:Heading|heading|标题)\s*(\d)$/

function headingLevel(xml) {
  const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)
  if (!pPr) return 0
  const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(pPr[1])
  if (style) {
    const m = HEADING_STYLE.exec(style[1])
    if (m) return Math.min(9, Number(m[1]))
    if (/^TOC/i.test(style[1])) return 0
  }
  const lvl = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(pPr[1])
  if (lvl) return Math.min(9, Number(lvl[1]) + 1)
  return 0
}

function paragraphText(xml) {
  let out = ''
  for (const tok of xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g)) {
    if (tok[1] !== undefined) out += decodeXml(tok[1])
    else if (tok[0].startsWith('<w:tab')) out += '\t'
    else out += '\n'
  }
  return out
}

export function parseDocx(buf, fileName) {
  const zip = readZip(buf)
  const doc = zip.text('word/document.xml') || ''
  const body = (/<w:body>([\s\S]*)<\/w:body>/.exec(doc) || [, doc])[1]
  const blocks = []
  let current = null
  let pre = []

  const push = (text) => {
    if (current) current.text.push(text)
    else pre.push(text)
  }

  for (const m of body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const chunk = m[0]
    if (chunk.startsWith('<w:tbl')) {
      for (const tr of chunk.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = []
        for (const tc of tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)) {
          const t = squash(paragraphText(tc[0]))
          if (t) cells.push(t)
        }
        if (cells.length) push(cells.join(' | '))
      }
      continue
    }
    const level = headingLevel(chunk)
    const text = squash(paragraphText(chunk))
    if (!text) continue
    if (level > 0 && level <= 3) {
      current = { level, title: text, text: [] }
      blocks.push(current)
    } else {
      push(text)
    }
  }

  if (!blocks.length) {
    blocks.push({ level: 1, title: String(fileName || '').replace(/\.[^.]+$/, ''), text: pre })
    pre = []
  } else if (pre.length) {
    blocks[0].text.unshift(...pre)
  }

  const joined = blocks.map((b) => ({ level: b.level, title: b.title, text: b.text.join('\n').trim() }))
  const title = joined[0]?.title || String(fileName || '').replace(/\.[^.]+$/, '')
  return { kind: 'docx', title, pages: [], blocks: joined }
}
