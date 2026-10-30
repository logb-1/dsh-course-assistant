#!/usr/bin/env node
/**
 * OCR benchmark: CER on generated samples, with and without the preprocessing +
 * artifact fixing that the image path now applies.
 *
 *   python tools/_gen_ocr_bench.py   # once, writes %TEMP%\ca-ocr-bench
 *   node tools/ocr-bench.mjs
 *
 * Manual tool (needs Windows OCR and the generated images); not part of CI.
 */
import { readFileSync } from 'node:fs'
import { ocrImage } from '../core/ocr.js'

const dir = process.env.TEMP + '\\ca-ocr-bench'
const manifest = JSON.parse(readFileSync(dir + '\\manifest.json', 'utf8'))

function cer(ref, hyp) {
  const a = ref.replace(/\s+/g, '')
  const b = hyp.replace(/\s+/g, '')
  if (!a.length) return b.length ? 1 : 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length] / a.length
}

let sumOn = 0
let sumOff = 0
for (const sample of manifest) {
  const on = await ocrImage(sample.image)
  const off = await ocrImage(sample.image, { preprocess: false })
  const a = cer(sample.text, on)
  const b = cer(sample.text, off)
  sumOn += a
  sumOff += b
  console.log(`${sample.id.padEnd(10)} CER on ${(a * 100).toFixed(1).padStart(5)}%  off ${(b * 100).toFixed(1).padStart(5)}%`)
  console.log(`           on : ${on.replace(/\s+/g, ' ').slice(0, 64)}`)
  console.log(`           off: ${off.replace(/\s+/g, ' ').slice(0, 64)}`)
}
console.log(`\nmean CER  on ${((sumOn / manifest.length) * 100).toFixed(1)}%  off ${((sumOff / manifest.length) * 100).toFixed(1)}%`)
