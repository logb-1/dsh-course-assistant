#!/usr/bin/env node
/**
 * Manual check: does page-level OCR triage run end-to-end on a real PDF?
 *
 *   node tools/ocr-e2e.mjs "D:\path\to\lecture.pdf" [auto|all|off]
 *
 * Runs the whole pipeline with a fake model, so the only thing under test is the
 * triage → OCR → merge → report path. Not part of CI: it needs a real PDF and a
 * working OCR engine.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../core/store.js'
import { runPipeline } from '../core/pipeline.js'

const file = process.argv[2]
if (!file) {
  console.log('usage: node tools/ocr-e2e.mjs <lecture.pdf> [auto|all|off]')
  process.exit(0)
}
const mode = process.argv[3] || 'auto'

const dir = mkdtempSync(join(tmpdir(), 'ca-ocr-e2e-'))
const store = createStore(dir)
const messages = []
const llm = {
  provider: 'test',
  model: 'fake',
  stream() {
    return (async function* () {
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          chapter: 'x',
          key_points: [{ text: '占位要点', evidence: '占位' }],
          important: [],
          difficult: [],
          keywords: ['计算机系统 测试'],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

try {
  const started = Date.now()
  const job = await runPipeline({
    id: 'ocr-e2e',
    inputs: [{ path: file, name: 'lecture.pdf' }],
    options: { withVideos: false, knowledge: false, concurrency: 1, ocrMode: mode, images: { mode: 'off' } },
    deps: { store, bili: null, llm },
    emit: (patch) => {
      if (patch?.message && /OCR/.test(patch.message) && !messages.includes(patch.message)) messages.push(patch.message)
    },
  })
  console.log(`mode=${mode} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log('files:', JSON.stringify(job.files))
  console.log('job.ocr:', JSON.stringify(job.ocr))
  console.log('quality:', JSON.stringify(job.quality?.metrics))
  console.log('chapters:', job.chapters.length)
  console.log('progress:', messages.slice(0, 3).join(' | '))
  const report = readFileSync(job.reportPath, 'utf8')
  const header = report.split('\n').find((line) => line.includes('页级 OCR')) || '(报告里没有页级 OCR 一行)'
  console.log('report header:', header.slice(0, 160))
  console.log('warnings:', JSON.stringify((job.warnings || []).slice(0, 4)))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
