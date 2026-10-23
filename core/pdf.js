/**
 * Lightweight PDF text + bookmark extraction (no dependencies).
 *
 * Only what a lecture handout needs: page text and the outline (/Outlines).
 * Strategy follows PyMuPDF's `doc.get_toc()` precedence (bookmarks first, then
 * text patterns) but the decoder is our own: objects → pages → content streams
 * → ToUnicode CMaps. Mozilla pdf.js (Apache-2.0) was the alternative; embedding
 * it into a profile plugin costs ~10 MB, so we keep the 300 lines we need.
 *
 * Limits: scanned pages have no text layer (needs OCR), encrypted PDFs are
 * rejected, and Type0 fonts without /ToUnicode decode to nothing.
 */
import { inflateRawSync, inflateSync } from 'node:zlib'

const MAX_BYTES = 60 * 1024 * 1024

/* --------------------------- low-level lexer --------------------------- */

class Lexer {
  constructor(s) {
    this.s = s
    this.i = 0
  }
  skip() {
    const s = this.s
    while (this.i < s.length) {
      const c = s[this.i]
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') this.i++
      else if (c === '%') {
        while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++
      } else break
    }
  }
  /** returns {type, value} or null at EOF */
  next() {
    this.skip()
    const s = this.s
    if (this.i >= s.length) return null
    const c = s[this.i]
    if (c === '/' ) {
      this.i++
      const start = this.i
      while (this.i < s.length && !/[\s()<>[\]{}/%]/.test(s[this.i])) this.i++
      return { type: 'name', value: s.slice(start, this.i) }
    }
    if (c === '(') return { type: 'string', value: this.literalString() }
    if (c === '<') {
      if (s[this.i + 1] === '<') { this.i += 2; return { type: 'dict-open' } }
      return { type: 'string', value: this.hexString() }
    }
    if (c === '>') {
      if (s[this.i + 1] === '>') { this.i += 2; return { type: 'dict-close' } }
      this.i++
      return { type: 'junk' }
    }
    if (c === '[') { this.i++; return { type: 'array-open' } }
    if (c === ']') { this.i++; return { type: 'array-close' } }
    if (c === '{') { this.i++; return { type: 'junk' } }
    if (c === '}') { this.i++; return { type: 'junk' } }
    if (c === ')') { this.i++; return { type: 'junk' } }
    const num = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(s.slice(this.i, this.i + 24))
    if (num) {
      this.i += num[0].length
      return { type: 'number', value: Number(num[0]) }
    }
    const start = this.i
    while (this.i < s.length && !/[\s()<>[\]{}/%]/.test(s[this.i])) this.i++
    if (this.i === start) this.i++
    return { type: 'op', value: s.slice(start, this.i) }
  }
  literalString() {
    const s = this.s
    this.i++ // (
    let depth = 1
    let out = ''
    while (this.i < s.length && depth > 0) {
      const c = s[this.i]
      if (c === '\\') {
        const n = s[this.i + 1]
        if (n === 'n') { out += '\n'; this.i += 2 }
        else if (n === 'r') { out += '\r'; this.i += 2 }
        else if (n === 't') { out += '\t'; this.i += 2 }
        else if (n === 'b') { out += '\b'; this.i += 2 }
        else if (n === 'f') { out += '\f'; this.i += 2 }
        else if (n === '(' || n === ')' || n === '\\') { out += n; this.i += 2 }
        else if (n >= '0' && n <= '7') {
          let oct = ''
          let k = 1
          while (k <= 3 && s[this.i + k] >= '0' && s[this.i + k] <= '7') { oct += s[this.i + k]; k++ }
          out += String.fromCharCode(parseInt(oct, 8))
          this.i += k
        } else if (n === '\r' || n === '\n') { this.i += 2 }
        else { out += n || ''; this.i += 2 }
      } else if (c === '(') {
        depth++
        out += c
        this.i++
      } else if (c === ')') {
        depth--
        if (depth > 0) out += c
        this.i++
      } else {
        out += c
        this.i++
      }
    }
    return out
  }
  hexString() {
    const s = this.s
    this.i++ // <
    let hex = ''
    while (this.i < s.length && s[this.i] !== '>') {
      const c = s[this.i]
      if (/[0-9a-fA-F]/.test(c)) hex += c
      this.i++
    }
    this.i++ // >
    if (hex.length % 2) hex += '0'
    let out = ''
    for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16))
    return out
  }
}

/* --------------------------- object scanning --------------------------- */

function findEndobj(s, from) {
  const idx = s.indexOf('endobj', from)
  return idx === -1 ? s.length : idx
}

/** A legitimate lecture PDF never needs more than this; bombs do. */
const MAX_OBJECTS = 200000
const MAX_STREAM_BYTES = 64 * 1024 * 1024

