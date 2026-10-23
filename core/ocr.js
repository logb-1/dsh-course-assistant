/**
 * OCR engine registry.
 *
 * An engine is a plain object:
 *   {
 *     id: string,                  // stable id used in config/health
 *     label: string,               // shown in the panel
 *     platform: 'win32' | 'any',
 *     available(): boolean | Promise<boolean>,
 *     availableSync?(): boolean,   // optional cheap answer for sync callers
 *     recognize(pdfPath, options): Promise<Array<{index, title?, text}>>,
 *   }
 *
 * Engines never normalise text themselves: the registry does it once, so a new
 * engine only has to return raw lines. Adding one is `registerOcrEngine(...)`.
 */
import windowsEngine from './ocr-windows.js'
import rapidocrEngine from './ocr-rapidocr.js'

const engines = new Map()

export function registerOcrEngine(engine) {
  if (!engine?.id || typeof engine.recognize !== 'function') throw new Error('OCR 引擎缺少 id 或 recognize()')
  engines.set(engine.id, engine)
  return engine
}

registerOcrEngine(windowsEngine)
registerOcrEngine(rapidocrEngine)

/** Synchronous view: only engines that can answer without I/O report `true`. */
export function listOcrEngines() {
  return [...engines.values()].map((e) => ({
    id: e.id,
    label: e.label,
    platform: e.platform || 'any',
    available: !!e.availableSync?.(),
  }))
}

/** Async view for /health: probes engines that need one. */
export async function ocrStatus() {
  const rows = []
  for (const e of engines.values()) {
    let available = false
    try {
      available = !!(await e.available())
    } catch {
      available = false
    }
    rows.push({ id: e.id, label: e.label, platform: e.platform || 'any', available })
  }
  return rows
}

export function ocrAvailable() {
  return listOcrEngines().some((e) => e.available)
}

export function pickOcrEngine(preferred) {
  if (preferred && engines.has(preferred)) return engines.get(preferred)
  return [...engines.values()].find((e) => e.availableSync?.()) || null
}

/**
 * @param {string} pdfPath absolute path
 * @param {{engine?:string, maxPages?:number, width?:number, onProgress?:Function, signal?:AbortSignal}} options
 * @returns {Promise<Array<{index:number,title:string,text:string}>>}
 */
export async function ocrPdf(pdfPath, options = {}) {
  const engine = options.engine && engines.has(options.engine) ? engines.get(options.engine) : pickOcrEngine(options.engine)
  if (!engine) throw new Error('没有可用的 OCR 引擎（Windows 用内置 WinRT，其他平台装 rapidocr_onnxruntime）')
  const pages = await engine.recognize(pdfPath, options)
  return (pages || [])
    .map((p, i) => {
      const text = normalizeOcrText(p.text || '')
      return { index: p.index ?? i + 1, title: p.title || (text.split('\n')[0] || '').slice(0, 40), text }
    })
    .filter((p) => p.text.trim().length > 0)
}

/**
 * Both engines emit one physical line per line. Windows OCR separates CJK
 * glyphs with spaces ("第 二 章"), so join CJK runs but keep latin words apart.
 */
export function normalizeOcrText(text) {
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
