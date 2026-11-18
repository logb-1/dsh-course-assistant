/**
 * End-to-end smoke test against a running web server.
 *
 *   node tools/smoke-server.mjs http://127.0.0.1:8099 path/to/lecture.pdf
 *   node tools/smoke-server.mjs http://127.0.0.1:8099 path/to/lecture.pdf max
 *   node tools/smoke-server.mjs http://127.0.0.1:8099 path/to/lecture.pdf plus 10 80 120
 *
 * Registers a throwaway account, uploads the file, waits for the job and
 * checks that the HTML report renders (PLUS also checks the five books).
 * Prints a one-line verdict.
 */
const [, , baseArg, fileArg, levelArg, daysArg, targetArg, minutesArg] = process.argv
const base = (baseArg || 'http://127.0.0.1:8099').replace(/\/$/, '')
const file = fileArg
const level = ['normal', 'max', 'plus'].includes(levelArg) ? levelArg : 'normal'

if (!file) {
  console.error('usage: node tools/smoke-server.mjs <base-url> <file> [normal|max|plus] [days] [target] [minutes]')
  process.exit(2)
}

const { readFile } = await import('node:fs/promises')
const { basename } = await import('node:path')

let cookie = ''
const call = async (path, options = {}) => {
  const headers = { ...(options.headers || {}) }
  if (cookie) headers.cookie = cookie
  const res = await fetch(base + path, { ...options, headers, redirect: 'manual' })
  const setCookie = res.headers.getSetCookie?.() || []
  for (const line of setCookie) {
    const pair = line.split(';')[0]
    if (pair.startsWith('ca_session=')) cookie = pair
  }
  return res
}

const email = `smoke-${Date.now().toString(36)}@example.com`
const password = 'smoke-test-123'

let res = await call('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
if (!res.ok) throw new Error(`register ${res.status}: ${await res.text()}`)
console.log('register ok', email)

const bytes = await readFile(file)
const form = new FormData()
form.append('files', new Blob([bytes]), basename(file))
form.append('report_level', level)
form.append('with_videos', 'false')
if (level === 'plus') {
  form.append('days', daysArg || '14')
  form.append('target', targetArg || '80')
  form.append('minutes', minutesArg || '120')
}
res = await call('/api/jobs', { method: 'POST', body: form })
if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`)
const job = await res.json()
console.log('job', job.id, job.filename, `${job.size} bytes`)

const deadline = Date.now() + 180_000
let state = job
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const poll = await call(`/api/jobs/${job.id}`)
  state = await poll.json()
  process.stdout.write(`\r  ${state.status} ${Math.round((state.progress || 0) * 100)}% ${state.phase || ''}        `)
  if (state.status === 'done' || state.status === 'error') break
}
process.stdout.write('\n')
if (state.status !== 'done') throw new Error(`job ended as ${state.status}: ${state.error || state.message}`)

const html = await call(`/api/jobs/${job.id}/report.html`)
const body = await html.text()
if (!html.ok) throw new Error(`report ${html.status}: ${body.slice(0, 200)}`)
console.log('report html', body.length, 'bytes; contains table:', body.includes('<table>'))
if (level === 'plus') {
  const md = await call(`/api/jobs/${job.id}/report`)
  const text = await md.text()
  const books = (text.match(/^## 0[1-5] /gm) || []).length
  if (!md.ok || books !== 5) throw new Error(`plus report books=${books}: ${text.slice(0, 200)}`)
  console.log('plus report', text.length, 'bytes, books:', books)
}
console.log('SMOKE PASS', job.id)
