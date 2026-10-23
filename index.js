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
import { basename, join } from 'node:path'
import { createStore, resolveDataDir } from './core/store.js'
import { createBiliClient } from './core/bili.js'
import { runPipeline } from './core/pipeline.js'
import { markdownToDocx } from './core/docx.js'
import { SUPPORTED } from './core/parser.js'

export const name = 'course-assistant'
export const inject = ['tools', 'webServer']

const ROUTE = '/course-assistant'
const MAX_UPLOAD = 60 * 1024 * 1024
const text = (s) => [{ type: 'text', text: s }]

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
  const bili = createBiliClient({
    cache: store.cache,
    spacingMs: Number(config.spacingMs) || 1000,
    log: (m) => ctx.logger?.info?.(m),
  })
  const jobs = new Map()
  const uploads = new Map()
  const disposers = []

  const optionsOf = (raw = {}) => ({
    withVideos: raw.withVideos !== false && config.withVideos !== false,
    concurrency: Math.max(1, Math.min(5, Number(raw.concurrency) || Number(config.concurrency) || 4)),
  })

  function resolveLlm() {
    const svc = ctx.get('llm')
    if (!svc) return null
    let provider = config.provider
    let model = config.model
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

  async function makeJob(inputs, options) {
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
        jobs.set(id, final)
      })
      .catch((error) => {
        const failed = { ...(jobs.get(id) || job), status: 'error', phase: 'error', error: String(error?.message || error), progress: 1 }
        jobs.set(id, failed)
        store.saveJob(failed)
        ctx.logger?.warn?.(`[course-assistant] job ${id} failed: ${error?.stack || error}`)
      })
    return job
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
          version: '1.1.1',
          llm: !!resolveLlm(),
          pdf: !!ctx.get('officeToPdf')?.convert,
          dataDir: store.dataDir,
          supported: SUPPORTED,
          jobs: jobs.size,
        })
      }

      if (path === `${ROUTE}/upload` && req.method === 'POST') {
        const rawName = url.searchParams.get('name') || 'file'
        const name = basename(decodeURIComponent(rawName))
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
        if (!SUPPORTED.includes(ext)) {
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
          inputs.push({ path: saved.path, name: saved.name })
        }
        if (inputs.length > 12) return send(res, 400, { ok: false, reason: '一次最多处理 12 个文件' })
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

      if (path === `${ROUTE}/report` && req.method === 'GET') {
        const id = url.searchParams.get('id')
        const format = (url.searchParams.get('format') || 'md').toLowerCase()
        const job = jobs.get(id) || (id && store.loadJob(id))
        if (!job) return send(res, 404, { ok: false, reason: '任务不存在' })
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

  /* -------------------------------- tools -------------------------------- */

  const toolText = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const output = (schema) => ({ schema, render: (_args, value) => toolText(value) })

  disposers.push(
    ctx.tools.register({
      name: 'course_assistant',
      description:
        '课程文件学习助手：把 .pptx/.pdf/.docx/.md/.txt 转成学习报告（课程目录、分章知识点与重难点、全课程总结，附录 B 站网课推荐）。' +
        'action=analyze 分析给定文件（files 为工作区路径，可多个）；action=status 查询任务进度（jobId）；action=library 列出历史报告。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['analyze', 'status', 'library'], description: '操作类型' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '课程文件路径（绝对路径或相对当前工作目录）',
          },
          jobId: { type: 'string', description: 'status 操作使用的任务 id' },
          withVideos: { type: 'boolean', description: '是否检索 B 站网课，默认 true' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output({ type: 'object', additionalProperties: true }),
      async execute(args = {}) {
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
        const job = await makeJob(inputs, optionsOf({ withVideos: args.withVideos }))
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
