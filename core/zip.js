/**
 * Minimal ZIP reader/writer (no dependencies).
 *
 * OOXML (.pptx/.docx) is a ZIP container; the harness plugin runs inside the
 * dsh Node process, so `node:zlib` is all we need. Idea borrowed from
 * Stuk/jszip (https://github.com/Stuk/jszip, MIT/GPLv3 dual) — we only need
 * stored/deflated entries, so 80 lines beat a full dependency.
 */
import { inflateRawSync, deflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new Error('not a zip file (EOCD not found)')
}

export function readZip(buf) {
  const eocd = findEOCD(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method, compSize, rawSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return {
    names() {
      return [...entries.keys()]
    },
    has(name) {
      return entries.has(name)
    },
    read(name) {
      const e = entries.get(name)
      if (!e) return undefined
      if (e.rawSize === 0xffffffff || e.compSize === 0xffffffff) {
        throw new Error(`zip64 entry unsupported: ${name}`)
      }
      const lo = e.localOffset
      if (buf.readUInt32LE(lo) !== LOCAL_SIG) throw new Error(`bad local header: ${name}`)
      const nameLen = buf.readUInt16LE(lo + 26)
      const extraLen = buf.readUInt16LE(lo + 28)
      const start = lo + 30 + nameLen + extraLen
      const slice = buf.subarray(start, start + e.compSize)
      if (e.method === 0) return Buffer.from(slice)
      if (e.method === 8) return inflateRawSync(slice)
      throw new Error(`unsupported zip method ${e.method}: ${name}`)
    },
    text(name) {
      const b = this.read(name)
      return b === undefined ? undefined : b.toString('utf8')
    },
  }
}

/* ---------------- writer (used for the optional PDF export) ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** files: Array<{ name: string, data: Buffer|string }> → Buffer */
export function writeZip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const comp = deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // utf-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt32LE(0, 10) // time/date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, comp)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(CD_SIG, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(0, 12)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + comp.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, end])
}
