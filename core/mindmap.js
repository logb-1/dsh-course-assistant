import { stripHeadingNumber } from './titles.js'

/**
 * Mind map for the report.
 *
 * Two renderings from the same data:
 *  - an indented tree that is readable in any Markdown viewer (the report may be
 *    opened in a plain editor),
 *  - a Mermaid `mindmap` block for viewers that render it.
 *
 * Deliberately no SVG layout library: the plugin ships zero dependencies, and a
 * broken diagram is worse than a readable outline.
 */

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * @param {{ courseTitle: string, chapters: object[], plan?: object[], graph?: object }} input
 */
export function mindmapTree({ courseTitle, chapters = [], plan = [], graph = null }) {
  const byChapter = new Map()
  if (graph?.nodes) {
    for (const concept of graph.nodes.values()) {
      if (!Number.isFinite(concept.chapter)) continue
      if (!byChapter.has(concept.chapter)) byChapter.set(concept.chapter, [])
      byChapter.get(concept.chapter).push(concept.name || concept.id)
    }
  }
  const blockedByChapter = new Map((plan || []).filter((s) => s.blocked).map((s) => [s.index, s]))
  const lines = [clip(courseTitle || '课程', 40)]
  for (const chapter of chapters) {
    const blocked = blockedByChapter.get(chapter.index)
    const suffix = blocked ? `  ⚠ 前置未满足 ${blocked.missing.length}` : ''
    lines.push(`├─ 第${chapter.index}章 ${clip(stripHeadingNumber(chapter.title) || chapter.title, 28)}${suffix}`)
    for (const name of (byChapter.get(chapter.index) || []).slice(0, 5)) {
      lines.push(`│   · ${clip(name, 24)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Mermaid mindmap block. Concept names are sanitised because Mermaid treats
 * brackets and parentheses as syntax.
 */
export function mindmapMermaid({ courseTitle, chapters = [], plan = [], graph = null }) {
  const byChapter = new Map()
  if (graph?.nodes) {
    for (const concept of graph.nodes.values()) {
      if (!Number.isFinite(concept.chapter)) continue
      if (!byChapter.has(concept.chapter)) byChapter.set(concept.chapter, [])
      byChapter.get(concept.chapter).push(concept.name || concept.id)
    }
  }
  const blocked = new Set((plan || []).filter((s) => s.blocked).map((s) => s.index))
  const safe = (text) => clip(text, 28).replace(/[()[\]{}"`]/g, ' ')
  const lines = ['mindmap', `  root((${safe(courseTitle || '课程')}))`]
  for (const chapter of chapters) {
    const label = `第${chapter.index}章 ${safe(chapter.title)}${blocked.has(chapter.index) ? ' ⚠' : ''}`
    lines.push(`    ch${chapter.index}[${label}]`)
    for (const name of (byChapter.get(chapter.index) || []).slice(0, 4)) {
      lines.push(`      ${safe(name)}`)
    }
  }
  return lines.join('\n')
}

/** Markdown section for the report; empty string when there is nothing to say. */
export function renderMindmapSection({ courseTitle, chapters, plan, graph }) {
  if (!chapters?.length) return ''
  const tree = mindmapTree({ courseTitle, chapters, plan, graph })
  const lines = ['## 前置知识路径', '', '```', tree, '```', '']
  if ((plan || []).some((step) => step.blocked)) {
    lines.push('> ⚠ 标记的章节存在未满足的前置概念：先补齐左侧依赖，再安排该章难点。', '')
  }
  lines.push('<details><summary>Mermaid 思维导图（可复制到支持 Mermaid 的编辑器）</summary>', '', '```mermaid', mindmapMermaid({ courseTitle, chapters, plan, graph }), '```', '', '</details>', '')
  return lines.join('\n')
}
