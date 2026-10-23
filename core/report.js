/**
 * Markdown report assembly (the deliverable format is fixed by the request).
 */
import { searchLink } from './bili.js'
import { describeQuality } from './quality.js'

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()

const fmtPlay = (n) => {
  const v = Number(n) || 0
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`
  return String(v)
}

const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return `${m}:${String(r).padStart(2, '0')}`
}

function toc(chapters) {
  const lines = []
  chapters.forEach((c, i) => {
    lines.push(`${c.index}. ${c.title}`)
    for (const sub of (c.subs || []).slice(0, 6)) lines.push(`   - ${sub}`)
  })
  return lines.join('\n')
}

function chapterSection(c) {
  const s = c.summary || {}
  const lines = [`### 第 ${c.index} 章 ${c.title}`]
  const points = (s.key_points || []).filter(Boolean)
  if (points.length) {
    lines.push('- 要点：')
    for (const p of points) lines.push(`  - ${p}`)
  } else {
    lines.push('- 要点：（本章未提取到有效要点）')
  }
  for (const p of (s.important || []).filter(Boolean)) lines.push(`- ⭐ 重点：${p}`)
  for (const p of (s.difficult || []).filter(Boolean)) lines.push(`- ⚠️ 难点：${p}`)
  if (s.lowConfidence) {
    lines.push(`- 备注：本章要点与原文的重合度只有 ${Math.round((s.support || 0) * 100)}%，可能有推断成分，建议对照原页核对`)
  }
  if (s.keywords?.length) lines.push(`- 关键词：${s.keywords.join(' / ')}`)
  if (c.summary?.error) lines.push(`- 备注：本章总结失败（${c.summary.error}），以上为本地兜底摘要`)
  return lines.join('\n')
}

function seriesTable(series, fallback, courseTitle, seriesLinks = []) {
  if (!series.length) {
    const links = seriesLinks.length
      ? seriesLinks
      : [{ label: `${courseTitle} 合集`, url: searchLink(`${courseTitle} 合集`) }]
    const rows = links.slice(0, 3).map(
      (l, i) => `| ${i + 1} | ${cell(l.label)}（B 站搜索入口） | — | — | — | ${l.url} |`,
    )
    return ['| 序号 | 标题 | UP 主 | 播放量 | 时长/集数 | 链接 |', '|------|------|-------|--------|-----------|------|', ...rows].join('\n')
  }
  const rows = series.map(
    (v, i) =>
      `| ${i + 1} | ${cell(v.title)} | ${cell(v.author)} | ${fmtPlay(v.play)} | ${v.duration ? fmtDur(v.duration) : '合集'} | ${v.url} |`,
  )
  return [
    '| 序号 | 标题 | UP 主 | 播放量 | 时长/集数 | 链接 |',
    '|------|------|-------|--------|-----------|------|',
    ...rows,
    ...(fallback ? [] : []),
  ].join('\n')
}

function chapterTable(chapters, byChapter, fallback) {
  const rows = ['| 章节 | 标题 | UP 主 | 播放量 | 时长 | 链接 |', '|------|------|-------|--------|------|------|']
  let any = false
  chapters.forEach((c) => {
    const videos = byChapter[c.index]?.videos || []
    if (videos.length) {
      for (const v of videos) {
        any = true
        rows.push(
          `| 第 ${c.index} 章 ${cell(c.title)} | ${cell(v.title)} | ${cell(v.author)} | ${fmtPlay(v.play)} | ${fmtDur(v.duration)} | ${v.url} |`,
        )
      }
    } else {
      any = true
      const q = (byChapter[c.index]?.queries?.[0] || c.title || c.summary?.keywords?.[0] || '').toString()
      const link = searchLink(q)
      rows.push(`| 第 ${c.index} 章 ${cell(c.title)} | ${cell(q)}（B 站搜索） | — | — | — | ${link} |`)
    }
  })
  if (!any) {
    rows.push(`| 全部 | 课程名搜索入口 | — | — | — | ${searchLink('课程')} |`)
  }
  return rows.join('\n')
}

