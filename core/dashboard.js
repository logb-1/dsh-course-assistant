/**
 * Standalone dashboard: one self-contained HTML file next to the report.
 *
 * No framework, no CDN, no build step — the file must open offline by double
 * click. It carries the chapter plan, the prerequisite state and a small SVG
 * tree, which is enough for "看板" without dragging a layout library into a
 * zero-dependency plugin.
 */

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function conceptCount(concepts, chapterIndex) {
  return (concepts || []).filter((c) => c.chapter === chapterIndex).length
}

/**
 * Simple layered tree: chapters down the page, concepts branching right.
 * Deliberately crude — a readable diagram beats a broken one.
 */
function renderSvg({ chapters, plan, knowledge }) {
  const concepts = knowledge?.concepts || []
  const rowHeight = 58
  const width = 720
  const nodes = []
  let y = 30
  for (const chapter of chapters) {
    const blocked = plan?.find((step) => step.index === chapter.index)?.blocked
    const items = concepts.filter((c) => c.chapter === chapter.index).slice(0, 4)
    nodes.push({ y, label: `第${chapter.index}章 ${chapter.title}`, blocked, items, height: Math.max(1, items.length) * 20 + 26 })
    y += Math.max(1, items.length) * 20 + 40
  }
  const height = Math.max(120, y + 20)
  const parts = [`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="章节与知识点">`]
  for (const node of nodes) {
    const fill = node.blocked ? '#fff4e5' : '#eef6ff'
    const stroke = node.blocked ? '#e08b00' : '#3b82f6'
    parts.push(
      `<rect x="16" y="${node.y}" width="${width - 32}" height="${node.height}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`,
    )
    parts.push(
      `<text x="32" y="${node.y + 22}" font-size="14" font-weight="600" fill="#111">${escapeHtml(node.label)}${
        node.blocked ? ' ⚠ 前置未满足' : ''
      }</text>`,
    )
    node.items.forEach((item, i) => {
      parts.push(
        `<text x="48" y="${node.y + 44 + i * 20}" font-size="12" fill="#444">· ${escapeHtml(item.name || item.id)}</text>`,
      )
    })
  }
  parts.push('</svg>')
  return parts.join('')
}

function planTable({ chapters, plan }) {
  const rows = (plan || []).map((step) => {
    const chapter = chapters.find((c) => c.index === step.index)
    return `<tr>
      <td>第 ${step.index} 章</td>
      <td>${escapeHtml(chapter?.title || step.title || '')}</td>
      <td>${step.concepts ?? conceptCount(null, step.index)}</td>
      <td>${step.blocked ? `<span class="warn">未满足：${escapeHtml((step.missing || []).join('、'))}</span>` : '可执行'}</td>
    </tr>`
  })
  return `<table><thead><tr><th>章</th><th>标题</th><th>概念数</th><th>前置状态</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
}

const CSS = `body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:28px;color:#111;background:#fafafa}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.meta{color:#666;font-size:12px;margin-bottom:18px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:18px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee}
th{color:#666;font-weight:600;background:#fafafa}
.warn{color:#b45309;font-weight:600}
.kpis{display:flex;gap:22px;flex-wrap:wrap}
.kpi{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;min-width:120px}
.kpi b{display:block;font-size:20px}
.kpi span{color:#666;font-size:12px}`

/**
 * @param {{ courseTitle: string, chapters: object[], plan?: object[],
 *           knowledge?: object|null, byChapter?: object, meta?: object }} input
 */
export function renderDashboardHtml({ courseTitle, chapters = [], plan = [], knowledge = null, byChapter = {}, meta = {} }) {
  const concepts = knowledge?.concepts || []
  const edges = knowledge?.edges || []
  const blocked = plan.filter((step) => step.blocked).length
  const videos = Object.values(byChapter || {}).reduce((n, entry) => n + (entry?.videos?.length || 0), 0)
  const kpis = [
    { label: '章节', value: chapters.length },
    { label: '概念', value: concepts.length },
    { label: '前置关系', value: edges.length },
    { label: '前置阻塞', value: blocked },
    { label: '推荐视频', value: videos },
  ]
    .map((kpi) => `<div class="kpi"><b>${kpi.value}</b><span>${kpi.label}</span></div>`)
    .join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(courseTitle || '课程')} · 学习看板</title>
<style>${CSS}</style></head>
<body>
<h1>${escapeHtml(courseTitle || '课程')} · 学习看板</h1>
<div class="meta">生成于 ${escapeHtml(meta.generatedAt || '')}${meta.model ? ` · 模型 ${escapeHtml(meta.model)}` : ''}</div>
<div class="kpis">${kpis}</div>
<h2>章节与知识点</h2>
<div class="card">${renderSvg({ chapters, plan, knowledge })}</div>
<h2>学习计划</h2>
<div class="card">${plan.length ? planTable({ chapters, plan }) : '<p>本次未启用知识图（plan 为空）。</p>'}</div>
${blocked ? `<div class="card"><b>⚠ ${blocked} 章存在未满足的前置</b><p>先把「未满足」列出的概念补齐，再安排这些章的难点。</p></div>` : ''}
</body></html>`
}
