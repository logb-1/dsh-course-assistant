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
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseFile } from '../core/parser.js'
import { parsePdf } from '../core/pdf.js'
import { buildOutline } from '../core/outline.js'
import { assessQuality } from '../core/quality.js'
import { detectDomain } from '../core/domain.js'
import { supportScore } from '../core/verify.js'
import { createStore } from '../core/store.js'
import { diffSummary, rerunChapter, runPipeline } from '../core/pipeline.js'

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

check('章节重跑差异：只报新增/删除的要点', () => {
  const before = { key_points: ['A', 'B'], important: ['C'], difficult: [], keywords: ['x'] }
  const after = { key_points: ['B', 'D'], important: ['C'], difficult: [], keywords: ['x', 'y'] }
  const diff = diffSummary(before, after)
  assert(diff.added.length === 1 && diff.added[0].text === 'D', `新增判错：${JSON.stringify(diff.added)}`)
  assert(diff.removed.length === 1 && diff.removed[0].text === 'A', `删除判错：${JSON.stringify(diff.removed)}`)
  assert(diff.keywordsAdded.length === 1 && diff.keywordsAdded[0] === 'y', `关键词新增判错：${JSON.stringify(diff.keywordsAdded)}`)
  assert(diff.changed === true, '应标记为有变化')
  // a rerun that produces the same bullets must not look like a change
  const same = diffSummary(before, { ...before })
  assert(same.added.length === 0 && same.removed.length === 0 && same.changed === false, '相同内容被判成有变化')
  return `+${diff.added.length} −${diff.removed.length}, 相同内容无差异`
})

check('单章重跑：只换这一章，其他章节与报告保持一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-regress-'))
  try {
    const store = createStore(dir)
    const filler = (sentence, times) => Array.from({ length: times }, () => sentence).join('')
    const body = [
      '# 微观经济学',
      '## 第一章 供给与需求',
      filler('需求量随价格上升而下降，供给量随价格上升而增加。均衡价格由两条曲线的交点决定。', 8),
      '## 第二章 弹性',
      filler('需求价格弹性等于需求量变化百分比除以价格变化百分比。弹性大于一称为富有弹性，小于一称为缺乏弹性。', 8),
      '## 第三章 市场结构',
      filler('完全竞争市场有大量卖者、同质产品与自由进出。垄断市场只有一个卖者，并且存在明显的进入壁垒。', 8),
    ].join('\n\n')
    const file = join(dir, 'course.md')
    writeFileSync(file, body, 'utf8')
    const inputs = [{ path: file, name: 'course.md' }]
    const deps = { store, bili: null, llm: null }
    const base = await runPipeline({ id: 'base', inputs, options: { withVideos: false }, deps, emit: () => {} })
    assert(base.status === 'done', `首跑失败：${base.error || base.status}`)
    assert(base.chapters.length >= 3, `只切出 ${base.chapters.length} 章`)
    const rerun = await rerunChapter({
      id: 'rerun',
      inputs,
      previous: base,
      chapterIndex: 2,
      options: { withVideos: false },
      deps,
      emit: () => {},
    })
    assert(rerun.status === 'done', `重跑失败：${rerun.error || rerun.status}`)
    assert(rerun.chapters.length === base.chapters.length, `章节数变了：${rerun.chapters.length} ≠ ${base.chapters.length}`)
    const target = rerun.chapters.find((c) => c.index === 2)
    assert(target?.rerunAt, '目标章没有 rerunAt')
    assert(target?.diff, '目标章没有 diff')
    assert(target.diff.changed === false, '本地兜底是确定性的，重跑不该有差异')
    const untouched = (job) => JSON.stringify(job.chapters.filter((c) => c.index !== 2))
    assert(untouched(rerun) === untouched(base), '其他章节被改动了')
    assert(rerun.reportPath && existsSync(rerun.reportPath), '报告没有重建')
    assert(rerun.rerunOf === base.id, 'rerunOf 没记原任务')
    return `${base.chapters.length} 章，第 2 章重跑，其余不变`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* --------------------- synthetic PDFs (layout fixtures) --------------------- */

function makePdf(ops) {
  const content = ops.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  objects.forEach((body, i) => {
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  return Buffer.from(`${out}trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n`, 'latin1')
}

const textOp = (x, y, text) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`

check('列检测：双栏 PDF 按栏读，不串行', () => {
  // drawn left-right-left-right, the way a two-column paper stores its stream
  const ops = [textOp(50, 730, 'TITLE OF THE WHOLE PAGE THAT REALLY SPANS BOTH COLUMNS WIDE')]
  const order = []
  for (let i = 1; i <= 5; i += 1) {
    const y = 700 - i * 24
    ops.push(textOp(50, y, `LEFT-${i}`), textOp(330, y, `RIGHT-${i}`))
  }
  for (let i = 1; i <= 5; i += 1) order.push(`LEFT-${i}`)
  for (let i = 1; i <= 5; i += 1) order.push(`RIGHT-${i}`)
  const text = parsePdf(makePdf(ops), 'two-column.pdf').pages[0].text
  const at = order.map((needle) => text.indexOf(needle))
  assert(at.every((i) => i >= 0), `缺文本：${text.replace(/\n/g, ' | ')}`)
  assert(text.startsWith('TITLE OF THE WHOLE PAGE'), `宽标题应最先输出：${text.split('\n')[0]}`)
  for (let i = 1; i < at.length; i += 1) {
    assert(at[i] > at[i - 1], `列顺序错：${text.replace(/\n/g, ' | ')}`)
  }
  return '左栏 5 行 → 右栏 5 行'
})

check('列检测：单栏 PDF 保持原顺序', () => {
  const ops = []
  const names = []
  for (let i = 1; i <= 9; i += 1) {
    names.push(`LINE-${i}`)
    ops.push(textOp(60, 720 - i * 24, `LINE-${i}`))
  }
  const text = parsePdf(makePdf(ops), 'one-column.pdf').pages[0].text
  const at = names.map((n) => text.indexOf(n))
  assert(at.every((i) => i >= 0), `缺文本：${text.replace(/\n/g, ' | ')}`)
  for (let i = 1; i < at.length; i += 1) {
    assert(at[i] > at[i - 1], `单栏被重排：${text.replace(/\n/g, ' | ')}`)
  }
  return '9 行原序'
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    const note = await fn()
    if (!QUIET) console.log(`PASS  ${name}${note ? `  —  ${note}` : ''}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
