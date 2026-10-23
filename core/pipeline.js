/**
 * The pipeline: parse → outline → (summarize ∥ search) → summary → report.
 *
 * Two rules shape this file:
 *   1. local work first (parse/clean/group), the model only sees one chapter at
 *      a time with the fixed JSON prompt;
 *   2. the outline is the split point: Bilibili search and chapter summaries
 *      start together, and each chapter's videos are searched the moment its
 *      keywords exist, so partial results show up early.
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { parseFile } from './parser.js'
import { buildOutline } from './outline.js'
import { summarizeChapter, summarizeCourse, mapLimit, localSummary, CHAPTER_PROMPT_VERSION } from './summarize.js'
import { buildReport } from './report.js'
import { assessQuality, describeQuality } from './quality.js'
import { ocrPdf, ocrStatus } from './ocr.js'
import { detectDomain } from './domain.js'
import { supportScore, SUPPORT_THRESHOLD } from './verify.js'

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)

/**
 * @param {object} opts
 * @param {string} opts.id job id
 * @param {Array<{path:string,name:string}>} opts.inputs uploaded files on disk
 * @param {object} opts.options { withVideos, concurrency }
 * @param {object} opts.deps { store, bili, llm: {provider, model, stream} | null }
 * @param {(job:object)=>void} opts.emit progress callback (same object mutated)
 */
