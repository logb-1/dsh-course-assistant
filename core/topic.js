/**
 * Course topic profile: the anchor word that keeps a search on-topic, the
 * vocabulary that proves a video belongs to this course, and the off-topic
 * subjects that disqualify one.
 *
 * The old `detectDomain` only understood programming languages, so a
 * 「计算机系统」 course had no anchor at all and searched with page headers.
 */
import { cleanTerm, tfidfTerms } from './terms.js'

/** Off-topic subjects, removed from the list when the course itself uses the word. */
const NEGATIVE_BANK = [
  '英语', '语文', '数学', '物理', '化学', '政治', '历史', '地理', '生物',
  '高考', '中考', '考研', '中职', '中专', '小学', '初中', '高中',
  '四级', '六级', '雅思', '托福', '作文', '阅读理解',
]

function pickAnchor({ configDomain, domain, keywords, courseTitle }) {
  const manual = cleanTerm(configDomain)
  if (manual) return manual
  // the model's keywords usually carry the course name as their first word
  const votes = new Map()
  for (const keyword of keywords || []) {
    const head = cleanTerm(String(keyword).split(/[\s,，、/|]+/)[0])
    if (!head || head.length < 2) continue
    votes.set(head, (votes.get(head) || 0) + 1)
  }
  const [best, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] || []
  if (best && count >= 2) return best
  const title = cleanTerm(courseTitle)
  if (title) return title.slice(0, 20)
  return domain?.name || ''
}

/**
 * @param {object} input
 * @param {string} input.courseTitle
 * @param {string[]} input.keywords  model keywords across all chapters
 * @param {string[]} input.texts     chapter bodies (for the vocabulary)
 * @param {object|null} input.domain detectDomain() result (programming languages)
 * @param {string} [input.configDomain] user-forced domain
 */
export function buildTopicProfile({ courseTitle, keywords = [], texts = [], domain = null, configDomain = '' } = {}) {
  const corpus = (texts || []).filter(Boolean).join('\n')
  const anchor = pickAnchor({ configDomain, domain, keywords, courseTitle })
  const vocab = tfidfTerms(texts, { topK: 40 })
  const negative = NEGATIVE_BANK.filter((word) => !corpus.includes(word))
  return {
    anchor,
    vocab,
    negative,
    lang: domain?.name || '',
    courseTitle: String(courseTitle || ''),
  }
}

/**
 * @returns {{anchor:boolean, vocabHits:string[], negative:string|null}}
 */
export function matchTopic(text, profile) {
  const hay = String(text || '').toLowerCase()
  if (!profile) return { anchor: true, vocabHits: [], negative: null }
  const anchor = profile.anchor ? hay.includes(profile.anchor.toLowerCase()) : false
  const vocabHits = (profile.vocab || []).filter((term) => term.length >= 2 && hay.includes(term.toLowerCase()))
  const negative = (profile.negative || []).find((word) => hay.includes(word)) || null
  return { anchor, vocabHits, negative }
}

/** Which of this chapter's concepts appear in the video text. */
export function conceptHits(text, concepts) {
  const hay = String(text || '').toLowerCase()
  return (concepts || []).filter((concept) => {
    const value = String(concept || '').toLowerCase()
    return value.length >= 2 && hay.includes(value)
  })
}

/**
 * The topic rule: a video must prove it belongs to this course AND to this
 * chapter, and must not name an off-topic subject.
 * @returns {{ok:boolean, reason:string, anchor:boolean, vocabHits:string[], concepts:string[]}}
 */
export function judgeVideo(text, profile, concepts) {
  const { anchor, vocabHits, negative } = matchTopic(text, profile)
  if (negative) return { ok: false, reason: `off-topic:${negative}`, anchor, vocabHits, concepts: [] }
  const conceptsHit = conceptHits(text, concepts)
  const topicOk = anchor || vocabHits.length >= 2
  if (!topicOk) return { ok: false, reason: 'no-topic', anchor, vocabHits, concepts: conceptsHit }
  if (!conceptsHit.length) return { ok: false, reason: 'no-concept', anchor, vocabHits, concepts: [] }
  return { ok: true, reason: '', anchor, vocabHits, concepts: conceptsHit }
}
