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
import { basename, relative, isAbsolute } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { parseFile } from './parser.js'
import { buildOutline } from './outline.js'
import { summarizeChapter, summarizeCourse, mapLimit, localSummary, CHAPTER_PROMPT_VERSION } from './summarize.js'
import { buildReport } from './report.js'
import { renderDashboardHtml } from './dashboard.js'
import { assessQuality, describeQuality } from './quality.js'
import { ocrPdf, ocrStatus } from './ocr.js'
import { classifyError, planChapters, nextChapterAction, FAILURE } from './schedule.js'
import { createGraph } from './graph.js'
import { extractKnowledge, fallbackKnowledge } from './knowledge.js'
import { detectDomain } from './domain.js'
import { evaluateSummary, describeConfidence, pointText, pointEvidence, normalizeForMatch } from './verify.js'
import { buildIndex, serializePassages } from './search.js'
import { buildTopicProfile } from './topic.js'
import { cleanKeywords, topTermsFor } from './terms.js'

/** Content-addressed OCR cache: reruns reuse the first run's pages byte-for-byte. */
export function ocrCachePath(store, pdfPath, options = {}) {
  const bytes = readFileSync(pdfPath)
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const engine = options.engine || 'auto'
  const pages = Number(options.maxPages) || 60
  return { key: `${digest}-${engine}-${pages}`, file: `${digest}-${engine}-${pages}.json` }
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)

export const JOB_SCHEMA_VERSION = 2

/** Cache identity: prompt version + text + everything else that changes the answer. */
export function summaryCacheKey(text, { provider, model, domain } = {}) {
  const scope = `${provider || '-'}/${model || '-'}/${domain?.id || '-'}`
  return `sum:v${CHAPTER_PROMPT_VERSION}:${sha(text)}:${scope}`
}

/**
 * Point each bullet at the page its quote came from, so the report can say
 * "（p.12）" instead of asking the reader to search. Single-document only: page
 * numbers collide across files.
 */
export function locatePages(chapter, summary, docs) {
  if (docs.length !== 1) return
  const wanted = new Set(chapter.pages || [])
  const pages = (docs[0].pages || []).filter((p) => wanted.has(p.index))
  if (!pages.length) return
  const normalized = pages.map((p) => ({ index: p.index, text: normalizeForMatch(p.text) }))
  for (const point of summary.key_points || []) {
    const quote = normalizeForMatch(pointEvidence(point)).slice(0, 24)
    if (quote.length < 6) continue
    const hit = normalized.find((p) => p.text.includes(quote))
    if (hit) point.page = hit.index
  }
}

/**
 * Attach the credibility assessment to one chapter. Called by the first run and
 * by the rerun path alike, so both produce identical fields (B3).
 */
export function applyAssessment({ summary, chapter, text, warnings }) {
  const confidence = evaluateSummary(text, summary)
  summary.confidence = confidence
  summary.tier = confidence.tier
  summary.overlap = confidence.overlap
  summary.faithfulness = confidence.faithfulness
  // legacy aliases kept for older clients and saved jobs
  summary.support = confidence.overlap
  summary.lowConfidence = confidence.tier === 'suspect'
  if (chapter) {
    // the caller used to set these two; keep them here so every path agrees
    chapter.summary = summary
    chapter.status = 'done'
    chapter.confidence = confidence
    chapter.support = confidence.overlap
  }
  if (summary.lowConfidence) {
    const detail = describeConfidence(confidence)
    warnings.push(`第 ${chapter?.index ?? '?'} 章可信度偏低${detail ? `：${detail}` : ''}`)
  }
  return confidence
}

/**
 * @param {object} opts
 * @param {string} opts.id job id
 * @param {Array<{path:string,name:string}>} opts.inputs uploaded files on disk
 * @param {object} opts.options { withVideos, concurrency }
 * @param {object} opts.deps { store, bili, llm: {provider, model, stream} | null }
 * @param {(job:object)=>void} opts.emit progress callback (same object mutated)
 */
/**
 * The provider occasionally ends a concurrent stream with no text at all. One
 * quiet retry turns those into a normal summary instead of a local fallback.
 */
