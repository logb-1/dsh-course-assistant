/**
 * Markdown report assembly (the deliverable format is fixed by the request).
 */
import { renderMindmapSection } from './mindmap.js'
import { searchLink } from './bili.js'
import { describeQuality } from './quality.js'
import { describeCoverage } from './audit.js'
import { describeConfidence, pointText } from './verify.js'
import { describeReview } from './review.js'
import { cleanTitle, hasChapterPrefix, stripHeadingNumber, titleScore } from './titles.js'

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()

const fmtPlay = (n) => {
  const v = Number(n) || 0
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`
  return String(v)
}

const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return `${m}:${String(r).padStart(2, '0')}`
}

/** "### 第 3 章 xxx" — or the title itself when it already carries a chapter number. */
function chapterHeading(c, level = '###') {
  const title = cleanTitle(c.title) || `第 ${c.index} 部分`
  // the author numbered this heading (第 N 章 / 一、二、): print it as written
  const numbered = hasChapterPrefix(title) || /^[一二三四五六七八九十]+\s*[、.．]/.test(title)
  return numbered ? `${level} ${title}` : `${level} 第 ${c.index} 章 ${title}`
}

/** One line for the report header; empty when the outline looked clean. */
function describeOutlineDiagnostics(diagnostics) {
  if (!diagnostics || !diagnostics.chapters) return ''
  const bad = diagnostics.bad?.length || 0
  const fallback = diagnostics.fallback?.length || 0
  const dup = diagnostics.duplicates?.length || 0
  if (!bad && !fallback && !dup) return ''
  const bits = [`${diagnostics.chapters} 章`]
  if (bad) bits.push(`${bad} 章标题由关键词/小节兜底`)
  if (fallback) bits.push(`${fallback} 章只有占位名`)
  if (dup) bits.push(`${dup} 处章名重复`)
  return `目录自检：${bits.join('，')}`
}

/**
 * Table of contents. Sub-headings are page titles, and page titles are often
 * fragments ("pu", "10.1×"): they are scored, deduped and capped, with the
 * chapter's own keywords as the fallback so the list always says something.
 */
function toc(chapters) {
  const lines = []
  chapters.forEach((c) => {
    const title = stripHeadingNumber(cleanTitle(c.title)) || cleanTitle(c.title) || `第 ${c.index} 部分`
    lines.push(`${c.index}. ${title}`)
    const seen = new Set()
    const subs = []
    for (const raw of c.subs || []) {
      const sub = cleanTitle(raw)
      if (!sub || seen.has(sub) || titleScore(sub).score < 0.55) continue
      // a chapter whose page title equals its own name adds nothing to the list
      if (stripHeadingNumber(sub) === stripHeadingNumber(title)) continue
      seen.add(sub)
      subs.push(sub)
      if (subs.length >= 4) break
    }
    if (!subs.length) {
      const keywords = (c.summary?.keywords || []).slice(0, 2)
      if (keywords.length) subs.push(keywords.join(' / '))
    }
    for (const sub of subs) lines.push(`   - ${sub}`)
  })
  return lines.join('\n')
}

/* ------------------------------ review layout ------------------------------ */

const oneLine = (s, max = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** "文件名—第 12 页" / "（页码待确认）" / '' — never invent a page. */
function sourceOf(block, fileLabel = '') {
  if (!block?.source && !block?.page) return ''
  const page = block.page ? `第 ${block.page} 页` : ''
  const label = block.page ? (fileLabel ? `${fileLabel}—${page}` : page) : oneLine(block.source, 40)
  if (!label) return ''
  return block.sourceOk === false ? `${label}（不在本章范围，待确认）` : label
}

const tagOf = (point) => (point.tag ? `〔${point.tag}〕` : '')

function reviewPoint(point, fileLabel = '') {
  const lines = []
  const src = sourceOf(point, fileLabel)
  lines.push(
    `- **${point.id} ${point.name}**${point.tag ? `〔${point.tag}〕` : ''}${src ? `（${src}）` : ''}`,
  )
  const field = (label, value) => {
    if (value) lines.push(`  - ${label}：${oneLine(value, 900)}`)
  }
  field('定义/结论', point.definition)
  field('通俗解释', point.plain)
  field('关键条件', point.conditions)
  field('掌握要求', point.mastery)
  field('公式/方法', point.formula)
  field('知识联系', point.links)
  field('常见误区', point.pitfalls)
  return lines.join('\n')
}

function reviewExample(example, fileLabel = '') {
  const src = sourceOf(example, fileLabel)
  const lines = [`#### ${example.id} ${example.name}${src ? `（${src}）` : ''}`]
  if (example.points?.length) lines.push(`- 对应知识点：${example.points.join('、')}`)
  const field = (label, value) => {
    if (value) lines.push(`- ${label}：${oneLine(value, 1200)}`)
  }
  field('背景/题目', example.background)
  field('要说明什么', example.purpose)
  field('分析步骤', example.steps)
  field('结果/结论', example.result)
  field('可迁移的方法', example.transfer)
  field('容易出错的地方', example.pitfalls)
  return lines.join('\n')
}

