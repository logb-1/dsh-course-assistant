/**
 * Chapter → sections.
 *
 * A chapter is summarized from a 3.6k-character window, so a long chapter used to
 * lose whole sections that scored low on TF-IDF. Splitting first lets the
 * selector keep at least one passage per section and lets the audit say which
 * sections never produced a key point.
 *
 * Zero dependencies; headings come from the outline (`chapter.subs`) or from the
 * numbering patterns inside the text.
 */

const HEADING = /^\s*(?:第\s*[一二三四五六七八九十百\d]+\s*[节章]|[一二三四五六七八九十]+\s*[、.．]|\d+(?:\.\d+){0,3}\s*[、.．]?\s|【[^】]{2,20}】)/

/**
 * @param {{ title?: string, subs?: string[] }} chapter
 * @param {string} text
 * @param {{ maxSections?: number }} [options]
 * @returns {Array<{ index:number, title:string, text:string, chars:number, from:number }>}
 */
export function splitSections(chapter, text, options = {}) {
  const body = String(text || '')
  if (!body.trim()) return []
  const maxSections = Math.max(1, Math.min(20, options.maxSections || 12))

  // 1) outline sub-headings, when they actually appear in the body
  const subs = (chapter?.subs || []).map((t) => String(t || '').trim()).filter(Boolean)
  const bySubs = []
  if (subs.length >= 2) {
    let cursor = 0
    for (const sub of subs) {
      const at = body.indexOf(sub, cursor)
      if (at < 0) continue
      bySubs.push({ title: sub, from: at })
      cursor = at + sub.length
    }
  }

  const cuts = bySubs.length >= 2 ? bySubs : numberedHeadings(body)
  if (!cuts.length) {
    return [{ index: 1, title: chapter?.title || '全文', text: body, chars: body.length, from: 0 }]
  }

  const sections = []
  for (let i = 0; i < cuts.length && sections.length < maxSections; i += 1) {
    const start = cuts[i].from
    const end = i + 1 < cuts.length ? cuts[i + 1].from : body.length
    const slice = body.slice(start, end).trim()
    if (!slice) continue
    sections.push({ index: sections.length + 1, title: cuts[i].title, text: slice, chars: slice.length, from: start })
  }
  return sections.length ? sections : [{ index: 1, title: chapter?.title || '全文', text: body, chars: body.length, from: 0 }]
}

function numberedHeadings(body) {
  const lines = body.split('\n')
  const cuts = []
  let offset = 0
  for (const line of lines) {
    if (HEADING.test(line) && line.trim().length <= 60) {
      cuts.push({ title: line.trim().slice(0, 60), from: offset })
    }
    offset += line.length + 1
  }
  return cuts
}

/** Which section contains a character offset (used to attribute passages). */
export function sectionAt(sections, offset) {
  let found = sections[0] || null
  for (const section of sections) {
    if (section.from <= offset) found = section
    else break
  }
  return found
}
