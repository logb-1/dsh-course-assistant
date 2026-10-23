#!/usr/bin/env node
/**
 * Chapter-boundary metrics.
 *
 * The plugin's chaptering is judged on page boundaries, so the classic
 * text-segmentation metrics are adapted to a page sequence:
 *   - WindowDiff (Pevzner & Hearst 2002): share of sliding windows whose number
 *     of boundaries differs between reference and hypothesis. 0 is perfect.
 *   - Boundary F1 with a ±N page tolerance: a boundary one page off is still a
 *     useful chapter start for a human reader.
 *
 * CLI: node tools/segment-metrics.mjs [gold.json ...]
 * A gold file is { "file": "<path or name>", "boundaries": [1, 8, 15, ...] }
 * where boundaries are 1-based chapter-start pages.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFile } from '../core/parser.js'
import { buildOutline } from '../core/outline.js'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))

/** boolean[] → page numbers (1-based) where a chapter starts */
export function boundaryPages(flags) {
  const out = []
  flags.forEach((flag, i) => {
    if (flag) out.push(i + 1)
  })
  return out
}

/** chapters → boolean[] of length pageCount */
export function flagsFromChapters(chapters, pageCount) {
  const flags = new Array(pageCount).fill(false)
  for (const chapter of chapters) {
    const first = (chapter.pages || []).slice().sort((a, b) => a - b)[0]
    if (first >= 1 && first <= pageCount) flags[first - 1] = true
  }
  flags[0] = true
  return flags
}

/**
 * @param {boolean[]} ref reference chapter-start flags
 * @param {boolean[]} hyp hypothesis chapter-start flags
 * @param {number} [k] window size in pages; default N / (2 × reference chapters)
 */
export function windowDiff(ref, hyp, k) {
  const n = ref.length
  if (!n || hyp.length !== n) return 1
  const kk = Math.max(1, Math.round(k || n / (2 * Math.max(1, ref.filter(Boolean).length))))
  let error = 0
  let total = 0
  for (let i = 0; i + kk <= n; i += 1) {
    let r = 0
    let h = 0
    for (let j = i; j < i + kk; j += 1) {
      if (ref[j]) r += 1
      if (hyp[j]) h += 1
    }
    if (r !== h) error += 1
    total += 1
  }
  return total ? Math.round((error / total) * 1000) / 1000 : 0
}

/**
 * @param {boolean[]} ref
 * @param {boolean[]} hyp
 * @param {number} tolerance pages a hypothesis boundary may be off by
 */
export function boundaryF1(ref, hyp, tolerance = 1) {
  const r = boundaryPages(ref).filter((page) => page > 1)
  const h = boundaryPages(hyp).filter((page) => page > 1)
  if (!r.length && !h.length) return { precision: 1, recall: 1, f1: 1, matched: 0 }
  const used = new Set()
  let matched = 0
  for (const page of r) {
    let best = -1
    let bestGap = Infinity
    h.forEach((candidate, index) => {
      if (used.has(index)) return
      const gap = Math.abs(candidate - page)
      if (gap <= tolerance && gap < bestGap) {
        best = index
        bestGap = gap
      }
    })
    if (best >= 0) {
      used.add(best)
      matched += 1
    }
  }
  const precision = h.length ? matched / h.length : r.length ? 0 : 1
  const recall = r.length ? matched / r.length : h.length ? 0 : 1
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return {
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    matched,
  }
}

/** Evaluate one parsed document against a gold boundary list. */
export function evaluateDoc(doc, goldBoundaries, { tolerance = 1 } = {}) {
  const pageCount = doc.pages?.length || 0
  const outline = buildOutline([doc])
  const hyp = flagsFromChapters(outline.chapters, pageCount)
  const ref = new Array(pageCount).fill(false)
  for (const page of goldBoundaries) if (page >= 1 && page <= pageCount) ref[page - 1] = true
  ref[0] = true
  return {
    chapters: outline.chapters.length,
    goldChapters: goldBoundaries.length,
    windowDiff: windowDiff(ref, hyp),
    ...boundaryF1(ref, hyp, tolerance),
  }
}

function loadGold(file) {
  const gold = JSON.parse(readFileSync(file, 'utf8'))
  const target = gold.file || ''
  return {
    file: target && /^[A-Za-z]:[\\/]/.test(target) ? target : join(dirname(file), target),
    name: gold.file || basename(file),
    boundaries: gold.boundaries || [],
    notes: gold.notes || '',
  }
}

if (process.argv[1] && process.argv[1].endsWith('segment-metrics.mjs')) {
  const goldDir = join(HERE, 'gold')
  const args = process.argv.slice(2)
  const files = args.length ? args : existsSync(goldDir) ? readdirSync(goldDir).filter((n) => n.endsWith('.json')).map((n) => join(goldDir, n)) : []
  if (!files.length) {
    console.log('没有 gold 文件（tools/gold/*.json）')
    process.exit(0)
  }
  for (const file of files) {
    const gold = loadGold(file)
    if (!existsSync(gold.file)) {
      console.log(`SKIP  ${gold.name}（课件不在 ${gold.file}）`)
      continue
    }
    const doc = parseFile(gold.file, gold.name)
    const result = evaluateDoc(doc, gold.boundaries)
    console.log(
      `PASS  ${gold.name}  章数 ${result.chapters}/${result.goldChapters}  windowdiff ${result.windowDiff}  ` +
        `P ${result.precision} R ${result.recall} F1 ${result.f1}`,
    )
  }
}