async function summarizeWithRetry(args) {
  // The retry policy lives in core/schedule.js: a table keyed by failure class,
  // not a conversation. AUTH never retries (a missing key cannot fix itself),
  // EMPTY escalates budget then shrinks the input, RATE_LIMIT backs off.
  let attempt = 0
  let last = null
  for (;;) {
    const failure = last ? classifyError(last) : null
    const decision = nextChapterAction({ attempts: attempt, failure })
    if (decision.action === 'degrade') throw last
    if (decision.delayMs) await new Promise((resolve) => setTimeout(resolve, decision.delayMs))
    const extra = decision.action === 'retry' ? { maxTokens: decision.maxTokens, passageRatio: decision.passageRatio } : {}
    try {
      return await summarizeChapter({ ...args, ...extra })
    } catch (error) {
      last = error
      attempt += 1
      if (classifyError(error) === FAILURE.AUTH) throw error
    }
  }
}

/** Stable key for "same files + same settings" — enables a zero-cost rerun. */
export function dedupeKeyFor(inputs, options, llm) {
  const files = (inputs || [])
    .map((file) => file?.sha256 || file?.name || '')
    .sort()
    .join('+')
  const scope = [
    llm?.provider || '-',
    llm?.model || '-',
    options?.withVideos === false ? 'v0' : 'v1',
    options?.knowledge === false ? 'k0' : 'k1',
    options?.domain || '',
  ].join('|')
  return createHash('sha256').update(files).update('|').update(scope).digest('hex').slice(0, 16)
}

/* ------------------------- shared preparation step ------------------------- */

/**
 * Parse the inputs, drop same-name PDF twins and (optionally) re-read with OCR.
 *
 * Shared by the first run and every rerun: the rerun path must see exactly the
 * same documents as the original job, otherwise chapter numbers drift.
 * OCR results are cached by content hash so a rerun never re-runs OCR.
 */
async function prepareDocs({ inputs, store, ocr, warnings, push }) {
  const docs = []
  const files = []
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
      files.push({ name: label, kind: doc.kind, pages: doc.pages?.length || 0, title: doc.title })
    } catch (error) {
      warnings.push(`解析失败：${label} — ${error.message}`)
    }
  }
  if (!docs.length) return { docs, files, dropped: [], ocrInfo: null }

  // Prefer the Office source over an exported PDF of the same deck: the XML text
  // is complete, the PDF text often only carries glyph ids.
  const stem = (name) => String(name || '').replace(/\.[^.]+$/, '').toLowerCase().trim()
  const dropped = []
  const kept = docs.filter((doc) => {
    if (doc.kind !== 'pdf') return true
    const twin = docs.find((d) => d !== doc && d.kind !== 'pdf' && stem(d.name) === stem(doc.name))
    if (twin) {
      dropped.push(`${doc.name}（改用 ${twin.name}）`)
      return false
    }
    return true
  })
  if (dropped.length) warnings.push(`同名的 PDF 已跳过：${dropped.join('、')} 的文本更可靠`)
  const usable = dropped.length ? kept : docs

  /* ---------------- optional OCR re-read ---------------- */
  let ocrInfo = null
  if (ocr?.enabled === true) {
    const requested = ocr.engine
    const maxPages = Number(ocr.maxPages) || 60
    const engines = await ocrStatus()
    const ready = requested ? engines.find((e) => e.id === requested)?.available : engines.some((e) => e.available)
    const targets = usable.filter((d) => d.kind === 'pdf' && d.sourcePath)
    if (!ready) {
      warnings.push(
        requested
          ? `OCR 引擎 ${requested} 不可用：${engines.find((e) => e.id === requested)?.label || '未知引擎'}`
          : 'OCR 不可用：没有检测到 OCR 引擎（Windows 内置 WinRT；其他平台 pip install rapidocr_onnxruntime pymupdf）',
      )
    } else {
      ocrInfo = { engine: requested || 'auto', maxPages }
    }
    for (const doc of ready ? targets : []) {
      try {
        const cache = ocrCachePath(store, doc.sourcePath, { engine: requested, maxPages })
        let pages = store.readOcr?.(cache.file) || null
        if (pages) {
          push({ message: `OCR 缓存命中：${doc.name}`, progress: 0.06 })
        } else {
          push({ phase: 'ocr', message: `OCR 重读：${doc.name}`, progress: 0.05 })
          pages = await ocrPdf(doc.sourcePath, {
            engine: requested,
            python: ocr.python,
            maxPages,
            onProgress: (done, total) =>
              push({
                message: `OCR 第 ${done}/${total || '?'} 页：${doc.name}`,
                progress: Math.min(0.16, 0.05 + 0.11 * (done / Math.max(1, total || done))),
              }),
          })
          if (pages?.length) store.writeOcr?.(cache.file, { pages, engine: requested || 'auto', maxPages, sha: cache.key })
        }
        if (pages?.length) {
          doc.pages = pages.map((p, i) => ({ index: i + 1, title: p.title || '', text: p.text }))
          doc.text = pages.map((p) => p.text).join('\n\n')
          doc.ocr = true
          const row = files.find((f) => f.name === doc.name)
          if (row) {
            row.pages = doc.pages.length
            row.ocr = true
          }
        }
      } catch (error) {
        warnings.push(`OCR 失败（${doc.name}）：${error.message}`)
      }
    }
  }

  const scanned = usable.filter((d) => d.kind === 'pdf' && d.pages.length && d.pages.every((p) => p.text.length < 40))
  if (scanned.length) warnings.push(`疑似扫描版 PDF（无文本层）：${scanned.map((d) => d.name).join('、')}`)
  return { docs: usable, files, dropped, ocrInfo }
}