function reviewExercises(chapter) {
  const review = chapter.summary?.review
  const exercises = review?.exercises || []
  const answers = new Map((review?.answers || []).map((answer) => [answer.id, answer]))
  if (!exercises.length) return ['#### 自测题', '', '课件未提供可识别的习题。']
  const lines = ['#### 自测题（先做题，答案见下一小节）', '']
  for (const exercise of exercises) {
    const meta = [exercise.origin, exercise.type, exercise.difficulty ? `难度 ${exercise.difficulty}` : ''].filter(Boolean).join('｜')
    lines.push(`- **${exercise.id}**〔${meta}〕${exercise.points?.length ? ` 对应 ${exercise.points.join('、')}` : ''}`)
    lines.push(`  - 题干：${oneLine(exercise.stem, 900)}`)
    if (exercise.options?.length) lines.push(`  - 选项：${exercise.options.map((option) => oneLine(option, 120)).join(' ／ ')}`)
  }
  lines.push('')
  lines.push('#### 参考答案')
  lines.push('')
  lines.push('> 先自测再对照；标「参考解答」的是整理者求解，不是课件原答案。')
  lines.push('')
  for (const exercise of exercises) {
    const answer = answers.get(exercise.id)
    if (!answer) {
      lines.push(`- **${exercise.id}**：课件未给答案，暂缺参考解答（待确认）。`)
      continue
    }
    lines.push(`- **${exercise.id}**：${oneLine(answer.text, 1600)}${answer.note ? `（${oneLine(answer.note, 60)}）` : ''}`)
  }
  return lines
}

function reviewChapterSection(c, fileLabel = '') {
  const review = c.summary?.review
  const chapterIndex = c.index
  if (!review) {
    // the model could not produce the review JSON for this chapter: keep the
    // bullets instead of dropping the chapter from the document
    return [chapterSection(c), '', '> 本章未能生成复习结构（模型返回不可解析），上面是普通摘要。'].join('\n')
  }
  const lines = [chapterHeading(c, '###'), '']
  const stats = c.reviewStats
  if (stats) {
    lines.push(`> 本章：${stats.points} 个知识点 · ${stats.examples} 个实例 · ${stats.exercises} 道习题（${stats.answered} 道带答案）`)
    lines.push('')
  }

  lines.push('#### 本章概览')
  lines.push('')
  const overview = review.overview || {}
  const field = (label, value) => {
    if (value) lines.push(`- ${label}：${oneLine(value, 800)}`)
  }
  field('研究什么', overview.question)
  field('为什么学', overview.why)
  if (overview.abilities?.length) lines.push(`- 需要掌握的能力：${overview.abilities.map((a) => oneLine(a, 80)).join('；')}`)
  field('与前后章节的联系', overview.links)
  if (!overview.question && !overview.why && !overview.links) lines.push('（本章概览缺失，模型未返回）')
  lines.push('')

  lines.push('#### 模块与知识点')
  lines.push('')
  for (const module of review.modules) {
    lines.push(`##### ${module.name}`)
    lines.push('')
    for (const point of module.points) {
      lines.push(reviewPoint(point, fileLabel))
      lines.push('')
    }
  }

  lines.push('#### 课件实例')
  lines.push('')
  if (!review.examples?.length) {
    lines.push('课件未提供实例。')
  } else {
    for (const example of review.examples) {
      lines.push(reviewExample(example, fileLabel))
      lines.push('')
    }
  }
  lines.push('')

  lines.push(...reviewExercises(c))
  lines.push('')

  lines.push('#### 本章小结')
  lines.push('')
  const summary = review.summary || {}
  field('一句话概括', summary.oneLine)
  if (summary.logic?.length) lines.push(`- 逻辑链：${summary.logic.map((step) => oneLine(step, 120)).join(' → ')}`)
  const bullets = (label, list) => {
    if (list?.length) lines.push(`- ${label}：${list.map((item) => oneLine(item, 160)).join('；')}`)
  }
  bullets('必须记住', summary.remember)
  bullets('必须理解', summary.understand)
  bullets('必须会做', summary.tasks)
  if (summary.priority?.length) {
    lines.push(`- 优先复习：${summary.priority.map((item) => `${oneLine(item.what, 80)}${item.why ? `（${oneLine(item.why, 100)}）` : ''}`).join('；')}`)
  }
  const confidence = c.summary?.confidence || legacyConfidence(c.summary)
  const detail = describeConfidence(confidence)
  if (detail) lines.push(`- 备注：${detail}`)
  if (!summary.oneLine && !summary.logic?.length) lines.push('（本章小结缺失，模型未返回）')
  return lines.join('\n')
}