export async function runPipeline({ id, inputs, options, deps, emit, signal }) {
  const { store, bili, llm } = deps
  const started = Date.now()
  const concurrency = Math.max(1, Math.min(5, Number(options?.concurrency) || 4))
  const warnings = []

  const job = {
    id,
    createdAt: new Date().toISOString(),
    status: 'running',
    phase: 'parse',
    message: '解析文件…',
    progress: 0.02,
    files: [],
    courseTitle: '',
    chapters: [],
    courseSummary: '',
    series: [],
    byChapter: {},
    fallback: false,
    warnings,
    reportPath: '',
    pdfPath: '',
    error: '',
    elapsedMs: 0,
  }
  const push = (patch) => {
    Object.assign(job, patch)
    job.elapsedMs = Date.now() - started
    try {
      emit?.(job)
    } catch {}
    store.saveJob(job)
  }
  push({})

  /* ---------------- 1. parse ---------------- */
  let docs = []
  for (const input of inputs) {
    const label = input.name || basename(input.path)
    try {
      if (input.convertError) throw new Error(`旧格式转换失败：${input.convertError}`)
      const doc = parseFile(input.path, input.name)
      doc.name = label
      doc.sourcePath = input.path
      // "幻灯片 12" is a slide-number placeholder, not a course title
      if (/^(幻灯片|slide)\s*\d+$/i.test(String(doc.title || '').trim())) {
        doc.title = label.replace(/\.[^.]+$/, '')
      }
      docs.push(doc)
      job.files.push({ name: label, kind: doc.kind, pages: doc.pages?.length || 0, title: doc.title })
    } catch (error) {
      warnings.push(`解析失败：${label} — ${error.message}`)
    }
  }
  if (!docs.length) {
    push({ status: 'error', phase: 'error', error: `所有文件都无法解析：${warnings.join('；')}`, progress: 1 })
    return job
  }
  // Prefer the Office source over an exported PDF of the same deck: the XML text
  // is complete, the PDF text often only carries glyph ids.
  const stem = (name) => String(name || '').replace(/\.[^.]+$/, '').toLowerCase().trim()
  const twinsDropped = []
  const kept = docs.filter((doc) => {
    if (doc.kind !== 'pdf') return true
    const twin = docs.find((d) => d !== doc && d.kind !== 'pdf' && stem(d.name) === stem(doc.name))
    if (twin) {
      twinsDropped.push(`${doc.name}（改用 ${twin.name}）`)
      return false
    }
    return true
  })
  if (twinsDropped.length) {
    docs = kept
    warnings.push(`同名的 PDF 已跳过：${twinsDropped.join('、')} 的文本更可靠`)
  }
  const scanned = docs.filter((d) => d.kind === 'pdf' && d.pages.length && d.pages.every((p) => p.text.length < 40))
  if (scanned.length) warnings.push(`疑似扫描版 PDF（无文本层）：${scanned.map((d) => d.name).join('、')}`)

  /* ---------------- 1.4 optional OCR re-read ---------------- */
  if (options?.ocr === true) {
    const requested = options.ocrEngine
    const engines = await ocrStatus()
    const ready = requested ? engines.find((e) => e.id === requested)?.available : engines.some((e) => e.available)
    const targets = docs.filter((d) => d.kind === 'pdf' && d.sourcePath)
    if (!ready) {
      warnings.push(
        requested
          ? `OCR 引擎 ${requested} 不可用：${engines.find((e) => e.id === requested)?.label || '未知引擎'}`
          : 'OCR 不可用：没有检测到 OCR 引擎（Windows 内置 WinRT；其他平台 pip install rapidocr_onnxruntime pymupdf）',
      )
    }
    for (const doc of ready ? targets : []) {
      try {
        push({ phase: 'ocr', message: `OCR 重读：${doc.name}`, progress: 0.05 })
        const pages = await ocrPdf(doc.sourcePath, {
          engine: requested,
          python: options.ocrPython,
          maxPages: Number(options.ocrMaxPages) || 60,
          onProgress: (done, total) =>
            push({
              message: `OCR 第 ${done}/${total || '?'} 页：${doc.name}`,
              progress: Math.min(0.16, 0.05 + 0.11 * (done / Math.max(1, total || done))),
            }),
        })
        if (pages.length) {
          doc.pages = pages.map((p, i) => ({ index: i + 1, title: p.title || '', text: p.text }))
          doc.text = pages.map((p) => p.text).join('\n\n')
          doc.ocr = true
          job.files = job.files.map((f) => (f.name === doc.name ? { ...f, pages: doc.pages.length, ocr: true } : f))
        }
      } catch (error) {
        warnings.push(`OCR 失败（${doc.name}）：${error.message}`)
      }
    }
  }

  /* ---------------- 1.5 quality gate ---------------- */
  const quality = assessQuality(docs)
  if (quality.tier !== 'good') {
    warnings.push(`文本可读性${quality.tier === 'unusable' ? '不可用' : '偏低'}：${describeQuality(quality)}`)
    for (const reason of quality.reasons.slice(0, 2)) warnings.push(reason)
  }
  push({
    quality,
    phase: 'outline',
    message: quality.tier === 'unusable' ? '文字层不可用，仍按现状生成报告…' : '识别目录…',
    progress: 0.14,
  })

  /* ---------------- 2. outline ---------------- */
  const outline = buildOutline(docs)
  // Anchor the whole run to one language/domain so chapter searches cannot drift
  // (a C++ lecture must not surface Python/Java tutorials for "异常处理").
  const domain = detectDomain(docs, options?.domain)
  if (domain) {
    job.domain = { id: domain.id, name: domain.name, source: domain.source, score: domain.score }
  }
  // a garbled file yields a garbled title; fall back to the file name
  if (quality.tier === 'unusable') {
    const name = (docs[0]?.name || docs[0]?.fileName || '').replace(/\.[^.]+$/, '')
    if (name) outline.courseTitle = name
  }
  const chapters = outline.chapters.map((c) => ({
    index: c.index,
    title: c.title,
    source: c.source,
    subs: c.subs || [],
    pages: c.pages || [],
    chars: c.text.length,
    status: 'pending',
    summary: null,
  }))
  const texts = outline.chapters.map((c) => c.text)
  push({
    phase: 'summarize',
    message: `已识别 ${chapters.length} 章，开始总结与检索…`,
    progress: 0.18,
    courseTitle: outline.courseTitle,
    tree: outline.tree,
    chapters,
  })

  const modelLabel = llm ? `${llm.provider}/${llm.model}` : ''
  const useModel = !!llm
  const outlineTitles = chapters.map((c) => c.title)
  if (!useModel) warnings.push('未找到可用模型，改用本地兜底摘要')

  /* ---------------- 3. search + summarize in parallel ---------------- */
  const chapterQueries = chapters.length > 12 ? 1 : 2
  const seriesPromise =
    options?.withVideos === false
      ? Promise.resolve({ ok: true, series: [], fallback: false })
      : bili
          .recommendSeries(outline.courseTitle, { domain })
          .catch((e) => ({ ok: false, series: [], fallback: true, reason: e.message }))

  let doneCount = 0
  await mapLimit(
    chapters.map((chapter, i) => ({ chapter, text: texts[i] })),
    concurrency,
    async ({ chapter, text }) => {
      let summary = null
      const hash = sha(text)
      const cacheKey = `sum:v${CHAPTER_PROMPT_VERSION}:${hash}`
      if (useModel) {
        try {
          summary = await store.cache.get(cacheKey)
        } catch {}
        if (!summary) {
          try {
            summary = await summarizeChapter({
              llm,
              provider: llm.provider,
              model: llm.model,
              courseTitle: outline.courseTitle,
              chapter,
              outline: outlineTitles,
              domain,
              signal,
            })
            await store.cache.set(cacheKey, summary, 30 * 86400 * 1000)
          } catch (error) {
            summary = { ...localSummary({ ...chapter, text }), error: error.message, offline: true }
            warnings.push(`第 ${chapter.index} 章总结失败：${error.message}`)
          }
        }
      } else {
        summary = { ...localSummary({ ...chapter, text }), offline: true }
      }
      chapter.summary = summary
      chapter.status = 'done'
      // did the bullets actually come from this chapter's text?
      try {
        const support = supportScore(text, summary.key_points || [])
        summary.support = support
        chapter.support = support
        // statement-level check: the model marks bullets it could not source
        const total = (summary.key_points || []).length
        const marked = Array.isArray(summary.unsupported_idx)
        const faithfulness = marked && total ? 1 - summary.unsupported_idx.length / total : null
        summary.faithfulness = faithfulness === null ? null : Math.round(faithfulness * 100) / 100
        if (support < SUPPORT_THRESHOLD || (faithfulness !== null && faithfulness < 0.6)) {
          summary.lowConfidence = true
          const faithText = faithfulness === null ? '—' : `${Math.round(faithfulness * 100)}%`
          warnings.push(`第 ${chapter.index} 章可信度偏低：有依据 ${faithText}，与原文重合 ${Math.round(support * 100)}%`)
        }
      } catch {}
      doneCount += 1
      push({
        message: `总结第 ${chapter.index}/${chapters.length} 章：${chapter.title.slice(0, 24)}`,
        progress: 0.18 + 0.62 * (doneCount / chapters.length),
      })

      if (options?.withVideos !== false) {
        try {
          const keywords = (summary.keywords || []).slice(0, chapterQueries)
          const res = await bili.recommendChapter(keywords.length ? keywords : [chapter.title], {
            domain,
            chapterTitle: chapter.title,
          })
          job.byChapter[chapter.index] = {
            videos: res.videos.map((v) => ({
              bvid: v.bvid,
              title: v.title,
              author: v.author,
              play: v.play,
              duration: v.duration,
              score: v.score,
              url: v.url,
              series: v.series,
            })),
            queries: res.queries,
            ok: res.ok,
            fallback: res.fallback,
            reason: res.reason || '',
          }
          if (res.fallback && !job.fallback) {
            job.fallback = true
            warnings.push(`B 站检索受限：${res.reason || '风控'}，附录改用搜索链接`)
          }
        } catch (error) {
          warnings.push(`第 ${chapter.index} 章检索失败：${error.message}`)
        }
        push({})
      }
    },
  )

  const seriesResult = await seriesPromise
  let series = seriesResult.series || []
  let seriesLinks = seriesResult.links || []
  if (options?.withVideos !== false) {
    if (seriesResult.fallback) {
      job.fallback = true
      if (seriesResult.reason) warnings.push(`系列课检索受限：${seriesResult.reason}`)
    }
    // Refine the course-level search with the vocabulary that only exists once
    // every chapter has keywords (e.g. 「国际贸易 政策评估 教程」).
    const freq = new Map()
    for (const c of chapters) {
      for (const k of c.summary?.keywords || []) freq.set(k, (freq.get(k) || 0) + 1)
    }
    const topKeywords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .map(([k]) => k)
      .filter((k) => k.length >= 4 && k.length <= 16)
      .slice(0, 2)
    if (topKeywords.length) {
      try {
        const refined = await bili.recommendSeries(outline.courseTitle, { extraQueries: topKeywords, domain })
        if ((refined.series?.length || 0) > series.length) series = refined.series
        if (refined.links?.length) seriesLinks = [...refined.links, ...seriesLinks].slice(0, 3)
      } catch (error) {
        warnings.push(`系列课补充检索失败：${error.message}`)
      }
    }
    job.series = series
    job.seriesLinks = seriesLinks
  }
  push({ phase: 'summary', message: '生成全课程总结…', progress: 0.83 })

  /* ---------------- 4. course summary ---------------- */
  let courseSummary = ''
  if (useModel) {
    try {
      courseSummary = await summarizeCourse({
        llm,
        provider: llm.provider,
        model: llm.model,
        courseTitle: outline.courseTitle,
        chapters,
        signal,
      })
    } catch (error) {
      warnings.push(`全课程总结失败：${error.message}`)
    }
  }
  if (!courseSummary) {
    const parts = chapters
      .map((c) => `${c.title}：${(c.summary?.key_points || []).slice(0, 2).join('、')}`)
      .join('；')
    courseSummary = parts.slice(0, 280)
  }
  push({ phase: 'report', message: '生成报告…', progress: 0.9, courseSummary })

  /* ---------------- 5. report ---------------- */
  const markdown = buildReport({
    courseTitle: outline.courseTitle,
    files: job.files,
    chapters,
    courseSummary,
    series: job.series,
    seriesLinks: job.seriesLinks,
    byChapter: job.byChapter,
    fallback: job.fallback,
    meta: {
      model: modelLabel,
      elapsedMs: job.elapsedMs,
      warnings,
      quality,
      domain: job.domain,
      offline: !useModel || chapters.every((c) => c.summary?.offline),
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    },
  })
  const reportPath = store.writeReport(outline.courseTitle || 'course', markdown)
  push({
    status: 'done',
    phase: 'done',
    message: `完成：${chapters.length} 章、${Object.values(job.byChapter).reduce((a, b) => a + (b.videos?.length || 0), 0)} 个视频`,
    progress: 1,
    markdown,
    reportPath,
    elapsedMs: Date.now() - started,
  })
  return job
}

