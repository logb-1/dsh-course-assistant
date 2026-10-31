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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFile } from '../core/parser.js'
import { parsePdf } from '../core/pdf.js'
import { cleanDoc } from '../core/text.js'
import { buildOutline } from '../core/outline.js'
import { assessQuality } from '../core/quality.js'
import { detectDomain } from '../core/domain.js'
import { supportScore, evaluateSummary } from '../core/verify.js'
import { selectPassages, summarizeChapter } from '../core/summarize.js'
import { splitSections } from '../core/sections.js'
import { auditCoverage } from '../core/audit.js'
import { createStore } from '../core/store.js'
import { __debug as ooxmlDebug } from '../core/ooxml.js'
import { boundaryF1, evaluateDoc, windowDiff } from './segment-metrics.mjs'
import { ask, buildIndex, indexFromPassages, search, serializePassages } from '../core/search.js'
import { coverage, parseSyllabus } from '../core/coverage.js'
import { bestPart, rankWithTopic } from '../core/bili.js'
import { cleanKeywords, cleanTerm } from '../core/terms.js'
import { extractKeywords } from '../core/keywords.js'
import { addEdge, topoOrder, validateEdges } from '../core/graph.js'
import { FAILURE, classifyError, nextChapterAction, planChapters } from '../core/schedule.js'
import { mindmapMermaid, mindmapTree, renderMindmapSection } from '../core/mindmap.js'
import { buildKnowledgePrompt, extractKnowledge, fallbackKnowledge } from '../core/knowledge.js'
import { dedupeKeyFor } from '../core/pipeline.js'
import { renderDashboardHtml } from '../core/dashboard.js'
import { attachImageText, imageSize } from '../core/media.js'
import { fixOcrArtifacts } from '../core/ocr-text.js'
import { applyOcrPages, planOcrPages } from '../core/ocr-triage.js'
import { scoreText } from '../core/ocr-score.js'
import { ocrPdf, ocrPdfDeep, registerOcrEngine } from '../core/ocr.js'
import { buildTopicProfile } from '../core/topic.js'
import { buildAnkiCsv, buildCourseJson } from '../index.js'
import { diffSummary, readImageTexts, rerunChapter, runPipeline } from '../core/pipeline.js'

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

real('PDF 图片页：只有图片的页不再被丢弃，页号保持真实', () => {
  if (!FILES.L12) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  // L12 真实页数 67（WinRT pageCount 与 PyMuPDF 一致）；此前只解析出 54 页
  assert(doc.pages.length === 67, `L12 应解析出 67 页，实际 ${doc.pages.length} 页`)
  const pictureOnly = doc.pages.filter((page) => !page.text.trim() && page.images > 0)
  assert(pictureOnly.length >= 10, `只有图片的页应保留，实际 ${pictureOnly.length} 页`)
  const sequential = doc.pages.every((page, i) => page.index === i + 1)
  assert(sequential, `页号被压缩：${doc.pages.map((p) => p.index).join(',')}`)
  return `67 页，其中 ${pictureOnly.length} 页只有图片`
})

real('OCR 分诊：真实课件只挑读不出来的页，不全量重读', () => {
  if (!FILES.L12) return 'skip'
  const doc = parseFile(FILES.L12, basename(FILES.L12))
  const plan = planOcrPages(doc.pages, { mode: 'auto', maxPages: 60 })
  assert(plan.pages.length > 0, '应该至少有几页需要重读')
  assert(plan.pages.length < doc.pages.length * 0.6, `读了 ${plan.pages.length}/${doc.pages.length} 页，分诊没有省下来`)
  assert(plan.scanned === false, 'L12 不该判成扫描件')
  const noText = doc.pages.filter((page) => !page.text.trim()).map((page) => page.index)
  assert(noText.length > 0, 'L12 应有纯图片页')
  assert(noText.every((index) => plan.pages.includes(index)), `无文本页没进计划：${noText.join(',')}`)
  const all = planOcrPages(doc.pages, { mode: 'all', maxPages: 60 })
  assert(all.pages.length === 60 && all.deferred === doc.pages.length - 60, `all 模式上限记账不对：${all.pages.length}/${all.deferred}`)
  return `${plan.pages.length}/67 页，${JSON.stringify(plan.reasons)}`
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

real('分章质量：gold 集上的 windowdiff 与边界 F1', () => {
  const dir = join(HERE, 'gold')
  if (!existsSync(dir)) return 'skip'
  const rows = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const gold = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    const target = /^[A-Za-z]:[\\/]/.test(gold.file) ? gold.file : join(dir, gold.file)
    if (!existsSync(target)) continue
    const doc = parseFile(target, gold.name || basename(target))
    const result = evaluateDoc(doc, gold.boundaries)
    assert(result.windowDiff <= 0.25, `${name} windowdiff ${result.windowDiff} 偏高（>0.25）`)
    assert(result.f1 >= 0.85, `${name} 边界 F1 ${result.f1} 偏低（<0.85）`)
    rows.push(`${name}: 章 ${result.chapters}/${result.goldChapters} wd=${result.windowDiff} F1=${result.f1}`)
  }
  return rows.length ? rows.join('；') : 'skip'
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

check('同名章节：重复页眉合并且不出现同名', () => {
  const same = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    title: '第 3 章 指针与数组',
    text: '幻灯内容 '.repeat(20),
  }))
  const one = buildOutline([{ kind: 'pptx', title: '测试课件', pages: same, blocks: [] }])
  assert(one.chapters.length === 1, `重复页眉切出了 ${one.chapters.length} 章`)
  const mixed = [
    ...Array.from({ length: 3 }, (_, i) => ({ index: i + 1, title: '第 1 章 甲', text: '甲内容 '.repeat(30) })),
    ...Array.from({ length: 3 }, (_, i) => ({ index: i + 4, title: '第 2 章 乙', text: '乙内容 '.repeat(30) })),
    ...Array.from({ length: 3 }, (_, i) => ({ index: i + 7, title: '第 1 章 甲', text: '甲补充 '.repeat(30) })),
  ]
  const two = buildOutline([{ kind: 'pptx', title: '测试2', pages: mixed, blocks: [] }])
  const titles = two.chapters.map((c) => c.title)
  assert(new Set(titles).size === titles.length, `出现同名章：${titles.join(' | ')}`)
  assert(titles.some((t) => /p\d+–\d+/.test(t)), `非相邻同名没有付页码：${titles.join(' | ')}`)
  return `${one.chapters.length} 章 / ${two.chapters.length} 章带区间`
})