/** Chapter-level prerequisite edges, derived from concept edges. */
function chapterDependencies(knowledge) {
  const concepts = knowledge?.concepts || []
  const chapterOf = new Map(concepts.map((concept) => [concept.id, Number(concept.chapter)]))
  const nameOf = new Map(concepts.map((concept) => [concept.id, concept.name]))
  const pairs = new Map()
  for (const edge of knowledge?.edges || []) {
    const from = chapterOf.get(edge.from)
    const to = chapterOf.get(edge.to)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue
    const key = `${from}->${to}`
    if (!pairs.has(key)) pairs.set(key, { from, to, names: [] })
    const name = nameOf.get(edge.to)
    if (name && pairs.get(key).names.length < 3) pairs.get(key).names.push(name)
  }
  return [...pairs.values()].sort((a, b) => a.from - b.from || a.to - b.to)
}

function frameworkSection({ files, framework, chapters, knowledge, plan, warnings, meta, style }) {
  const lines = []
  lines.push('### 1. 已读取的文件')
  lines.push('')
  if (files?.length) {
    lines.push('| 文件 | 类型 | 页数 | 备注 |')
    lines.push('|------|------|------|------|')
    for (const file of files) {
      const notes = [file.ocr ? '已 OCR 重读' : '', file.title && file.title !== file.name ? `标题：${cell(file.title)}` : ''].filter(Boolean)
      lines.push(`| ${cell(file.name)} | ${file.kind || ''} | ${file.pages || ''} | ${cell(notes.join('；'))} |`)
    }
  } else {
    lines.push('（没有可用文件）')
  }
  lines.push('')

  lines.push('### 2. 课程主题与学习目标')
  lines.push('')
  if (framework?.theme) lines.push(`- 总体主题：${oneLine(framework.theme, 200)}`)
  if (framework?.goals?.length) {
    for (const goal of framework.goals.slice(0, 6)) lines.push(`- 学习目标：${oneLine(goal, 160)}`)
  }
  if (!framework?.theme && !framework?.goals?.length) {
    lines.push(`- 总体主题：${oneLine(framework?.summary || '（模型未返回复习框架，可在课程总结中查看概况）', 200)}`)
  }
  lines.push('')

  lines.push('### 3. 章节目录与课件范围')
  lines.push('')
  lines.push('| 章 | 标题 | 课件页范围 | 知识点 | 实例 | 习题 |')
  lines.push('|----|------|-----------|--------|------|------|')
  for (const chapter of chapters || []) {
    const pages = (chapter.pages || []).filter((n) => Number.isInteger(n))
    const range = pages.length ? `第 ${Math.min(...pages)}–${Math.max(...pages)} 页` : '—'
    const stats = chapter.reviewStats || {}
    lines.push(
      `| ${chapter.index} | ${cell(chapter.title)} | ${range} | ${stats.points ?? '—'} | ${stats.examples ?? '—'} | ${stats.exercises ?? '—'} |`,
    )
  }
  lines.push('')

  lines.push('### 4. 章间依赖关系')
  lines.push('')
  const deps = chapterDependencies(knowledge)
  if (deps.length) {
    for (const dep of deps.slice(0, 16)) {
      lines.push(`- 第 ${dep.from} 章 → 第 ${dep.to} 章${dep.names.length ? `（${dep.names.join('、')} 依赖前面章节）` : ''}`)
    }
  } else {
    lines.push('- 未识别到跨章概念依赖，按章节顺序推进即可。')
  }
  lines.push('')

  lines.push('### 5. 建议复习顺序')
  lines.push('')
  const order = Array.isArray(plan) && plan.length ? plan : (chapters || []).map((c) => ({ index: c.index, title: c.title }))
  order.forEach((step, i) => {
    const note = step.blocked ? '（前置未掌握，先补前置）' : ''
    lines.push(`${i + 1}. 第 ${step.index} 章 ${step.title || ''}${note}`)
  })
  lines.push('')

  lines.push('### 6. 待确认与资料缺口')
  lines.push('')
  const gaps = []
  for (const warning of (warnings || []).slice(0, 8)) gaps.push(warning)
  if (meta?.ocr?.deferred) gaps.push(`OCR 页数上限：还有 ${meta.ocr.deferred} 页没有重读`)
  if (meta?.quality?.tier === 'unusable') gaps.push('文字层不可用，建议改用原始 .pptx/.docx 或开启 OCR 全量重读')
  const tagged = (chapters || []).reduce((n, c) => n + (c.reviewStats?.byTag?.['待确认'] || 0), 0)
  if (tagged) gaps.push(`${tagged} 个知识点被标为「待确认」（看不清、缺失或有疑问）`)
  const missingAnswers = (chapters || []).reduce((n, c) => n + ((c.reviewStats?.exercises || 0) - (c.reviewStats?.answered || 0)), 0)
  if (missingAnswers) gaps.push(`${missingAnswers} 道习题没有答案，需自己补或补充截图`)
  if (gaps.length) for (const gap of gaps) lines.push(`- ${gap}`)
  else lines.push('- 未发现明显缺口。')
  return lines.join('\n')
}

