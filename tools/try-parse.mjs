import { readFileSync } from 'node:fs'
import { parsePptx, parseDocx } from '../core/ooxml.js'

const files = process.argv.slice(2)
for (const f of files) {
  const buf = readFileSync(f)
  const r = f.endsWith('.pptx') ? parsePptx(buf, f) : parseDocx(buf, f)
  console.log('===', f.split(/[\\/]/).pop(), r.kind, '| title:', r.title, '| pages:', r.pages.length, '| blocks:', r.blocks.length)
  if (r.pages.length) {
    for (const p of r.pages.slice(0, 30)) console.log(`  p${p.index} [${p.title}] ${p.text.replace(/\n/g, ' / ').slice(0, 110)}`)
  } else {
    for (const b of r.blocks.slice(0, 30)) console.log(`  L${b.level} [${b.title}] ${b.text.join(' / ').slice(0, 110)}`)
  }
}
