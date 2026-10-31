/**
 * Pictures inside a deck.
 *
 * The OOXML parser only reads text runs and tables, so a slide that is mostly a
 * screenshot or a diagram contributed nothing to the summary. This module finds
 * those pictures (and only those worth reading) so the OCR pass can append their
 * text to the slide.
 *
 * Zero dependencies: ZIP is read by core/zip.js, dimensions by header parsing.
 */
import { createHash } from 'node:crypto'
import { readZip } from './zip.js'

/** A logo or a decorative rule is never worth an OCR round-trip. */
export const MIN_IMAGE_BYTES = 8 * 1024
export const MIN_IMAGE_SIDE = 120
export const MAX_IMAGES_PER_DECK = 40

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/i
const RELS_RE = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/i

/**
 * Dimensions from the file header — JPEG (SOFn) and PNG (IHDR) cover essentially
 * every slide picture; anything else reports null and is filtered by size only.
 * @returns {{ width: number|null, height: number|null, type: string }}
 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return { width: null, height: null, type: 'unknown' }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buf[offset + 1]
      const length = buf.readUInt16BE(offset + 2)
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), type: 'jpeg' }
      }
      offset += 2 + length
    }
    return { width: null, height: null, type: 'jpeg' }
  }
  return { width: null, height: null, type: 'unknown' }
}

/** rId → media path, per slide, from the slide's rels part. */
function relationsOf(zip, slideNumber) {
  const relsName = `ppt/slides/_rels/slide${slideNumber}.xml.rels`
  const xml = zip.has(relsName) ? zip.read(relsName)?.toString('utf8') : ''
  const map = new Map()
  for (const match of String(xml).matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0]
    const id = /Id="([^"]+)"/.exec(tag)?.[1]
    const target = /Target="([^"]+)"/.exec(tag)?.[1]
    if (!id || !target) continue
    // Targets are relative to ppt/slides/: "../media/image1.png"
    const normalized = target.replace(/^\.\.\//, 'ppt/').replace(/^\/?ppt\/slides\//, 'ppt/')
    map.set(id, normalized)
  }
  return map
}

/**
 * Slide part → display position. `slide7.xml` is not necessarily the 7th slide:
 * the order lives in `p:sldIdLst`. Page numbers must follow the *display* order,
 * otherwise OCR text lands on the wrong slide (and so does `（p.12）`).
 */
function slideOrder(zip) {
  const pres = zip.has('ppt/presentation.xml') ? zip.read('ppt/presentation.xml')?.toString('utf8') || '' : ''
  const relsXml = zip.has('ppt/_rels/presentation.xml.rels')
    ? zip.read('ppt/_rels/presentation.xml.rels')?.toString('utf8') || ''
    : ''
  const rels = new Map()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(match[0])?.[1]
    const target = /Target="([^"]+)"/.exec(match[0])?.[1]
    if (id && target) rels.set(id, target.replace(/^\.\.\//, 'ppt/').replace(/^\/?ppt\//, 'ppt/'))
  }
  const order = new Map()
  let position = 0
  for (const match of pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    position += 1
    const target = rels.get(match[1])
    if (target) order.set(target, position)
  }
  return order
}

/**
 * @param {Buffer} buf pptx bytes
 * @param {{ minBytes?: number, minSide?: number, max?: number }} [limits]
 * @returns {Array<{ slide:number, name:string, sha:string, bytes:number, width:number|null, height:number|null, type:string, data:Buffer }>}
 */
export function listPptxImages(buf, limits = {}) {
  const minBytes = limits.minBytes ?? MIN_IMAGE_BYTES
  const minSide = limits.minSide ?? MIN_IMAGE_SIDE
  const max = limits.max ?? MAX_IMAGES_PER_DECK
  const zip = readZip(buf)
  const seen = new Set()
  const out = []
  const order = slideOrder(zip)
  const slides = zip
    .names()
    .map((name) => ({ name, match: SLIDE_RE.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))

  for (const { name, match } of slides) {
    const part = Number(match[1])
    const slide = order.get(name) || part
    const xml = zip.read(name)?.toString('utf8') || ''
    const rels = relationsOf(zip, part)
    const embeds = new Set()
    for (const blip of String(xml).matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) embeds.add(blip[1])
    for (const rid of embeds) {
      const mediaPath = rels.get(rid)
      if (!mediaPath || !zip.has(mediaPath)) continue
      const data = zip.read(mediaPath)
      if (!data || data.length < minBytes) continue
      const sha = createHash('sha256').update(data).digest('hex').slice(0, 16)
      if (seen.has(sha)) continue
      const size = imageSize(data)
      if (size.width && size.height && Math.min(size.width, size.height) < minSide) continue
      seen.add(sha)
      out.push({ slide, name: mediaPath, sha, bytes: data.length, ...size, data })
      if (out.length >= max) return out
    }
  }
  return out
}

/** Append OCR text to the slide it belongs to, keeping the source visible. */
export function attachImageText(page, texts) {
  const body = texts.map((text) => String(text || '').trim()).filter(Boolean)
  if (!body.length) return page
  return { ...page, text: `${page.text || ''}\n[图片] ${body.join(' / ')}`.trim() }
}
