#!/usr/bin/env node
/**
 * Manual check: does a real deck's pictures reach the model?
 *
 *   node tools/img-e2e.mjs "D:\path\to\deck.pptx"
 *
 * Runs the whole pipeline against the real PPTX with a fake model, so the only
 * thing under test is the image path: media extraction → OCR → page text →
 * chapter prompt. Not part of CI (it needs a real deck and the OCR engine).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../core/store.js'
import { runPipeline } from '../core/pipeline.js'

const deck = process.argv[2]
if (!deck) {
  console.log('usage: node tools/img-e2e.mjs <deck.pptx>')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'ca-img-e2e-'))
const store = createStore(dir)
const messages = []
const prompts = []

const llm = {
  provider: 'test',
  model: 'fake',
  stream(options) {
    const prompt = options.messages?.[0]?.content?.[0]?.text || ''
    prompts.push(prompt)
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
  const job = await runPipeline({
    id: 'img-e2e',
    inputs: [{ path: deck, name: 'deck.pptx' }],
    options: { withVideos: false, knowledge: false, concurrency: 1, images: { mode: 'ocr', max: 12 } },
    deps: { store, bili: null, llm },
    emit: (patch) => {
      if (patch?.message && /图片/.test(patch.message)) messages.push(patch.message)
    },
  })
  console.log('chapters:', job.chapters.length)
  console.log('job.images:', JSON.stringify(job.images))
  console.log('progress:', messages.slice(0, 3).join(' | '))
  const withImage = prompts.filter((p) => p.includes('[图片]')).length
  console.log('prompts carrying [图片] text:', withImage, '/', prompts.length)
  const report = readFileSync(job.reportPath, 'utf8')
  console.log('report mentions 幻灯片图片:', report.includes('幻灯片图片'))
  const sample = prompts.find((p) => p.includes('[图片]'))
  if (sample) {
    const at = sample.indexOf('[图片]')
    console.log('sample:', JSON.stringify(sample.slice(at, at + 120)))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