check('PPTX 节：按 slide id 还原节边界（id 非单调）', () => {
  const pres = `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/>
    <p:sldId id="259" r:id="rId4"/><p:sldId id="258" r:id="rId5"/>
  </p:sldIdLst>
  <p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">
    <p14:sectionLst>
      <p14:section name="Introduction" id="{01F07B81}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section>
      <p14:section name="Content" id="{1FEF2C88}"><p14:sldIdLst><p14:sldId id="257"/><p14:sldId id="259"/></p14:sldIdLst></p14:section>
      <p14:section name="Conclusion" id="{CA1E145A}"><p14:sldIdLst><p14:sldId id="258"/></p14:sldIdLst></p14:section>
    </p14:sectionLst></p:ext></p:extLst></p:presentation>`
  const rels = new Map([
    ['rId2', { type: 'slide', target: 'slides/slide1.xml' }],
    ['rId3', { type: 'slide', target: 'slides/slide2.xml' }],
    ['rId4', { type: 'slide', target: 'slides/slide3.xml' }],
    ['rId5', { type: 'slide', target: 'slides/slide4.xml' }],
  ])
  const order = ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml', 'ppt/slides/slide4.xml']
  const sections = ooxmlDebug.parsePptxSections(pres, rels, order)
  assert(sections.length === 3, `解析出 ${sections.length} 个节`)
  assert(sections[0].name === 'Introduction' && sections[0].pages.join(',') === '1', `第一节：${JSON.stringify(sections[0])}`)
  assert(sections[1].pages.join(',') === '2,3', `Content 应覆盖第 2、3 页：${JSON.stringify(sections[1])}`)
  assert(sections[2].pages.join(',') === '4', `Conclusion 应为第 4 页：${JSON.stringify(sections[2])}`)
  return sections.map((s) => `${s.name}:${s.pages.join('+')}`).join(' / ')
})

check('长章节：中间的关键段落不会被截断丢掉', () => {
  const filler = Array.from(
    { length: 60 },
    (_, i) => `第 ${i + 1} 段背景介绍。` + '这里给出一个与本章主题没有直接关系的补充例子，用来占位并拉长篇幅。'.repeat(3),
  )
  const key = [
    '需求价格弹性等于需求量变化百分比除以价格变化百分比，这是本章的核心定义。'.repeat(2),
    '弹性大于一时称为富有弹性，小于一时称为缺乏弹性，理解弹性是后续定价策略的基础。'.repeat(2),
    '交叉弹性用于判断两种商品是替代品还是互补品，收入弹性衡量需求对收入变化的反应。'.repeat(2),
  ]
  const body = [...filler.slice(0, 25), key[0], ...filler.slice(25, 40), key[1], ...filler.slice(40, 55), key[2], ...filler.slice(55)].join('\n\n')
  const kept = selectPassages(body, 1200)
  assert(kept.length <= 1400, `节选后仍然过长：${kept.length}`)
  assert(kept.includes('需求价格弹性'), '核心定义段被丢掉了')
  assert(kept.includes('富有弹性'), '弹性大小段被丢掉了')
  assert(kept.includes('交叉弹性'), '交叉弹性段被丢掉了')
  return `${body.length} → ${kept.length} 字，3/3 关键段保留`
})

check('导出：Anki CSV 与 course.json 结构', () => {
  const job = {
    courseTitle: '微观经济学',
    files: [{ name: 'a.md' }],
    chapters: [
      {
        index: 1,
        title: '第一章 供给与需求',
        pages: [1, 2],
        confidence: { tier: 'verified' },
        summary: {
          keywords: ['需求'],
          key_points: [{ text: '需求定律：价格上升需求量下降', evidence: '价格上升会使需求量下降', page: 3 }],
          important: [],
          difficult: [],
        },
      },
    ],
  }
  const csv = buildAnkiCsv(job)
  assert(csv.split('\r\n').filter(Boolean).length === 2, `CSV 行数不对：${csv}`)
  assert(csv.includes('"需求定律：价格上升需求量下降"'), 'CSV 缺少正面')
  assert(csv.includes('p.3'), 'CSV 缺少页码')
  assert(csv.includes('原文：价格上升会使需求量下降'), 'CSV 缺少引文')
  const json = JSON.parse(buildCourseJson(job))
  assert(json.schema === 'dsh-course-assistant/course@1', `schema 不对：${json.schema}`)
  assert(json.chapters[0].keyPoints[0].page === 3, 'course.json 丢了页码')
  assert(json.chapters[0].keyPoints[0].evidence.length > 0, 'course.json 丢了引文')
  return 'CSV 1 张卡 + course.json'
})

check('PDF 字号：cm 缩放要乘进有效字号', () => {
  const ops = ['q 2 0 0 2 0 0 cm', textOp(50, 700, 'SCALED HEADING LINE'), 'Q', textOp(50, 600, 'NORMAL BODY TEXT HERE')]
  const doc = parsePdf(makePdf(ops), 'scaled.pdf')
  const size = doc.pages[0].heading?.size || 0
  assert(size >= 20, `缩放后的字号是 ${size}，应约为 24`)
  return `heading=${size}`
})

check('分章指标：windowdiff 与边界 F1 的已知用例', () => {
  const ref = [true, false, false, true, false, false, true, false]
  const same = boundaryF1(ref, ref)
  assert(same.f1 === 1, `完全一致应 F1=1，实际 ${same.f1}`)
  assert(windowDiff(ref, ref) === 0, '完全一致应 windowdiff=0')
  const shifted = ref.map((flag, i) => (i === 1 ? true : i === 3 ? false : flag))
  const tolerant = boundaryF1(ref, shifted, 2)
  assert(tolerant.f1 >= 0.9, `容差内应基本满分，实际 ${tolerant.f1}`)
  const wrong = [true, false, false, false, true, false, false, true]
  const f1 = boundaryF1(ref, wrong, 0)
  assert(f1.f1 < 0.5, `边界错位应低分，实际 ${f1.f1}`)
  assert(windowDiff(ref, wrong) > 0, '错位应 windowdiff>0')
  return `same=${same.f1} shifted=${tolerant.f1} wrong=${f1.f1}`
})

