/**
 * Host half of @local/course-assistant.
 *
 * Responsibilities:
 *   • same-origin HTTP routes the panel calls (upload / run / poll / report)
 *   • one agent tool sharing the exact same pipeline
 *   • no state outside this machine: uploads, cache and reports live under
 *     `<DSH_HOME>/course-assistant` (config `dataDir` overrides it)
 *
 * The model is reached through the Host `llm` service, so the plugin uses the
 * profile's configured provider/model and never needs an API key of its own.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from 'schemastery'
import { createStore, resolveDataDir } from './core/store.js'
import { createBiliClient } from './core/bili.js'
import { runPipeline, rerunChapter } from './core/pipeline.js'
import { ocrAvailable, ocrStatus } from './core/ocr.js'
import { pointText } from './core/verify.js'
import { ask, indexFromPassages } from './core/search.js'
import { coverage, parseSyllabus } from './core/coverage.js'
import { parseFile } from './core/parser.js'
import { markdownToDocx } from './core/docx.js'
import { SUPPORTED } from './core/parser.js'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  } catch {
    return { version: String(0) }
  }
})()

export const name = 'course-assistant'
export const inject = ['tools', 'webServer']

/**
 * Every knob the panel and the tool read, validated at activation. A bad value
 * fails the plugin loudly instead of starting half-configured.
 * Precedence for every field: request option > this config > built-in default.
 */
export const Config = Schema.object({
  dataDir: Schema.string().default('').description('上传/缓存/报告目录，留空用 <DSH_HOME>/course-assistant'),
  concurrency: Schema.natural().min(1).max(5).default(4).description('并行章节数'),
  withVideos: Schema.boolean().default(true).description('默认是否检索 B 站网课'),
  images: Schema.string().default('ocr').description('幻灯片图片 OCR：ocr 读取图片文字，off 关闭'),
  imagesMax: Schema.natural().default(40).description('每份课件最多 OCR 的图片数'),
  coverage: Schema.string().default('auto').description('要点覆盖：auto 自动，fast 不分节提示（最省），thorough 逐节摘要（每章最多 4 次调用）'),
  reportStyle: Schema.union([Schema.const('brief'), Schema.const('review')])
    .default('brief')
    .description('报告形态：brief 要点式学习报告；review 复习资料（模块/知识点/实例/习题+参考答案，token 约 2-3 倍）'),
  vision: Schema.string().default('').description('多模态模型（预留，留空关闭）'),
  domain: Schema.string().default('').description('强制课程领域（如 C++），留空自动识别'),
  ocrMaxPages: Schema.natural().min(1).max(400).default(60).description('OCR 重读页数上限（页级分诊选出的页，按文档顺序）'),
  ocrMode: Schema.union([Schema.const('auto'), Schema.const('all'), Schema.const('off')])
    .default('auto')
    .description('PDF 页级 OCR：auto 只重读文字层不可用的页，all 整份重读，off 关闭'),
  ocrPick: Schema.union([Schema.const('first'), Schema.const('best')])
    .default('first')
    .description('OCR 引擎择优：first 只用首选引擎，best 对低分页再用第二引擎复读并取高分（耗时翻倍）'),
  ocrEngine: Schema.union([Schema.const(''), Schema.const('windows'), Schema.const('rapidocr')])
    .default('')
    .description('OCR 引擎，留空自动选择'),
  ocrPython: Schema.string().default('').description('rapidocr 用的 python 可执行文件'),
  provider: Schema.string().default('').description('摘要模型 provider，留空跟随默认模型'),
  model: Schema.string().default('').description('摘要模型名，留空跟随默认模型'),
  spacingMs: Schema.natural().min(1000).max(60000).default(1000).description('B 站请求间隔（毫秒）'),
  keepUploadsDays: Schema.natural().min(1).max(90).default(7).description('上传文件保留天数'),
})

const ROUTE = '/course-assistant'
const MAX_UPLOAD = 60 * 1024 * 1024
const HEARTBEAT_MS = 15_000
const STALE_MS = 90_000
const BOOT_ID = randomUUID()
const text = (s) => [{ type: 'text', text: s }]

const csvCell = (value) => `"${String(value ?? '').replace(/\r/g, '').replace(/"/g, '""')}"`

