import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SCRIPT = 'core/ocr.ps1'

function run(image, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Image', image, ...extra])
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c.toString('utf8')))
    child.stderr.on('data', (c) => (err += c.toString('utf8')))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `exit ${code}`))
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
      const textLine = lines.filter((l) => l.startsWith('{') && l.includes('"text"')).pop() || '{}'
      try {
        resolve(JSON.parse(textLine).text || '')
      } catch {
        resolve('')
      }
    })
  })
}

function cer(ref, hyp) {
  const a = ref.replace(/\s+/g, '')
  const b = hyp.replace(/\s+/g, '')
  const m = a.length
  const n = b.length
  if (!m) return n ? 1 : 0
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i += 1) {
    const cur = [i]
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n] / m
}

const image = process.argv[2]
const gold = process.argv[3]
if (!image) {
  console.log('usage: node tools/_ocr_ab.mjs <image> ["gold text"]')
  process.exit(0)
}

const pre = await run(image)
const raw = await run(image, ['-NoPreprocess'])
console.log('--- preprocessed ---')
console.log(JSON.stringify(pre.slice(0, 160)))
console.log('--- raw ---')
console.log(JSON.stringify(raw.slice(0, 160)))
if (gold) {
  console.log('CER pre :', (cer(gold, pre) * 100).toFixed(1) + '%')
  console.log('CER raw :', (cer(gold, raw) * 100).toFixed(1) + '%')
  console.log('chars pre/raw:', pre.replace(/\s+/g, '').length, '/', raw.replace(/\s+/g, '').length)
}
