#!/usr/bin/env node
/**
 * Regression checks over the real files that broke this plugin.
 *
 *   node tools/regress.mjs                 # everything available
 *   node tools/regress.mjs --unit          # synthetic only (any machine, no fixtures)
 *   node tools/regress.mjs --unit --strict # a skipped unit test fails the run (CI)
 *   node tools/regress.mjs --real          # only checks that need courseware
 *
 * Fixtures resolve from CA_FIXTURES, then tools/fixtures/, then the Desktop
 * paths this project grew up with. Missing courseware is a skip, never a silent
 * pass; `--strict` turns unit skips into failures.
 *
 * Every assertion encodes a bug we actually hit, so a future change that
 * reintroduces it fails loudly instead of silently degrading a report.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFile } from '../core/parser.js'
import { parsePdf } from '../core/pdf.js'
import { buildOutline } from '../core/outline.js'
import { assessQuality } from '../core/quality.js'
import { detectDomain } from '../core/domain.js'
import { supportScore, evaluateSummary } from '../core/verify.js'
import { createStore } from '../core/store.js'
import { diffSummary, rerunChapter, runPipeline } from '../core/pipeline.js'

const ARGV = process.argv.slice(2)
const QUIET = ARGV.includes('--quiet')
const STRICT = ARGV.includes('--strict')
const ONLY_UNIT = ARGV.includes('--unit')
const ONLY_REAL = ARGV.includes('--real')

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const FIXTURES = process.env.CA_FIXTURES || join(HERE, 'fixtures')
const DESKTOP = process.env.CA_DESKTOP || 'C:\\Users\\ThinkPad\\Desktop'
const WORKSPACE = process.env.CA_WORKSPACE || 'C:\\Users\\ThinkPad\\Documents\\deepseek-harness\\default-workspace'

const checks = []
const check = (name, fn, group = 'unit') => checks.push({ name, fn, group })
const real = (name, fn) => check(name, fn, 'real')
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}
const cjkCount = (text) => (String(text).match(/[\u4e00-\u9fff]/g) || []).length
const pick = (...paths) => paths.find((p) => p && existsSync(p)) || ''

const FILES = {
  L10: pick(join(FIXTURES, 'L10_C08_多态与虚函数.pdf'), join(DESKTOP, 'L10_C08_多态与虚函数.pdf')),
  L12: pick(join(FIXTURES, 'L12_C10_异常与断言.pdf'), join(DESKTOP, 'L12_C10_异常与断言.pdf')),
  deck: pick(join(FIXTURES, '关上800美元的小门_课程汇报.pptx'), join(WORKSPACE, '关上800美元的小门_课程汇报.pptx')),
  docx: pick(join(FIXTURES, '关上800美元的小门_数据与模型出处说明.docx'), join(WORKSPACE, '关上800美元的小门_数据与模型出处说明.docx')),
  md: pick(join(FIXTURES, '计算机系统基础 复习&自学大纲.md'), join(DESKTOP, '计算机系统基础 复习&自学大纲.md')),
}

/* ------------------------------ real courseware ------------------------------ */

real('PDF 字形反查：PowerPoint 导出的 PDF 能读出中文', () => {
  if (!FILES.L10) return 'skip'
  const doc = parseFile(FILES.L10, basename(FILES.L10))
  const cjk = cjkCount(doc.pages.map((p) => p.text).join('\n'))
  assert(cjk >= 500, `L10 汉字只有 ${cjk}（应 ≥500，字形反查失效？）`)
  return `L10 cjk=${cjk}`
})

real('PDF 字形反查：第二份导出件同样可读', () => {
  if (!FILES.L12) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  const cjk = cjkCount(doc.pages.map((p) => p.text).join('\n'))
  assert(cjk >= 300, `L12 汉字只有 ${cjk}（应 ≥300）`)
  return `L12 cjk=${cjk}`
})

real('质量闸门：乱码 PDF 不该被判为 good', () => {
  if (!FILES.L12) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  const q = assessQuality([doc])
  assert(q.tier !== 'good', `L12 判成了 ${q.tier}，可疑字符率 ${q.metrics.noiseRatio}`)
  return `${q.tier} noise=${q.metrics.noiseRatio}`
})

real('领域锚定：C++ 课件识别为 C++', () => {
  if (!FILES.L12) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  const domain = detectDomain([doc])
  assert(domain?.name === 'C++', `识别为 ${domain?.name || 'null'}，应为 C++`)
  return `${domain.name} score=${domain.score}`
})

real('切章：幻灯片型 PDF 不再塌成 1 章', () => {
  let ran = 0
  for (const key of ['L10', 'L12']) {
    if (!FILES[key]) continue
    ran += 1
    const doc = parseFile(FILES[key], basename(FILES[key]))
    const outline = buildOutline([doc])
    assert(outline.chapters.length >= 3, `${key} 只切出 ${outline.chapters.length} 章（应 ≥3）`)
  }
  return ran ? 'L10/L12 ≥3 章' : 'skip'
})

real('PPTX：演讲者备注被读入', () => {
  if (!FILES.deck) return 'skip'
  const doc = parseFile(FILES.deck, basename(FILES.deck))
  const withNotes = doc.pages.filter((p) => p.notes).length
  assert(withNotes >= 1, '没有任何演讲者备注')
  const chars = doc.pages.reduce((n, p) => n + p.text.length, 0)
  assert(chars >= 20000, `全文 ${chars} 字（应 ≥20000）`)
  return `${doc.pages.length} 页, ${withNotes} 页有备注, ${chars} 字`
})

