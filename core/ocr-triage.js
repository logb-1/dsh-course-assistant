/**
 * Page-level OCR triage.
 *
 * The old switch was all-or-nothing: `ocr: true` re-read *every* page of a PDF,
 * `ocr: false` read none. Both are wrong for real courseware:
 *   • a 54-page slide export has 3 scanned pages among 51 readable ones — the
 *     user pays 54 s of OCR for 3 pages;
 *   • a scan with a broken text layer (or none at all) silently produces an
 *     empty report unless the user finds the switch;
 *   • a 200-page scan only ever got its first `ocrMaxPages` pages read, because
 *     the cap was applied to the document, not to the pages that needed it.
 *
 * Triage fixes all three: score every page locally, re-read only the weak ones,
 * and report what was skipped, deferred or replaced.
 */
import { scoreText, textProblem } from './ocr-score.js'

export const OCR_MODES = ['off', 'auto', 'all']
/** `auto` treats a document as a scan when this share of pages has no usable text. */
export const SCAN_RATIO = 0.6

const DEFAULT_PICK = { minChars: 40, maxNoise: 0.12, minWordLike: 0.5 }

/**
 * Decide which pages to hand to an OCR engine.
 *
 * @param {Array<{index:number,text:string,images?:number}>} pages 1-based page records
 * @param {{mode?:'off'|'auto'|'all', maxPages?:number, minChars?:number,
 *          requireImage?:boolean}} options
 * @returns {{mode:string,pages:number[],total:number,weak:number,reasons:object,
 *            deferred:number,scanned:boolean,emptyPages:number}}
 */
export function planOcrPages(pages, options = {}) {
  const mode = OCR_MODES.includes(options.mode) ? options.mode : 'auto'
  const maxPages = Math.max(1, Number(options.maxPages) || 60)
  const requireImage = options.requireImage !== false
  let emptyPages = 0
  const rows = (pages || []).map((page) => {
    const row = { index: page.index, ...textProblem(page.text, { ...DEFAULT_PICK, ...options }) }
    // A sparse page that draws no picture has nothing for OCR to read: skipping
    // it keeps title/divider slides from costing a second each.
    if (row.problem === 'sparse' && requireImage && Number.isInteger(page.images) && page.images === 0) {
      emptyPages += 1
      return { index: page.index, problem: '' }
    }
    return row
  })
  const reasons = rows.reduce((acc, row) => {
    if (row.problem) acc[row.problem] = (acc[row.problem] || 0) + 1
    return acc
  }, {})

  if (!rows.length) return { mode, pages: [], total: 0, weak: 0, reasons, deferred: 0, scanned: false, emptyPages: 0 }
  if (mode === 'off') {
    return { mode, pages: [], total: rows.length, weak: Object.values(reasons).reduce((a, b) => a + b, 0), reasons, deferred: 0, scanned: false, emptyPages }
  }

  const weakRows = rows.filter((row) => row.problem)
  // A text layer with this many broken pages is an overlay on a scan, not text:
  // reading the other pages would only mix OCR text with glyph garbage.
  const scanned = weakRows.length / rows.length >= (options.scanRatio ?? SCAN_RATIO)
  const wanted = mode === 'all' || scanned ? rows.map((row) => row.index) : weakRows.map((row) => row.index)
  const capped = wanted.slice(0, maxPages)
  return {
    mode,
    pages: capped,
    total: rows.length,
    weak: weakRows.length,
    reasons,
    deferred: wanted.length - capped.length,
    scanned,
    emptyPages,
  }
}

/**
 * Put OCR text back where it came from.
 *
 * Per page, not per document: a page with a readable text layer keeps it, a page
 * whose layer is empty or garbled takes the OCR text. That way switching OCR on
 * can only add information — it never replaces 51 good pages to fix 3 bad ones.
 *
 * @returns {{pages:Array, adopted:number[], kept:number[], chars:number, reasons:object}}
 */
export function applyOcrPages(pages, ocrPages, options = {}) {
  const margin = options.margin ?? 0.05
  const pick = { ...DEFAULT_PICK, ...options }
  const byIndex = new Map()
  for (const page of ocrPages || []) {
    if (page && Number.isInteger(page.index) && String(page.text || '').trim()) byIndex.set(page.index, page)
  }
  const adopted = []
  const kept = []
  let chars = 0
  const reasons = {}
  const out = (pages || []).map((page) => {
    const hit = byIndex.get(page.index)
    if (!hit) return page
    const before = scoreText(page.text)
    const after = scoreText(hit.text)
    const { problem } = textProblem(page.text, pick)
    // A sparse page's score is meaningless — 10 clean characters score 0.95 and
    // still make a useless report. There, "more content" is the signal.
    const take = !before.chars
      ? after.chars > 0
      : problem === 'sparse'
        ? after.chars > before.chars * 1.5 || after.score > before.score + margin
        : problem
          ? after.score >= before.score
          : after.score > before.score + margin
    if (!take) {
      kept.push(page.index)
      reasons['text-layer'] = (reasons['text-layer'] || 0) + 1
      return page
    }
    adopted.push(page.index)
    const why = !before.chars ? 'empty' : problem || 'better'
    reasons[why] = (reasons[why] || 0) + 1
    chars += after.chars - before.chars
    return {
      ...page,
      text: hit.text,
      // a page that had no text had no title either; the OCR'd first line is one
      title: page.title || firstLine(hit.text) || '',
      ocr: true,
      ocrScore: after.score,
    }
  })
  return { pages: out, adopted, kept, chars, reasons }
}

/** First line that could be a heading (not a page number or a rule of symbols). */
function firstLine(text) {
  for (const line of String(text || '').split('\n').slice(0, 4)) {
    const t = line.trim()
    if (t.length >= 2 && t.length <= 60 && !/^[\d\s.·、\-–—]+$/.test(t)) return t
  }
  return ''
}