/** Anki: one card per key point, back side carries the chapter, page and quote. */
export function buildAnkiCsv(job) {
  const rows = [['front', 'back', 'tags'].map(csvCell).join(',')]
  const tags = `课程助手 ${job.courseTitle || ''}`.trim()
  for (const chapter of job.chapters || []) {
    for (const point of chapter.summary?.key_points || []) {
      const front = pointText(point)
      if (!front) continue
      const page = point.page ? `（p.${point.page}）` : ''
      const evidence = point.evidence ? `\n原文：${point.evidence}` : ''
      rows.push([csvCell(front), csvCell(`${chapter.title}${page}${evidence}`), csvCell(tags)].join(','))
    }
  }
  // BOM so Excel on Windows reads it as UTF-8; Anki ignores it
  return `\uFEFF${rows.join('\r\n')}\r\n`
}

/** Interop document other plugins can read without parsing the markdown report. */
export function buildCourseJson(job) {
  return JSON.stringify(
    {
      schema: 'dsh-course-assistant/course@1',
      generatedAt: new Date().toISOString(),
      courseTitle: job.courseTitle || '',
      files: (job.files || []).map((f) => f.name),
      domain: job.domain || null,
      chapters: (job.chapters || []).map((c) => ({
        index: c.index,
        title: c.title,
        pages: c.pages || [],
        keywords: c.summary?.keywords || [],
        confidence: c.confidence?.tier || null,
        keyPoints: (c.summary?.key_points || []).map((p) => ({
          text: pointText(p),
          page: p?.page ?? null,
          evidence: p?.evidence || '',
        })),
        important: c.summary?.important || [],
        difficult: c.summary?.difficult || [],
      })),
    },
    null,
    2,
  )
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, code, body, headers = {}) {
  try {
    res.statusCode = code
    res.setHeader('content-type', headers['content-type'] || 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    for (const [k, v] of Object.entries(headers)) {
      if (k !== 'content-type') res.setHeader(k, v)
    }
    // strings (markdown) go out verbatim; objects are JSON-encoded
    const payload = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'utf8') : JSON.stringify(body)
    res.end(payload)
  } catch {}
}

