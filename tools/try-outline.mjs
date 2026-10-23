import { parseFile } from '../core/parser.js'
import { buildOutline } from '../core/outline.js'

const files = process.argv.slice(2)
const docs = files.map((f) => {
  const t0 = Date.now()
  const d = parseFile(f)
  console.log('#', d.kind, d.title, 'pages', d.pages.length, 'blocks', d.blocks.length, 'outline', d.outline?.length ?? 0, `${Date.now() - t0}ms`)
  return d
})
const t0 = Date.now()
const o = buildOutline(docs)
console.log(`outline ${Date.now() - t0}ms | course: ${o.courseTitle} | chapters: ${o.chapters.length}`)
for (const c of o.chapters) {
  console.log(` ${c.index}. [${c.source}] ${c.title} (${c.text.length}字, pages ${c.pages.join(',') || '-'})`)
  if (c.subs.length) console.log(`      subs: ${c.subs.slice(0, 6).join(' | ')}`)
}