function scanObjects(buf) {
  const s = buf.toString('latin1')
  const objects = new Map()
  const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g
  let m
  while ((m = re.exec(s))) {
    if (objects.size >= MAX_OBJECTS) throw new Error(`PDF has too many objects (> ${MAX_OBJECTS})`)
    const start = m.index + m[0].length
    const end = findEndobj(s, start)
    const body = s.slice(start, end)
    const streamKw = /\bstream\b/.exec(body)
    let dict = body
    let data = null
    if (streamKw) {
      dict = body.slice(0, streamKw.index)
      let dataStart = start + streamKw.index + 6
      if (s[dataStart] === '\r') dataStart++
      if (s[dataStart] === '\n') dataStart++
      const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)
      let dataEnd = -1
      if (lenM) {
        const candidate = dataStart + Number(lenM[1])
        if (s.startsWith('endstream', candidate + 2) || /^\s*endstream/.test(s.slice(candidate, candidate + 20))) {
          dataEnd = candidate
        }
      }
      if (dataEnd < 0) {
        const idx = s.indexOf('endstream', dataStart)
        dataEnd = idx === -1 ? end : idx
        while (dataEnd > dataStart && (s[dataEnd - 1] === '\n' || s[dataEnd - 1] === '\r')) dataEnd--
      }
      data = buf.subarray(dataStart, dataEnd)
    }
    objects.set(Number(m[1]), { num: Number(m[1]), dict, data })
    re.lastIndex = end + 6
  }
  return { objects, text: s }
}

function inflate(data) {
  if (!data || !data.length) return ''
  try {
    return inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES }).toString('latin1')
  } catch {}
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_STREAM_BYTES }).toString('latin1')
  } catch {}
  return null
}

function ascii85Decode(buf) {
  const chunks = []
  let group = []
  const emit = () => {
    let v = 0
    for (const c of group) v = (v * 85 + c) % 4294967296
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v >>> 0, 0)
    chunks.push(b)
    group = []
  }
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c === 0x7e) break // ~> terminator
    if (c === 0x3c && buf[i + 1] === 0x7e) { i++; continue } // <~
    if (c <= 32) continue
    if (c === 0x7a && group.length === 0) { chunks.push(Buffer.alloc(4)); continue } // z
    if (c < 33 || c > 117) continue
    group.push(c - 33)
    if (group.length === 5) emit()
  }
  if (group.length) {
    const keep = group.length - 1
    while (group.length < 5) group.push(84)
    let v = 0
    for (const c of group) v = (v * 85 + c) % 4294967296
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v >>> 0, 0)
    chunks.push(b.subarray(0, keep))
  }
  return Buffer.concat(chunks)
}

function asciiHexDecode(buf) {
  let hex = ''
  for (const c of buf) {
    if (c === 0x3e) break
    const ch = String.fromCharCode(c)
    if (/[0-9a-fA-F]/.test(ch)) hex += ch
  }
  if (hex.length % 2) hex += '0'
  const out = Buffer.alloc(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Apply the stream's /Filter chain (Flate, ASCII85, ASCIIHex). */
function decodeStream(data, dict) {
  if (!data || !data.length) return ''
  const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)
  const list = f ? [...f[1].matchAll(/\/(\w+)/g)].map((m) => m[1]) : []
  let out = data
  for (const name of list) {
    if (name === 'FlateDecode' || name === 'Fl') {
      const inflated = inflateSyncFallback(out)
      if (inflated === null) return ''
      out = inflated
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      out = ascii85Decode(out)
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      out = asciiHexDecode(out)
    } else {
      return '' // image codecs (DCT/JBIG2/CCITT) carry no text
    }
  }
  return out.toString('latin1')
}

function inflateSyncFallback(data) {
  try {
    return inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES })
  } catch {}
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_STREAM_BYTES })
  } catch {}
  return null
}

/** Expand /Type /ObjStm containers so objects that live inside them are found. */
function expandObjectStreams(objects) {
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue
    const body = inflate(obj.data)
    if (!body) continue
    const n = Number((/\/N\s+(\d+)/.exec(obj.dict) || [])[1] || 0)
    const first = Number((/\/First\s+(\d+)/.exec(obj.dict) || [])[1] || 0)
    const header = body.slice(0, first).trim().split(/\s+/).map(Number)
    for (let i = 0; i < n; i++) {
      const num = header[2 * i]
      const off = header[2 * i + 1]
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue
      const from = first + off
      const to = i + 1 < n ? first + header[2 * i + 3] : body.length
      if (objects.has(num) && objects.get(num).data) continue
      objects.set(num, { num, dict: body.slice(from, to), data: null })
    }
  }
}

const refOf = (v) => {
  const m = /^(\d+)\s+\d+\s+R$/.exec(String(v || '').trim())
  return m ? Number(m[1]) : null
}

