#!/usr/bin/env node
/**
 * Render a finished job's report to PDF, out of process.
 *
 *   node bin/make-pdf.mjs --meta <reports/x.meta.json> --out <x.pdf>
 *
 * The HTTP shell keeps Node at arm's length: it launches this script, reads one
 * JSON line from stdout and serves the file. Meta is written by bin/run-job.mjs
 * at the end of a successful run (report path, course title, chapter outline).
 *
 * Exit codes: 0 ok · 2 render failed · 3 bad input.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { buildPdf } from '../core/pdfdoc.js'
import { buildStructure } from '../core/diagram.js'

function parseArgs(argv) {
  const args = { meta: '', out: '', quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--meta' || argv[i] === '-m') args.meta = argv[++i]
    else if (argv[i] === '--out' || argv[i] === '-o') args.out = argv[++i]
    else if (argv[i] === '--quiet' || argv[i] === '-q') args.quiet = true
  }
  return args
}

function fail(message, code = 3) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  return code
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.meta || !args.out) return fail('用法：node bin/make-pdf.mjs --meta <meta.json> --out <report.pdf>')

  let meta
  try {
    meta = JSON.parse(readFileSync(args.meta, 'utf8'))
  } catch (error) {
    return fail(`读不到 meta：${error.message}`)
  }
  const reportPath = meta.reportPath
  if (!reportPath || !existsSync(reportPath)) return fail('meta 里的 reportPath 不存在')
  const markdown = readFileSync(reportPath, 'utf8')

  const level = meta.reportLevel || meta.style || ''
  const subtitle =
    level === 'plus' || level === 'sprint' ? '冲刺五册 · PLUS' : level === 'max' || level === 'review' ? '复习资料 · MAX' : '学习报告'
  const files = Array.isArray(meta.files) ? meta.files : []
  const pages = files.reduce((total, file) => total + (Number(file.pages) || 0), 0)
  const metaLines = [
    `读取文件：${files.length} 个${pages ? `（${pages} 页）` : ''}`,
    `章节：${(meta.chapters || []).length} 章`,
    `生成时间：${new Date(meta.createdAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}`,
    `报告模式：${subtitle}`,
  ]
  if (files.length) {
    const names = files.slice(0, 4).map((file) => file.name).filter(Boolean)
    if (names.length) metaLines.push(`课件：${names.join('、')}${files.length > 4 ? ' 等' : ''}`)
  }

  const structure = buildStructure({ courseTitle: meta.courseTitle, chapters: meta.chapters || [], plan: meta.plan || [] })
  const buffer = await buildPdf({
    markdown,
    courseTitle: meta.courseTitle || '课程报告',
    subtitle,
    meta: metaLines,
    structure,
  })
  writeFileSync(args.out, buffer)
  process.stdout.write(
    `${JSON.stringify({ ok: true, path: args.out, bytes: buffer.length, chapters: structure.stats.chapters })}\n`,
  )
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`)
    process.exitCode = 2
  })
