/**
 * Per-page text plausibility.
 *
 * Two decisions in the OCR path need a number instead of a boolean:
 *   • does this page's text layer need OCR at all?  (triage)
 *   • when both the text layer and OCR produced text, which one is better?
 *
 * The score is deliberately local and model-free: it only measures "does this
 * look like text a human wrote" — word-like runs, glyph-decoding noise, and
 * fragmentation. It never sees a dictionary, so it costs nothing per page.
 */
import { wordLikeRatio } from './quality.js'

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const HIGH_LATIN = /[\u0080-\u024f]/
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const round2 = (n) => Math.round(n * 100) / 100

/** Raw counters for one page (or an image): cheap enough to run on every page. */
export function textStats(text) {
  const raw = String(text ?? '')
  let chars = 0
  let cjk = 0
  let highLatin = 0
  let control = 0
  for (const ch of raw) {
    if (/\s/.test(ch)) continue
    chars += 1
    if (CJK.test(ch)) cjk += 1
    else if (HIGH_LATIN.test(ch)) highLatin += 1
    else if (CTRL.test(ch)) control += 1
  }

  const lines = raw.split('\n').filter((line) => line.trim())
  // OCR of vertical or badly cropped text comes out one glyph per line; prose
  // never does. This is the cheapest fragmentation signal we have.
  const singleCharLines = lines.filter((line) => line.trim().length === 1).length

  return {
    chars,
    cjk,
    highLatin,
    control,
    lines: lines.length,
    singleCharLines,
    wordLike: wordLikeRatio(raw),
  }
}

/**
 * @returns {{score:number, noise:number, frag:number, chars:number, wordLike:number,
 *            cjk:number, lines:number, singleCharLines:number}}
 * Score is 0..1: 1 = clean prose, 0 = nothing readable.
 */
export function scoreText(text) {
  const stats = textStats(text)
  const noise = stats.chars ? (stats.highLatin + stats.control) / stats.chars : 0
  const frag = stats.lines ? stats.singleCharLines / stats.lines : 0
  const score = stats.chars
    ? round2(0.55 * stats.wordLike + 0.3 * (1 - Math.min(1, noise * 2.5)) + 0.15 * (1 - Math.min(1, frag)))
    : 0
  return { ...stats, noise: round2(noise), frag: round2(frag), score }
}

/**
 * Why a page should be re-read. Kept as data so the job can explain it later
 * ("42 页跳过：文字层可用" vs "9 页：文字层像字形乱码").
 */
export function textProblem(text, options = {}) {
  const stats = scoreText(text)
  const minChars = Number(options.minChars) || 40
  if (stats.chars < minChars) return { problem: 'sparse', stats }
  if (stats.noise > (options.maxNoise ?? 0.12)) return { problem: 'noise', stats }
  if (stats.wordLike < (options.minWordLike ?? 0.5)) return { problem: 'garbled', stats }
  return { problem: '', stats }
}

/** Human summary used by the panel and the report header. */
export function describeScore(score) {
  if (!score) return ''
  const parts = [`${Math.round(score.score * 100)} 分`]
  if (score.chars) parts.push(`${score.chars} 字`)
  if (score.noise > 0.02) parts.push(`可疑字符 ${Math.round(score.noise * 100)}%`)
  if (score.frag > 0.2) parts.push(`碎片行 ${Math.round(score.frag * 100)}%`)
  return parts.join('，')
}
