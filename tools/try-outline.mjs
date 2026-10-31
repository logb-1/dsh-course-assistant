#!/usr/bin/env node
/**
 * Outline diagnostics: what titles the parser produced, and which ones look wrong.
 *
 *   node tools/try-outline.mjs <file> [<file>...]        # chapters + subs
 *   node tools/try-outline.mjs --pages <file>            # also dump page titles
 *   node tools/try-outline.mjs --all <file>...           # both
 *
 * The flags are the point: they encode the title defects we keep finding in real
 * courseware (slide-number prefixes, code lines, bare numbers, duplicates).
 */
import { parseFile } from '../core/parser.js'
import { buildOutline } from '../core/outline.js'

const argv = process.argv.slice(2)
const SHOW_PAGES = argv.includes('--pages') || argv.includes('--all')
const files = argv.filter((a) => !a.startsWith('--'))
if (!files.length) {
  console.log('用法：node tools/try-outline.mjs [--pages|--all] <课件文件> [更多文件…]')
  process.exit(2)
}

const CODEISH = /[{};=<>#]|\b(?:int|void|char|return|include|printf|std)\b/i
const SLIDE_NO = /(?:幻灯片|slide)\s*\d+/i
const BARE_NUMBER = /^[\d.\s·\-–—、]+$/

/** One line per suspicious title. Keep the rules explicit: they become tests. */
export function titleProblems(title, { isSlide = true } = {}) {
  const t = String(title || '').trim()
  const out = []
  if (!t) out.push('空标题')
  if (SLIDE_NO.test(t)) out.push('含「幻灯片 N」前缀')
  if (BARE_NUMBER.test(t)) out.push('纯数字/符号')
  if (/^[（(]?\d{1,3}[)）.、]?$/.test(t)) out.push('纯编号')
  if (CODEISH.test(t)) out.push('像代码行')
  if ((t.match(/[\u4e00-\u9fff]/g) || []).length < 2 && t.length > 2) out.push('中文少于 2 字')
  if (t.length > 40) out.push(`过长（${t.length} 字）`)
  if (/^第\s*\d+\s*章\s*$/.test(t)) out.push('只有章号没有章名')
  if (isSlide && !SLIDE_NO.test(t) && /^\d{1,2}[.．]\d{1,2}\s/.test(t) && !/第\s*\d+\s*章/.test(t)) {
    out.push('以「x.y」小节号开头（缺章名层级）')
  }
  return out
}

let failed = 0
for (const file of files) {
  let doc
  try {
    doc = parseFile(file)
  } catch (error) {
    console.log(`# ${file}\n  解析失败：${error.message}`)
    failed += 1
    continue
  }
  const pages = doc.pages || []
  const chars = pages.reduce((n, p) => n + (p.text || '').length, 0)
  console.log(`\n# ${file}`)
  console.log(
    `  kind=${doc.kind} title="${doc.title}" pages=${pages.length} 均字数=${pages.length ? Math.round(chars / pages.length) : 0}` +
      ` sections=${doc.sections?.length || 0} outline=${doc.outline?.length || 0} blocks=${doc.blocks?.length || 0}`,
  )
  const courseProblems = titleProblems(doc.title || '', { isSlide: false })
  if (courseProblems.length) console.log(`  ⚠ 课程名问题：${courseProblems.join('；')}`)

  if (SHOW_PAGES && pages.length) {
    console.log('  页面标题（前 16 页）：')
    for (const page of pages.slice(0, 16)) {
      const problems = titleProblems(page.title || '')
      console.log(
        `    p.${String(page.index).padStart(3)}  ${JSON.stringify((page.title || '').slice(0, 40))}` +
          `${problems.length ? `  ⚠ ${problems.join('、')}` : ''}`,
      )
    }
  }

  const outline = buildOutline([doc])
  console.log(`  → courseTitle="${outline.courseTitle}" chapters=${outline.chapters.length}`)
  const seen = new Map()
  for (const chapter of outline.chapters) {
    const key = String(chapter.title || '').replace(/（p\d+[–-]\d+）\s*$/, '').trim()
    seen.set(key, (seen.get(key) || 0) + 1)
    const problems = titleProblems(chapter.title || '', { isSlide: pages.length > 0 })
    if (seen.get(key) > 1) problems.push('章名重复')
    const pagesLabel = chapter.pages?.length ? `p${chapter.pages[0]}–${chapter.pages[chapter.pages.length - 1]}` : '—'
    console.log(
      `   ${String(chapter.index).padStart(2)}. ${chapter.title}` +
        `  [${chapter.source || 'heuristic'}, ${pagesLabel}, ${chapter.text.length}字]` +
        `${problems.length ? `  ⚠ ${problems.join('、')}` : ''}`,
    )
    if (chapter.subs?.length) console.log(`       subs: ${chapter.subs.slice(0, 5).join(' | ')}`)
  }
  if (outline.courseTitle && titleProblems(outline.courseTitle, { isSlide: false }).length) failed += 1
}
process.exit(0)
