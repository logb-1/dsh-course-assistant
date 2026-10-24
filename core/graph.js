/**
 * Knowledge-point DAG: prerequisite edges between concepts, with the rules that
 * keep a model-proposed graph honest.
 *
 * Zero dependencies on purpose. The plugin must stay installable on a machine
 * with nothing but DSH, so this is Kahn's algorithm plus a validator — not
 * graphology, dagre or any other package.
 */

/** @typedef {{ id: string, name?: string, chapter?: number, evidence?: string }} Concept */
/** @typedef {{ from: string, to: string, evidence?: string, source?: string }} Edge */

const MAX_EDGES = 400

export function createGraph(concepts = [], edges = []) {
  const byId = new Map()
  for (const concept of concepts) {
    if (!concept?.id) continue
    byId.set(String(concept.id), {
      id: String(concept.id),
      name: String(concept.name || concept.id),
      chapter: Number.isFinite(concept.chapter) ? concept.chapter : null,
      evidence: String(concept.evidence || ''),
    })
  }
  const graph = { nodes: byId, edges: [], adjacency: new Map(), indegree: new Map() }
  for (const id of byId.keys()) {
    graph.adjacency.set(id, [])
    graph.indegree.set(id, 0)
  }
  for (const edge of edges) addEdge(graph, edge)
  return graph
}

/**
 * Add one edge if it can be added without creating a cycle.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function addEdge(graph, edge) {
  const from = String(edge?.from ?? '')
  const to = String(edge?.to ?? '')
  if (!from || !to) return { ok: false, reason: 'missing-endpoint' }
  if (from === to) return { ok: false, reason: 'self-loop' }
  if (!graph.nodes.has(from)) return { ok: false, reason: 'unknown-from' }
  if (!graph.nodes.has(to)) return { ok: false, reason: 'unknown-to' }
  if (graph.edges.length >= MAX_EDGES) return { ok: false, reason: 'too-many-edges' }
  if (graph.adjacency.get(from).some((e) => e.to === to)) return { ok: false, reason: 'duplicate' }
  // adding this edge must not close a cycle: `from` must not already be
  // reachable from `to`
  if (reachable(graph, to, from)) return { ok: false, reason: 'cycle' }
  const record = { from, to, evidence: String(edge.evidence || ''), source: String(edge.source || 'model') }
  graph.edges.push(record)
  graph.adjacency.get(from).push(record)
  graph.indegree.set(to, (graph.indegree.get(to) || 0) + 1)
  return { ok: true }
}

function reachable(graph, start, goal) {
  if (start === goal) return true
  const seen = new Set([start])
  const stack = [start]
  while (stack.length) {
    const id = stack.pop()
    for (const edge of graph.adjacency.get(id) || []) {
      if (edge.to === goal) return true
      if (!seen.has(edge.to)) {
        seen.add(edge.to)
        stack.push(edge.to)
      }
    }
  }
  return false
}

/** Kahn's algorithm; returns null when the graph has a cycle. */
export function topoOrder(graph) {
  const indegree = new Map(graph.indegree)
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const edge of graph.adjacency.get(id) || []) {
      const next = indegree.get(edge.to) - 1
      indegree.set(edge.to, next)
      if (next === 0) queue.push(edge.to)
    }
  }
  return order.length === graph.nodes.size ? order : null
}

export function prerequisitesOf(graph, id) {
  return graph.edges.filter((edge) => edge.to === id).map((edge) => edge.from)
}

export function dependentsOf(graph, id) {
  return (graph.adjacency.get(id) || []).map((edge) => edge.to)
}

/**
 * Validate model-proposed edges against the concept table and the course order.
 *
 * The model is allowed to guess; this function decides. An edge survives only if
 * both endpoints exist, it does not point backwards across chapters, and adding
 * it cannot close a cycle. Everything rejected is returned with a reason so the
 * report can show why the graph is smaller than the model claimed.
 *
 * @param {Edge[]} proposed
 * @param {Concept[]} concepts
 * @returns {{ graph: object, accepted: Edge[], rejected: Array<{ edge: Edge, reason: string }> }}
 */
export function validateEdges(proposed, concepts) {
  const graph = createGraph(concepts)
  const accepted = []
  const rejected = []
  this_loop: for (const edge of proposed || []) {
    const from = String(edge?.from ?? '')
    const to = String(edge?.to ?? '')
    const fromChapter = graph.nodes.get(from)?.chapter
    const toChapter = graph.nodes.get(to)?.chapter
    if (Number.isFinite(fromChapter) && Number.isFinite(toChapter) && fromChapter > toChapter) {
      rejected.push({ edge, reason: 'backward-chapter' })
      continue this_loop
    }
    const result = addEdge(graph, edge)
    if (result.ok) accepted.push(edge)
    else rejected.push({ edge, reason: result.reason || 'invalid' })
  }
  return { graph, accepted, rejected }
}

/**
 * Which concepts may be studied now, given what the student already knows.
 * A concept is ready when every prerequisite reaches `threshold`; a concept with
 * no prerequisites is always ready.
 *
 * @param {object} graph
 * @param {Record<string, number>} mastery concept id → 0..1
 * @param {number} threshold
 * @returns {{ ready: string[], blocked: Array<{ id: string, missing: string[] }> }}
 */
export function readiness(graph, mastery = {}, threshold = 0.6) {
  const ready = []
  const blocked = []
  for (const id of graph.nodes.keys()) {
    const prerequisites = prerequisitesOf(graph, id)
    const missing = prerequisites.filter((p) => (mastery[p] ?? 0) < threshold)
    if (missing.length) blocked.push({ id, missing })
    else ready.push(id)
  }
  return { ready, blocked }
}

/** Concepts that appear in no edge — usually a sign the extraction missed them. */
export function isolatedNodes(graph) {
  const touched = new Set()
  for (const edge of graph.edges) {
    touched.add(edge.from)
    touched.add(edge.to)
  }
  return [...graph.nodes.keys()].filter((id) => !touched.has(id))
}

export function graphStats(graph) {
  return {
    concepts: graph.nodes.size,
    edges: graph.edges.length,
    topo: topoOrder(graph) !== null,
    isolated: isolatedNodes(graph).length,
    maxDepth: maxDepth(graph),
  }
}

function maxDepth(graph) {
  const order = topoOrder(graph)
  if (!order) return 0
  const depth = new Map()
  let best = 0
  for (const id of order) {
    const prerequisites = prerequisitesOf(graph, id)
    const d = prerequisites.length ? Math.max(...prerequisites.map((p) => depth.get(p) || 0)) + 1 : 0
    depth.set(id, d)
    best = Math.max(best, d)
  }
  return best
}