real('PPTX/DOCX 切章数量稳定', () => {
  let ran = 0
  if (FILES.deck) {
    ran += 1
    const deck = buildOutline([parseFile(FILES.deck, basename(FILES.deck))])
    assert(deck.chapters.length >= 8 && deck.chapters.length <= 14, `deck 切出 ${deck.chapters.length} 章`)
  }
  if (FILES.docx) {
    ran += 1
    const doc = buildOutline([parseFile(FILES.docx, basename(FILES.docx))])
    assert(doc.chapters.length >= 5, `docx 只切出 ${doc.chapters.length} 章`)
  }
  return ran ? 'deck 8–14 章, docx ≥5 章' : 'skip'
})

real('Markdown：按标题切章', () => {
  if (!FILES.md) return 'skip'
  const doc = parseFile(FILES.md, basename(FILES.md))
  const outline = buildOutline([doc])
  assert(outline.chapters.length >= 6, `md 只切出 ${outline.chapters.length} 章`)
  return `${outline.chapters.length} 章`
})

/* ---------------------------------- unit ---------------------------------- */

check('可信度：原文要点高重合、编造内容低重合', () => {
  const text = '正式制度包括法律、产权与契约安排。非正式制度包括惯例、文化与行业规范。'
  const good = supportScore(text, ['正式制度包括法律与契约安排', '非正式制度包括惯例与行业规范'])
  const bad = supportScore(text, ['本章讨论国际贸易政策的历史演进与理论发展'])
  assert(good > 0.6, `原文要点得分 ${good} 偏低`)
  assert(bad < 0.2, `编造内容得分 ${bad} 偏高`)
  return `good=${good} bad=${bad}`
})

check('可信度：空文本不再得满分（null 语义）', () => {
  assert(supportScore('', ['任意要点']) === null, '空原文应返回 null，不能是 1')
  assert(supportScore('有原文', []) === null, '没有要点应返回 null')
  const c = evaluateSummary('', { key_points: [{ text: '甲', evidence: '' }] })
  assert(c.tier === 'unrated' || c.tier === 'suspect', `空原文判成了 ${c.tier}`)
  return 'null → unrated'
})

check('证据机检：引文能命中原文才算有依据', () => {
  const text = '需求价格弹性等于需求量变化百分比除以价格变化百分比，弹性大于一称为富有弹性。'
  const exact = evaluateSummary(text, {
    key_points: [{ text: '弹性大于一称为富有弹性', evidence: '弹性大于一称为富有弹性' }],
  })
  assert(exact.evidence.exact === 1, `exact 未命中：${JSON.stringify(exact.evidence)}`)
  assert(exact.tier === 'verified', `应判 verified，实际 ${exact.tier}`)
  const fake = evaluateSummary(text, {
    key_points: [{ text: '完全竞争市场的四个条件', evidence: '完全竞争市场有大量买者与卖者并且产品同质' }],
  })
  assert(fake.evidence.missing === 1 || fake.evidence.short === 1, `伪造引文未被识别：${JSON.stringify(fake.evidence)}`)
  assert(fake.tier !== 'verified', '伪造引文应降级')
  const short = evaluateSummary(text, { key_points: [{ text: '弹性', evidence: '弹性' }] })
  assert(short.evidence.short === 1, '过短引文应标 short')
  return `exact=${exact.tier} fake=${fake.tier}`
})

check('章节重跑差异：只报新增/删除的要点', () => {
  const before = { key_points: ['A', 'B'], important: ['C'], difficult: [], keywords: ['x'] }
  const after = { key_points: ['B', 'D'], important: ['C'], difficult: [], keywords: ['x', 'y'] }
  const diff = diffSummary(before, after)
  assert(diff.added.length === 1 && diff.added[0].text === 'D', `新增判错：${JSON.stringify(diff.added)}`)
  assert(diff.removed.length === 1 && diff.removed[0].text === 'A', `删除判错：${JSON.stringify(diff.removed)}`)
  assert(diff.keywordsAdded.length === 1 && diff.keywordsAdded[0] === 'y', `关键词新增判错：${JSON.stringify(diff.keywordsAdded)}`)
  assert(diff.changed === true, '应标记为有变化')
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
    assert(base.inputs?.length === 1, 'manifest 没有记录输入')
    assert(base.outline?.boundaries?.length === base.chapters.length, 'manifest 没有锁住分章边界')
    assert(base.schemaVersion === 2, `schemaVersion 应为 2，实际 ${base.schemaVersion}`)
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
    assert(target?.confidence, '重跑章节缺少可信度评估')
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

/* --------------------------------- runner --------------------------------- */

const selected = checks.filter(({ group }) => (ONLY_UNIT ? group === 'unit' : ONLY_REAL ? group === 'real' : true))
let failed = 0
let skipped = 0

for (const { name, fn, group } of selected) {
  try {
    const note = await fn()
    if (note === 'skip') {
      skipped += 1
      const strictFail = STRICT && group === 'unit'
      if (strictFail) failed += 1
      if (!QUIET) console.log(`${strictFail ? 'FAIL' : 'SKIP'}  ${name}  (缺少课件文件)`)
      continue
    }
    if (!QUIET) console.log(`PASS  ${name}${note ? `  —  ${note}` : ''}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

const passed = selected.length - failed - skipped
const summary = `${passed} pass / ${skipped} skip / ${failed} fail`
console.log(QUIET && !failed ? summary : `\n${failed ? `${summary}（${failed} 项失败）` : `全部通过（${summary}）`}`)
process.exit(failed ? 1 : 0)