function chapterSection(c) {
  const s = c.summary || {}
  const lines = [chapterHeading(c, '###')]
  const points = (s.key_points || []).filter(Boolean)
  if (points.length) {
    lines.push('- 要点：')
    for (const p of points) {
      const page = Number(p?.page)
      lines.push(`  - ${pointText(p)}${page ? `（p.${page}）` : ''}`)
    }
  } else {
    lines.push('- 要点：（本章未提取到有效要点）')
  }
  for (const p of (s.important || []).filter(Boolean)) lines.push(`- ⭐ 重点：${p}`)
  for (const p of (s.difficult || []).filter(Boolean)) lines.push(`- ⚠️ 难点：${p}`)
  // the note states what was measured; it never claims the model "编造" anything
  const confidence = s.confidence || legacyConfidence(s)
  const detail = describeConfidence(confidence, { paged: true })
  if (detail) lines.push(`- 备注：${detail}`)
  if (s.keywords?.length) lines.push(`- 关键词：${s.keywords.join(' / ')}`)
  if (s.error) lines.push(`- 备注：本章总结失败（${s.error}），以上为本地兜底摘要`)
  return lines.join('\n')
}

/** Jobs saved before schemaVersion 2 only carry support / lowConfidence. */
function legacyConfidence(summary) {  if (!summary?.lowConfidence) return null
  return {
    tier: 'weak',
    reasons: [],
    overlap: summary.support ?? null,
    faithfulness: summary.faithfulness ?? null,
    evidence: { checked: 0, exact: 0, fuzzy: 0, short: 0, missing: 0, ratio: null },
  }
}