check('课件问答：BM25 命中正确的章并给页码', () => {
  const chapters = [
    { index: 1, title: '第一章 供给与需求', pages: [1, 2, 3] },
    { index: 2, title: '第二章 弹性', pages: [4, 5, 6] },
    { index: 3, title: '第三章 市场结构', pages: [7, 8] },
  ]
  const texts = [
    '需求定律指出价格上升需求量下降。均衡价格由供给与需求的交点决定。价格上限会制造短缺。',
    '需求价格弹性等于需求量变化百分比除以价格变化百分比。弹性大于一称为富有弹性，必需品通常缺乏弹性。',
    '完全竞争市场有大量卖者与同质产品。垄断市场只有一个卖者并存在进入壁垒。',
  ]
  const index = buildIndex(chapters, texts)
  const hits = search(index, '需求价格弹性怎么算', 3)
  assert(hits[0]?.chapter === 2, `应命中第 2 章，实际 ${hits[0]?.chapter}`)
  assert(hits[0]?.page >= 4, `页码不对：${hits[0]?.page}`)
  const round = indexFromPassages(serializePassages(index))
  assert(search(round, '垄断市场的进入壁垒', 1)[0]?.chapter === 3, '序列化后检索结果不一致')
  const miss = ask(index, '量子纠缠退相干')
  assert(miss.answers.length === 0 && miss.hint, '无关问题应返回空与提示')
  return `ch${hits[0].chapter} p${hits[0].page}`
})

check('考纲覆盖：命中章节并列出未覆盖考点', () => {
  const chapters = [
    { index: 1, title: '第一章 供给与需求', summary: { keywords: ['供给', '需求'], key_points: [{ text: '需求定律：价格上升需求量下降' }] } },
    { index: 2, title: '第二章 弹性', summary: { keywords: ['需求价格弹性'], key_points: [{ text: '弹性等于需求量变化百分比除以价格变化百分比' }] } },
    { index: 3, title: '第三章 市场结构', summary: { keywords: ['垄断', '完全竞争'], key_points: [{ text: '垄断市场存在进入壁垒' }] } },
  ]
  const text = ['# 期中考点', '- 需求定律与供给定律', '- 需求价格弹性及其分类', '- 垄断市场的进入壁垒', '- 博弈论与纳什均衡', '- 外部性与科斯定理'].join('\n')
  const items = parseSyllabus(text, { ignore: ['期中考点'] })
  assert(items.length === 5, `考纲条目数 ${items.length}，应为 5`)
  const result = coverage(chapters, items)
  assert(result.covered === 3, `覆盖数 ${result.covered}，应为 3`)
  assert(result.uncovered.includes('博弈论与纳什均衡'), '无关考点不应被算作覆盖')
  assert(result.byChapter[1].covered.length === 1, '弹性章应覆盖 1 条')
  return `${result.covered}/${result.total}，未覆盖 ${result.uncovered.length}`
})

check('B 站分 P：标题匹配到具体 P，无关分 P 不误配', () => {
  const pages = [
    { page: 1, part: '第1P C++ 异常处理基础' },
    { page: 2, part: '第2P C++ 断言与调试' },
    { page: 3, part: '第3P C++ 智能指针' },
  ]
  const hit = bestPart(pages, ['异常与断言', 'C++ 异常处理'])
  assert(hit?.page === 1, `应命中第 1P，实际 ${JSON.stringify(hit)}`)
  assert(hit.score >= 0.34, `匹配分数过低：${hit.score}`)
  assert(bestPart([{ page: 1, part: '线性代数' }, { page: 2, part: '概率论' }], ['异常与断言']) === null, '无关分 P 不应匹配')
  assert(bestPart([{ page: 1, part: '单 P 视频' }], ['异常']) === null, '单 P 视频不应给分 P 推荐')
  return `第 ${hit.page}P · ${hit.score}`
})

check('通用词：编号剥离、通用词丢弃、TF-IDF 兜底', () => {
  assert(cleanTerm('四、编码方案') === '编码方案', `编号未剥离：${cleanTerm('四、编码方案')}`)
  assert(cleanTerm('主要内容') === '', '「主要内容」应被丢弃')
  assert(cleanTerm('3. 码点空间') === '码点空间', `英文编号未剥离：${cleanTerm('3. 码点空间')}`)
  assert(cleanKeywords(['主要内容', '本章小结', '四、编码方案'], 4).join('|') === '编码方案', '关键词清洗失败')
  // 通用章名必须被替换掉，不能进目录
  const pages = Array.from({ length: 10 }, (_, i) => ({
    index: i + 1,
    title: '主要内容',
    text: `第${i + 1}页 补码 原码 无符号整数 的表示范围与运算`,
  }))
  const outline = buildOutline([{ kind: 'pptx', title: '数据的机器级表示和处理', pages, blocks: [] }])
  assert(outline.chapters.every((c) => c.title !== '主要内容'), `仍有通用章名：${outline.chapters.map((c) => c.title).join(' | ')}`)
  return `${outline.chapters.length} 章均已改名`
})

check('主题锚词：关键词前缀投票，否则退回课程标题', () => {
  const voted = buildTopicProfile({
    courseTitle: '数据的机器级表示和处理',
    keywords: ['计算机系统 补码', '计算机系统 浮点数', '计算机系统 字符编码'],
    texts: ['补码与原码的区别，浮点数按 IEEE754 存储。'],
    domain: null,
  })
  assert(voted.anchor === '计算机系统', `锚词应为 计算机系统，实际 ${voted.anchor}`)
  const titled = buildTopicProfile({ courseTitle: '微观经济学', keywords: ['弹性', '供给'], texts: ['需求价格弹性。'], domain: null })
  assert(titled.anchor === '微观经济学', `无投票时应退回课程标题，实际 ${titled.anchor}`)
  return `${voted.anchor} / ${titled.anchor}`
})

check('B 站主题过滤：跑题视频全淘汰，对题视频保留', () => {
  const profile = buildTopicProfile({
    courseTitle: '数据的机器级表示和处理',
    keywords: ['计算机系统 补码', '计算机系统 浮点数', '计算机系统 字符编码'],
    texts: [
      '补码表示法把减法变成加法，补码与原码、反码的区别在于符号位参与运算。',
      '浮点数按 IEEE754 标准存储，阶码用移码表示，尾数决定精度。',
      '字符编码包括 ASCII 与 Unicode，UTF-8 是变长编码。',
    ],
    domain: null,
  })
  const items = [
    { bvid: 'BV1', title: '中职英语基础模块一（1-8单元语法汇总和每章主要内容总结）', duration: 1800, play: 500000, like: 1000, favorites: 500 },
    { bvid: 'BV2', title: '【ESP32教程】第二章: 低功耗蓝牙BLE相关概念及用法', duration: 1200, play: 90000, like: 300, favorites: 200 },
    { bvid: 'BV3', title: '阅读理解 概括文章主要内容答题框架＋练习', duration: 900, play: 300000, like: 800, favorites: 400 },
    { bvid: 'BV4', title: '计算机系统 补码与原码 数据表示（袁春风）', duration: 2400, play: 50000, like: 900, favorites: 800 },
  ]
  const ranked = rankWithTopic(items, { topic: profile, concepts: ['补码', '编码'], minDuration: 0 })
  const ids = ranked.map((v) => v.bvid)
  for (const bad of ['BV1', 'BV2', 'BV3']) assert(!ids.includes(bad), `${bad} 应被淘汰，实际保留：${ids.join(',')}`)
  assert(ids.includes('BV4'), `对题视频被误杀：${ids.join(',')}`)
  const kept = ranked.find((v) => v.bvid === 'BV4')
  assert(kept.relevance >= 0.5, `相关度 ${kept.relevance} 低于 0.5`)
  assert(ranked.every((v) => v.relevance >= 0.5), '低于 0.5 的视频不应进入结果')
  return `保留 ${ids.join(',')}，相关度 ${kept.relevance}`
})