/** Match a balanced `<< … >>` starting at `from`; nested dicts are common in /Resources. */
function matchDict(s, from) {
  let depth = 0
  for (let i = from; i < s.length - 1; i += 1) {
    if (s[i] === '<' && s[i + 1] === '<') {
      depth += 1
      i += 1
    } else if (s[i] === '>' && s[i + 1] === '>') {
      depth -= 1
      i += 1
      if (depth === 0) return s.slice(from, i + 1)
    }
  }
  return null
}

/**
 * Read `/Key` whose value is either an inline dict or an indirect reference.
 * A regex with `<<[\s\S]*?>>` truncates at the first nested dict, which silently
 * drops every font on pages that carry `/ExtGState <<…>>`.
 */
function dictRef(s, key) {
  const m = new RegExp(`\\/${key}\\s*`).exec(String(s || ''))
  if (!m) return null
  const start = m.index + m[0].length
  if (s.startsWith('<<', start)) {
    const dict = matchDict(s, start)
    return dict ? { dict } : null
  }
  const ref = /^(\d+)\s+\d+\s+R/.exec(s.slice(start, start + 24))
  return ref ? { ref: Number(ref[1]) } : null
}

function dictValue(dict, key) {
  const m = new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|<<[\\s\\S]*?>>|/\\w+|\\d+\\s+\\d+\\s+R|[-\\d.]+)`).exec(dict)
  return m ? m[1] : null
}

/* -------------------------------- fonts -------------------------------- */

/**
 * Parse a TrueType `cmap` table and invert it to GID → Unicode.
 *
 * Idea borrowed from pdf.js (Apache-2.0): a subset font usually keeps its cmap
 * even when the PDF forgot /ToUnicode, so the glyph ids shown by Identity-H can
 * be mapped back to characters. That is the difference between "w\t)Wy°a¼" and
 * real Chinese text.
 */
function parseTtfCmap(buf) {
  if (!buf || buf.length < 12) return null
  try {
    const numTables = buf.readUInt16BE(4)
    let cmapOff = 0
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16
      if (rec + 16 > buf.length) break
      if (buf.toString('ascii', rec, rec + 4) === 'cmap') {
        cmapOff = buf.readUInt32BE(rec + 8)
        break
      }
    }
    if (!cmapOff || cmapOff + 4 > buf.length) return null
    const numSub = buf.readUInt16BE(cmapOff + 2)
    let best = null
    for (let i = 0; i < numSub; i++) {
      const rec = cmapOff + 4 + i * 8
      if (rec + 8 > buf.length) break
      const platform = buf.readUInt16BE(rec)
      const encoding = buf.readUInt16BE(rec + 2)
      const offset = cmapOff + buf.readUInt32BE(rec + 4)
      if (offset + 2 > buf.length) continue
      const format = buf.readUInt16BE(offset)
      const usable = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0
      if (!usable) continue
      if (!best || format === 12) best = { offset, format }
    }
    if (!best) return null
    const map = new Map()
    if (best.format === 4) {
      const segX2 = buf.readUInt16BE(best.offset + 6)
      const segs = segX2 / 2
      const endOff = best.offset + 14
      const startOff = endOff + segX2 + 2
      const deltaOff = startOff + segX2
      const rangeOff = deltaOff + segX2
      if (rangeOff + segX2 > buf.length) return null
      for (let s = 0; s < segs; s++) {
        const end = buf.readUInt16BE(endOff + s * 2)
        const start = buf.readUInt16BE(startOff + s * 2)
        const delta = buf.readInt16BE(deltaOff + s * 2)
        const ro = buf.readUInt16BE(rangeOff + s * 2)
        for (let code = start; code <= end && code !== 0xffff; code++) {
          let gid
          if (ro === 0) {
            gid = (code + delta) & 0xffff
          } else {
            const gi = rangeOff + s * 2 + ro + (code - start) * 2
            if (gi + 1 >= buf.length) break
            gid = buf.readUInt16BE(gi)
            if (gid) gid = (gid + delta) & 0xffff
          }
          if (gid) map.set(gid, String.fromCharCode(code))
        }
      }
    } else if (best.format === 12) {
      const nGroups = buf.readUInt32BE(best.offset + 12)
      for (let i = 0; i < nGroups; i++) {
        const off = best.offset + 16 + i * 12
        if (off + 12 > buf.length) break
        const startChar = buf.readUInt32BE(off)
        const endChar = buf.readUInt32BE(off + 4)
        const startGid = buf.readUInt32BE(off + 8)
        for (let code = startChar; code <= endChar && code - startChar < 65535; code++) {
          map.set(startGid + (code - startChar), String.fromCodePoint(code))
        }
      }
    }
    return map.size ? map : null
  } catch {
    return null
  }
}

const glyphMapCache = new Map()

/** Type0 fonts keep FontDescriptor / CIDToGIDMap on the descendant CIDFont. */
function descendantDict(objects, fontObject) {
  const raw = dictValue(fontObject.dict, 'DescendantFonts')
  const ref = raw ? refOf((raw.match(/(\d+)\s+\d+\s+R/) || [])[1]) : null
  const node = ref ? objects.get(ref) : null
  return node ? node.dict : fontObject.dict
}

/** GID → Unicode for a font that lost /ToUnicode but embeds its TrueType program. */
function embeddedGlyphMap(objects, fontObject) {
  const fontDict = descendantDict(objects, fontObject)
  const descRef = refOf(dictValue(fontDict, 'FontDescriptor'))
  if (!descRef) return null
  const desc = objects.get(descRef)
  if (!desc) return null
  const fileRef = refOf(dictValue(desc.dict, 'FontFile2'))
  if (!fileRef) return null
  if (glyphMapCache.has(fileRef)) return glyphMapCache.get(fileRef)
  const program = collectStream(objects, fileRef)
  const bytes = program ? Buffer.from(program, 'latin1') : null
  const map = bytes ? parseTtfCmap(bytes) : null
  glyphMapCache.set(fileRef, map)
  return map
}

/** /CIDToGIDMap stream (CID → GID) for subset fonts that remap. */
function cidToGidMap(objects, fontObject) {
  const fontDict = descendantDict(objects, fontObject)
  const ref = refOf(dictValue(fontDict, 'CIDToGIDMap'))
  if (!ref) return null
  if (glyphMapCache.has(`cid:${ref}`)) return glyphMapCache.get(`cid:${ref}`)
  const raw = collectStream(objects, ref)
  const map = new Map()
  if (raw) {
    const bytes = Buffer.from(raw, 'latin1')
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const gid = bytes.readUInt16BE(i)
      if (gid) map.set(i / 2, gid)
    }
  }
  glyphMapCache.set(`cid:${ref}`, map.size ? map : null)
  return map.size ? map : null
}

function parseToUnicode(text) {
  const map = new Map()
  let codeBytes = 0
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
  let cm
  while ((cm = cs.exec(text))) codeBytes = Math.max(codeBytes, cm[1].length / 2)

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  let block
  while ((block = bfchar.exec(text))) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1], 16), hexToUnicode(pair[2]))
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  while ((block = bfrange.exec(text))) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1])
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, hexToUnicode(items[c - lo]))
      } else {
        const base = hexToUnicode(m[3].slice(1, -1))
        const code = base.codePointAt(0) || 0
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          map.set(c, String.fromCodePoint(code + (c - lo)))
        }
      }
    }
  }
  return { map, codeBytes: codeBytes || 2 }
}

function hexToUnicode(hex) {
  let out = ''
  for (let i = 0; i < hex.length; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16)
    if (Number.isFinite(code)) out += String.fromCharCode(code)
  }
  return out
}

/* ------------------------------- content ------------------------------- */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

function cjkScore(s) {
  const t = String(s || '').replace(/\s/g, '')
  if (!t) return 0
  let n = 0
  for (const ch of t) if (CJK_RE.test(ch)) n += 1
  return n / t.length
}

let gbkDecoder = null
let big5Decoder = null

/**
 * A PDF string is just bytes. When the font carries no Unicode map, those bytes
 * are frequently GBK/Big5 text that a naive latin1 decode turns into mojibake
 * ("锟斤拷" style). Try the CJK code pages and keep whichever reads as Chinese.
 */
function reinterpretBytes(raw) {
  if (!/[\u0080-\u00ff]/.test(raw)) return raw
  const bytes = Buffer.from(raw, 'latin1')
  let best = raw
  let bestScore = cjkScore(raw)
  for (const kind of ['gbk', 'big5']) {
    try {
      if (kind === 'gbk' && !gbkDecoder) gbkDecoder = new TextDecoder('gbk')
      if (kind === 'big5' && !big5Decoder) big5Decoder = new TextDecoder('big5')
      const decoded = (kind === 'gbk' ? gbkDecoder : big5Decoder).decode(bytes)
      const score = cjkScore(decoded)
      if (score > bestScore + 0.25) {
        best = decoded
        bestScore = score
      }
    } catch {}
  }
  return best
}

function decodeString(raw, font) {
  if (font?.cmap?.size) {
    const step = font.codeBytes || 2
    let out = ''
    for (let i = 0; i + step <= raw.length; i += step) {
      const code = step === 2
        ? (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)
        : raw.charCodeAt(i)
      const hit = font.cmap.get(code)
      if (hit !== undefined) out += hit
      else if (step === 1) out += raw[i]
    }
    return out
  }
  if (font?.twoByte) return ''
  return reinterpretBytes(raw)
}

function contentToText(content, fonts) {
  const lex = new Lexer(content)
  let font = null
  let fontSize = 12
  const lines = []
  let frags = []
  let fragText = ''
  let fragX0 = null
  let fragX1 = null
  let lineY = 0
  let lineSize = 12
  let lineFont = ''
  let x = 0
  let y = 0
  let prevY = null
  let freshBT = true
  let leading = 0
  let lastEndX = null
  const stack = []
  let ctm = [1, 0, 0, 1, 0, 0]
  let tm = [1, 0, 0, 1, 0, 0]
  const gstack = []
  const det = (m) => m[0] * m[3] - m[1] * m[2]
  /** Effective glyph size: Tf × |det(Tm × CTM)|^0.5 (Tz affects width only). */
  const effectiveSize = () => {
    const scale = Math.sqrt(Math.abs(det(tm) * det(ctm)))
    return scale > 0.01 && Number.isFinite(scale) ? fontSize * scale : fontSize
  }
  const compose = (a, b) => [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
  const width = (t) => {
    const size = effectiveSize()
    let w = 0
    for (const ch of t) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.5
    return w
  }
  // glyph-level PDFs jitter the baseline by a fraction of a point; only a move
  // of roughly half a line really is a new line.
  const dyLimit = () => Math.max(2, effectiveSize() * 0.55)
  // a gap wider than ~3 em is a column break, not a word space: keep the pieces
  // apart so the column detector can see them (they are re-joined when the page
  // turns out to be single-column)
  const gapLimit = () => effectiveSize() * 3
  const pushFrag = () => {
    if (fragText.trim()) frags.push({ text: fragText, x0: fragX0 ?? 0, x1: fragX1 ?? fragX0 ?? 0 })
    fragText = ''
    fragX0 = null
    fragX1 = null
  }
  const flush = () => {
    pushFrag()
    if (frags.length) {
      lines.push({
        text: frags.map((f) => f.text).join(' '),
        x0: frags[0].x0,
        x1: frags[frags.length - 1].x1,
        y: lineY,
        size: lineSize,
        font: lineFont,
        fragments: frags,
      })
    }
    frags = []
  }
  const newline = () => {
    flush()
    lastEndX = null
  }
  const show = (raw) => {
    const t = decodeString(raw, font)
    if (!t) return
    const isNewFrag = fragX0 === null
    if (isNewFrag) {
      fragX0 = x
      if (!frags.length && !fragText) {
        lineY = y
        lineSize = effectiveSize()
        lineFont = font?.baseFont || ''
      }
    } else if (lastEndX !== null && x - lastEndX > gapLimit()) {
      pushFrag()
      fragX0 = x
    } else if (lastEndX !== null && x - lastEndX > effectiveSize() * 0.25) {
      // a real x gap means a word break; glyph-by-glyph PDFs must not get spaces
      fragText += ' '
    }
    fragText += t
    lastEndX = x + width(t)
    fragX1 = lastEndX
  }
  for (;;) {
    const tok = lex.next()
    if (!tok) break
    if (tok.type === 'array-open' || tok.type === 'dict-open') {
      stack.push(tok.type)
      continue
    }
    if (tok.type === 'array-close' || tok.type === 'dict-close') {
      stack.pop()
      continue
    }
    if (tok.type === 'string' || tok.type === 'number' || tok.type === 'name') {
      stack.push(tok)
      continue
    }
    if (tok.type !== 'op') continue
    const op = tok.value
    if (op === 'Tf') {
      const name = [...stack].reverse().find((t) => t.type === 'name')
      font = name ? fonts.get(name.value) || null : null
      const size = [...stack].reverse().find((t) => t.type === 'number')
      if (size && size.value > 0 && size.value < 400) fontSize = size.value
    } else if (op === 'Tj' || op === "'" || op === '"') {
      const str = [...stack].reverse().find((t) => t.type === 'string')
      if (op !== 'Tj') newline()
      if (str) show(str.value)
    } else if (op === 'TJ') {
      for (const p of stack) {
        if (p.type === 'string') show(p.value)
        else if (p.type === 'number') x += (-p.value / 1000) * effectiveSize()
      }
    } else if (op === 'q') {
      gstack.push([...ctm])
    } else if (op === 'Q') {
      ctm = gstack.pop() || [1, 0, 0, 1, 0, 0]
    } else if (op === 'cm') {
      const nums = stack.filter((t) => t.type === 'number').map((t) => t.value)
      if (nums.length >= 6) ctm = compose(ctm, nums.slice(0, 6))
    } else if (op === 'Td' || op === 'TD') {
      const nums = stack.filter((t) => t.type === 'number').map((t) => t.value)
      if (nums.length >= 2) {
        // Td is relative to the text-space origin, which BT resets
        const nx = freshBT ? nums[0] : x + nums[0]
        const ny = freshBT ? nums[1] : y + nums[1]
        x = nx
        y = ny
        if (prevY !== null && Math.abs(ny - prevY) > dyLimit()) newline()
        prevY = ny
        freshBT = false
      }
      if (op === 'TD') leading = -nums[1]
    } else if (op === 'Tm') {
      const nums = stack.filter((t) => t.type === 'number').map((t) => t.value)
      if (nums.length >= 6) {
        if (prevY !== null && Math.abs(nums[5] - prevY) > dyLimit()) newline()
        tm = nums.slice(0, 6)
        x = nums[4]
        y = nums[5]
        prevY = nums[5]
        freshBT = false
      }
    } else if (op === 'TL') {
      const n = [...stack].reverse().find((t) => t.type === 'number')
      if (n) leading = n.value
    } else if (op === 'T*') {
      y -= leading || 12
      newline()
    } else if (op === 'BT') {
      x = 0
      y = 0
      tm = [1, 0, 0, 1, 0, 0]
      freshBT = true
    }
    stack.length = 0
  }
  flush()
  return lines
}

/* ---------------------------- column detection ---------------------------- */

/**
 * Two-column papers and textbooks store text in visual order per column, so a
 * naive stream walk reads "left line 1, right line 1, left line 2, …".
 *
 * A page is treated as two columns when a vertical gutter exists that most
 * lines avoid: ≥3 lines wholly left of it, ≥3 wholly right, and few lines
 * crossing it. Wide lines (titles, full-width figures) flush the columns and
 * stay in document order, so sections are never merged across the gutter.
 */
const MIN_COLUMN_LINES = 8
const GUTTER_MIN = 0.34
const GUTTER_MAX = 0.66
const GUTTER_STEP = 0.02

function detectGutter(lines, pageWidth) {
  if (!pageWidth || lines.length < MIN_COLUMN_LINES) return null
  let best = null
  for (let g = GUTTER_MIN; g <= GUTTER_MAX + 1e-9; g += GUTTER_STEP) {
    let crossing = 0
    let left = 0
    let right = 0
    for (const line of lines) {
      const x0 = line.x0 / pageWidth
      const x1 = line.x1 / pageWidth
      if (x0 < g - GUTTER_STEP && x1 > g + GUTTER_STEP) crossing += 1
      else if (x1 <= g) left += 1
      else if (x0 >= g) right += 1
    }
    if (left < 3 || right < 3) continue
    if (crossing > lines.length * 0.18) continue
    const score = Math.min(left, right) / lines.length - crossing / lines.length
    if (!best || score > best.score) best = { gutter: g, score }
  }
  return best && best.score > 0.15 ? best.gutter : null
}

const columnOrder = (list) => [...list].sort((a, b) => b.y - a.y || a.x0 - b.x0)

/** Fragments that share a baseline are one visual line again once ordered. */
function mergeSameLine(fragments) {
  const out = []
  for (const f of fragments) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.y - f.y) < 1) last.text += ` ${f.text}`
    else out.push({ text: f.text, y: f.y })
  }
  return out.filter((line) => line.text.trim())
}

function orderByColumns(lines, pageWidth) {
  if (!pageWidth) return lines
  const fragments = []
  for (const line of lines) {
    if (line.fragments?.length) {
      for (const f of line.fragments) fragments.push({ text: f.text, x0: f.x0, x1: f.x1, y: line.y })
    } else {
      fragments.push({ text: line.text, x0: line.x0, x1: line.x1, y: line.y })
    }
  }
  const gutter = detectGutter(fragments, pageWidth)
  if (!gutter) return lines
  const out = []
  let left = []
  let right = []
  const flushColumns = () => {
    for (const bucket of [left, right]) {
      if (bucket.length) out.push(...mergeSameLine(columnOrder(bucket)))
    }
    left = []
    right = []
  }
  for (const f of fragments) {
    const x0 = f.x0 / pageWidth
    const x1 = f.x1 / pageWidth
    if (x0 < gutter - GUTTER_STEP && x1 > gutter + GUTTER_STEP) {
      flushColumns()
      out.push({ text: f.text, y: f.y })
    } else if (x1 <= gutter) {
      left.push(f)
    } else if (x0 >= gutter) {
      right.push(f)
    } else {
      out.push({ text: f.text, y: f.y })
    }
  }
  flushColumns()
  return out
}

/** /MediaBox may live on the page or be inherited from any /Pages parent. */
function pageWidthOf(objects, page) {
  let node = page
  for (let depth = 0; node && depth < 6; depth += 1) {
    const box = dictValue(node.dict || '', 'MediaBox')
    if (box) {
      const nums = (box.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
      if (nums.length >= 4) {
        const w = Math.abs(nums[2] - nums[0])
        if (w > 0) return w
      }
    }
    const parent = dictRef(node.dict || '', 'Parent')
    node = parent?.ref ? objects.get(parent.ref) : null
  }
  return 0
}

/* -------------------------------- pages -------------------------------- */

function pageList(objects) {
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict))
  const pages = []
  const seen = new Set()
  const walk = (num, depth) => {
    if (depth > 32 || pages.length > 5000) return
    const node = objects.get(num)
    if (!node || seen.has(num)) return
    seen.add(num)
    if (/\/Type\s*\/Page\b/.test(node.dict)) {
      pages.push({ num, dict: node.dict })
      return
    }
    const kids = dictValue(node.dict, 'Kids')
    if (kids && kids.startsWith('[')) {
      for (const r of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(r[1]), depth + 1)
    }
  }
  if (catalog) {
    const root = refOf(dictValue(catalog.dict, 'Pages'))
    if (root) walk(root, 0)
  }
  if (!pages.length) {
    for (const o of objects.values()) {
      if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push({ num: o.num, dict: o.dict })
    }
    pages.sort((a, b) => a.num - b.num)
  }
  return pages
}

function collectStream(objects, ref) {
  const node = objects.get(ref)
  if (!node || !node.data) return ''
  return decodeStream(node.data, node.dict)
}

function pageText(objects, page) {
  const contents = dictValue(page.dict, 'Contents')
  const refs = []
  if (contents && contents.startsWith('[')) {
    for (const m of contents.matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(m[1]))
  } else {
    const r = refOf(contents)
    if (r) refs.push(r)
  }
  const resNode = dictRef(page.dict, 'Resources')
  const resDict = resNode?.dict ?? (resNode?.ref ? objects.get(resNode.ref)?.dict : null) ?? null
  const fonts = new Map()
  if (resDict) {
    const fontNode = dictRef(resDict, 'Font')
    const fd = fontNode?.dict ?? (fontNode?.ref ? objects.get(fontNode.ref)?.dict : null) ?? null
    if (fd) {
      for (const m of fd.matchAll(/\/([^\s/<>\[\]]+)\s+(\d+)\s+\d+\s+R/g)) {
        const fontObj = objects.get(Number(m[2]))
        if (!fontObj) continue
        const sub = (/\/Subtype\s*\/(\w+)/.exec(fontObj.dict) || [])[1]
        const enc = (/\/Encoding\s*\/([\w-]+)/.exec(fontObj.dict) || [])[1]
        const tu = refOf(dictValue(fontObj.dict, 'ToUnicode'))
        let cmap = null
        let codeBytes = sub === 'Type0' || enc === 'Identity-H' ? 2 : 1
        if (tu) {
          const stream = collectStream(objects, tu)
          if (stream) {
            const parsed = parseToUnicode(stream)
            if (parsed.map.size) {
              cmap = parsed.map
              codeBytes = parsed.codeBytes
            }
          }
        }
        // no /ToUnicode: recover characters from the embedded font's own cmap
        if (!cmap && (sub === 'Type0' || enc === 'Identity-H')) {
          const gidMap = embeddedGlyphMap(objects, fontObj)
          if (gidMap?.size) {
            const cidMap = cidToGidMap(objects, fontObj)
            if (cidMap) {
              const composed = new Map()
              for (const [cid, gid] of cidMap) {
                const ch = gidMap.get(gid)
                if (ch) composed.set(cid, ch)
              }
              if (composed.size) {
                cmap = composed
                codeBytes = 2
              }
            } else {
              cmap = gidMap
              codeBytes = 2
            }
          }
        }
        fonts.set(m[1], { cmap, codeBytes, twoByte: codeBytes === 2, baseFont: dictValue(fontObj.dict, 'BaseFont') || '' })
      }
    }
  }
  const collected = []
  for (const ref of refs) {
    const content = collectStream(objects, ref)
    if (content) collected.push(...contentToText(content, fonts))
  }
  if (!collected.length) return { text: '', lines: [] }
  const ordered = orderByColumns(collected, pageWidthOf(objects, page))
  return { text: cleanup(ordered.map((line) => line.text).join('\n')), lines: ordered }
}

/**
 * Heading signals from the text layer: the largest font on the page and the
 * line it belongs to. PowerPoint exports keep the real size in `Tf`, so a title
 * slide can be told from a body slide without any OCR.
 */
function headingOf(lines) {
  if (!lines?.length) return null
  const sized = lines.filter((line) => line.text.trim().length >= 2 && line.size > 0)
  if (!sized.length) return null
  const biggest = sized.reduce((a, b) => (b.size > a.size ? b : a), sized[0])
  const bold = /\b(bold|black|heavy|semibold|demi)\b/i.test(String(biggest.font || ''))
  return { size: Math.round(biggest.size * 10) / 10, bold, text: biggest.text.slice(0, 60) }
}

function cleanup(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/* ------------------------------- outline ------------------------------- */

function decodePdfTextString(tok) {
  // tok is already a decoded literal (latin1-ish) or UTF-16BE hex payload
  if (tok.length >= 2 && tok.charCodeAt(0) === 0xfe && tok.charCodeAt(1) === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < tok.length; i += 2) out += String.fromCharCode((tok.charCodeAt(i) << 8) | tok.charCodeAt(i + 1))
    return out
  }
  return tok
}

function readOutline(objects) {
  const root = [...objects.values()].find((o) => /\/Type\s*\/Outlines/.test(o.dict))
  if (!root) return []
  const items = []
  const pageOrder = new Map(pageList(objects).map((p, i) => [p.num, i + 1]))
  const destPage = (dict) => {
    const dest = dictValue(dict, 'Dest')
    let ref = dest ? refOf(dest) : null
    if (!ref) {
      const arr = dest && dest.startsWith('[') ? dest : null
      if (arr) ref = refOf((arr.match(/(\d+\s+\d+\s+R)/) || [])[1])
    }
    if (!ref) {
      const a = dictValue(dict, 'A')
      if (a && a.startsWith('<<')) {
        const d = dictValue(a, 'D')
        ref = d ? refOf(d) || refOf((d.match(/(\d+\s+\d+\s+R)/) || [])[1]) : null
      }
    }
    return ref && pageOrder.has(ref) ? pageOrder.get(ref) : null
  }
  const walk = (num, level) => {
    let cur = num
    let guard = 0
    while (cur && guard++ < 2000) {
      const node = objects.get(cur)
      if (!node) break
      const titleM = /\/Title\s*(\((?:\\.|[^)])*\)|<[0-9a-fA-F\s]*>)/.exec(node.dict)
      if (titleM) {
        const raw = titleM[1].startsWith('<')
          ? decodePdfTextString(hexToBytes(titleM[1].slice(1, -1)))
          : decodePdfTextString(new Lexer(titleM[1]).literalString())
        const title = cleanup(raw.replace(/\s+/g, ' '))
        if (title) items.push({ level, title, page: destPage(node.dict) })
      }
      const first = refOf(dictValue(node.dict, 'First'))
      if (first) walk(first, level + 1)
      cur = refOf(dictValue(node.dict, 'Next'))
    }
  }
  const first = refOf(dictValue(root.dict, 'First'))
  if (first) walk(first, 1)
  return items
}

function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '')
  let out = ''
  for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16) || 0)
  return out
}

/* -------------------------------- entry -------------------------------- */

export const __debug = { scanObjects, expandObjectStreams, pageList, pageText, collectStream }

export function parsePdf(buf, fileName) {
  if (buf.length > MAX_BYTES) throw new Error('PDF 过大（>60MB）')
  const head = buf.subarray(0, 1024).toString('latin1')
  if (!head.includes('%PDF')) throw new Error('不是有效的 PDF 文件')
  if (/\/Encrypt\b/.test(buf.subarray(-4096).toString('latin1')) || /trailer[\s\S]*?\/Encrypt/.test(buf.toString('latin1').slice(-8192))) {
    throw new Error('PDF 已加密，无法提取文本')
  }
  const { objects } = scanObjects(buf)
  expandObjectStreams(objects)
  const pages = []
  for (const p of pageList(objects)) {
    const { text, lines } = pageText(objects, p)
    if (!text) continue
    const title = pickTitle(text)
    pages.push({ index: pages.length + 1, title, text, heading: headingOf(lines) })
  }
  const outline = readOutline(objects).filter((i) => i.title && i.level <= 3)
  let title = outline[0]?.title || ''
  if (!title || /^(目录|目\s*录|contents)$/i.test(title)) {
    title = String(fileName || '').replace(/\.[^.]+$/, '')
  }
  if (!pages.length) throw new Error('PDF 没有可提取的文本层（可能是扫描件），需先 OCR')
  return {
    kind: 'pdf',
    title,
    pages,
    blocks: [],
    outline,
    text: pages.map((p) => p.text).join('\n\n'),
  }
}

const NOISE_TITLE = /^(第\s*\d{1,4}\s*页|\d{1,4}|\d{1,4}\s*\/\s*\d{1,4}|page\s*\d+)$/i

function pickTitle(text) {
  for (const line of text.split('\n').slice(0, 5)) {
    const t = line.trim()
    if (t.length >= 2 && t.length <= 60 && !NOISE_TITLE.test(t)) return t.replace(/\s+/g, ' ')
  }
  return ''
}
