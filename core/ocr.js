/**
 * Windows OCR bridge for scanned / glyph-coded PDFs.
 *
 * Rendering and recognition both happen in a PowerShell helper (`ocr.ps1`) that
 * talks to WinRT: Windows.Data.Pdf renders a page, Windows.Media.Ocr reads it
 * with the installed zh-CN language pack. No extra binary, no network.
 *
 * Windows-only by design. Other platforms report the capability as absent and
 * the caller falls back to "use the source .pptx/.docx".
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'ocr.ps1')

export function ocrAvailable() {
  if (process.platform !== 'win32') return false
  return true
}

/**
 * @param {string} pdfPath absolute path
 * @param {{maxPages?:number, onProgress?:(done:number,total:number)=>void, signal?:AbortSignal, width?:number}} options
 * @returns {Promise<Array<{index:number,title:string,text:string}>>}
 */
export function ocrPdf(pdfPath, options = {}) {
  const maxPages = Math.max(1, Math.min(400, options.maxPages || 60))
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-ocr-'))
  mkdirSync(scratch, { recursive: true })
  // WinRT's GetFileFromPathAsync only accepts native Windows separators
  const nativePdf = String(pdfPath).replace(/\//g, '\\')
  const nativeScratch = scratch.replace(/\//g, '\\')

  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Pdf',
      nativePdf,
      '-OutDir',
      nativeScratch,
      '-First',
      '0',
      '-Last',
      String(maxPages - 1),
      '-Width',
      String(options.width || 1600),
    ]
    const child = spawn('powershell.exe', args, { windowsHide: true })
    let buffer = ''
    let stderr = ''
    const pages = []
    let total = 0

    const handleLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return
      }
      if (msg.error) {
        reject(new Error(`OCR 引擎不可用：${msg.error}`))
        return
      }
      if (typeof msg.pageCount === 'number') {
        total = Math.min(msg.pageCount, maxPages)
        return
      }
      if (typeof msg.page === 'number') {
        const text = normalize(msg.text || '')
        // the first meaningful line is the best available page title for a slide
        const title = (text.split('\n')[0] || '').slice(0, 40)
        pages.push({ index: msg.page, title, text })
        options.onProgress?.(pages.length, total || pages.length)
      }
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      rmSync(scratch, { recursive: true, force: true })
      reject(error)
    })
    child.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer)
      rmSync(scratch, { recursive: true, force: true })
      if (code !== 0 && !pages.length) {
        reject(new Error(`OCR 失败（exit ${code}）：${stderr.slice(-300) || '无输出'}`))
        return
      }
      resolve(pages.filter((p) => p.text.trim().length > 0))
    })

    options.signal?.addEventListener('abort', () => {
      child.kill()
      reject(new Error('OCR 已取消'))
    })
  })
}

/**
 * Windows OCR separates CJK glyphs with spaces and merges lines, so a raw page
 * reads like "第 二 童 程 序". Join CJK runs, keep latin words apart.
 */
function normalize(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim(),
    )
    // slide-number placeholders and bare page numbers are not content
    .filter((line) => line.length > 0 && !/^(幻灯片|slide)\s*\d+$/i.test(line) && !/^\d{1,3}$/.test(line))
    .join('\n')
}
