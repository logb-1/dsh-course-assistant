#!/usr/bin/env node
/**
 * Regression checks over the real files that broke this plugin.
 *
 *   node tools/regress.mjs            # all checks
 *   node tools/regress.mjs --quiet    # failures only
 *
 * Every assertion encodes a bug we actually hit, so a future change that
 * reintroduces it fails loudly instead of silently degrading a report.
 */
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { parseFile } from '../core/parser.js'
import { buildOutline } from '../core/outline.js'
import { assessQuality } from '../core/quality.js'
import { detectDomain } from '../core/domain.js'
import { supportScore } from '../core/verify.js'

const QUIET = process.argv.includes('--quiet')
const DESKTOP = 'C:\\Users\\ThinkPad\\Desktop'
const WORKSPACE = 'C:\\Users\\ThinkPad\\Documents\\deepseek-harness\\default-workspace'

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}
const cjkCount = (text) => (String(text).match(/[\u4e00-\u9fff]/g) || []).length

const FILES = {
  L10: `${DESKTOP}\\L10_C08_多态与虚函数.pdf`,
  L12: `${DESKTOP}\\L12_C10_异常与断言.pdf`,
  deck: `${WORKSPACE}\\关上800美元的小门_课程汇报.pptx`,
  docx: `${WORKSPACE}\\关上800美元的小门_数据与模型出处说明.docx`,
  md: `${DESKTOP}\\计算机系统基础 复习&自学大纲.md`,
}

check('PDF 字形反查：PowerPoint 导出的 PDF 能读出中文', () => {
  if (!existsSync(FILES.L10)) return 'skip'
  const doc = parseFile(FILES.L10, basename(FILES.L10))
  const cjk = cjkCount(doc.pages.map((p) => p.text).join('\n'))
  assert(cjk >= 500, `L10 汉字只有 ${cjk}（应 ≥500，字形反查失效？）`)
  return `L10 cjk=${cjk}`
})

check('PDF 字形反查：第二份导出件同样可读', () => {
  if (!existsSync(FILES.L12)) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  const cjk = cjkCount(doc.pages.map((p) => p.text).join('\n'))
  assert(cjk >= 300, `L12 汉字只有 ${cjk}（应 ≥300）`)
  return `L12 cjk=${cjk}`
})

check('质量闸门：乱码 PDF 不该被判为 good', () => {
  if (!existsSync(FILES.L12)) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  const q = assessQuality([doc])
  assert(q.tier !== 'good', `L12 判成了 ${q.tier}，可疑字符率 ${q.metrics.noiseRatio}`)
  return `${q.tier} noise=${q.metrics.noiseRatio}`
})

check('领域锚定：C++ 课件识别为 C++', () => {
  if (!existsSync(FILES.L12)) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  const domain = detectDomain([doc])
  assert(domain?.name === 'C++', `识别为 ${domain?.name || 'null'}，应为 C++`)
  return `${domain.name} score=${domain.score}`
})

check('切章：幻灯片型 PDF 不再塌成 1 章', () => {
  for (const key of ['L10', 'L12']) {
    if (!existsSync(FILES[key])) continue
    const doc = parseFile(FILES[key], basename(FILES[key]))
    const outline = buildOutline([doc])
    assert(outline.chapters.length >= 3, `${key} 只切出 ${outline.chapters.length} 章（应 ≥3）`)
  }
  return 'L10/L12 ≥3 章'
})

check('PPTX：演讲者备注被读入', () => {
  if (!existsSync(FILES.deck)) return 'skip'
  const doc = parseFile(FILES.deck, basename(FILES.deck))
  const withNotes = doc.pages.filter((p) => p.notes).length
  assert(withNotes >= 1, '没有任何演讲者备注')
  const chars = doc.pages.reduce((n, p) => n + p.text.length, 0)
  assert(chars >= 20000, `全文 ${chars} 字（应 ≥20000）`)
  return `${doc.pages.length} 页, ${withNotes} 页有备注, ${chars} 字`
})

check('PPTX/DOCX 切章数量稳定', () => {
  if (existsSync(FILES.deck)) {
    const deck = buildOutline([parseFile(FILES.deck, basename(FILES.deck))])
    assert(deck.chapters.length >= 8 && deck.chapters.length <= 14, `deck 切出 ${deck.chapters.length} 章`)
  }
  if (existsSync(FILES.docx)) {
    const doc = buildOutline([parseFile(FILES.docx, basename(FILES.docx))])
    assert(doc.chapters.length >= 5, `docx 只切出 ${doc.chapters.length} 章`)
  }
  return 'deck 8–14 章, docx ≥5 章'
})

check('Markdown：按标题切章', () => {
  if (!existsSync(FILES.md)) return 'skip'
  const doc = parseFile(FILES.md, basename(FILES.md))
  const outline = buildOutline([doc])
  assert(outline.chapters.length >= 6, `md 只切出 ${outline.chapters.length} 章`)
  return `${outline.chapters.length} 章`
})

check('可信度：原文要点高重合、编造内容低重合', () => {
  const text = '正式制度包括法律、产权与契约安排。非正式制度包括惯例、文化与行业规范。'
  const good = supportScore(text, ['正式制度包括法律与契约安排', '非正式制度包括惯例与行业规范'])
  const bad = supportScore(text, ['本章讨论国际贸易政策的历史演进与理论发展'])
  assert(good > 0.6, `原文要点得分 ${good} 偏低`)
  assert(bad < 0.2, `编造内容得分 ${bad} 偏高`)
  return `good=${good} bad=${bad}`
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    const note = fn()
    if (!QUIET) console.log(`PASS  ${name}${note ? `  —  ${note}` : ''}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