function seriesTable(series, fallback, courseTitle, seriesLinks = []) {
  if (!series.length) {
    const links = seriesLinks.length
      ? seriesLinks
      : [{ label: `${courseTitle} 合集`, url: searchLink(`${courseTitle} 合集`) }]
    const rows = links.slice(0, 3).map(
      (l, i) => `| ${i + 1} | ${cell(l.label)}（B 站搜索入口） | — | — | — | ${l.url} |`,
    )
    return ['| 序号 | 标题 | UP 主 | 播放量 | 时长/集数 | 链接 |', '|------|------|-------|--------|-----------|------|', ...rows].join('\n')
  }
  const rows = series.map(
    (v, i) =>
      `| ${i + 1} | ${cell(v.title)} | ${cell(v.author)} | ${fmtPlay(v.play)} | ${v.duration ? fmtDur(v.duration) : '合集'} | ${v.url} |`,
  )
  return [
    '| 序号 | 标题 | UP 主 | 播放量 | 时长/集数 | 链接 |',
    '|------|------|-------|--------|-----------|------|',
    ...rows,
    ...(fallback ? [] : []),
  ].join('\n')
}

function chapterTable(chapters, byChapter, fallback) {
  const rows = ['| 章节 | 标题 | UP 主 | 播放量 | 时长 | 链接 |', '|------|------|-------|--------|------|------|']
  let any = false
  chapters.forEach((c) => {
    const videos = byChapter[c.index]?.videos || []
    if (videos.length) {
      for (const v of videos) {
        any = true
        // "第 7P" beats a whole 30-part collection when the part title matches
        const partLabel = v.bestPart ? `（第 ${v.bestPart.page}P）` : v.parts > 1 ? `（${v.parts}P 合集）` : ''
        const url = v.bestPart ? `${v.url}?p=${v.bestPart.page}` : v.url
        rows.push(
          `| 第 ${c.index} 章 ${cell(c.title)} | ${cell(v.title)}${partLabel} | ${cell(v.author)} | ${fmtPlay(v.play)} | ${fmtDur(v.duration)} | ${url} |`,
        )
      }
    } else {
      any = true
      const q = (byChapter[c.index]?.queries?.[0] || c.title || c.summary?.keywords?.[0] || '').toString()
      const link = searchLink(q)
      rows.push(`| 第 ${c.index} 章 ${cell(c.title)} | ${cell(q)}（B 站搜索） | — | — | — | ${link} |`)
    }
  })
  if (!any) {
    rows.push(`| 全部 | 课程名搜索入口 | — | — | — | ${searchLink('课程')} |`)
  }
  return rows.join('\n')
}

/**
 * @param {object} input
 * @param {string} input.courseTitle
 * @param {Array} input.files      [{ name, kind, pages }]
 * @param {Array} input.chapters   [{ index, title, subs, summary }]
 * @param {string} input.courseSummary
 * @param {Array} input.series
 * @param {object} input.byChapter   index → { videos, queries }
 * @param {boolean} input.fallback   bilibili blocked → link-only appendix
 * @param {object} [input.meta]     { model, elapsedMs, warnings, generatedAt }
 */
