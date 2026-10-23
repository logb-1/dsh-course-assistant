/**
 * Grounding checks for generated chapter summaries.
 *
 * Three different questions, three different numbers — never mixed:
 *   overlap       lexical: how much of the wording also appears in the source.
 *                 A paraphrase legitimately scores low. Never call it "编造".
 *   evidence      the model must quote a contiguous span of the source for each
 *                 bullet; we verify the quote locally (exact → fuzzy → missing).
 *                 This is machine-checkable and replaces self-reporting.
 *   faithfulness  supported bullets / bullets that carried evidence.
 *
 * `assessConfidence()` is the single place that turns them into a tier and
 * reason codes; the report, the panel and the warnings all read that object.
 */

export const THRESHOLDS = {
  overlap: { weak: 0.55, suspect: 0.3 },
  faithfulness: { weak: 0.8, suspect: 0.6 },
  /** shorter quotes match by accident ("指针数组" is in almost every chapter) */
  evidenceMinChars: 10,
  /** share of 4-gram shingles that must be present for a fuzzy match */
  evidenceFuzzy: 0.85,
  /** a bullet whose words are absent from its own quote is likely a padded quote */
  evidenceLink: 0.2,
}

const DROP_PUNCT = /[\s\u3000，。、；：？！""''（）《》【】—…·,.;:?!"'()<>[\]{}_\-~`|/\\]+/g

/** Compare forms: NFKC, no whitespace, no punctuation, lower case. */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(DROP_PUNCT, '')
    .toLowerCase()
}

function bigrams(text) {
  const clean = normalizeForMatch(text)
  const set = new Set()
  for (let i = 0; i + 2 <= clean.length; i += 1) set.add(clean.slice(i, i + 2))
  return set
}

function shingles(text, size = 4) {
  const clean = normalizeForMatch(text)
  const set = new Set()
  for (let i = 0; i + size <= clean.length; i += 1) set.add(clean.slice(i, i + size))
  return set
}

/**
 * @returns {number|null} 0..1 share of the bullets' bigrams that occur in the
 *   source, or null when either side is empty (an empty chapter is not "perfect").
 */
export function supportScore(chapterText, points) {
  const source = bigrams(chapterText)
  const texts = (points || []).filter(Boolean).map(pointText)
  if (!source.size || !texts.length) return null
  let hit = 0
  let total = 0
  for (const text of texts) {
    for (const gram of bigrams(text)) {
      total += 1
      if (source.has(gram)) hit += 1
    }
  }
  return total ? Math.round((hit / total) * 1000) / 1000 : null
}

/** Backwards-compatible alias: the old name described the wrong thing. */
export const overlapScore = supportScore

/** A point is either a plain string (legacy) or { text, evidence }. */
export function pointText(point) {
  if (typeof point === 'string') return point
  return String(point?.text ?? '')
}

export function pointEvidence(point) {
  if (typeof point === 'string') return ''
  return String(point?.evidence ?? point?.quote ?? '')
}

/**
 * @returns {{level:'exact'|'fuzzy'|'short'|'missing', ratio:number}}
 */
export function matchEvidence(quote, sourceText) {
  const q = normalizeForMatch(quote)
  if (!q) return { level: 'missing', ratio: 0 }
  if (q.length < THRESHOLDS.evidenceMinChars) return { level: 'short', ratio: 0 }
  const haystack = normalizeForMatch(sourceText)
  if (!haystack) return { level: 'missing', ratio: 0 }
  if (haystack.includes(q)) return { level: 'exact', ratio: 1 }
  const parts = shingles(q)
  if (!parts.size) return { level: 'missing', ratio: 0 }
  const hs = shingles(haystack)
  let hit = 0
  for (const part of parts) if (hs.has(part)) hit += 1
  const ratio = hit / parts.size
  return ratio >= THRESHOLDS.evidenceFuzzy ? { level: 'fuzzy', ratio: Math.round(ratio * 100) / 100 } : { level: 'missing', ratio: Math.round(ratio * 100) / 100 }
}

/**
 * Does the bullet actually talk about its quote? Catches a quote pasted from an
 * unrelated paragraph. Soft signal only: it can demote verified → weak.
 */
function evidenceLinkRatio(point, quote, sourceText) {
  const source = normalizeForMatch(sourceText)
  const q = normalizeForMatch(quote)
  const at = source.indexOf(q.slice(0, Math.min(q.length, 12)))
  const window = at >= 0 ? source.slice(Math.max(0, at - 60), at + q.length + 60) : q
  const grams = bigrams(pointText(point))
  if (!grams.size) return 1
  let hit = 0
  for (const gram of grams) if (window.includes(gram)) hit += 1
  return hit / grams.size
}

