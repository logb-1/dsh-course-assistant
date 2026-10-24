/**
 * Knowledge extraction: one bounded model call turns a course into concepts and
 * prerequisite candidates. The model only *proposes*; core/graph.js decides what
 * survives, so a hallucinated edge cannot reach the report.
 *
 * Cost control: the prompt carries chapter titles plus a short excerpt each, and
 * the result is cached by course hash — a second upload of the same file never
 * pays for it again.
 */
import { validateEdges } from './graph.js'

const PROMPT_VERSION = 1
const MAX_CHAPTERS = 24
const EXCERPT_CHARS = 220
const MAX_CONCEPTS = 30

export function knowledgePromptVersion() {
  return PROMPT_VERSION
}

export function buildKnowledgePrompt({ courseTitle, chapters, texts }) {
  const lines = []
  const count = Math.min(chapters.length, MAX_CHAPTERS)
  for (let i = 0; i < count; i += 1) {
    const chapter = chapters[i]
    const excerpt = String(texts?.[i] || '')
      .replace(/\s+/g, ' ')
      .slice(0, EXCERPT_CHARS)
    lines.push(`第${chapter.index}章 ${chapter.title}：${excerpt}`)
  }
  return [
    `课程：${courseTitle}`,
    '下面是各章标题与开头片段。请抽出这门课的核心概念，并给出「学 B 之前必须先学 A」的前置关系。',
    '',
    ...lines,
    '',
    '只输出一个 JSON 对象，不要解释、不要 Markdown：',
    '{"concepts":[{"id":"kebab-case 英文 id","name":"中文概念名","chapter":章号,"evidence":"原文里的短语"}],',
    ' "edges":[{"from":"前置概念 id","to":"后继概念 id","evidence":"原文里的短语"}]}',
    `要求：concepts ${Math.min(8, MAX_CONCEPTS)}-${MAX_CONCEPTS} 个，必须是本课程真实出现的概念；`,
    'edges 的 from/to 必须来自上面列出的 concepts（不能新造 id），只写有原文支撑的强前置关系，宁少勿多；',
    '同一个概念只能出现一次；跨章前置必须「前面的章 → 后面的章」。',
  ].join('\n')
}

function parseJson(raw) {
  const text = String(raw || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  const body = from >= 0 && to > from ? text.slice(from, to + 1) : text
  try {
    return JSON.parse(body)
  } catch {
    // a truncated tail is common with reasoning models: close the arrays and try
    let repaired = body
    if (!repaired.endsWith('}')) repaired += ']}'
    try {
      return JSON.parse(repaired)
    } catch {
      return null
    }
  }
}

const slug = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

/**
 * @param {{ llm: any, provider: string, model: string, courseTitle: string,
 *           chapters: object[], texts: string[], signal?: AbortSignal }} input
 * @returns {Promise<null | { concepts: object[], edges: object[], rejected: object[], stats: object }>}
 */
export async function extractKnowledge({ llm, provider, model, courseTitle, chapters, texts, signal, maxTokens = 2400 }) {
  if (!llm || !chapters?.length || chapters.length < 2) return null
  const prompt = buildKnowledgePrompt({ courseTitle, chapters, texts })
  let raw = ''
  const stream = llm.stream({
    provider,
    model,
    system: '你是课程知识图谱助手。只输出 JSON。',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    temperature: 0.1,
    signal,
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text' && chunk.text) raw += chunk.text
  }
  const parsed = parseJson(raw)
  if (!parsed) return null

  const chapterOf = new Map(chapters.map((c) => [c.index, c]))
  const concepts = []
  const seen = new Set()
  for (const item of Array.isArray(parsed.concepts) ? parsed.concepts : []) {
    const name = String(item?.name || '').trim()
    if (!name) continue
    const id = slug(item?.id || name)
    if (!id || seen.has(id)) continue
    const chapter = Number(item?.chapter)
    if (!chapterOf.has(chapter)) continue
    seen.add(id)
    concepts.push({ id, name, chapter, evidence: String(item?.evidence || '').slice(0, 120) })
    if (concepts.length >= MAX_CONCEPTS) break
  }
  if (concepts.length < 4) return null

  const proposed = (Array.isArray(parsed.edges) ? parsed.edges : [])
    .map((edge) => ({
      from: slug(edge?.from),
      to: slug(edge?.to),
      evidence: String(edge?.evidence || '').slice(0, 120),
      source: 'model',
    }))
    .filter((edge) => edge.from && edge.to)

  const { graph, accepted, rejected } = validateEdges(proposed, concepts)
  return {
    concepts,
    edges: accepted,
    rejected,
    stats: {
      concepts: concepts.length,
      proposed: proposed.length,
      accepted: accepted.length,
      rejected: rejected.length,
      depth: graphDepth(graph),
    },
  }
}

function graphDepth(graph) {
  const indegree = new Map(graph.indegree)
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id)
  const depth = new Map()
  let best = 0
  while (queue.length) {
    const id = queue.shift()
    for (const edge of graph.adjacency.get(id) || []) {
      depth.set(edge.to, Math.max(depth.get(edge.to) || 0, (depth.get(id) || 0) + 1))
      best = Math.max(best, depth.get(edge.to))
      const next = indegree.get(edge.to) - 1
      indegree.set(edge.to, next)
      if (next === 0) queue.push(edge.to)
    }
  }
  return best
}
