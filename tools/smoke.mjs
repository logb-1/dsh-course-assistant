/**
 * End-to-end smoke test against the running Harness (same routes the panel uses).
 *
 *   node tools/smoke.mjs <course-file> [<course-file> ...]
 *
 * Prints one line per phase, then writes the report (.md) and, when the profile
 * provides officeToPdf, the PDF next to it. Exit code 1 on any failure.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join, extname } from 'node:path'

const BASE = process.env.DSH_WEB_URL ? `${process.env.DSH_WEB_URL}/course-assistant` : 'http://127.0.0.1:54763/course-assistant'
const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node tools/smoke.mjs <file> [<file>...]')
  process.exit(2)
}

const j = async (res) => {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }
}

const health = await j(await fetch(`${BASE}/health`))
console.log('health', health)

const ids = []
for (const file of files) {
  const name = basename(file)
  const res = await fetch(`${BASE}/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(file),
  })
  const data = await j(res)
  if (!data.ok) throw new Error(`upload failed: ${data.reason}`)
  ids.push({ id: data.file.id })
  console.log('upload', name, data.file.bytes, 'bytes')
}

const started = Date.now()
const run = await j(
  await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: ids, options: { withVideos: true } }),
  }),
)
if (!run.ok) throw new Error(`run failed: ${run.reason}`)
console.log('job', run.jobId)

let job = null
for (;;) {
  await new Promise((r) => setTimeout(r, 1000))
  job = (await j(await fetch(`${BASE}/job?id=${run.jobId}`))).job
  process.stdout.write(`\r  ${job.phase} ${Math.round((job.progress || 0) * 100)}%   `)
  if (job.status !== 'running') break
  if (Date.now() - started > 180000) throw new Error('timeout')
}
console.log('')
if (job.status !== 'done') throw new Error(`job failed: ${job.error}`)

console.log(
  `done in ${((Date.now() - started) / 1000).toFixed(1)}s | chapters=${job.chapters.length} | videos=${Object.values(job.byChapter || {}).reduce((a, b) => a + (b.videos?.length || 0), 0)} | series=${job.series.length} | fallback=${job.fallback}`,
)
if (job.warnings?.length) console.log('warnings:', job.warnings)

const outDir = join(process.cwd(), 'course-assistant', 'samples')
mkdirSync(outDir, { recursive: true })
const stem = basename(files[0], extname(files[0])).slice(0, 60)

const md = await fetch(`${BASE}/report?id=${run.jobId}&format=md`)
const mdText = await md.text()
const mdPath = join(outDir, `${stem}_学习报告.md`)
writeFileSync(mdPath, mdText, 'utf8')
console.log('report', mdPath, `${(mdText.length / 1024).toFixed(1)} KB`)

if (health.pdf) {
  const pdf = await fetch(`${BASE}/report?id=${run.jobId}&format=pdf`)
  if (pdf.ok && (pdf.headers.get('content-type') || '').includes('pdf')) {
    const bytes = Buffer.from(await pdf.arrayBuffer())
    const pdfPath = join(outDir, `${stem}_学习报告.pdf`)
    writeFileSync(pdfPath, bytes)
    console.log('pdf', pdfPath, `${(bytes.length / 1024).toFixed(1)} KB`)
  } else {
    const reason = await pdf.text()
    console.log('pdf export failed:', reason.slice(0, 200))
  }
}
process.exit(0)
