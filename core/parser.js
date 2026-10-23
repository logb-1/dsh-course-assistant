/**
 * File → { kind, title, pages, blocks, outline } (the one parser entry point).
 */
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parsePptx, parseDocx } from './ooxml.js'
import { parsePdf } from './pdf.js'
import { parseMarkdown, parsePlainText, cleanDoc } from './text.js'

export const SUPPORTED = ['.pptx', '.pdf', '.docx', '.md', '.txt', '.markdown']

export function parseFile(path, displayName) {
  const ext = extname(path).toLowerCase()
  if (!SUPPORTED.includes(ext)) {
    throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}，支持：${SUPPORTED.join(' / ')}`)
  }
  const buf = readFileSync(path)
  if (!buf.length) throw new Error('文件为空')
  // uploads are stored under an opaque id: the *display* name is the real name
  const fileLabel = basename(displayName || path)
  const name = basename(fileLabel, extname(fileLabel))
  let doc
  if (ext === '.pptx') doc = parsePptx(buf, name)
  else if (ext === '.docx') doc = parseDocx(buf, name)
  else if (ext === '.pdf') doc = parsePdf(buf, name)
  else doc = parseMarkdownOrText(buf.toString('utf8'), name, ext)
  doc.fileName = fileLabel
  doc.bytes = buf.length
  return cleanDoc(doc)
}

function parseMarkdownOrText(text, name, ext) {
  if (ext === '.md' || ext === '.markdown') return parseMarkdown(text, name)
  return parsePlainText(text, name)
}

/** For uploads received over HTTP (bytes already in memory). */
export function parseBytes(buf, fileName) {
  const ext = extname(fileName).toLowerCase()
  if (!SUPPORTED.includes(ext)) {
    throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}，支持：${SUPPORTED.join(' / ')}`)
  }
  const name = basename(fileName, ext)
  let doc
  if (ext === '.pptx') doc = parsePptx(buf, name)
  else if (ext === '.docx') doc = parseDocx(buf, name)
  else if (ext === '.pdf') doc = parsePdf(buf, name)
  else doc = parseMarkdownOrText(buf.toString('utf8'), name, ext)
  doc.fileName = basename(fileName)
  doc.bytes = buf.length
  return cleanDoc(doc)
}
