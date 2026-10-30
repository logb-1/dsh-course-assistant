#!/usr/bin/env node
/**
 * End-to-end pipeline check with a fake model — no network, no fixtures.
 *
 * This exists because the `text-delta` bug (the knowledge graph silently received
 * an empty string) survived 30 module-level tests: every unit was fine, the
 * *wiring* was not. A whole run against a scripted LLM catches that class of bug.
 *
 *   node tools/e2e-fake.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../core/store.js'
import { runPipeline } from '../core/pipeline.js'

const dir = mkdtempSync(join(tmpdir(), 'ca-e2e-'))
const store = createStore(dir)
try {
  const sections = ['一、概述', '二、数据', '三、浮点', '四、链接']
  const fillerOf = (n) =>
    `本节讲述计算机系统中的基本原理与实现细节，包含大量术语与例题（第 ${n} 章）。`.repeat(6)
  const bodyOf = (n) => sections.map((title) => `${title}\n${fillerOf(n)}`).join('\n')
  const markdown = [
    '# 计算机系统基础',
    '',
    '## 第一章 绪论',
    bodyOf(1),
    '',
    '## 第二章 数据表示',
    bodyOf(2),
    '',
    '## 第三章 程序的机器级表示',
    bodyOf(3),
  ].join('\n')
  const file = join(dir, 'course.md')
  writeFileSync(file, markdown)

  let calls = 0
  const llm = {
    provider: 'test',
    model: 'fake',
    stream() {
      calls += 1
      return (async function* () {
        const points = sections.map((title) => ({ text: `${title} 的关键结论`, evidence: `${title} 的原文摘录` }))
        yield {
          type: 'text-delta',
          text: JSON.stringify({ chapter: 'x', key_points: points, important: [], difficult: [], keywords: ['计算机系统 测试'] }),
        }
        yield { type: 'text-delta', text: '\n课程总结：这里是全课程总结。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }

  const job = await runPipeline({
    id: 'e2e-fake',
    inputs: [{ path: file, name: 'course.md' }],
    options: { withVideos: false, knowledge: false, concurrency: 1 },
    deps: { store, bili: null, llm },
    emit: () => {},
  })

  assert(job.chapters.length >= 3, `应识别出至少 3 章，实际 ${job.chapters.length}`)
  assert(calls >= 3, `至少应有 3 次模型调用，实际 ${calls} 次`)
  assert(job.chapters.every((c) => (c.summary?.key_points || []).length > 0), '每章都应有点要')
  assert(job.coverage && job.coverage.total > 0, '应记录覆盖率')
  assert(job.coverage.covered === job.coverage.total, `覆盖率应为满分，实际 ${job.coverage.covered}/${job.coverage.total}`)

  const report = readFileSync(job.reportPath, 'utf8')
  assert(report.includes('要点覆盖'), '报告应包含覆盖率一行')
  assert(/学习看板|看板/.test(report), '报告应包含看板信息')

  console.log(`PASS  e2e(fake)  —  ${job.chapters.length} 章 / ${calls} 次调用 / 覆盖 ${job.coverage.covered}/${job.coverage.total}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
