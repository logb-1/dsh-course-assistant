/**
 * Grounding check for generated chapter summaries.
 *
 * A model that never received readable text still produces confident bullets.
 * Comparing the summary's character bigrams with the chapter text is a cheap,
 * local proxy for "did this come from the source at all".
 */

const STRIP = /[\s\p{P}\p{S}]/gu

function bigrams(text) {
  const clean = String(text || '').replace(STRIP, '')
  const set = new Set()
  for (let i = 0; i + 2 <= clean.length; i += 1) set.add(clean.slice(i, i + 2))
  return set
}

/**
 * @returns {number} 0..1 share of the summary's bigrams that occur in the source
 */
export function supportScore(chapterText, points) {
  const source = bigrams(chapterText)
  const list = (points || []).filter(Boolean).map((p) => bigrams(p))
  if (!source.size || !list.length) return 1
  let hit = 0
  let total = 0
  for (const grams of list) {
    for (const g of grams) {
      total += 1
      if (source.has(g)) hit += 1
    }
  }
  return total ? Math.round((hit / total) * 1000) / 1000 : 1
}

/** Below this share a chapter is flagged as weakly grounded. */
export const SUPPORT_THRESHOLD = 0.3