/** Input manifest: what the job consumed, in a form that survives a restart. */
function manifestInputs(inputs, store) {
  return inputs.map((input) => {
    let sha256 = ''
    try {
      sha256 = createHash('sha256').update(readFileSync(input.path)).digest('hex').slice(0, 16)
    } catch {}
    let path = input.path
    if (store?.dataDir && isAbsolute(path)) {
      const rel = relative(store.dataDir, path)
      if (rel && !rel.startsWith('..')) path = rel
    }
    return {
      uploadId: input.uploadId || '',
      name: input.name || basename(input.path),
      path,
      sha256,
      convertedFrom: input.convertedFrom || '',
    }
  })
}

export async function runPipeline({ id, inputs, options, deps, emit, signal }) {
  const { store, bili, llm } = deps
  const started = Date.now()
  const dedupeKey = dedupeKeyFor(inputs, options, llm)
  if (!options?.noReuse) {
    const reusable = store.findReusableJob?.(dedupeKey)
    if (reusable) {
      try {
        emit?.({ ...reusable, reused: true })
      } catch {}
      return reusable
    }
  }
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

  /* ---------------- 1. parse + twins + optional OCR ---------------- */
  const prepared = await prepareDocs({
    inputs,
    store,
    ocr: options?.ocr === true ? { enabled: true, engine: options.ocrEngine, python: options.ocrPython, maxPages: options.ocrMaxPages } : null,
    warnings,
    push,
  })
  let docs = prepared.docs
  job.files = prepared.files
  job.inputs = manifestInputs(inputs, store)
  job.inputsDropped = prepared.dropped
  job.ocr = prepared.ocrInfo
  job.schemaVersion = JOB_SCHEMA_VERSION
  if (!docs.length) {
    push({ status: 'error', phase: 'error', error: `所有文件都无法解析：${warnings.join('；')}`, progress: 1 })
    return job
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
  // Lock the boundaries in the job: a rerun replays them instead of re-deriving,
  // so changing the chaptering algorithm never renumbers an existing job.
  job.outline = {
    source: outline.source || 'heuristic',
    boundaries: outline.chapters.map((c) => ({ index: c.index, title: c.title, pages: c.pages || [], chars: c.text.length })),
    hash: createHash('sha256').update(outline.chapters.map((c) => `${c.title}#${(c.pages || []).join(',')}`).join('|')).digest('hex').slice(0, 16),
  }
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

  /* ---------------- 3. summarize (search runs after, once the topic is known) ---------------- */

  let doneCount = 0
  // set once when the provider has no usable key: the rest of the run must not
  // keep paying for calls that cannot succeed
  let authMissing = false
  const telemetry = { chapters: chapters.length, modelCalls: 0, cacheHits: 0, sourceChars: 0, keptChars: 0 }
  await mapLimit(
    chapters.map((chapter, i) => ({ chapter, text: texts[i] })),
    concurrency,
    async ({ chapter, text }) => {
      let summary = null
      const cacheKey = summaryCacheKey(text, { provider: llm?.provider, model: llm?.model, domain })
      if (useModel && !authMissing) {
        try {
          const cached = await store.cache.get(cacheKey)
          // clone: the assessment fields written below must never leak into the cache
          if (cached) {
            summary = structuredClone(cached)
            telemetry.cacheHits += 1
          }
        } catch {}
        if (!summary) {
          try {
            summary = await summarizeWithRetry({
              llm,
              provider: llm.provider,
              model: llm.model,
              courseTitle: outline.courseTitle,
              chapter,
              text,
              outline: outlineTitles,
              domain,
              signal,
            })
            await store.cache.set(cacheKey, structuredClone(summary), 30 * 86400 * 1000)
          } catch (error) {
            summary = { ...localSummary({ ...chapter, text }), error: error.message, offline: true }
            const failure = classifyError(error)
            if (failure === FAILURE.AUTH && !authMissing) {
              // one clear sentence beats eleven identical per-chapter errors
              authMissing = true
              warnings.push('模型未配置：缺少可用 API Key，其余章节改用本地摘要（在设置里选好模型后重跑即可）')
            } else if (!authMissing) {
              warnings.push(`第 ${chapter.index} 章总结失败：${error.message}`)
            }
          }
        }
      } else {
        summary = { ...localSummary({ ...chapter, text }), offline: true }
      }
      applyAssessment({ summary, chapter, text, warnings })
      locatePages(chapter, summary, docs)
      telemetry.modelCalls += summary.sourceChars ? 1 : 0
      telemetry.sourceChars += summary.sourceChars || 0
      telemetry.keptChars += summary.keptChars || 0
      doneCount += 1
      push({
        message: `总结第 ${chapter.index}/${chapters.length} 章：${chapter.title.slice(0, 24)}`,
        progress: 0.18 + 0.55 * (doneCount / chapters.length),
      })
    },
  )

  /* ---------------- 3.5 topic profile + Bilibili search ---------------- */
  // generic page headers ("主要内容") must never become search words
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i]
    const cleaned = cleanKeywords(chapter.summary?.keywords || [], 4)
    if (cleaned.length) {
      chapter.summary.keywords = cleaned
    } else {
      const terms = topTermsFor(texts[i] || '', texts, 3)
      chapter.summary.keywords = terms.length ? terms : cleaned
    }
  }
  const allKeywords = chapters.flatMap((c) => c.summary?.keywords || [])
  const topic = buildTopicProfile({
    courseTitle: outline.courseTitle,
    keywords: allKeywords,
    texts,
    domain,
    configDomain: options?.domain || '',
  })
  job.topic = { anchor: topic.anchor, vocab: topic.vocab.slice(0, 12), negative: topic.negative.slice(0, 8), lang: topic.lang }
  push({ phase: 'search', message: `检索 B 站网课（主题：${topic.anchor || '未识别'}）…`, progress: 0.75 })

  let series = []
  let seriesLinks = []
  if (options?.withVideos !== false) {
    const freq = new Map()
    for (const c of chapters) {
      for (const k of c.summary?.keywords || []) freq.set(k, (freq.get(k) || 0) + 1)
    }
    const topKeywords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .map(([k]) => k)
      .filter((k) => k.length >= 4 && k.length <= 16)
      .slice(0, 2)

    try {
      const seriesResult = await bili.recommendSeries(outline.courseTitle, { domain, topic, extraQueries: topKeywords })
      series = seriesResult.series || []
      seriesLinks = seriesResult.links || []
      if (seriesResult.fallback) {
        job.fallback = true
        if (seriesResult.reason) warnings.push(`系列课检索受限：${seriesResult.reason}`)
      }
    } catch (error) {
      warnings.push(`系列课检索失败：${error.message}`)
    }

    await mapLimit(chapters, Math.min(3, concurrency), async (chapter) => {
      const keywords = chapter.summary?.keywords || []
      try {
        const res = await bili.recommendChapter(keywords, {
          domain,
          chapterTitle: chapter.title,
          topic,
        })
        job.byChapter[chapter.index] = {
          videos: res.videos.map((v) => ({
            bvid: v.bvid,
            title: v.title,
            author: v.author,
            play: v.play,
            duration: v.duration,
            score: v.score,
            relevance: v.relevance ?? null,
            url: v.url,
            series: v.series,
            parts: v.partCount || 0,
            bestPart: v.bestPart || null,
          })),
          queries: res.queries,
          level: res.level ?? null,
          filteredOut: res.filteredOut ?? 0,
          ok: res.ok,
          fallback: res.fallback,
          reason: res.reason || '',
        }
        if (res.fallback && !job.fallback) {
          job.fallback = true
          warnings.push(`第 ${chapter.index} 章主题过滤后没有对题网课，附录改用搜索链接`)
        }
      } catch (error) {
        warnings.push(`第 ${chapter.index} 章检索失败：${error.message}`)
      }
      push({})
    })
    job.series = series
    job.seriesLinks = seriesLinks
  }
  /* ---------------- 3.8 knowledge graph → study plan ---------------- */
  let knowledge = null
  let plan = []
  if (useModel && !authMissing && options?.knowledge !== false && chapters.length >= 2) {
    push({ message: '构建知识点依赖图…', progress: 0.8 })
    try {
      const graphHash = createHash('sha256')
        .update(chapters.map((c) => c.title).join('|'))
        .update(texts.join('\n'))
        .digest('hex')
        .slice(0, 16)
      const cached = store.readKnowledge?.(graphHash)
      if (cached) {
        knowledge = cached
      } else {
        // Same idea as chapter summaries: a reasoning model that returns nothing
        // has spent the budget, so give it more room and less input before giving up.
        const ladder = [
          { maxTokens: 3600, chapterLimit: 12 },
          { maxTokens: 5200, chapterLimit: 8 },
          { maxTokens: 5200, chapterLimit: 6 },
        ]
        for (const step of ladder) {
          try {
            knowledge = await extractKnowledge({
              llm,
              provider: llm.provider,
              model: llm.model,
              courseTitle: outline.courseTitle,
              chapters,
              texts,
              signal,
              maxTokens: step.maxTokens,
              chapterLimit: step.chapterLimit,
            })
            if (knowledge) break
          } catch (error) {
            knowledge = null
          }
        }
      }
      if (!knowledge && chapters.length >= 2) {
        // model gave nothing: chapter order is still a true prerequisite chain
        knowledge = fallbackKnowledge(chapters)
        warnings.push('模型没有返回知识图，已按章节顺序生成兜底前置关系')
      }
      if (!knowledge) warnings.push('知识点依赖图：模型没有返回可用的概念，本次跳过前置校验')
      if (knowledge && !cached) store.writeKnowledge?.(graphHash, knowledge)
      if (knowledge) {
        const graph = createGraph(knowledge.concepts, knowledge.edges)
        job.knowledge = { hash: graphHash, ...knowledge.stats }
        job.plan = planChapters(chapters, graph, {}, 0.6)
        plan = job.plan
        telemetry.modelCalls += cached ? 0 : 1
      }
    } catch (error) {
      warnings.push(`知识点依赖图构建失败：${error.message}`)
    }
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
  let dashboardPath = ''
  try {
    const dashboardHtml = renderDashboardHtml({
      courseTitle: outline.courseTitle,
      chapters,
      plan,
      knowledge,
      byChapter: job.byChapter,
      meta: { model: modelLabel, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    })
    dashboardPath = store.writeDashboard(outline.courseTitle, dashboardHtml)
    job.dashboardPath = dashboardPath
  } catch (error) {
    warnings.push(`看板生成失败：${error.message}`)
  }

  const markdown = buildReport({
    courseTitle: outline.courseTitle,
    files: job.files,
    chapters,
    courseSummary,
    series: job.series,
    seriesLinks: job.seriesLinks,
    byChapter: job.byChapter,
    fallback: job.fallback,
    plan,
    knowledge,
    meta: {
      model: modelLabel,
      elapsedMs: job.elapsedMs,
      warnings,
      quality,
      domain: job.domain,
      offline: !useModel || chapters.every((c) => c.summary?.offline),
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      dashboardPath,
    },
  })
  const reportPath = store.writeReport(outline.courseTitle || 'course', markdown)
  // local Q&A needs the chapter bodies; keep them out of the job JSON
  try {
    store.saveSearchIndex?.(id, serializePassages(buildIndex(chapters, texts)))
  } catch {}
  store.rememberJobKey?.(dedupeKey, job.id)
  push({
    status: 'done',
    phase: 'done',
    message: `完成：${chapters.length} 章、${Object.values(job.byChapter).reduce((a, b) => a + (b.videos?.length || 0), 0)} 个视频`,
    progress: 1,
    markdown,
    reportPath,
    telemetry,
    elapsedMs: Date.now() - started,
  })
  return job
}

/* --------------------------- chapter-level rerun --------------------------- */

const bulletOf = (summary) => [
  ...(summary?.key_points || []).map((point) => ({ kind: '要点', text: pointText(point) })),
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

  const prepared = await prepareDocs({
    inputs,
    store,
    // replay exactly the OCR the first run used: the cache makes it instant, and
    // without it the chapter text (and therefore the numbering) would differ
    ocr: previous.ocr ? { enabled: true, engine: previous.ocr.engine, maxPages: previous.ocr.maxPages } : null,
    warnings,
    push,
  })
  const docs = prepared.docs
  job.files = prepared.files.length ? prepared.files : job.files
  job.inputs = manifestInputs(inputs, store)
  if (!docs.length) {
    push({ status: 'error', phase: 'error', error: '原文件无法再解析，请重新上传后重跑', progress: 1 })
    return job
  }

  // Replay the locked boundaries when they exist: changing the chaptering
  // algorithm must never renumber an existing job.
  const previousRow = (previous.chapters || []).find((c) => c.index === Number(chapterIndex))
  let target = null
  const locked = Array.isArray(previous.outline?.boundaries) ? previous.outline.boundaries : null
  if (locked && docs.length === 1) {
    const boundary = locked.find((b) => b.index === Number(chapterIndex)) || locked[Number(chapterIndex) - 1]
    if (boundary?.pages?.length) {
      const wanted = new Set(boundary.pages)
      const text = (docs[0].pages || [])
        .filter((p) => wanted.has(p.index))
        .map((p) => p.text)
        .join('\n\n')
      if (text) {
        target = {
          index: boundary.index,
          title: boundary.title || previousRow?.title || `第 ${boundary.index} 章`,
          subs: previousRow?.subs || [],
          pages: boundary.pages,
          text,
        }
      }
    }
  }
  let outline = null
  if (!target) {
    outline = buildOutline(docs)
    target =
      outline.chapters.find((c) => c.index === Number(chapterIndex)) || outline.chapters[Math.max(0, Number(chapterIndex) - 1)]
  }
  const chapterCount = (previous.chapters || []).length || outline?.chapters.length || 0
  if (!target) {
    push({ status: 'error', phase: 'error', error: `找不到第 ${chapterIndex} 章（当前共 ${chapterCount} 章）`, progress: 1 })
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
  const cacheKey = summaryCacheKey(target.text, { provider: llm?.provider, model: llm?.model, domain })
  if (llm) {
    try {
      summary = await summarizeWithRetry({
        llm,
        provider: llm.provider,
        model: llm.model,
        courseTitle: previous.courseTitle || outline?.courseTitle || '',
        chapter,
        text: target.text,
        outline: (previous.chapters || []).map((c) => c.title),
        domain,
        signal,
      })
      // a rerun deliberately bypasses the cache read, but the fresh answer is
      // worth keeping for the next full run
      await store.cache.set(cacheKey, structuredClone(summary), 30 * 86400 * 1000)
    } catch (error) {
      warnings.push(`第 ${target.index} 章重跑失败：${error.message}`)
      summary = { ...localSummary({ ...chapter, text: target.text }), offline: true, error: error.message }
    }
  } else {
    summary = { ...localSummary({ ...chapter, text: target.text }), offline: true }
  }
  // same assessment as the first run, otherwise the note disappears after a rerun
  applyAssessment({ summary, chapter, text: target.text, warnings })
  locatePages(chapter, summary, docs)
  job.telemetry = {
    chapters: (previous.chapters || []).length,
    modelCalls: summary.sourceChars ? 1 : 0,
    cacheHits: 0,
    sourceChars: summary.sourceChars || 0,
    keptChars: summary.keptChars || 0,
    chapterRerun: target.index,
  }

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
  // keep the local Q&A index in sync with the regenerated chapter
  try {
    store.patchSearchIndex?.(id, merged.index, serializePassages(buildIndex([merged], [target.text])))
  } catch {}

  if (options?.withVideos !== false && bili) {
    push({ message: `重新检索第 ${target.index} 章的 B 站网课…`, progress: 0.6 })
    try {
      // rebuild the topic from what the job already knows; the chapter bodies of
      // other chapters are not on disk, so their key points stand in for text
      const topic = buildTopicProfile({
        courseTitle: previous.courseTitle || outline?.courseTitle || '',
        keywords: (previous.chapters || []).flatMap((c) => c.summary?.keywords || []).concat(summary.keywords || []),
        texts: [
          (previous.chapters || []).map((c) => (c.summary?.key_points || []).map(pointText).join(' ')).join('\n'),
          target.text,
        ],
        domain,
      })
      const keywords = cleanKeywords(summary.keywords || [], 3)
      const res = await bili.recommendChapter(keywords, {
        domain,
        chapterTitle: target.title,
        topic,
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
            parts: v.partCount || 0,
            bestPart: v.bestPart || null,
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
    courseTitle: previous.courseTitle || outline?.courseTitle || '',
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
  const reportPath = store.writeReport(previous.courseTitle || outline?.courseTitle || 'course', markdown)
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
