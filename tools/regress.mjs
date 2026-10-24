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
import { buildOutline } from '../core/outline.js'
import { assessQuality } from '../core/quality.js'
import { detectDomain } from '../core/domain.js'
import { supportScore, evaluateSummary } from '../core/verify.js'
import { selectPassages } from '../core/summarize.js'
import { createStore } from '../core/store.js'
import { __debug as ooxmlDebug } from '../core/ooxml.js'
import { boundaryF1, evaluateDoc, windowDiff } from './segment-metrics.mjs'
import { ask, buildIndex, indexFromPassages, search, serializePassages } from '../core/search.js'
import { coverage, parseSyllabus } from '../core/coverage.js'
import { bestPart, rankWithTopic } from '../core/bili.js'
import { cleanKeywords, cleanTerm } from '../core/terms.js'
import { addEdge, topoOrder, validateEdges } from '../core/graph.js'
import { FAILURE, classifyError, nextChapterAction, planChapters } from '../core/schedule.js'
import { mindmapMermaid, mindmapTree, renderMindmapSection } from '../core/mindmap.js'
import { buildKnowledgePrompt, extractKnowledge, fallbackKnowledge } from '../core/knowledge.js'
import { dedupeKeyFor } from '../core/pipeline.js'
import { renderDashboardHtml } from '../core/dashboard.js'
import { buildTopicProfile } from '../core/topic.js'
import { buildAnkiCsv, buildCourseJson } from '../index.js'
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
    texts: ['一', '二', '三'],
  })
  assert(result, '应当解析出知识图')
  assert(result.concepts.length === 4, `概念数应为 4，实际 ${result.concepts?.length}`)
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
