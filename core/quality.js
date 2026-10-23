/**
 * Post-parse quality gate.
 *
 * A report is only as good as the text it was built from, but "empty text" and
 * "glyph codes decoded as Latin-1" both look like a normal (if short) report.
 * These metrics make that failure visible before the model works on garbage:
 * cheap, local, no network.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/
const LATIN_HIGH = /[\u0080-\u024f]/
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const WORDISH = /[A-Za-z0-9'.-]/

const round = (n) => Math.round(n * 100) / 100

/**
 * Share of non-space characters that sit inside a plausible word:
 * a CJK run of >=2 chars, or a latin/digit run of >=3 chars.
 * Glyph-code garbage ("w\t)Wy°a¼") scores low; real prose scores high.
 */
function wordLikeRatio(text) {
  let total = 0
  let good = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    let j = i + 1
    if (CJK.test(ch)) {
      while (j < text.length && CJK.test(text[j])) j += 1
      if (j - i >= 2) good += j - i
    } else if (WORDISH.test(ch)) {
      while (j < text.length && WORDISH.test(text[j])) j += 1
      if (j - i >= 3) good += j - i
    }
    total += j - i
    i = j
  }
  return total ? good / total : 0
}

/**
 * @param {Array<{kind:string, pages?:Array, blocks?:Array}>} docs
 * @returns {{tier:'good'|'fair'|'unusable', score:number, reasons:string[], metrics:object}}
 */
export function assessQuality(docs) {
  const pages = docs.flatMap((d) => d.pages || [])
  const blocks = docs.flatMap((d) => d.blocks || [])
  const pageBased = pages.length > 0
  const units = pageBased ? pages.length : blocks.length
  const text = pageBased
    ? pages.map((p) => p.text).join('\n')
    : blocks.map((b) => `${b.title}\n${b.text}`).join('\n')

  let chars = 0
  let cjk = 0
  let latinHigh = 0
  let control = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    chars += 1
    if (CJK.test(ch)) cjk += 1
    else if (CJK_PUNCT.test(ch)) continue
    else if (LATIN_HIGH.test(ch)) latinHigh += 1
    else if (CTRL.test(ch)) control += 1
  }

  const emptyUnits = pageBased
    ? pages.filter((p) => (p.text || '').trim().length < 5).length
    : blocks.filter((b) => (b.text || '').trim().length < 5).length
  const charsPerUnit = units ? Math.round(chars / units) : 0
  const noiseRatio = chars ? (latinHigh + control) / chars : 0
  const emptyRatio = units ? emptyUnits / units : 0
  const wordLike = wordLikeRatio(text)

  const metrics = {
    units,
    chars,
    charsPerUnit,
    cjkRatio: round(chars ? cjk / chars : 0),
    noiseRatio: round(noiseRatio),
    emptyRatio: round(emptyRatio),
    wordLike: round(wordLike),
    pageBased,
  }

  const reasons = []
  let tier = 'good'

  const unusable =
    chars < 200 ||
    noiseRatio > 0.12 ||
    (pageBased && charsPerUnit < 80 && wordLike < 0.55) ||
    (pageBased && emptyRatio > 0.4)
  const fair = pageBased
    ? charsPerUnit < 200 || emptyRatio > 0.2 || wordLike < 0.65 || noiseRatio > 0.05
    : chars < 400

  if (unusable) tier = 'unusable'
  else if (fair) tier = 'fair'

  if (chars < 200) reasons.push(`全文只有 ${chars} 个字符，几乎没读到内容`)
  if (pageBased) {
    if (charsPerUnit < 120) reasons.push(`平均每页仅 ${charsPerUnit} 个字符（正常讲义 300–800）`)
    if (emptyRatio > 0.2) reasons.push(`${emptyUnits}/${units} 页几乎没有文本`)
    if (noiseRatio > 0.05) {
      reasons.push(`可疑字符占 ${Math.round(noiseRatio * 100)}%，像是字形编号被当成字符解码`)
    }
    if (wordLike < 0.65) {
      reasons.push(`成词片段只占 ${Math.round(wordLike * 100)}%，文本结构不像正常句子`)
    }
  } else {
    if (charsPerUnit < 80) reasons.push(`平均每节仅 ${charsPerUnit} 个字符`)
  }
  if (tier !== 'good' && !reasons.length) reasons.push('文本量偏少，报告可能不够完整')

  const score =
    tier === 'good' ? 1 - Math.min(0.2, noiseRatio + (pageBased ? Math.max(0, 0.2 - emptyRatio) : 0)) : tier === 'fair' ? 0.5 : Math.max(0.05, 1 - 0.5 - noiseRatio)

  return { tier, score: round(score), reasons, metrics }
}

/** One human line for the report header and the panel. */
export function describeQuality(quality) {
  if (!quality) return ''
  const m = quality.metrics
  const label = { good: '可读', fair: '一般', unusable: '不可用' }[quality.tier] || quality.tier
  const bits = [`${m.charsPerUnit} 字/${m.pageBased ? '页' : '节'}`, `全文 ${m.chars} 字`]
  if (m.pageBased) bits.push(`空页 ${Math.round(m.emptyRatio * 100)}%`, `可疑字符 ${Math.round(m.noiseRatio * 100)}%`)
  return `${label}（${bits.join('，')}）`
}
