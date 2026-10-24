/**
 * Deterministic scheduler.
 *
 * The orchestration used to live inside the pipeline as "try, catch, try again,
 * fall back", which made the number of model calls impossible to predict and
 * impossible to test. This module makes every such decision a pure function of
 * (state, failure, attempt): the model never decides whether to retry.
 */
import { prerequisitesOf } from './graph.js'

export const FAILURE = {
  AUTH: 'auth',
  EMPTY: 'empty',
  BAD_JSON: 'bad-json',
  RATE_LIMIT: 'rate-limit',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
}

/** Classify an error once; the whole retry policy follows from this. */
export function classifyError(error) {
  const message = String(error?.message || error || '')
  if (/no API key|未配置|unauthorized|401|403|invalid api key/i.test(message)) return FAILURE.AUTH
  if (/模型没有返回内容|empty|no content/i.test(message)) return FAILURE.EMPTY
  if (/未返回可解析 JSON|parse|JSON/i.test(message)) return FAILURE.BAD_JSON
  if (/风控|429|rate|too many|限流/i.test(message)) return FAILURE.RATE_LIMIT
  if (/fetch|network|ECONN|timeout|ETIMEDOUT|socket/i.test(message)) return FAILURE.NETWORK
  return FAILURE.UNKNOWN
}

/**
 * Retry ladder per failure class. Deliberately a table, not a conversation.
 *
 * `maxTokens` and `passageRatio` are the knobs that actually matter for a
 * reasoning model returning nothing: more room, then less input.
 */
const LADDER = {
  [FAILURE.EMPTY]: [
    { maxTokens: 3600 },
    { maxTokens: 5200, passageRatio: 0.5 },
  ],
  [FAILURE.BAD_JSON]: [
    { maxTokens: 3200 },
  ],
  [FAILURE.RATE_LIMIT]: [
    { delayMs: 4000 },
    { delayMs: 12000 },
  ],
  [FAILURE.NETWORK]: [
    { delayMs: 1500 },
    { delayMs: 4000 },
  ],
}

/**
 * @param {string} failure classifyError() result
 * @param {number} attempt how many attempts already failed for this chapter
 * @returns {{ retry: boolean, reason: string, next: object }}
 */
export function retryDecision(failure, attempt) {
  if (failure === FAILURE.AUTH) {
    // a missing key never fixes itself; retrying only burns quota and hides the
    // real problem from the user
    return { retry: false, reason: 'auth-missing-config', next: {} }
  }
  const ladder = LADDER[failure] || []
  if (attempt >= ladder.length) {
    return { retry: false, reason: `exhausted:${failure}`, next: {} }
  }
  return { retry: true, reason: `retry:${failure}#${attempt + 1}`, next: ladder[attempt] }
}

/**
 * Pick the next action for one chapter.
 *
 * @param {{ attempts: number, failure: string|null }} state
 */
export function nextChapterAction(state) {
  if (!state.failure) return { action: 'summarize' }
  const decision = retryDecision(state.failure, state.attempts || 0)
  if (!decision.retry) return { action: 'degrade', reason: decision.reason }
  return { action: 'retry', reason: decision.reason, ...decision.next }
}

/**
 * Turn a knowledge graph into a study plan that respects prerequisites.
 *
 * A chapter is `blocked` when any prerequisite concept it introduces has an
 * unmet prerequisite in an *earlier* chapter — that is exactly the "don't
 * schedule the hard part before its foundation" rule.
 *
 * @param {object[]} chapters
 * @param {object} graph from core/graph.js
 * @param {Record<string, number>} mastery
 * @param {number} threshold
 */
export function planChapters(chapters, graph, mastery = {}, threshold = 0.6) {
  const byChapter = new Map()
  if (graph) {
    for (const concept of graph.nodes.values()) {
      if (!Number.isFinite(concept.chapter)) continue
      if (!byChapter.has(concept.chapter)) byChapter.set(concept.chapter, [])
      byChapter.get(concept.chapter).push(concept.id)
    }
  }
  const plan = []
  for (const chapter of chapters || []) {
    const concepts = byChapter.get(chapter.index) || []
    const missing = new Set()
    for (const id of concepts) {
      for (const prerequisite of prerequisitesOf(graph, id)) {
        const concept = graph.nodes.get(prerequisite)
        // a prerequisite introduced in the same chapter is usually explained first
        if (concept && Number.isFinite(concept.chapter) && concept.chapter >= chapter.index) continue
        if ((mastery[prerequisite] ?? 0) < threshold) missing.add(prerequisite)
      }
    }
    plan.push({
      index: chapter.index,
      title: chapter.title,
      concepts: concepts.length,
      blocked: missing.size > 0,
      missing: [...missing],
      order: chapter.index,
    })
  }
  return plan
}

/**
 * One-line summary of a plan, for the report header.
 * @param {ReturnType<typeof planChapters>} plan
 */
export function describePlan(plan) {
  const blocked = plan.filter((step) => step.blocked)
  if (!blocked.length) return `计划可执行：${plan.length} 章均无未满足前置`
  return `${plan.length} 章中 ${blocked.length} 章存在未满足前置：${blocked
    .map((step) => `第${step.index}章`)
    .join('、')}`
}