/* --------------------------- chapter-level rerun --------------------------- */

const bulletOf = (summary) => [
  ...(summary?.key_points || []).map((text) => ({ kind: '要点', text: String(text) })),
  ...(summary?.important || []).map((text) => ({ kind: '重点', text: String(text) })),
  ...(summary?.difficult || []).map((text) => ({ kind: '难点', text: String(text) })),
]

/**
 * Bullet-level diff between two summaries of the same chapter.
 * Comparisons ignore whitespace so a reflowed model answer is not "changed".
 */
export function diffSummary(before, after) {
  const keyOf = (b) => `${b.kind}:${b.text.replace(/\s+/g, '').slice(0, 80)}`
  const oldMap = new Map(bulletOf(before).map((b) => [keyOf(b), b]))
  const newMap = new Map(bulletOf(after).map((b) => [keyOf(b), b]))
  const added = [...newMap.entries()].filter(([k]) => !oldMap.has(k)).map(([, b]) => b)
  const removed = [...oldMap.entries()].filter(([k]) => !newMap.has(k)).map(([, b]) => b)
  const oldKeywords = new Set(before?.keywords || [])
  const newKeywords = new Set(after?.keywords || [])
  return {
    added,
    removed,
    keywordsAdded: [...newKeywords].filter((k) => !oldKeywords.has(k)),
    keywordsRemoved: [...oldKeywords].filter((k) => !newKeywords.has(k)),
    supportBefore: before?.support ?? null,
    supportAfter: after?.support ?? null,
    changed: added.length > 0 || removed.length > 0,
  }
}

