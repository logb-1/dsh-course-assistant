#!/usr/bin/env node
/**
 * Headless job runner: the bridge between the FastAPI product shell and the
 * plugin pipeline.
 *
 *   node bin/run-job.mjs --spec job.json
 *
 * The spec is JSON on disk (or stdin with `--spec -`):
 *   {
 *     "id": "1a2b3c4d",
 *     "dataDir": "/data",                     // store root
 *     "inputs": [{"name": "ch1.pdf", "path": "/data/uploads/.../ch1.pdf"}],
 *     "options": {"reportLevel": "normal", "ocrMode": "off"},
 *     "offline": false,                       // true = no model, local fallback
 *     "llm": {"baseUrl": "...", "model": "deepseek-chat"}   // apiKey via env
 *   }
 *
 * stdout is a JSON-lines event stream and nothing else, so the caller can parse
 * it without a protocol library:
 *   {"type":"progress","status":"running","phase":"summary",...}
 *   {"type":"done","status":"done","reportPath":"/data/reports/xxx.md",...}
 *   {"type":"error","message":"..."}
 *
 * Exit codes: 0 done · 2 pipeline error · 3 bad spec / missing input.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStore } from '../core/store.js'
import { createBiliClient } from '../core/bili.js'
import { createHttpLlm } from '../core/llm-http.js'
import { runPipeline } from '../core/pipeline.js'

function parseArgs(argv) {
  const args = { spec: '', quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--spec' || arg === '-s') args.spec = argv[++i]
    else if (arg === '--quiet' || arg === '-q') args.quiet = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

function readSpec(path) {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  return JSON.parse(text)
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stderr.write('usage: node bin/run-job.mjs --spec <job.json|-> [--quiet]\n')
    return 0
  }
  if (!args.spec) {
    emit({ type: 'error', message: '缺少 --spec（作业描述 JSON 路径，或 - 表示 stdin）' })
    return 3
  }
  let spec
  try {
    spec = readSpec(args.spec)
  } catch (error) {
    emit({ type: 'error', message: `读不到作业描述：${error.message}` })
    return 3
  }

  const id = String(spec.id || '').trim()
  if (!/^[0-9a-z-]{4,64}$/i.test(id)) {
    emit({ type: 'error', message: '作业 id 不合法（4-64 位字母、数字或短横线）' })
    return 3
  }
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : []
  if (!inputs.length) {
    emit({ type: 'error', message: '作业没有输入文件' })
    return 3
  }
  for (const input of inputs) {
    if (!input?.path) {
      emit({ type: 'error', message: '输入文件缺少 path' })
      return 3
    }
    try {
      if (!statSync(input.path).isFile()) throw new Error('不是文件')
    } catch (error) {
      emit({ type: 'error', message: `输入文件不存在：${input.name || input.path}（${error.message}）` })
      return 3
    }
  }

  const dataDir = resolve(spec.dataDir || process.env.COURSE_DATA_DIR || './data')
  const store = createStore(dataDir)
  const bili = createBiliClient({
    cache: store.cache,
    spacingMs: Number(spec.biliSpacingMs) || 600,
    log: (message) => {
      if (!args.quiet) process.stderr.write(`${message}\n`)
    },
  })

  let llm = null
  if (!spec.offline) {
    try {
      llm = createHttpLlm({ ...(spec.llm || {}) })
    } catch (error) {
      emit({ type: 'error', message: error.message })
      return 3
    }
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  const options = { ...(spec.options || {}) }
  // the server never has the Windows OCR engine; the job spec says so explicitly
  if (options.ocrMode == null) options.ocrMode = 'off'

  const startedAt = Date.now()
  try {
    const final = await runPipeline({
      id,
      inputs,
      options,
      deps: { store, bili, llm },
      emit: (job) => {
        emit({
          type: 'progress',
          status: job.status,
          phase: job.phase,
          progress: Number(job.progress) || 0,
          message: job.message || '',
          chapters: (job.chapters || []).map((chapter) => chapter.title).filter(Boolean),
          reused: !!job.reused,
        })
      },
      signal: controller.signal,
    })
    const status = final?.status || 'error'
    let metaPath = ''
    if (status === 'done' && final?.reportPath) {
      // The web shell renders PDFs out of process, so the outline it needs for
      // the structure diagram is persisted next to the report.
      metaPath = final.reportPath.replace(/\.md$/, '.meta.json')
      try {
        writeFileSync(
          metaPath,
          `${JSON.stringify(
            {
              id: final.id || id,
              reportPath: final.reportPath,
              courseTitle: final.courseTitle || '',
              reportLevel: final.reportLevel || '',
              style: final.style || '',
              chapters: (final.chapters || []).map((chapter) => ({
                index: chapter.index,
                title: chapter.title,
                subs: (chapter.subs || []).slice(0, 8),
                pages: chapter.pages || [],
              })),
              plan: final.sprint?.plan || [],
              files: (final.files || []).map((file) => ({ name: file.name, pages: file.pages || 0 })),
              createdAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          'utf8',
        )
      } catch (error) {
        metaPath = ''
        if (!args.quiet) process.stderr.write(`写 meta 失败（PDF 仍可按需生成）：${error.message}\n`)
      }
    }
    emit({
      type: 'done',
      id: final?.id || id,
      status,
      error: final?.error || '',
      reportPath: final?.reportPath || '',
      metaPath,
      reportLevel: final?.reportLevel || '',
      chapters: (final?.chapters || []).length,
      warnings: (final?.warnings || []).slice(0, 20),
      elapsedMs: final?.elapsedMs || Date.now() - startedAt,
      reused: !!final?.reused,
    })
    return status === 'done' ? 0 : 2
  } catch (error) {
    emit({ type: 'error', id, message: String(error?.message || error) })
    return 2
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    emit({ type: 'error', message: String(error?.message || error) })
    process.exitCode = 2
  })