check('知识 DAG：未知端点/自环/跨章反向/成环都会被拒绝', () => {
  const concepts = [
    { id: 'unsigned', name: '无符号整数', chapter: 2 },
    { id: 'twos', name: '补码', chapter: 2 },
    { id: 'float', name: '浮点数', chapter: 3 },
  ]
  const { graph, accepted, rejected } = validateEdges(
    [
      { from: 'unsigned', to: 'twos' },
      { from: 'twos', to: 'float' },
      { from: 'float', to: 'unsigned' },
      { from: 'twos', to: 'twos' },
      { from: 'ghost', to: 'twos' },
    ],
    concepts,
  )
  assert(accepted.length === 2, `应接受 2 条，实际 ${accepted.length}`)
  const reasons = rejected.map((r) => r.reason).sort()
  assert(reasons.includes('backward-chapter'), '跨章反向应被拒：' + reasons.join(','))
  assert(reasons.includes('self-loop'), '自环应被拒')
  assert(reasons.includes('unknown-from'), '未知端点应被拒')
  assert(topoOrder(graph) !== null, '接受后的图必须无环')
  assert(!addEdge(graph, { from: 'float', to: 'twos' }).ok, '成环的边必须拒绝')
  return `接受 ${accepted.length} / 拒绝 ${rejected.length}`
})

check('知识 DAG：前置未掌握时章节被阻塞', () => {
  const concepts = [
    { id: 'unsigned', name: '无符号整数', chapter: 2 },
    { id: 'twos', name: '补码', chapter: 2 },
    { id: 'float', name: '浮点数', chapter: 3 },
  ]
  const { graph } = validateEdges([{ from: 'unsigned', to: 'twos' }, { from: 'twos', to: 'float' }], concepts)
  const chapters = [{ index: 2, title: '数据表示' }, { index: 3, title: '浮点数' }]
  const blockedPlan = planChapters(chapters, graph, {}, 0.6)
  assert(blockedPlan.find((s) => s.index === 3).blocked, '第 3 章应因前置未满足被阻塞')
  const readyPlan = planChapters(chapters, graph, { unsigned: 1, twos: 1 }, 0.6)
  assert(!readyPlan.find((s) => s.index === 3).blocked, '前置满足后不应再阻塞')
  return `阻塞 ${blockedPlan.filter((s) => s.blocked).length} 章`
})

check('确定性调度：AUTH 不重试，EMPTY 走阶梯后降级', () => {
  assert(classifyError(new Error('llm-deepseek: no API key for provider route "deepseek-official"')) === FAILURE.AUTH, 'AUTH 分类')
  assert(classifyError(new Error('模型没有返回内容')) === FAILURE.EMPTY, 'EMPTY 分类')
  assert(classifyError(new Error('模型未返回可解析 JSON（前 120 字：…）')) === FAILURE.BAD_JSON, 'BAD_JSON 分类')
  assert(nextChapterAction({ attempts: 0, failure: FAILURE.AUTH }).action === 'degrade', 'AUTH 必须直接降级')
  assert(nextChapterAction({ attempts: 0, failure: FAILURE.EMPTY }).action === 'retry', 'EMPTY 第一次应重试')
  const third = nextChapterAction({ attempts: 2, failure: FAILURE.EMPTY })
  assert(third.action === 'degrade', 'EMPTY 第三次应降级，实际 ' + third.action)
  return 'auth/degrade 正确'
})

check('思维导图：树与 Mermaid 都能从同一份数据生成', () => {
  const chapters = [{ index: 1, title: '概述' }, { index: 2, title: '数据表示' }]
  const plan = [{ index: 2, blocked: true, missing: ['twos'] }]
  const tree = mindmapTree({ courseTitle: '计算机系统基础', chapters, plan })
  const mermaid = mindmapMermaid({ courseTitle: '计算机系统基础', chapters, plan })
  assert(tree.includes('第2章') && tree.includes('⚠'), '树里应标出被阻塞的章')
  assert(mermaid.startsWith('mindmap'), 'Mermaid 必须以 mindmap 开头')
  assert(mermaid.includes('数据表示'), 'Mermaid 应包含章名')
  const section = renderMindmapSection({ courseTitle: '计算机系统基础', chapters, plan })
  assert(section.includes('前置知识路径') && section.includes('mermaid'), '报告段落应含标题与代码块')
  return 'tree + mermaid ok'
})

check('知识点抽取提示：只允许引用已列出的概念', () => {
  const prompt = buildKnowledgePrompt({
    courseTitle: '计算机系统基础',
    chapters: [{ index: 1, title: '概述' }, { index: 2, title: '数据表示' }],
    texts: ['第一章讲体系结构', '第二章讲补码'],
  })
  assert(prompt.includes('第2章 数据表示'), '提示里要有章名')
  assert(prompt.includes('不能新造 id'), '必须禁止模型自造 id')
  assert(prompt.includes('前面的章 → 后面的章'), '必须限制跨章方向')
  return 'prompt ok'
})

