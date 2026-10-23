/**
 * Local course Q&A: BM25 over chapter passages, no model, no network.
 *
 * Chinese is segmented with the built-in `Intl.Segmenter` (Node 18+), so the
 * plugin still has zero runtime dependencies for this feature. Answers are
 * extractive: the snippet is quoted from the courseware with its chapter and an
 * approximate page, which is what makes it checkable.
 */

const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '也', '就', '都', '而', '并', '其', '之', '于',
  '有', '无', '这', '那', '一个', '一种', '我们', '可以', '需要', '进行', '通过', '对于', '因为',
  '所以', '如果', '但是', '而且', '这个', '那个', '什么', '怎么', '为什', '如何', '以及',
])

const segmenter = (() => {
  try {
    return new Intl.Segmenter('zh', { granularity: 'word' })
  } catch {
    return null
  }
})()

/** Words for Chinese, lower-cased words for Latin; stopwords and 1-char noise dropped. */
export function tokenize(text) {
  const raw = String(text || '')
  const out = []
  if (segmenter) {
    for (const piece of segmenter.segment(raw)) {
      const word = piece.segment.trim().toLowerCase()
      if (!word || STOP.has(word)) continue
      if (/^[\p{P}\p{S}\s]+$/u.test(word)) continue
      if (word.length < 2 && !/[a-z0-9]/i.test(word)) continue
      out.push(word)
    }
  } else {
    for (const word of raw.toLowerCase().match(/[\u4e00-\u9fff]{2}|[a-z0-9]{2,}/g) || []) out.push(word)
  }
  return out
}

/** Split a chapter into 60–180 char passages, keeping their order. */
export function splitPassages(text, { min = 60, max = 180 } = {}) {
  const sentences = String(text || '')
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > max) {
      out.push(current)
      current = ''
    }
    current += sentence
    if (current.length >= min && current.length <= max) {
      out.push(current)
      current = ''
    }
  }
  if (current.trim()) out.push(current)
  return out.filter((p) => p.trim().length >= 8)
}

/**
 * @param {Array<{index:number,title:string,pages:number[],summary?:object}>} chapters
 * @param {string[]} [texts] chapter bodies parallel to `chapters` (optional)
 */
export function buildIndex(chapters, texts = []) {
  const passages = []
  chapters.forEach((chapter, ci) => {
    const body = texts[ci] || chapter.text || (chapter.summary?.key_points || []).map((p) => (typeof p === 'string' ? p : p.text)).join('\n')
    const pieces = splitPassages(body)
    const pages = chapter.pages || []
    pieces.forEach((piece, i) => {
      const page = pages.length ? pages[Math.min(pages.length - 1, Math.floor((i / Math.max(1, pieces.length)) * pages.length))] : null
      const tokens = tokenize(`${chapter.title} ${piece}`)
      passages.push({ chapter: chapter.index, chapterTitle: chapter.title, page, text: piece, tokens, length: tokens.length })
    })
  })
  const df = new Map()
  for (const passage of passages) {
    for (const token of new Set(passage.tokens)) df.set(token, (df.get(token) || 0) + 1)
  }
  const totalLength = passages.reduce((n, p) => n + p.length, 0)
  return {
    passages,
    df,
    avgLength: passages.length ? totalLength / passages.length : 0,
    size: passages.length,
  }
}

const K1 = 1.5
const B = 0.75
/** @returns {Array<{chapter:number, chapterTitle:string, page:number|null, text:string, score:number}>} */
export function search(index, query, topK = 5) {
  const tokens = tokenize(query)
  if (!tokens.length || !index?.size) return []
  const unique = [...new Set(tokens)]
  const scored = []
  for (const passage of index.passages) {
    const tf = new Map()
    for (const token of passage.tokens) tf.set(token, (tf.get(token) || 0) + 1)
    let score = 0
    for (const token of unique) {
      const freq = tf.get(token)
      if (!freq) continue
      const df = index.df.get(token) || 0
      const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5))
      score += idf * ((freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * passage.length) / Math.max(1, index.avgLength))))
    }
    if (score > 0) scored.push({ ...passage, score: Math.round(score * 100) / 100 })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map(({ tokens, length, ...rest }) => rest)
}

/**
 * One call the panel and the tool both use.
 * @returns {{answers:Array, hint:string}}
 */
export function ask(index, question, topK = 3) {
  const answers = search(index, question, topK)
  if (!answers.length) return { answers: [], hint: '课件里没有检索到相关内容，换个问法或检查是否已生成要点' }
  return { answers, hint: '' }
}

/** Persistable form: tokens are cheap to recompute, text is what matters. */
export function serializePassages(index) {
  return (index?.passages || []).map(({ chapter, chapterTitle, page, text }) => ({ chapter, chapterTitle, page, text }))
}

export function indexFromPassages(rows) {
  const passages = (rows || []).map((row) => {
    const tokens = tokenize(`${row.chapterTitle} ${row.text}`)
    return { ...row, tokens, length: tokens.length }
  })
  const df = new Map()
  for (const passage of passages) {
    for (const token of new Set(passage.tokens)) df.set(token, (df.get(token) || 0) + 1)
  }
  const totalLength = passages.reduce((n, p) => n + p.length, 0)
  return { passages, df, avgLength: passages.length ? totalLength / passages.length : 0, size: passages.length }
}