/**
 * @param {object} input
 * @param {string} input.courseTitle
 * @param {Array} input.files      [{ name, kind, pages }]
 * @param {Array} input.chapters   [{ index, title, subs, summary }]
 * @param {string} input.courseSummary
 * @param {Array} input.series
 * @param {object} input.byChapter   index → { videos, queries }
 * @param {boolean} input.fallback   bilibili blocked → link-only appendix
 * @param {object} [input.meta]     { model, elapsedMs, warnings, generatedAt }
 */
export function buildReport(input) {
  const {
    courseTitle,
    files = [],
    chapters = [],
    courseSummary = '',
    series = [],
    seriesLinks = [],
    byChapter = {},
    fallback = false,
    meta = {},
  } = input
  const out = []
  const rawTitle = String(courseTitle || '课程').trim().replace(/[_]+/g, ' ').replace(/\s+/g, ' ')
  const bareTitle = /^《[^》]*》$/.test(rawTitle) ? rawTitle.slice(1, -1) : rawTitle
  out.push(`# 《${bareTitle}》学习报告`)
  out.push('')
  const sourceLine = files.map((f) => `${f.name}（${f.kind}${f.pages ? `，${f.pages} 页` : ''}）`).join('、')
  const bits = [
    `生成时间：${meta.generatedAt || new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `来源文件：${sourceLine || '（无）'}`,
    `章节数：${chapters.length}`,
    meta.model ? `总结模型：${meta.model}` : '',
    meta.domain ? `领域锚定：${meta.domain.name}${meta.domain.source === 'config' ? '（配置）' : '（从课件代码特征识别）'}` : '',
    meta.quality ? `文本可读性：${describeQuality(meta.quality)}` : '',
    meta.offline ? '总结方式：本地兜底（模型不可用）' : '',
  ].filter(Boolean)
  out.push(`> ${bits.join(' ｜ ')}`)
  if (meta.quality?.tier === 'unusable') {
    out.push('>')
    out.push('> ⚠️ **文字层不可用**：这份文件里的文字没能被正确提取（多为导出型 PDF 的字形编码），下面的内容参考价值有限。建议改用原始 .pptx/.docx，或启用 OCR 重读。')
  }
  if (meta.warnings?.length) {
    out.push('>')
    for (const w of meta.warnings) out.push(`> ⚠️ ${w}`)
  }
  out.push('')

  out.push('## 一、课程目录')
  out.push('')
  out.push(toc(chapters) || '（未识别到目录）')
  out.push('')

  out.push('## 二、各章知识点')
  out.push('')
  for (const c of chapters) {
    out.push(chapterSection(c))
    out.push('')
  }

  out.push('## 三、课程总结')
  out.push('')
  out.push(courseSummary ? courseSummary.slice(0, 300) : '（未生成总结）')
  out.push('')

  out.push('## 附录：B 站相关网课推荐')
  out.push('')
  if (fallback) {
    out.push('> B 站检索接口触发风控，以下为搜索入口链接（点击可在浏览器内检索）。')
    out.push('')
  }
  out.push('### A. 系列课程推荐')
  out.push('')
  out.push(seriesTable(series, fallback, courseTitle, seriesLinks))
  out.push('')
  out.push('### B. 分章节视频推荐')
  out.push('')
  out.push(chapterTable(chapters, byChapter, fallback))
  out.push('')
  if (meta.elapsedMs) {
    out.push(`<!-- 生成耗时 ${Math.round(meta.elapsedMs / 1000)}s；评分 = 匹配度×0.5 + log(播放)×0.2 + 收藏/点赞×0.2 + 合集×0.1 -->`)
  }
  return out.join('\n')
}

export { fmtDur, fmtPlay }