/**
 * @param {string} chapterText
 * @param {object} summary  key_points may be strings or {text, evidence}
 * @returns {{tier:'verified'|'weak'|'suspect'|'unrated', reasons:string[], overlap:number|null,
 *            faithfulness:number|null, evidence:{checked:number, exact:number, fuzzy:number, short:number, missing:number, ratio:number|null},
 *            points:Array<{text:string, evidence:string, level:string, ratio:number}>}}
 */
export function evaluateSummary(chapterText, summary) {
  const points = (summary?.key_points || []).filter(Boolean)
  const reasons = []
  const detail = points.map((point) => {
    const quote = pointEvidence(point)
    const match = quote ? matchEvidence(quote, chapterText) : { level: 'missing', ratio: 0 }
    const link = quote && match.level !== 'missing' ? evidenceLinkRatio(point, quote, chapterText) : 1
    return { text: pointText(point), evidence: quote, level: match.level, ratio: match.ratio, link: Math.round(link * 100) / 100 }
  })

  const withQuote = detail.filter((d) => d.evidence)
  const exact = detail.filter((d) => d.level === 'exact').length
  const fuzzy = detail.filter((d) => d.level === 'fuzzy').length
  const short = detail.filter((d) => d.level === 'short').length
  const missing = detail.filter((d) => d.level === 'missing').length
  const checked = withQuote.length
  const evidenceRatio = checked ? Math.round(((exact + fuzzy) / checked) * 100) / 100 : null

  const overlap = supportScore(chapterText, points)
  // legacy self-report is only a fallback when the model gave no quotes at all
  const marked = Array.isArray(summary?.unsupported_idx)
  const markerFaithfulness = marked && points.length ? Math.round((1 - summary.unsupported_idx.length / points.length) * 100) / 100 : null
  const faithfulness = evidenceRatio !== null ? evidenceRatio : markerFaithfulness

  if (overlap === null) reasons.push('no_source_text')
  if (exact + fuzzy < detail.length) reasons.push(missing || short ? 'evidence_missing' : 'evidence_partial')
  if (short) reasons.push('evidence_short')
  if (detail.some((d) => d.link < THRESHOLDS.evidenceLink)) reasons.push('evidence_unrelated')
  if (evidenceRatio === null && markerFaithfulness !== null && markerFaithfulness < THRESHOLDS.faithfulness.weak) {
    reasons.push('model_marked_unsupported')
  }

  const lowOverlap = overlap !== null && overlap < THRESHOLDS.overlap.suspect
  const midOverlap = overlap !== null && overlap < THRESHOLDS.overlap.weak
  const lowEvidence = evidenceRatio !== null && evidenceRatio < THRESHOLDS.faithfulness.suspect
  const midEvidence = evidenceRatio !== null && evidenceRatio < THRESHOLDS.faithfulness.weak
  const lowMarker = markerFaithfulness !== null && markerFaithfulness < THRESHOLDS.faithfulness.suspect

  let tier = 'verified'
  if (overlap === null && evidenceRatio === null && markerFaithfulness === null) tier = 'unrated'
  else if (lowOverlap || lowEvidence || lowMarker) tier = 'suspect'
  else if (midOverlap || midEvidence || detail.some((d) => d.link < THRESHOLDS.evidenceLink)) tier = 'weak'

  return {
    tier,
    reasons,
    overlap,
    faithfulness,
    evidence: { checked, exact, fuzzy, short, missing, ratio: evidenceRatio },
    points: detail,
  }
}

/** One-line explanation for the report; never asserts fabrication. */
export function describeConfidence(confidence, { paged = false } = {}) {
  if (!confidence || confidence.tier === 'verified' || confidence.tier === 'unrated') return ''
  const pct = (v) => `${Math.round(v * 100)}%`
  const parts = []
  const ev = confidence.evidence || {}
  if (confidence.tier === 'suspect' && ev.checked) {
    parts.push(`证据核对：${ev.checked} 条要点带引文，${ev.exact + ev.fuzzy} 条能在原文中找到（${ev.missing} 条找不到）`)
  }
  if (confidence.overlap !== null && confidence.overlap < THRESHOLDS.overlap.weak) {
    parts.push(`词面重合 ${pct(confidence.overlap)}：要点多为改写，建议对照原${paged ? '页' : '文'}`)
  }
  if (confidence.reasons.includes('model_marked_unsupported')) {
    parts.push(`模型自评：部分要点在原文中找不到依据（${pct(confidence.faithfulness ?? 0)} 条有依据）`)
  }
  if (confidence.reasons.includes('evidence_short')) parts.push('部分引文过短，未能有效核对')
  return parts.join('；')
}