export function apply(ctx, config = {}) {
  const store = createStore(resolveDataDir(config.dataDir))
  store.pruneUploads(config.keepUploadsDays ?? 7)
  try {
    store.pruneReports(90)
    store.cache.prune(500)
  } catch {}
  const bili = createBiliClient({
    cache: store.cache,
    spacingMs: Number(config.spacingMs) || 1000,
    log: (m) => ctx.logger?.info?.(m),
  })
  const jobs = new Map()
  const jobInputs = new Map()
  const uploads = new Map()
  const disposers = []

  const pick = (value) => (value === '' || value == null ? undefined : value)
  // precedence is the same for every field: request option > config > default
  const optionsOf = (raw = {}) => ({
    withVideos: raw.withVideos !== false && config.withVideos !== false,
    concurrency: Math.max(1, Math.min(5, Number(raw.concurrency) || Number(config.concurrency) || 4)),
    ocr: raw.ocr === true,
    ocrMaxPages: Number(raw.ocrMaxPages) || Number(config.ocrMaxPages) || 60,
    ocrMode: String(pick(raw.ocrMode) || pick(config.ocrMode) || 'auto'),
    ocrPick: String(pick(raw.ocrPick) || pick(config.ocrPick) || 'first'),
    ocrEngine: pick(raw.ocrEngine) || pick(config.ocrEngine),
    ocrPython: pick(raw.ocrPython) || pick(config.ocrPython),
    domain: pick(raw.domain) || pick(config.domain),
    images: {
      mode: String(pick(raw.images) || pick(config.images) || 'ocr'),
      max: Number(pick(raw.imagesMax) ?? pick(config.imagesMax) ?? 40) || 40,
      engine: pick(raw.imagesEngine),
    },
    coverage: String(pick(raw.coverage) || pick(config.coverage) || 'auto'),
    reportStyle: String(pick(raw.reportStyle) || pick(config.reportStyle) || 'brief'),
    vision: pick(raw.vision) || pick(config.vision) || '',
  })

  function resolveLlm() {
    const svc = ctx.get('llm')
    if (!svc) return null
    let provider = pick(config.provider)
    let model = pick(config.model)
    if (!provider || !model) {
      try {
        const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
        provider = provider || sel?.provider
        model = model || sel?.model
      } catch {}
    }
    if (!provider || !model) return null
    return { provider, model, stream: (options) => svc.stream(options) }
  }

  /**
   * .ppt/.doc are OLE compound files our parser does not read. The profile's
   * officeToPdf service converts them to PDF, which we already parse — cheaper
   * and more faithful than writing two more binary parsers.
   */
  const LEGACY_EXT = new Set(['ppt', 'doc', 'xls'])

  async function prepareInputs(inputs) {
    const office = ctx.get('officeToPdf')
    if (!office?.convert) return inputs
    const prepared = []
    for (const input of inputs) {
      const ext = String(input.name || input.path).split('.').pop().toLowerCase()
      if (!LEGACY_EXT.has(ext)) {
        prepared.push(input)
        continue
      }
      try {
        const bytes = readFileSync(input.path)
        const result = await office.convert({
          extension: ext,
          priority: 'foreground',
          source: {
            key: `course-assistant:${basename(input.path)}:${bytes.length}`,
            version: String(bytes.length),
            bytes: bytes.length,
            read: async () => ({ bytes, version: String(bytes.length) }),
          },
        })
        const target = join(store.uploadsDir, `${randomUUID().slice(0, 8)}-${basename(input.name).replace(/\.[^.]+$/, '')}.pdf`)
        store.writeBytes(target, Buffer.from(result.pdf))
        // keep the original display name: the report should say "x.ppt", not "x.pdf"
        prepared.push({ ...input, path: target, convertedFrom: ext })
        ctx.logger?.info?.(`converted ${input.name} (.${ext}) to PDF for parsing`)
      } catch (error) {
        ctx.logger?.warn?.(`legacy conversion failed for ${input.name}: ${error.message}`)
        prepared.push({ ...input, convertError: error.message })
      }
    }
    return prepared
  }

  /* ------------------------ heartbeat + zombie reaper ------------------------ */

  const heartbeats = new Map()

  const stopHeartbeat = (id) => {
    const timer = heartbeats.get(id)
    if (timer) clearInterval(timer)
    heartbeats.delete(id)
  }

  /**
   * A single chapter can run longer than a minute, so the beat cannot ride on
   * push(): an independent timer renews it. `owner` lets a second Host instance
   * on the same machine check pid liveness instead of declaring a false death.
   */
  const startHeartbeat = (id) => {
    stopHeartbeat(id)
    // stamp immediately: a crash inside the first interval must still look recent
    const seedJob = jobs.get(id)
    if (seedJob) {
      seedJob.heartbeatAt = Date.now()
      seedJob.owner = { pid: process.pid, hostname: hostname(), bootId: BOOT_ID }
    }
    const timer = setInterval(() => {
      const job = jobs.get(id)
      if (!job || job.status !== 'running') return stopHeartbeat(id)
      job.heartbeatAt = Date.now()
      job.owner = { pid: process.pid, hostname: hostname(), bootId: BOOT_ID }
      try {
        store.saveJob(job)
      } catch {}
    }, HEARTBEAT_MS)
    timer.unref?.()
    heartbeats.set(id, timer)
  }

  const finishJob = (id, job) => {
    jobs.set(id, job)
    stopHeartbeat(id)
  }

  /** Jobs left `running` by a dead process must not poll forever. */
  function reapZombies() {
    const now = Date.now()
    let reaped = 0
    for (const { id } of store.listJobs(300)) {
      if (jobs.has(id)) continue
      let job
      try {
        job = store.loadJob(id)
      } catch {
        continue
      }
      if (!job || job.status !== 'running') continue
      const beat = Number(job.heartbeatAt || 0) || Date.parse(job.createdAt || '') || 0
      if (now - beat <= STALE_MS) continue
      const owner = job.owner
      if (owner?.hostname === hostname() && Number.isInteger(owner.pid)) {
        let alive = false
        try {
          process.kill(owner.pid, 0)
          alive = true
        } catch {}
        if (alive) continue
      }
      const dead = {
        ...job,
        status: 'interrupted',
        phase: 'interrupted',
        error: '进程重启，任务已中断（可重新运行）',
        interruptedAt: new Date().toISOString(),
      }
      jobs.set(id, dead)
      store.saveJob(dead)
      reaped += 1
    }
    return reaped
  }

  async function makeJob(inputs, options) {
    const prepared = await prepareInputs(inputs)
    inputs = prepared
    const id = randomUUID().slice(0, 8)
    const job = {
      id,
      status: 'running',
      phase: 'queued',
      message: '排队中…',
      progress: 0,
      files: inputs.map((f) => ({ name: f.name })),
      chapters: [],
      byChapter: {},
      series: [],
      warnings: [],
    }
    jobs.set(id, job)
    jobInputs.set(id, inputs)
    store.touchUploads(inputs.map((f) => f.uploadId).filter(Boolean))
    startHeartbeat(id)
    const llm = resolveLlm()
    runPipeline({
      id,
      inputs,
      options,
      deps: { store, bili, llm },
      emit: (next) => {
        jobs.set(id, next)
      },
    })
      .then((final) => {
        finishJob(id, final)
      })
      .catch((error) => {
        finishJob(id, {
          ...(jobs.get(id) || job),
          status: 'error',
          phase: 'error',
          error: String(error?.message || error),
          progress: 1,
        })
        store.saveJob(jobs.get(id))
        ctx.logger?.warn?.(`[course-assistant] job ${id} failed: ${error?.stack || error}`)
      })
    return job
  }

  /**
   * Rerun one chapter of a finished job: the parse + outline are replayed to
   * recover that chapter's text, the summary is regenerated with the cache
   * bypassed, and the report is rebuilt. Everything else is carried over.
   */
  async function makeRerunJob(previous, inputs, chapterIndex, options) {
    const id = randomUUID().slice(0, 8)
    const seed = {
      ...previous,
      id,
      status: 'running',
      phase: 'rerun',
      message: `重跑第 ${chapterIndex} 章…`,
      progress: 0.05,
      error: '',
    }
    jobs.set(id, seed)
    jobInputs.set(id, inputs)
    store.touchUploads(inputs.map((f) => f.uploadId).filter(Boolean))
    startHeartbeat(id)
    rerunChapter({
      id,
      inputs,
      previous,
      chapterIndex,
      options,
      deps: { store, bili, llm: resolveLlm() },
      emit: (next) => jobs.set(id, next),
    })
      .then((final) => {
        finishJob(id, final)
      })
      .catch((error) => {
        finishJob(id, { ...seed, status: 'error', phase: 'error', error: String(error?.message || error), progress: 1 })
        store.saveJob(jobs.get(id))
        ctx.logger?.warn?.(`[course-assistant] rerun ${id} failed: ${error?.stack || error}`)
      })
    return seed
  }

  /**
   * Recover the inputs of a job after a restart: the in-memory map is gone, but
   * job.inputs carries dataDir-relative paths. A pruned upload is reported by
   * name (410), never as a generic "task not found".
   */
  function restoreInputs(jobId) {
    const previous = jobs.get(jobId) || store.loadJob(jobId)
    const rows = previous?.inputs
    if (!Array.isArray(rows) || !rows.length) return { error: '原任务缺少输入清单（旧版本任务），请重新拖入文件' }
    const inputs = []
    for (const row of rows) {
      const path = isAbsolute(row.path) ? row.path : join(store.dataDir, row.path)
      if (!existsSync(path)) {
        return {
          error: `上传文件已过期（保留 ${config.keepUploadsDays ?? 7} 天）：${row.name}，请重新拖入`,
          missing: row.name,
        }
      }
      inputs.push({ path, name: row.name, uploadId: row.uploadId })
    }
    return { inputs, previous }
  }

  async function exportPdf(job) {
    if (job.pdfPath && existsSync(job.pdfPath)) return job.pdfPath
    const office = ctx.get('officeToPdf')
    if (!office?.convert) throw new Error('PDF 导出不可用：当前 profile 未提供 officeToPdf 服务')
    const markdown = job.markdown || (job.reportPath && existsSync(job.reportPath) ? readFileSync(job.reportPath, 'utf8') : '')
    if (!markdown) throw new Error('报告尚未生成')
    const docx = markdownToDocx(markdown, `《${job.courseTitle || '课程'}》学习报告`)
    const version = String(job.createdAt || Date.now())
    const result = await office.convert({
      extension: 'docx',
      priority: 'foreground',
      source: {
        key: `course-assistant:${job.id}`,
        version,
        bytes: docx.length,
        read: async () => ({ bytes: docx, version }),
      },
    })
    const pdfPath = (job.reportPath || join(store.reportsDir, `course-${job.id}.md`)).replace(/\.md$/, '.pdf')
    store.writeBytes(pdfPath, Buffer.from(result.pdf))
    job.pdfPath = pdfPath
    store.saveJob(job)
    return pdfPath
  }

  /* ------------------------------- routes ------------------------------- */

  const routeHandler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (path === `${ROUTE}/health`) {
        return send(res, 200, {
          ok: true,
          version: PKG.version || 'unknown',
          llm: !!resolveLlm(),
          pdf: !!ctx.get('officeToPdf')?.convert,
          ocr: ocrAvailable(),
          ocrEngines: await ocrStatus(),
          ocrMode: String(config.ocrMode || 'auto'),
          ocrPick: String(config.ocrPick || 'first'),
          reportStyle: String(config.reportStyle || 'brief'),
          dataDir: store.dataDir,
          supported: [...SUPPORTED, '.ppt', '.doc', '.xls'],
          jobs: jobs.size,
        })
      }

      if (path === `${ROUTE}/history`) {
        const limit = Number(url.searchParams.get('limit')) || 20
        return send(res, 200, { ok: true, jobs: store.listHistory?.(limit) || [] })
      }

      if (path === `${ROUTE}/upload` && req.method === 'POST') {
        const rawName = url.searchParams.get('name') || 'file'
        const name = basename(decodeURIComponent(rawName))
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
        // legacy Office files are accepted and converted to PDF before parsing
        if (!SUPPORTED.includes(ext) && !LEGACY_EXT.has(ext.slice(1))) {
          return send(res, 400, { ok: false, reason: `不支持的文件类型：${ext || '(无扩展名)'}` })
        }
        const body = await readBody(req)
        if (!body.length) return send(res, 400, { ok: false, reason: '空文件' })
        const saved = store.saveUpload(body, name)
        uploads.set(saved.id, saved)
        return send(res, 200, { ok: true, file: { id: saved.id, name: saved.name, bytes: saved.bytes, sha256: saved.sha256 } })
      }

      if (path === `${ROUTE}/run` && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}')
        const list = Array.isArray(body.files) ? body.files : []
        if (!list.length) return send(res, 400, { ok: false, reason: '没有待处理文件' })
        const inputs = []
        for (const item of list) {
          const id = typeof item === 'string' ? item : item.id
          const saved = uploads.get(id)
          if (!saved || !existsSync(saved.path)) {
            return send(res, 400, { ok: false, reason: `上传文件已失效：${id}` })
          }
          inputs.push({ path: saved.path, name: saved.name, uploadId: saved.id })
        }
        if (inputs.length > 12) return send(res, 400, { ok: false, reason: '一次最多处理 12 个文件' })
        const job = await makeJob(inputs, optionsOf(body.options))
        return send(res, 200, { ok: true, jobId: job.id })
      }

      if (path === `${ROUTE}/rerun` && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8') || '{}')
        let inputs = jobInputs.get(body.jobId)
        if (!inputs?.length) {
          // after a restart the in-memory map is empty: rebuild from the manifest
          const restored = restoreInputs(body.jobId)
          if (restored.error) {
            return send(res, restored.missing ? 410 : 404, { ok: false, reason: restored.error })
          }
          inputs = restored.inputs
          jobInputs.set(body.jobId, inputs)
        }
        const chapterIndex = Number(body.chapterIndex)
        if (chapterIndex > 0) {
          const previous = jobs.get(body.jobId) || store.loadJob(body.jobId)
          if (!previous) return send(res, 404, { ok: false, reason: '原任务不存在' })
          if (!(previous.chapters || []).length) return send(res, 400, { ok: false, reason: '原任务还没有章节目录，先完整跑一次' })
          const job = await makeRerunJob(previous, inputs, chapterIndex, optionsOf(body.options))
          return send(res, 200, { ok: true, jobId: job.id, chapterIndex })
        }
        const job = await makeJob(inputs, optionsOf(body.options))
        return send(res, 200, { ok: true, jobId: job.id })
      }

      if (path === `${ROUTE}/job` && req.method === 'GET') {
        const id = url.searchParams.get('id')
        const job = jobs.get(id) || (id && store.loadJob(id))
        if (!job) return send(res, 404, { ok: false, reason: '任务不存在' })
        const { markdown, ...rest } = job
        return send(res, 200, { ok: true, job: { ...rest, hasReport: !!job.reportPath } })
      }

      if (path === `${ROUTE}/job` && req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (!id) return send(res, 400, { ok: false, reason: '缺少 id' })
        const job = jobs.get(id) || store.loadJob(id)
        if (!job) return send(res, 404, { ok: false, reason: '任务不存在' })
        stopHeartbeat(id)
        jobs.delete(id)
        jobInputs.delete(id)
        store.deleteJob(id, url.searchParams.get('withReport') === '1' ? job : null)
        return send(res, 200, { ok: true, deleted: id })
      }

      if (path === `${ROUTE}/report` && req.method === 'GET') {
        const id = url.searchParams.get('id')
        const format = (url.searchParams.get('format') || 'md').toLowerCase()
        const job = jobs.get(id) || (id && store.loadJob(id))
        if (!job) return send(res, 404, { ok: false, reason: '任务不存在' })
        if (format === 'csv' || format === 'json') {
          const body = format === 'csv' ? buildAnkiCsv(job) : buildCourseJson(job)
          return send(res, 200, body, {
            'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${job.courseTitle || job.id}.${format}`)}`,
          })
        }
        let markdown = job.markdown
        if (!markdown && job.reportPath && existsSync(job.reportPath)) markdown = readFileSync(job.reportPath, 'utf8')
        if (!markdown) return send(res, 404, { ok: false, reason: '报告尚未生成' })
        const stem = `课程学习报告-${(job.courseTitle || job.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}`
        if (format === 'pdf') {
          const pdfPath = await exportPdf({ ...job, markdown })
          return send(res, 200, readFileSync(pdfPath), {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${stem}.pdf`)}`,
          })
        }
        return send(res, 200, markdown, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${stem}.md`)}`,
        })
      }

      if (path === `${ROUTE}/ask` && req.method === 'GET') {
        const id = url.searchParams.get('id')
        const question = (url.searchParams.get('q') || '').trim()
        if (!id || !question) return send(res, 400, { ok: false, reason: '缺少 id 或 q' })
        const rows = store.loadSearchIndex(id)
        if (!rows?.length) return send(res, 404, { ok: false, reason: '该任务还没有可检索的内容（先完整跑一次）' })
        const { answers, hint } = ask(indexFromPassages(rows), question)
        return send(res, 200, { ok: true, question, answers, hint })
      }

      if (path === `${ROUTE}/library` && req.method === 'GET') {
        const rows = store.listJobs(20).map(({ id, mtime }) => {
          const job = jobs.get(id) || store.loadJob(id)
          return {
            id,
            updatedAt: new Date(mtime).toISOString(),
            courseTitle: job?.courseTitle || '',
            status: job?.status || 'unknown',
            chapters: job?.chapters?.length || 0,
            report: !!job?.reportPath,
          }
        })
        return send(res, 200, { ok: true, jobs: rows })
      }

      return send(res, 404, { ok: false, reason: 'not found' })
    } catch (error) {
      return send(res, 500, { ok: false, reason: String(error?.message || error) })
    }
  }

  try {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: routeHandler }))
  } catch (error) {
    ctx.logger?.warn?.(`[course-assistant] route unavailable: ${error}`)
  }

  // A previous process may have died mid-run; mark those jobs before the panel
  // starts polling them (otherwise it polls a `running` job forever).
  try {
    const reaped = reapZombies()
    if (reaped) ctx.logger?.info?.(`[course-assistant] ${reaped} interrupted job(s) marked as zombie`)
  } catch (error) {
    ctx.logger?.warn?.(`[course-assistant] zombie scan failed: ${error.message}`)
  }

  /* -------------------------------- tools -------------------------------- */

  const toolText = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const output = (schema) => ({ schema, render: (_args, value) => toolText(value) })

  disposers.push(
    ctx.tools.register({
      name: 'course_assistant',
      description:
        '课程文件学习助手：把 .pptx/.pdf/.docx/.md/.txt 转成学习报告（课程目录、分章知识点与重难点、全课程总结，附录 B 站网课推荐）。' +
        'action=analyze 分析给定文件（files 为工作区路径，可多个）；action=status 查询任务进度（jobId）；' +
        'action=library 列出历史报告；action=rerun 重跑整份任务或某一章（jobId + 可选 chapterIndex）；' +
        'action=export 导出报告（jobId + format=md|pdf）；action=health 查看模型/OCR/版本状态；' +
        'action=ask 用本地 BM25 在课件里检索并给出带页码的原文片段（jobId + question）；' +
        'action=coverage 对照考纲算覆盖率（jobId + files[0] 为考纲文件）；' +
        'action=append 把新课件追加到已有课程（jobId + files），未变的章节命中缓存不重算。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['analyze', 'status', 'library', 'rerun', 'export', 'health', 'ask', 'coverage', 'append'], description: '操作类型' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '课程文件路径（绝对路径或相对当前工作目录）',
          },
          jobId: { type: 'string', description: 'status / rerun / export / ask 使用的任务 id' },
          chapterIndex: { type: 'number', description: 'rerun 时只重跑这一章（从 1 开始），省略则整份重跑' },
          format: { type: 'string', enum: ['md', 'pdf', 'csv', 'json'], description: 'export 的格式，默认 md' },
          question: { type: 'string', description: 'ask 的问题（中文即可）' },
          withVideos: { type: 'boolean', description: '是否检索 B 站网课，默认 true' },
          reportStyle: {
            type: 'string',
            enum: ['brief', 'review'],
            description: 'brief 要点式学习报告（默认）；review 复习资料（模块/知识点/实例/习题+参考答案）',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output({ type: 'object', additionalProperties: true }),
      async execute(args = {}) {
        if (args.action === 'ask') {
          const rows = store.loadSearchIndex(args.jobId)
          if (!rows?.length) return { ok: false, reason: '该任务还没有可检索的内容（先完整跑一次）' }
          const { answers, hint } = ask(indexFromPassages(rows), args.question || '')
          return { ok: true, jobId: args.jobId, question: args.question || '', answers, hint }
        }
        if (args.action === 'health') {
          return {
            ok: true,
            version: PKG.version || 'unknown',
            llm: !!resolveLlm(),
            pdf: !!ctx.get('officeToPdf')?.convert,
            ocrEngines: await ocrStatus(),
            dataDir: store.dataDir,
          }
        }
        if (args.action === 'export') {
          const job = jobs.get(args.jobId) || (args.jobId && store.loadJob(args.jobId))
          if (!job) return { ok: false, reason: '任务不存在' }
          const format = ['pdf', 'csv', 'json'].includes(args.format) ? args.format : 'md'
          if (format === 'csv') return { ok: true, jobId: job.id, format: 'csv', content: buildAnkiCsv(job) }
          if (format === 'json') return { ok: true, jobId: job.id, format: 'json', content: buildCourseJson(job) }
          if (format === 'md') {
            const markdown = job.markdown || (job.reportPath ? readFileSync(job.reportPath, 'utf8') : '')
            if (!markdown) return { ok: false, reason: '报告尚未生成' }
            return { ok: true, jobId: job.id, format: 'md', reportPath: job.reportPath || '' }
          }
          const refreshed = job.markdown ? job : { ...job, markdown: job.reportPath ? readFileSync(job.reportPath, 'utf8') : '' }
          try {
            const pdfPath = await exportPdf(refreshed)
            return { ok: true, jobId: job.id, format: 'pdf', reportPath: pdfPath }
          } catch (error) {
            return { ok: false, reason: error.message }
          }
        }
        if (args.action === 'rerun') {
          const previous = jobs.get(args.jobId) || (args.jobId && store.loadJob(args.jobId))
          if (!previous) return { ok: false, reason: '任务不存在' }
          const inputs = jobInputs.get(args.jobId) || restoreInputs(args.jobId).inputs
          if (!inputs?.length) return { ok: false, reason: restoreInputs(args.jobId).error || '原任务的上传文件已过期' }
          const chapterIndex = Number(args.chapterIndex) || 0
          const job = chapterIndex > 0
            ? await makeRerunJob(previous, inputs, chapterIndex, optionsOf({ withVideos: args.withVideos, reportStyle: args.reportStyle }))
            : await makeJob(inputs, optionsOf({ withVideos: args.withVideos, reportStyle: args.reportStyle }))
          return { ok: true, jobId: job.id, chapterIndex: chapterIndex || null, status: job.status }
        }
        if (args.action === 'status') {
          const job = jobs.get(args.jobId) || (args.jobId && store.loadJob(args.jobId))
          if (!job) return { ok: false, reason: '任务不存在' }
          return {
            ok: true,
            jobId: job.id,
            status: job.status,
            phase: job.phase,
            message: job.message,
            progress: job.progress,
            chapters: job.chapters?.length || 0,
            reportPath: job.reportPath || '',
            error: job.error || '',
          }
        }
        if (args.action === 'coverage') {
          const job = jobs.get(args.jobId) || (args.jobId && store.loadJob(args.jobId))
          if (!job) return { ok: false, reason: '任务不存在' }
          const target = (Array.isArray(args.files) ? args.files.filter(Boolean) : [])[0]
          if (!target) return { ok: false, reason: '请给出考纲文件路径（files[0]）' }
          if (!existsSync(target)) return { ok: false, reason: `文件不存在：${target}` }
          try {
            const doc = parseFile(String(target), basename(String(target)))
            // markdown/docx put the body in blocks, pdf/pptx in pages
            const body =
              doc.text ||
              (doc.blocks || []).map((b) => `${b.title}\n${b.text}`).join('\n\n') ||
              (doc.pages || []).map((p) => p.text).join('\n\n')
            const result = coverage(job.chapters || [], parseSyllabus(body, { ignore: [doc.title, basename(String(target))] }))
            return { ok: true, jobId: job.id, syllabus: basename(String(target)), ...result }
          } catch (error) {
            return { ok: false, reason: `考纲解析失败：${error.message}` }
          }
        }
        if (args.action === 'append') {
          const previous = jobs.get(args.jobId) || (args.jobId && store.loadJob(args.jobId))
          if (!previous) return { ok: false, reason: '任务不存在' }
          const restored = restoreInputs(args.jobId)
          if (restored.error) return { ok: false, reason: restored.error }
          const extra = (Array.isArray(args.files) ? args.files.filter(Boolean) : []).map((file) => ({
            path: String(file),
            name: basename(String(file)),
          }))
          for (const file of extra) {
            if (!existsSync(file.path)) return { ok: false, reason: `文件不存在：${file.path}` }
          }
          if (!extra.length) return { ok: false, reason: '请给出新增课件路径（files）' }
          const job = await makeJob([...restored.inputs, ...extra], optionsOf({ withVideos: args.withVideos }))
          // unchanged chapters hit the summary cache, so only new material costs
          const created = jobs.get(job.id)
          if (created) created.appendedFrom = previous.id
          return { ok: true, jobId: job.id, appendedFrom: previous.id, files: restored.inputs.length + extra.length }
        }
        if (args.action === 'library') {
          return {
            ok: true,
            jobs: store.listJobs(20).map(({ id, mtime }) => {
              const job = jobs.get(id) || store.loadJob(id)
              return { id, updatedAt: new Date(mtime).toISOString(), courseTitle: job?.courseTitle || '', status: job?.status || 'unknown' }
            }),
          }
        }

        const files = Array.isArray(args.files) ? args.files.filter(Boolean) : []
        if (!files.length) return { ok: false, reason: '请提供 files（至少一个课程文件路径）' }
        const inputs = []
        for (const f of files) {
          const path = String(f)
          if (!existsSync(path)) return { ok: false, reason: `文件不存在：${path}` }
          const stat = statSync(path)
          if (!stat.isFile()) return { ok: false, reason: `不是文件：${path}` }
          if (stat.size > MAX_UPLOAD) return { ok: false, reason: `文件过大（>60MB）：${path}` }
          inputs.push({ path, name: basename(path) })
        }
        const job = await makeJob(inputs, optionsOf({ withVideos: args.withVideos, reportStyle: args.reportStyle }))
        // wait for completion so the agent gets the result in one call
        const deadline = Date.now() + 150000
        let current = jobs.get(job.id)
        while (current?.status === 'running' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 700))
          current = jobs.get(job.id)
        }
        if (!current || current.status === 'running') {
          return { ok: true, jobId: job.id, status: 'running', message: '仍在处理，可用 action=status 查询', progress: current?.progress || 0 }
        }
        if (current.status === 'error') return { ok: false, jobId: job.id, reason: current.error || '分析失败' }
        const markdown = current.markdown || (current.reportPath ? readFileSync(current.reportPath, 'utf8') : '')
        return {
          ok: true,
          jobId: current.id,
          courseTitle: current.courseTitle,
          chapters: (current.chapters || []).map((c) => ({
            index: c.index,
            title: c.title,
            keyPoints: c.summary?.key_points || [],
            important: c.summary?.important || [],
            difficult: c.summary?.difficult || [],
          })),
          courseSummary: current.courseSummary || '',
          videos: Object.fromEntries(
            Object.entries(current.byChapter || {}).map(([k, v]) => [k, (v.videos || []).map((x) => `${x.title} <${x.url}>`)]),
          ),
          series: (current.series || []).map((s) => `${s.title} <${s.url}>`),
          reportPath: current.reportPath,
          elapsedMs: current.elapsedMs,
          warnings: current.warnings,
          reportPreview: markdown.slice(0, 1500),
        }
      },
    }),
  )

  ctx.effect?.(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {}
    }
    try {
      store.cache.flush()
    } catch {}
  })
}
