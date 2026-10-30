/**
 * Windows OCR engine: WinRT renders the page, Windows.Media.Ocr reads it.
 * The work happens in `ocr.ps1`; no extra binary, no network, ~1s per page.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'ocr.ps1')

function recognize(pdfPath, options = {}) {
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
        pages.push({ index: msg.page, title: '', text: msg.text || '' })
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
      resolve(pages)
    })

    options.signal?.addEventListener('abort', () => {
      child.kill()
      reject(new Error('OCR 已取消'))
    })
  })
}


function recognizeImage(imagePath) {
  const native = String(imagePath).replace(/\//g, '\\')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Image', native], {
      windowsHide: true,
    })
    let buffer = ''
    let stderr = ''
    let text = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.error) reject(new Error(`OCR 引擎不可用：${msg.error}`))
          else if (typeof msg.text === 'string') text = msg.text
        } catch {}
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && !text) {
        reject(new Error(`图片 OCR 失败（exit ${code}）：${stderr.slice(-200) || '无输出'}`))
        return
      }
      resolve(text)
    })
  })
}

export default {
  id: 'windows',
  label: 'Windows OCR（WinRT）',
  platform: 'win32',
  available: () => process.platform === 'win32',
  availableSync: () => process.platform === 'win32',
  recognize,
  recognizeImage,
}