/**
 * Regenerate exactly one chapter of a finished job and rebuild its report.
 *
 * Parsing is deterministic, so the chapter body is recovered by re-parsing the
 * original inputs instead of storing every chapter's text on disk. Everything
 * else (other chapters, course summary, series videos) is carried over.
 */
export async function rerunChapter({ id, inputs, previous, chapterIndex, options, deps, emit, signal }) {
  const { store, bili, llm } = deps
  const started = Date.now()
  const warnings = [...(previous.warnings || [])]
  const job = {
    ...previous,
    id,
    status: 'running',
    phase: 'rerun',
    message: `重跑第 ${chapterIndex} 章…`,
    progress: 0.1,
    reportPath: '',
    pdfPath: '',
    markdown: '',
    error: '',
    warnings,
    rerunOf: previous.id,
    rerunChapter: Number(chapterIndex),
  }
  const push = (patch) => {
    Object.assign(job, patch)
    job.elapsedMs = Date.now() - started
    try {
      emit?.(job)
    } catch {}
    store.saveJob(job)
  }
  push({})

  const docs = []
  for (const input of inputs) {
    try {
      const doc = parseFile(input.path, input.name)
      doc.name = input.name || basename(input.path)
      doc.sourcePath = input.path
      docs.push(doc)
    } catch (error) {
      warnings.push(`解析失败：${input.name || input.path} — ${error.message}`)
    }
  }
  if (!docs.length) {
    push({ status: 'error', phase: 'error', error: '原文件无法再解析，请重新上传后重跑', progress: 1 })
    return job
  }
  const outline = buildOutline(docs)
  const outlined = outline.chapters
  const target =
    outlined.find((c) => c.index === Number(chapterIndex)) || outlined[Math.max(0, Number(chapterIndex) - 1)]
  if (!target) {
    push({ status: 'error', phase: 'error', error: `找不到第 ${chapterIndex} 章（当前共 ${outlined.length} 章）`, progress: 1 })
    return job
  }

  const domain = previous.domain
    ? { id: previous.domain.id, name: previous.domain.name, source: 'previous', score: previous.domain.score }
    : detectDomain(docs, options?.domain)
  const chapter = {
    index: target.index,
    title: target.title,
    source: target.source,
    subs: target.subs || [],
    pages: target.pages || [],
    chars: target.text.length,
  }
  push({ message: `重新总结第 ${target.index} 章：${target.title.slice(0, 20)}`, progress: 0.35 })

  let summary
  if (llm) {
    try {
      summary = await summarizeChapter({
        llm,
        provider: llm.provider,
        model: llm.model,
        courseTitle: previous.courseTitle || outline.courseTitle,
        chapter,
        outline: outlined.map((c) => c.title),
        domain,
        signal,
      })
      // a rerun deliberately bypasses the cache read, but the fresh answer is
      // worth keeping for the next full run
      await store.cache.set(`sum:v${CHAPTER_PROMPT_VERSION}:${sha(target.text)}`, summary, 30 * 86400 * 1000)
    } catch (error) {
      warnings.push(`第 ${target.index} 章重跑失败：${error.message}`)
      summary = { ...localSummary({ ...chapter, text: target.text }), offline: true, error: error.message }
    }
  } else {
    summary = { ...localSummary({ ...chapter, text: target.text }), offline: true }
  }
  try {
    const support = supportScore(target.text, summary.key_points || [])
    summary.support = support
    const total = (summary.key_points || []).length
    const marked = Array.isArray(summary.unsupported_idx)
    summary.faithfulness = marked && total ? Math.round((1 - summary.unsupported_idx.length / total) * 100) / 100 : null
  } catch {}

  const oldChapter =
    (previous.chapters || []).find((c) => c.index === target.index) || (previous.chapters || [])[Number(chapterIndex) - 1] || {}
  const diff = diffSummary(oldChapter.summary, summary)
  const merged = {
    ...oldChapter,
    ...chapter,
    status: 'done',
    summary,
    support: summary.support,
    rerunAt: new Date().toISOString(),
    diff,
  }
  job.chapters = (previous.chapters || []).map((c) => (c.index === (oldChapter.index ?? target.index) ? merged : c))
  if (!job.chapters.some((c) => c.index === merged.index)) job.chapters.push(merged)
  job.chapters.sort((a, b) => a.index - b.index)

  if (options?.withVideos !== false && bili) {
    push({ message: `重新检索第 ${target.index} 章的 B 站网课…`, progress: 0.6 })
    try {
      const keywords = (summary.keywords || []).slice(0, outlined.length > 12 ? 1 : 2)
      const res = await bili.recommendChapter(keywords.length ? keywords : [target.title], {
        domain,
        chapterTitle: target.title,
      })
      job.byChapter = {
        ...(previous.byChapter || {}),
        [merged.index]: {
          videos: res.videos.map((v) => ({
            bvid: v.bvid,
            title: v.title,
            author: v.author,
            play: v.play,
            duration: v.duration,
            score: v.score,
            url: v.url,
            series: v.series,
          })),
          queries: res.queries,
          ok: res.ok,
          fallback: res.fallback,
          reason: res.reason || '',
        },
      }
    } catch (error) {
      warnings.push(`第 ${target.index} 章重跑检索失败：${error.message}`)
    }
  }

  push({ phase: 'report', message: '重建报告…', progress: 0.85 })
  const markdown = buildReport({
    courseTitle: previous.courseTitle || outline.courseTitle,
    files: previous.files || [],
    chapters: job.chapters,
    courseSummary: previous.courseSummary || '',
    series: previous.series || [],
    seriesLinks: previous.seriesLinks || [],
    byChapter: job.byChapter || {},
    fallback: previous.fallback,
    meta: {
      model: llm ? `${llm.provider}/${llm.model}` : '',
      elapsedMs: job.elapsedMs,
      warnings,
      quality: previous.quality,
      domain: job.domain,
      offline: !llm,
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    },
  })
  const reportPath = store.writeReport(previous.courseTitle || outline.courseTitle || 'course', markdown)
  push({
    status: 'done',
    phase: 'done',
    message: `第 ${merged.index} 章已重跑：+${diff.added.length} −${diff.removed.length} 条要点`,
    progress: 1,
    markdown,
    reportPath,
    elapsedMs: Date.now() - started,
  })
  return job
}
