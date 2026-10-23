/**
 * RapidOCR engine: cross-platform OCR through `rapidocr_onnxruntime`.
 *
 * Everything is optional — nothing is bundled. When the Python package is not
 * installed the engine simply reports `available: false` and the panel keeps
 * using the Windows engine (or asks for the source .pptx/.docx).
 *
 * Rendering a PDF to images needs PyMuPDF (`pip install pymupdf`); the actual
 * script lives in `rapidocr.py` so this file stays about process plumbing.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'rapidocr.py')

function pythonOf(options = {}) {
  return options.python || process.env.DSH_OCR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
}

let probed = null
let probing = null

function probe(options = {}) {
  if (probed !== null) return Promise.resolve(probed)
  if (probing) return probing
  probing = new Promise((resolve) => {
    let child
    try {
      child = spawn(pythonOf(options), ['-c', 'import rapidocr_onnxruntime, fitz'], { windowsHide: true })
    } catch {
      probed = false
      return resolve(false)
    }
    const done = (value) => {
      probed = value
      probing = null
      resolve(value)
    }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
  return probing
}

function recognize(pdfPath, options = {}) {
  const maxPages = Math.max(1, Math.min(400, options.maxPages || 60))
  const args = [
    SCRIPT,
    '--pdf',
    pdfPath,
    '--first',
    '0',
    '--last',
    String(maxPages - 1),
    '--dpi',
    String(Math.round((Number(options.width) || 1600) / 8.5)),
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(pythonOf(options), args, { windowsHide: true })
    let buffer = ''
    let stderr = ''
    const pages = []
    let total = 0
    const handle = (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return
      }
      if (msg.error) {
        reject(new Error(`RapidOCR 不可用：${msg.error}`))
        return
      }
      if (typeof msg.pageCount === 'number') total = Math.min(msg.pageCount, maxPages)
      if (typeof msg.page === 'number') {
        pages.push({ index: msg.page, title: '', text: msg.text || '' })
        options.onProgress?.(pages.length, total || pages.length)
      }
    }
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (buffer.trim()) handle(buffer)
      if (code !== 0 && !pages.length) {
        reject(new Error(`RapidOCR 失败（exit ${code}）：${stderr.slice(-300) || '无输出'}`))
        return
      }
      resolve(pages)
    })
    options.signal?.addEventListener('abort', () => {
      child.kill()
      reject(new Error('OCR 已取消'))
    })
  })
}

export default {
  id: 'rapidocr',
  label: 'RapidOCR（Python，跨平台）',
  platform: 'any',
  available: () => probe(),
  // sync callers only see the answer once a probe has run; health awaits
  availableSync: () => probed === true,
  probe,
  recognize,
}
