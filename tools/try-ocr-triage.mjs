#!/usr/bin/env node
/**
 * Inspect OCR triage on a real PDF: which pages would be re-read, and why.
 *
 *   node tools/try-ocr-triage.mjs "D:\课件.pdf"                 # plan only
 *   node tools/try-ocr-triage.mjs "D:\课件.pdf" --run 3         # also OCR 3 pages
 *   node tools/try-ocr-triage.mjs "D:\课件.pdf" --mode all
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { parseFile } from '../core/parser.js'
import { planOcrPages } from '../core/ocr-triage.js'
import { scoreText } from '../core/ocr-score.js'
import { ocrPdfDeep, ocrStatus } from '../core/ocr.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
if (!file || !existsSync(file)) {
  console.error('用法：node tools/try-ocr-triage.mjs <课件.pdf> [--mode auto|all] [--run N]')
  process.exit(2)
}
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'auto'
const runAt = args.indexOf('--run')
const runPages = runAt >= 0 ? Number(args[runAt + 1]) || 0 : 0

const doc = parseFile(file, basename(file))
const plan = planOcrPages(doc.pages || [], { mode, maxPages: 400 })
console.log(`${basename(file)}：${plan.total} 页，${mode} 模式`)
console.log(`  需重读 ${plan.weak} 页，计划 ${plan.pages.length} 页，顺延 ${plan.deferred} 页，扫描版=${plan.scanned}`)
console.log(`  原因：${JSON.stringify(plan.reasons)}；无图空页跳过 ${plan.emptyPages} 页`)
for (const page of (doc.pages || []).slice(0, 12)) {
  const s = scoreText(page.text)
  const mark = plan.pages.includes(page.index) ? '*' : ' '
  console.log(`  ${mark} p.${String(page.index).padStart(3)}  ${String(s.chars).padStart(5)} 字  图${page.images ?? '?'}  ${s.score.toFixed(2)}  ${page.title?.slice(0, 24) || ''}`)
}

if (runPages > 0) {
  const status = await ocrStatus()
  const available = status.filter((row) => row.available).map((row) => row.id)
  console.log(`\n可用引擎：${available.join(', ') || '无'}`)
  const targets = plan.pages.slice(0, runPages)
  const started = Date.now()
  const deep = await ocrPdfDeep(file, { candidates: available, pages: targets, onProgress: (d, t) => process.stdout.write(`\r  OCR ${d}/${t}`) })
  process.stdout.write('\n')
  console.log(`读 ${deep.pages.length} 页，用时 ${((Date.now() - started) / 1000).toFixed(1)}s，引擎 ${deep.stats.engine}`)
  for (const page of deep.pages) {
    const s = scoreText(page.text)
    console.log(`  p.${page.index} → ${s.chars} 字 / ${s.score.toFixed(2)} 分：${page.text.replace(/\n/g, ' | ').slice(0, 70)}`)
  }
}
