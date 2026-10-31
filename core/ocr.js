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
 *     recognize(pdfPath, options): Promise<Array<{index, title?, text, score?}>>,
 *     recognizeImage?(imagePath, options): Promise<string>,
 *   }
 *
 * Engines never normalise text themselves: the registry does it once, so a new
 * engine only has to return raw lines. Adding one is `registerOcrEngine(...)`.
 *
 * `options.pages` (1-based) asks an engine to read a subset of pages. Both
 * shipped engines honour it, which is what makes page-level triage possible.
 */
import windowsEngine from './ocr-windows.js'
import rapidocrEngine from './ocr-rapidocr.js'
import { fixOcrArtifacts } from './ocr-text.js'
import { scoreText } from './ocr-score.js'

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
 * Requested engine first; otherwise any *reported available* candidate (the
 * caller already probed them for /health), then the sync default.
 */
function engineFor(requested, candidates) {
  if (requested && engines.has(requested)) return engines.get(requested)
  for (const id of candidates || []) {
    const engine = engines.get(id)
    if (engine && engine.availableSync?.()) return engine
  }
  return pickOcrEngine(requested)
}

/** One engine run, normalised: page numbers survive, empties are kept for stats. */
async function recognizeWith(engine, pdfPath, options) {
  const raw = await engine.recognize(pdfPath, options)
  return (raw || []).map((p, i) => ({
    index: Number.isInteger(p.index) ? p.index : i + 1,
    title: p.title || '',
    text: normalizeOcrText(p.text || ''),
    score: typeof p.score === 'number' ? p.score : null,
    engine: engine.id,
  }))
}

/**
 * OCR a PDF and — when `pick: 'best'` — re-read the pages the first engine
 * handled poorly with a second engine, keeping whichever text scores higher.
 * Escalation is per page and capped, so a clean scan never pays for it twice.
 *
 * @param {string} pdfPath absolute path
 * @param {{engine?:string,candidates?:string[],pick?:'first'|'best',pickThreshold?:number,
 *          pickMax?:number,pages?:number[],maxPages?:number,width?:number,
 *          python?:string,onProgress?:Function,signal?:AbortSignal}} options
 * @returns {Promise<{pages:Array<{index:number,title:string,text:string,engine:string}>,stats:object}>}
 */
export async function ocrPdfDeep(pdfPath, options = {}) {
  const primary = engineFor(options.engine, options.candidates)
  if (!primary) throw new Error('没有可用的 OCR 引擎（Windows 用内置 WinRT，其他平台装 rapidocr_onnxruntime）')

  let pages = await recognizeWith(primary, pdfPath, options)
  const stats = {
    engine: primary.id,
    engines: [primary.id],
    pages: pages.length,
    escalated: 0,
    improved: 0,
    pick: options.pick === 'best' ? 'best' : 'first',
  }
  if (stats.pick !== 'best') return { pages, stats }

  const threshold = Number(options.pickThreshold) || 0.6
  const pickMax = Math.max(1, Number(options.pickMax) || 40)
  const weak = pages
    .filter((page) => scoreText(page.text).score < threshold)
    .slice(0, pickMax)
  if (!weak.length) return { pages, stats }

  const order = [options.engine, ...(options.candidates || [])].filter(Boolean)
  const second = [...(order.length ? order : [...engines.keys()])]
    .map((id) => engines.get(id))
    .find((engine) => engine && engine.id !== primary.id && engine.availableSync?.())
  if (!second) return { pages, stats }

  let extra = []
  try {
    extra = await recognizeWith(second, pdfPath, { ...options, pages: weak.map((page) => page.index) })
  } catch {
    // a failed second opinion must never fail the run
    return { pages, stats }
  }
  stats.engines.push(second.id)
  stats.escalated = weak.length
  const better = new Map()
  for (const candidate of extra) {
    const current = pages.find((page) => page.index === candidate.index)
    if (!current) continue
    if (scoreText(candidate.text).score > scoreText(current.text).score + 0.02) better.set(candidate.index, candidate)
  }
  if (better.size) {
    pages = pages.map((page) => better.get(page.index) || page)
    stats.improved = better.size
  }
  stats.weak = weak.length
  return { pages, stats }
}

/**
 * @param {string} pdfPath absolute path
 * @param {{engine?:string,candidates?:string[],pick?:string,pages?:number[],maxPages?:number,
 *          width?:number,python?:string,onProgress?:Function,signal?:AbortSignal}} options
 * @returns {Promise<Array<{index:number,title:string,text:string}>>}
 */
export async function ocrPdf(pdfPath, options = {}) {
  const { pages } = await ocrPdfDeep(pdfPath, options)
  return pages.filter((page) => page.text.trim().length > 0)
}

/**
 * Both engines emit one physical line per line. Windows OCR separates CJK
 * glyphs with spaces ("第 二 章"), so join CJK runs but keep latin words apart.
 */

/** OCR one image file; engines that cannot read images simply report unsupported. */
export async function ocrImage(imagePath, options = {}) {
  const engine = engineFor(options.engine, options.candidates)
  if (!engine) throw new Error('没有可用的 OCR 引擎')
  if (typeof engine.recognizeImage !== 'function') throw new Error(`OCR 引擎 ${engine.id} 不支持图片`)
  const text = await engine.recognizeImage(imagePath, options)
  return fixOcrArtifacts(text || '')
}

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