export function buildReport(input) {
  const {
    courseTitle,
    files = [],
    chapters = [],
    courseSummary = '',
    series = [],
    seriesLinks = [],
    byChapter = {},
    fallback = false,
    meta = {},
    plan = [],
    knowledge = null,
    style = 'brief',
    framework = null,
    review = null,
  } = input
  const isReview = style === 'review'
  // the request asks for "文件名—第 X 页"; a page number only means something when
  // there is exactly one file, otherwise the report says nothing about pages
  const reviewFileLabel =
    isReview && files.length === 1 ? String(files[0].name || '').replace(/\.[^.]+$/, '').slice(0, 40) : ''
  const out = []
  const rawTitle = String(courseTitle || '课程').trim().replace(/[_]+/g, ' ').replace(/\s+/g, ' ')
  const bareTitle = /^《[^》]*》$/.test(rawTitle) ? rawTitle.slice(1, -1) : rawTitle
  // a title that already carries 《》 (`《计算机系统基础》复习大纲`) must not be
  // wrapped again — it produced "《《计算机系统基础》复习大纲》"
  out.push(
    rawTitle.includes('《')
      ? `# ${rawTitle}${isReview ? '复习资料' : '学习报告'}`
      : `# 《${bareTitle}》${isReview ? '复习资料' : '学习报告'}`,
  )
  out.push('')
  const sourceLine = files.map((f) => `${f.name}（${f.kind}${f.pages ? `，${f.pages} 页` : ''}）`).join('、')
  const bits = [
    `生成时间：${meta.generatedAt || new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `来源文件：${sourceLine || '（无）'}`,
    `章节数：${chapters.length}`,
    meta.model ? `总结模型：${meta.model}` : '',
    meta.domain ? `领域锚定：${meta.domain.name}${meta.domain.source === 'config' ? '（配置）' : '（从课件代码特征识别）'}` : '',
    meta.quality ? `文本可读性：${describeQuality(meta.quality)}` : '',
    meta.ocr && meta.ocr.pages
      ? `PDF 页级 OCR：${meta.ocr.pages}/${meta.ocr.total} 页（${meta.ocr.engine}${meta.ocr.scanned ? '，扫描版' : ''}），${meta.ocr.adopted} 页改用 OCR 文本`
      : '',
    meta.images ? `幻灯片图片：OCR ${meta.images.read}/${meta.images.images} 张，补充 ${meta.images.chars} 字` : '',
    meta.coverage && meta.coverage.total ? describeCoverage(meta.coverage) : '',
    meta.diagnostics ? describeOutlineDiagnostics(meta.diagnostics) : '',
    isReview && review ? `复习资料：${describeReview(review)}` : '',
    meta.offline ? '总结方式：本地兜底（模型不可用）' : '',
  ].filter(Boolean)
  out.push(`> ${bits.join(' ｜ ')}`)
  if (meta.quality?.tier === 'unusable') {
    out.push('>')
    out.push('> ⚠️ **文字层不可用**：这份文件里的文字没能被正确提取（多为导出型 PDF 的字形编码），下面的内容参考价值有限。建议改用原始 .pptx/.docx，或启用 OCR 重读。')
  }
  if (meta.warnings?.length) {
    out.push('>')
    for (const w of meta.warnings) out.push(`> ⚠️ ${w}`)
  }
  if (meta.dashboardPath) {
    out.push('>')
    out.push(`> 学习看板：\`${meta.dashboardPath}\`（用浏览器打开，离线可用）`)
  }
  out.push('')

  if (isReview) {
    out.push('## 一、复习框架')
    out.push('')
    out.push(frameworkSection({ files, framework, chapters, knowledge, plan, warnings: meta.warnings || [], meta }))
    out.push('')
    out.push('## 二、分章复习资料')
    out.push('')
    for (const c of chapters) {
      out.push(reviewChapterSection(c, reviewFileLabel))
      out.push('')
    }
  } else {
    out.push('## 一、课程目录')
    out.push('')
    out.push(toc(chapters) || '（未识别到目录）')
    out.push('')
    // the prerequisite tree is a supplement to the contents, not a replacement
    const mindmapSection = renderMindmapSection({ courseTitle: rawTitle, chapters, plan, graph: knowledge ? { nodes: new Map((knowledge.concepts || []).map((c) => [c.id, c])) } : null })
    if (mindmapSection) {
      out.push(mindmapSection)
      out.push('')
    }

    out.push('## 二、各章知识点')
    out.push('')
    for (const c of chapters) {
      out.push(chapterSection(c))
      out.push('')
    }
  }

  out.push('## 三、课程总结')
  out.push('')
  out.push(courseSummary ? courseSummary.slice(0, 300) : '（未生成总结）')
  out.push('')

  out.push('## 附录：B 站相关网课推荐')
  out.push('')
  if (fallback) {
    out.push('> B 站检索接口触发风控，以下为搜索入口链接（点击可在浏览器内检索）。')
    out.push('')
  }
  out.push('### A. 系列课程推荐')
  out.push('')
  out.push(seriesTable(series, fallback, courseTitle, seriesLinks))
  out.push('')
  out.push('### B. 分章节视频推荐')
  out.push('')
  out.push(chapterTable(chapters, byChapter, fallback))
  out.push('')
  if (meta.elapsedMs) {
    out.push(`<!-- 生成耗时 ${Math.round(meta.elapsedMs / 1000)}s；评分 = 匹配度×0.5 + log(播放)×0.2 + 收藏/点赞×0.2 + 合集×0.1 -->`)
  }
  return out.join('\n')
}

export { fmtDur, fmtPlay }
