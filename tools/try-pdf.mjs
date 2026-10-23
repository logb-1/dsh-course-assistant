import { readFileSync } from 'node:fs'
import { parsePdf } from '../core/pdf.js'

const f = process.argv[2]
const t0 = Date.now()
const r = parsePdf(readFileSync(f), f)
console.log('ms', Date.now() - t0, '| title:', r.title, '| pages:', r.pages.length, '| outline:', r.outline.length)
for (const o of r.outline.slice(0, 40)) console.log(`  ${'  '.repeat(o.level - 1)}- [p${o.page ?? '?'}] ${o.title}`)
console.log('--- page 1 ---')
console.log(r.pages[0]?.text.slice(0, 600))
console.log('--- page 2 ---')
console.log(r.pages[1]?.text.slice(0, 400))