check('去重键：文件与设置相同才复用', () => {
  const inputs = [{ sha256: 'aaa' }, { sha256: 'bbb' }]
  const a = dedupeKeyFor(inputs, {}, { provider: 'deepseek-account', model: 'deepseek-flash' })
  const b = dedupeKeyFor([...inputs].reverse(), {}, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert(a === b, '文件顺序不应影响去重键')
  const otherModel = dedupeKeyFor(inputs, {}, { provider: 'deepseek-account', model: 'deepseek-pro' })
  assert(a !== otherModel, '换模型必须生成不同的键')
  const noVideos = dedupeKeyFor(inputs, { withVideos: false }, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert(a !== noVideos, '关掉网课检索应是不同的键')
  return a
})

check('看板：章节/概念/前置阻塞都进 HTML', () => {
  const chapters = [{ index: 1, title: '概述' }, { index: 2, title: '数据表示' }]
  const plan = [
    { index: 1, blocked: false, missing: [], concepts: 1 },
    { index: 2, blocked: true, missing: ['twos'], concepts: 2 },
  ]
  const knowledge = { concepts: [{ id: 'twos', name: '补码', chapter: 2 }], edges: [{ from: 'a', to: 'twos' }] }
  const html = renderDashboardHtml({
    courseTitle: '计算机系统基础',
    chapters,
    plan,
    knowledge,
    byChapter: { 1: { videos: [{}, {}] } },
    meta: { generatedAt: '2026-10-24 20:00' },
  })
  assert(html.startsWith('<!doctype html>'), '必须是完整 HTML')
  assert(html.includes('学习看板'), '标题里要有看板')
  assert(html.includes('前置阻塞'), 'KPI 里要有前置阻塞')
  assert(html.includes('补码'), 'SVG 里要画出概念')
  assert(html.includes('未满足'), '阻塞章要标出缺失前置')
  assert(!html.includes('<script'), '不能带脚本（离线安全）')
  return html.length + ' bytes'
})

check('知识图抽取：识别 text-delta 流并过结构校验', async () => {
  const payload = JSON.stringify({
    concepts: [
      { id: 'bit', name: '位', chapter: 1, evidence: '二进制位' },
      { id: 'unsigned', name: '无符号整数', chapter: 2, evidence: '无符号整数表示' },
      { id: 'twos', name: '补码', chapter: 2, evidence: '补码表示法' },
      { id: 'float', name: '浮点数', chapter: 3, evidence: 'IEEE754 浮点' },
      { id: 'english', name: '中职英语', chapter: 2, evidence: '语法总结' },
    ],
    edges: [
      { from: 'bit', to: 'unsigned' },
      { from: 'unsigned', to: 'twos' },
      { from: 'twos', to: 'float' },
      { from: 'float', to: 'bit' },
    ],
  })
  const llm = {
    stream: () =>
      (async function* () {
        yield { type: 'text-delta', text: payload.slice(0, 40) }
        yield { type: 'text-delta', text: payload.slice(40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
  }
  const result = await extractKnowledge({
    llm,
    provider: 'p',
    model: 'm',
    courseTitle: '计算机系统基础',
    chapters: [{ index: 1, title: '概述' }, { index: 2, title: '数据表示' }, { index: 3, title: '浮点数' }],
    texts: ['二进制位与机器数', '无符号整数与补码表示法', 'IEEE754 浮点数与单精度'],
  })
  assert(result, '应当解析出知识图')
  assert(result.concepts.length === 4, `原文里查不到的概念应被丢掉，应剩 4 个，实际 ${result.concepts?.length}`)
  assert(result.stats.droppedConcepts === 1, `应有 1 个概念因原文没有依据被丢，实际 ${result.stats.droppedConcepts}`)
  assert(result.stats.accepted === 3, `三条合法边应接受，实际 ${result.stats.accepted}`)
  assert(result.stats.rejected === 1, '跨章反向的那条应被拒')
  return `${result.stats.concepts} 概念 / ${result.stats.accepted} 边`
})

check('知识图兜底：模型空回包时按章节顺序生成前置链', () => {
  const chapters = [
    { index: 1, title: '概述', summary: { keywords: ['计算机系统 概述'] } },
    { index: 2, title: '数据表示', summary: { keywords: ['计算机系统 补码'] } },
    { index: 3, title: '浮点数', summary: { keywords: ['计算机系统 IEEE754'] } },
  ]
  const graph = fallbackKnowledge(chapters)
  assert(graph.concepts.length === 3, `概念数应为 3，实际 ${graph.concepts.length}`)
  assert(graph.edges.length === 2, `顺序边应为 2，实际 ${graph.edges.length}`)
  assert(graph.fallback === true, '应标记为兜底')
  assert(graph.stats.accepted === 2, '两条顺序边都应通过校验')
  return `${graph.stats.concepts} 概念 / ${graph.stats.accepted} 边`
})

check('历史记录：写入、去重、最新优先', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-history-'))
  try {
    const store = createStore(dir)
    store.rememberHistory({ id: 'a', courseTitle: 'A', createdAt: '2026-10-01T00:00:00.000Z', chapters: [{}, {}], files: [{ name: 'a.pdf' }] })
    store.rememberHistory({ id: 'b', courseTitle: 'B', createdAt: '2026-10-02T00:00:00.000Z', chapters: [{}] })
    store.rememberHistory({ id: 'a', courseTitle: 'A2', createdAt: '2026-10-03T00:00:00.000Z', chapters: [{}] })
    const list = store.listHistory()
    assert(list.length === 2, `同 id 写入应更新而非追加，实际 ${list.length}`)
    assert(list[0].id === 'a' && list[0].courseTitle === 'A2', '重复写入应更新内容并置顶')
    assert(list[1].id === 'b', '较早的条目应排在后面')
    assert(store.listHistory(1).length === 1, 'limit 应生效')
    return `${list.length} 条 / 首条 ${list[0].courseTitle}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('图片抽取：尺寸解析与文本回填', () => {
  const png = Buffer.alloc(26)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  png.writeUInt32BE(886, 16)
  png.writeUInt32BE(408, 20)
  const pngSize = imageSize(png)
  assert(pngSize.type === 'png' && pngSize.width === 886 && pngSize.height === 408, `PNG 尺寸解析失败：${JSON.stringify(pngSize)}`)

  // JPEG: SOI + SOF0 with 640x480
  const jpeg = Buffer.alloc(40)
  jpeg[0] = 0xff
  jpeg[1] = 0xd8
  jpeg[2] = 0xff
  jpeg[3] = 0xc0
  jpeg.writeUInt16BE(17, 4)
  jpeg[6] = 8
  jpeg.writeUInt16BE(480, 7)
  jpeg.writeUInt16BE(640, 9)
  const jpegSize = imageSize(jpeg)
  assert(jpegSize.type === 'jpeg' && jpegSize.width === 640 && jpegSize.height === 480, `JPEG 尺寸解析失败：${JSON.stringify(jpegSize)}`)

  const page = attachImageText({ index: 5, text: '幻灯片正文' }, ['补码 表示法', '   '])
  assert(page.text.includes('幻灯片正文') && page.text.includes('[图片] 补码 表示法'), 'OCR 文本应回填到页正文')
  assert(attachImageText({ index: 5, text: 'x' }, ['  ']).text === 'x', '全空 OCR 不应改动正文')
  return 'png+jpeg 尺寸与回填 ok'
})

check('分节：按小标题与编号切分，无小标题则整章一节', () => {
  const chapter = { title: '章', subs: ['一、概述', '二、数据'] }
  const text = '一、概述\n概述内容。\n二、数据\n补码与原码。'
  const bySubs = splitSections(chapter, text)
  assert(bySubs.length === 2, `按小标题应切出 2 节，实际 ${bySubs.length}`)
  assert(bySubs[1].text.includes('补码'), '第二节应包含补码内容')

  const numbered = splitSections({ title: 'x' }, '1. 第一点\n内容一\n2. 第二点\n内容二')
  assert(numbered.length === 2, `按编号应切出 2 节，实际 ${numbered.length}`)

  const single = splitSections({ title: 'x' }, '没有小标题的一段话。')
  assert(single.length === 1, '没有小标题时应整章一节')
  return `${bySubs.length}/${numbered.length}/1`
})

check('覆盖率审计：命中的节算覆盖，没提的节进 missing', () => {
  const chapter = { title: '章', subs: ['一、概述', '二、数据', '三、浮点'] }
  const text = '一、概述\n闭卷考试，150 分钟。\n二、数据\n补码表示法把减法变成加法。\n三、浮点\nIEEE754 单精度。'
  const summary = {
    key_points: [
      { text: '闭卷 150 分钟', evidence: '闭卷考试，150 分钟。' },
      { text: '补码把减法变加法', evidence: '补码表示法把减法变成加法。' },
    ],
  }
  const audit = auditCoverage({ chapter, text, summary })
  assert(audit.total === 3, `应有 3 节，实际 ${audit.total}`)
  assert(audit.covered === 2, `应覆盖 2 节，实际 ${audit.covered}`)
  assert(audit.missing.length === 1 && audit.missing[0].includes('浮点'), `缺失节应指向浮点，实际 ${JSON.stringify(audit.missing)}`)
  const empty = auditCoverage({ chapter, text, summary: { key_points: [] } })
  assert(empty.covered === 0 && empty.ratio === 0, '无要点时覆盖率应为 0')
  return `${audit.covered}/${audit.total}`
})

check('选段：分节后每个小节都至少保留一段', () => {
  const parts = []
  for (let i = 1; i <= 30; i += 1) parts.push(`第${i}段：补码与原码的区别，符号位参与运算。`)
  const text = parts.join('\n\n')
  const out = selectPassages(text, 900, {
    sections: [
      { title: 'a', from: 0 },
      { title: 'b', from: Math.floor(text.length / 2) },
    ],
  })
  assert(out.includes('第1段'), '第一节应有段落入选')
  assert(out.includes('第30段'), '第二节应有段落入选')
  assert(out.length <= 1100, `选段不应大幅超出预算，实际 ${out.length}`)
  return `${out.length} 字`
})

check('thorough：逐节调用模型并合并去重', async () => {
  const sections = ['一、甲节', '二、乙节', '三、丙节', '四、丁节']
  const body = sections.map((title) => `${title}\n${'本节内容讲述原理与实现细节。'.repeat(90)}`).join('\n')
  let calls = 0
  const llm = {
    stream(options) {
      calls += 1
      const prompt = options.messages[0].content[0].text
      const title = /本章：第 \d+ 章 (.+)/.exec(prompt)?.[1]?.trim() || '整章'
      return (async function* () {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            chapter: title,
            key_points: [{ text: `${title} 的要点`, evidence: `${title}` }],
            important: [],
            difficult: [],
            keywords: ['计算机系统 测试'],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const result = await summarizeChapter({
    llm,
    provider: 'p',
    model: 'm',
    courseTitle: '计算机系统基础',
    chapter: { index: 1, title: '第一章', subs: sections },
    text: body,
    outline: [],
    domain: null,
    coverageMode: 'thorough',
  })
  assert(calls >= 2 && calls <= 4, `逐节调用应为 2-4 次，实际 ${calls}`)
  assert(result.sectionCalls === calls, `sectionCalls 应等于调用次数，实际 ${result.sectionCalls}/${calls}`)
  assert(result.key_points.length >= 2, `合并后应至少 2 条要点，实际 ${result.key_points.length}`)
  assert(result.key_points.length <= 12, '合并后要点不应超过 12 条')
  return `${calls} 次调用 / ${result.key_points.length} 条要点`
})

check('关键词捕获：多源融合、通用词丢弃、父子术语不重复', () => {
  const chapter = { title: '第 2 章 数据的机器级表示', subs: ['一、有符号整数'] }
  const text = '补码表示法把减法变成加法。IEEE754 规定浮点格式。ASCII 用七位编码。x86-64 的调用约定不同。'
  const picked = extractKeywords({
    chapter,
    text,
    corpus: ['浮点数按 IEEE754 存储。', '字符编码包括 ASCII 与 Unicode。'],
    modelKeywords: ['主要内容', '计算机系统 补码'],
    limit: 4,
  })
  const terms = picked.map((item) => item.term)
  assert(picked.length >= 2 && picked.length <= 4, `关键词数应为 2-4，实际 ${picked.length}`)
  assert(!terms.includes('主要内容'), '通用词必须被丢弃')
  assert(terms.some((term) => term.includes('补码')), '补码应被捕获')
  assert(terms.some((term) => /IEEE754|ASCII|x86/.test(term)), '英文缩写应被捕获')
  assert(!(terms.includes('计算机系统 补码') && terms.includes('补码')), '父子术语不应同时出现')
  const sources = new Set(picked.map((item) => item.source))
  assert(sources.size >= 2, `应来自多个来源，实际 ${[...sources].join(',')}`)
  return terms.join(' / ')
})

check('关键词捕获：模型给空时用标题与本地术语兜底', () => {
  const picked = extractKeywords({
    chapter: { title: '异常与中断', subs: ['中断处理'] },
    text: '异常是内部事件，中断是外部事件。响应过程包括保存现场与恢复现场。',
    corpus: [],
    modelKeywords: [],
    limit: 3,
  })
  const terms = picked.map((item) => item.term)
  assert(terms.length >= 1, '模型为空时也必须给出可用关键词')
  assert(terms.every((term) => term.length >= 2), `术语长度应 >=2，实际 ${terms.join(',')}`)
  return terms.join(' / ')
})

check('OCR 文本后处理：拆词合并、IEEE 纠正、全角转半角、偏旁合并', () => {
  const code = fixOcrArtifacts('i nt main(void) {\n  return 0 ；\n}')
  assert(code.includes('int main'), `拆开的 int 应被合并：${code}`)
  assert(code.includes('return 0 ;'), '全角分号应转成半角')
  assert(fixOcrArtifacts('浮点数按 lEEE754 存 储').includes('IEEE754'), 'lEEE754 应纠正为 IEEE754')
  assert(fixOcrArtifacts('衤卜码表示法').startsWith('补码'), '偏旁拆分的「补」应合并')
  assert(fixOcrArtifacts('氵孚点数').startsWith('浮点数'), '偏旁拆分的「浮」应合并')
  // 中文正文里的空格不该被当成代码处理，也不该被吃掉语义
  assert(fixOcrArtifacts('第 3 章 程序的机器级表示').includes('第 3 章'), '普通中文行应原样保留')
  return '4 类纠正均生效'
})

/* -------------------------- OCR triage and picking -------------------------- */

const GOOD_LINE = '第二章 数据的机器级表示。本节介绍整数的补码表示与溢出判定方法。'
const GOOD_PAGE = GOOD_LINE.repeat(3)
// glyph codes decoded as Latin-1: every character is high-latin, so the page
// scores as noise rather than as text (this is the L12 "includ fstrea" shape)
const GARBLED = '½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß'

check('OCR 分诊：只重读文字层不可用的页', () => {
  const pages = [
    { index: 1, text: GOOD_PAGE },
    { index: 2, text: '' },
    { index: 3, text: GARBLED },
    { index: 4, text: GOOD_PAGE },
    { index: 5, text: 'w\t)Wy°a¼' },
    ...Array.from({ length: 5 }, (_, i) => ({ index: i + 6, text: GOOD_PAGE })),
  ]
  const plan = planOcrPages(pages, { mode: 'auto', maxPages: 10 })
  assert(plan.pages.join(',') === '2,3,5', `应只读第 2/3/5 页，实际 [${plan.pages.join(',')}]`)
  assert(plan.weak === 3 && plan.total === 10, `弱页统计不对：${plan.weak}/${plan.total}`)
  assert(plan.reasons.sparse === 2 && plan.reasons.noise === 1, `原因分类异常：${JSON.stringify(plan.reasons)}`)
  assert(plan.scanned === false, '10 页里 3 页弱不该判成扫描版')
  assert(plan.deferred === 0, '未超上限不该有顺延')
  return `pages=[${plan.pages.join(',')}] ${JSON.stringify(plan.reasons)}`
})

check('OCR 分诊：无文本层的扫描件整份重读，超出上限的页有记录', () => {
  const blank = Array.from({ length: 100 }, (_, i) => ({ index: i + 1, text: '' }))
  const plan = planOcrPages(blank, { mode: 'auto', maxPages: 60 })
  assert(plan.scanned === true, '100 页全空应判为扫描版')
  assert(plan.pages.length === 60, `上限 60 页，实际 ${plan.pages.length}`)
  assert(plan.deferred === 40, `应记录 40 页顺延，实际 ${plan.deferred}`)
  assert(plan.pages[0] === 1 && plan.pages[59] === 60, '应按文档顺序取前 60 页')

  const readable = [
    { index: 1, text: GOOD_PAGE },
    { index: 2, text: GOOD_PAGE },
    { index: 3, text: GOOD_PAGE },
  ]
  const all = planOcrPages(readable, { mode: 'all', maxPages: 60 })
  assert(all.pages.join(',') === '1,2,3', `all 模式应读整份，实际 [${all.pages.join(',')}]`)
  const off = planOcrPages(readable, { mode: 'off', maxPages: 60 })
  assert(off.pages.length === 0, 'off 模式不该读任何页')
  // 全部可读时 auto 一页都不读（这正是省时间的地方）
  const none = planOcrPages(readable, { mode: 'auto', maxPages: 60 })
  assert(none.pages.length === 0 && none.weak === 0, `可读文件白跑 OCR：${none.pages.length} 页`)
  return `scan 60/100 (deferred 40), all=3, auto=0`
})

check('OCR 择优：可读文字层不被覆盖，空页与乱码页才换成 OCR 文本', () => {
  const pages = [
    { index: 1, text: GOOD_PAGE },
    { index: 2, text: '' },
    { index: 3, text: GARBLED },
  ]
  const ocr = [
    { index: 1, text: GOOD_PAGE },
    { index: 2, text: '第二页的正文：抛出异常的语法是 throw 表达式，由 catch 捕获。' },
    { index: 3, text: '第三页的正文：栈展开会依次调用局部对象的析构函数。' },
  ]
  const merged = applyOcrPages(pages, ocr, {})
  assert(merged.adopted.join(',') === '2,3', `应替换第 2、3 页，实际 [${merged.adopted.join(',')}]`)
  assert(merged.kept.join(',') === '1', '可读页被 OCR 覆盖了')
  assert(merged.pages[1].ocr === true, '换过文本的页要打 ocr 标记')
  assert(merged.pages[1].text === ocr[1].text, '第 2 页没有换成 OCR 文本')
  assert(merged.pages[0].text === GOOD_PAGE, '第 1 页文本被改动了')
  // 乱码页换掉后字数可能变少（乱码本来占位更多），净增为负是正常的
  assert(merged.chars !== 0, '净增字数没有被统计')
  // 文字层可读但 OCR 也读得出：以文字层为准（margin 内不替换）
  const tie = applyOcrPages([{ index: 4, text: GOOD_PAGE }], [{ index: 4, text: GOOD_LINE }], {})
  assert(tie.adopted.length === 0, '分数相近时不该替换文字层')
  return `adopted=[${merged.adopted.join(',')}] kept=[${merged.kept.join(',')}] 净增 ${merged.chars} 字`
})

check('OCR 引擎：请求哪几页就回哪几页，页号不被重排', async () => {
  const calls = []
  registerOcrEngine({
    id: 'fake-pages',
    label: '测试引擎',
    platform: 'any',
    available: () => true,
    availableSync: () => true,
    recognize: async (file, options) => {
      calls.push({ file, pages: options.pages })
      return (options.pages || []).map((index) => ({ index, text: `第 ${index} 页的正文内容，用来确认页号没有被重排。` }))
    },
  })
  const deep = await ocrPdfDeep('C:/fake.pdf', { engine: 'fake-pages', pages: [7, 9] })
  assert(deep.pages.map((p) => p.index).join(',') === '7,9', `页号被重排：[${deep.pages.map((p) => p.index).join(',')}]`)
  assert(calls[0].pages.join(',') === '7,9', 'page 子集没有传给引擎')
  const only = await ocrPdf('C:/fake.pdf', { engine: 'fake-pages', pages: [12] })
  assert(only.length === 1 && only[0].index === 12, `ocrPdf 丢了页号：[${only.map((p) => p.index).join(',')}]`)
  assert(scoreText(only[0].text).score > 0.8, `正常中文页得分偏低：${scoreText(only[0].text).score}`)
  return '7,9 / 12'
})

check('OCR 择优：低分页交第二引擎复读，取分高的一份', async () => {
  let secondCalls = 0
  registerOcrEngine({
    id: 'fake-bad',
    label: '劣质引擎',
    platform: 'any',
    available: () => true,
    availableSync: () => true,
    recognize: async (file, options) => (options.pages || []).map((index) => ({ index, text: GARBLED })),
  })
  registerOcrEngine({
    id: 'fake-good',
    label: '优质引擎',
    platform: 'any',
    available: () => true,
    availableSync: () => true,
    recognize: async (file, options) => {
      secondCalls += 1
      return (options.pages || []).map((index) => ({
        index,
        text: '这一页由第二引擎读出：异常对象的栈展开过程会依次析构局部变量。',
      }))
    },
  })
  const deep = await ocrPdfDeep('C:/fake.pdf', {
    engine: 'fake-bad',
    candidates: ['fake-bad', 'fake-good'],
    pick: 'best',
    pages: [1, 2, 3],
  })
  assert(deep.stats.escalated === 3, `应升级 3 页，实际 ${deep.stats.escalated}`)
  assert(deep.stats.improved === 3, `应改进 3 页，实际 ${deep.stats.improved}`)
  assert(secondCalls === 1, `第二引擎应只被调用一次，实际 ${secondCalls}`)
  assert(deep.pages.every((p) => p.engine === 'fake-good'), '低分页没有换成第二引擎的结果')

  // pick=first（默认）不该调用第二引擎：这是"耗时翻倍"开关的边界
  const before = secondCalls
  const single = await ocrPdfDeep('C:/fake.pdf', { engine: 'fake-bad', candidates: ['fake-bad', 'fake-good'], pages: [1] })
  assert(single.stats.escalated === 0 && secondCalls === before, 'pick=first 时不该升级')
  return `escalated=${deep.stats.escalated} improved=${deep.stats.improved}`
})

check('图片 OCR：命中缓存不再识别，python 一路传到引擎', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-img-'))
  const calls = []
  try {
    registerOcrEngine({
      id: 'fake-img',
      label: '图片测试引擎',
      platform: 'any',
      available: () => true,
      availableSync: () => true,
      recognize: async () => [],
      recognizeImage: async (file, options) => {
        calls.push({ file, options })
        return '关系表达式 2147483647 > 0 的判定'
      },
    })
    const images = [{ sha: 'abc123', type: 'png', name: 'image1.png', slide: 2, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]
    const store = createStore(dir)
    const first = await readImageTexts(images, { store, engine: 'fake-img', python: 'C:/fake/python.exe' })
    assert(calls.length === 1, `第一次应识别 1 张，实际 ${calls.length}`)
    assert(calls[0].options.python === 'C:/fake/python.exe', `python 没传到引擎：${JSON.stringify(calls[0].options)}`)
    assert(first.read === 1 && first.chars > 0, `识别结果没回填：${JSON.stringify({ read: first.read, chars: first.chars })}`)
    assert(first.texts.get(2)?.[0].includes('2147483647'), '识别文本没挂到第 2 页')
    const second = await readImageTexts(images, { store, engine: 'fake-img', python: 'C:/fake/python.exe' })
    assert(calls.length === 1, `第二次应命中缓存、不再识别，实际又调了 ${calls.length - 1} 次`)
    assert(second.read === 1 && second.chars === first.chars, '缓存命中的结果与首跑不一致')
    return `${first.chars} 字，第二次 0 次识别`
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

/* ------------------------ synthetic scanned PDF (images) ------------------------ */

/**
 * A PDF whose pages draw one picture and no text — the shape of a scan. Our own
 * parser has to keep those pages (that is what OCR reads), so this fixture locks
 * in both "page kept" and "document recognised as a scan".
 */
function makeScannedPdf(pageCount) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '']
  const kids = []
  let next = 3
  for (let i = 0; i < pageCount; i += 1) {
    kids.push(`${next} 0 R`)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${next + 2} 0 R >> >> /Contents ${next + 1} 0 R >>`,
    )
    const content = 'q 612 0 0 792 0 0 cm /Im1 Do Q'
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
    // 1x1 grayscale pixel: enough for /Subtype /Image to be recognised
    const pixel = Buffer.from([0x80])
    objects.push(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n`,
          'latin1',
        ),
        pixel,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    )
    next += 3
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`
  const body = Buffer.concat(
    objects.map((object, i) =>
      Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
        Buffer.isBuffer(object) ? object : Buffer.from(`${object}\n`, 'latin1'),
        Buffer.from('endobj\n', 'latin1'),
      ]),
    ),
  )
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    body,
    Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF\n`, 'latin1'),
  ])
}

check('扫描版 PDF：只有图片的页不再被丢弃，整份判为扫描件', () => {
  const doc = cleanDoc(parsePdf(makeScannedPdf(6), 'scan.pdf'))
  assert(doc.pages.length === 6, `应保留 6 页，实际 ${doc.pages.length} 页`)
  assert(doc.pages.every((page) => !page.text.trim()), '合成页不该有文本层')
  assert(doc.pages.every((page) => page.images >= 1), `图片计数没读到：${doc.pages.map((p) => p.images).join(',')}`)
  assert(doc.pages.every((page, i) => page.index === i + 1), '页号被压缩了')
  const plan = planOcrPages(doc.pages, { mode: 'auto', maxPages: 60 })
  assert(plan.scanned === true, '6 页全空应判为扫描件')
  assert(plan.pages.length === 6, `扫描件应整份重读，实际只计划了 ${plan.pages.length} 页`)
  const capped = planOcrPages(doc.pages, { mode: 'auto', maxPages: 4 })
  assert(capped.pages.length === 4 && capped.deferred === 2, `上限记账不对：${capped.pages.length}/${capped.deferred}`)
  return '6 页全部保留，按扫描件整份重读'
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
