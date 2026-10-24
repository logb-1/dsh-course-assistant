/* Client half of dsh-course-assistant.
   Drag-and-drop course files → outline → knowledge points + Bilibili courses.
   Talks to the Host half over same-origin routes; no other network access. */

/* The module id must be the package name: the web boot counts an entry as
   activated only when a factory is registered under that exact id. It used to
   be the old workspace alias `@local/course-assistant`, which DSH 0.2.1-rc.3
   no longer forgives ("web boot: 1 entry did not activate"). The window guard
   also keeps a second evaluation of this file from registering twice. */
if (!window.__COURSE_ASSISTANT_CLIENT__) {
  window.__COURSE_ASSISTANT_CLIENT__ = true
  window.__ModuleLoader__.load({
  id: 'dsh-course-assistant',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback } = React

    const ROUTE = '/course-assistant'
    const ACCEPT = '.pptx,.pdf,.docx,.md,.txt,.markdown'
    const EXT = ACCEPT.split(',')

    const CSS = `
    .ca-root{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);height:100%;display:flex;flex-direction:column;min-height:0;font-size:13px;line-height:1.6}
    .ca-head{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
    .ca-title{font-size:15px;font-weight:600;margin:0}
    .ca-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
    .ca-sp{flex:1}
    .ca-body{flex:1;overflow:auto;padding:16px 18px 32px;min-height:0}
    .ca-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;line-height:1.5}
    .ca-btn:hover{background:var(--dsw-alias-bg-layer-2)}
    .ca-btn[disabled]{opacity:.45;cursor:not-allowed}
    .ca-btn.pri{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
    .ca-btn.small{padding:2px 8px;font-size:11.5px}
    .ca-drop{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:14px;padding:26px 18px;text-align:center;background:var(--dsw-alias-bg-layer-1);transition:background .15s,border-color .15s;cursor:pointer}
    .ca-drop.hot{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
    .ca-drop-icon{font-size:26px;line-height:1}
    .ca-drop-title{font-weight:600;margin-top:6px}
    .ca-drop-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px}
    .ca-files{display:flex;flex-direction:column;gap:6px;margin:12px 0}
    .ca-file{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1)}
    .ca-file-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ca-file-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:ui-monospace,Menlo,monospace}
    .ca-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .ca-opt{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
    .ca-prog{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:8px 0}
    .ca-prog>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}
    .ca-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);margin-bottom:10px}
    .ca-phase{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
    .ca-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin:8px 0 14px}
    .ca-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:7px 14px;cursor:pointer;border-bottom:2px solid transparent;font-size:13px}
    .ca-tab[data-on="1"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
    .ca-ch{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 14px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1)}
    .ca-ch-head{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}
    .ca-ch-title{font-weight:600;font-size:13.5px}
    .ca-ch-subs{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:2px}
    .ca-conf.ok{color:var(--dsw-alias-state-success-primary)}
    .ca-conf.warn{color:var(--dsw-alias-state-warn-primary)}
    .ca-conf.err{color:var(--dsw-alias-state-error-primary)}
    .ca-ch-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .ca-diff{margin-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px}
    .ca-diff-h{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
    .ca-diff ul{margin:2px 0;padding-left:18px;font-size:12px}
    .ca-diff .add{color:var(--dsw-alias-state-success-primary)}
    .ca-diff .del{color:var(--dsw-alias-state-error-primary)}
    .ca-ul{margin:6px 0 0;padding-left:18px}
    .ca-ul li{margin:2px 0}
    .ca-tag{display:inline-block;border-radius:999px;padding:0 8px;font-size:11px;line-height:1.8;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
    .ca-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
    .ca-tag.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
    .ca-tag.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
    .ca-err{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;margin:10px 0;font-size:12.5px}
    .ca-note{border-left:3px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px 12px;margin:8px 0;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
    .ca-md{font-size:13px}
    .ca-md h1{font-size:18px;margin:14px 0 10px;font-weight:700}
    .ca-md h2{font-size:15px;margin:16px 0 8px;font-weight:650;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:4px}
    .ca-md h3{font-size:13.5px;margin:12px 0 6px;font-weight:600}
    .ca-md p{margin:6px 0}
    .ca-md ul{margin:6px 0;padding-left:20px}
    .ca-md blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
    .ca-md table{border-collapse:collapse;width:100%;font-size:12px;margin:8px 0}
    .ca-md th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2);padding:5px 8px}
    .ca-md td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:5px 8px;vertical-align:top}
    .ca-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}
    .ca-md a:hover{text-decoration:underline}
    .ca-md code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px}
    .ca-empty{color:var(--dsw-alias-label-secondary);padding:10px 0;font-size:12.5px}
    .ca-feed{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;margin:12px 0;background:var(--dsw-alias-bg-layer-1)}
    .ca-feed.warn{border-color:var(--dsw-alias-state-warn-primary)}
    .ca-feed-q{font-size:13px;font-weight:600;margin-bottom:8px}
    .ca-reason{color:var(--dsw-alias-label-secondary);font-size:12px;margin:2px 0 0 14px;list-style:disc}
    .ca-gap{height:6px}
    .ca-dock{display:flex;align-items:center;gap:8px;font-size:11.5px;opacity:.9;padding:2px 0}
    .ca-dock button{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:11.5px;padding:0 4px}
    .ca-panel-icon{display:block}
    `

    /* ------------------------------ markdown ------------------------------ */

    const inline = (text, keyBase) => {
      const nodes = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)|]+)/g
      let last = 0
      let m
      let i = 0
      while ((m = re.exec(text))) {
        if (m.index > last) nodes.push(text.slice(last, m.index))
        const token = m[0]
        if (token.startsWith('**')) nodes.push(h('b', { key: `${keyBase}-b${i++}` }, token.slice(2, -2)))
        else if (token.startsWith('`')) nodes.push(h('code', { key: `${keyBase}-c${i++}` }, token.slice(1, -1)))
        else if (token.startsWith('[')) {
          const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          nodes.push(
            h('a', { key: `${keyBase}-a${i++}`, href: mm[2], target: '_blank', rel: 'noreferrer' }, mm[1]),
          )
        } else {
          nodes.push(h('a', { key: `${keyBase}-u${i++}`, href: token, target: '_blank', rel: 'noreferrer' }, token))
        }
        last = m.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function Markdown({ text }) {
      const blocks = useMemo(() => {
        const lines = String(text || '').split('\n')
        const out = []
        let i = 0
        let list = null
        const flushList = () => {
          if (list) {
            out.push(h('ul', { key: `ul${out.length}` }, list.map((t, k) => h('li', { key: k }, inline(t, `li${out.length}-${k}`)))))
            list = null
          }
        }
        while (i < lines.length) {
          const line = lines[i]
          const trimmed = line.trim()
          if (!trimmed) {
            flushList()
            i++
            continue
          }
          if (/^<!--/.test(trimmed)) {
            i++
            continue
          }
          const head = /^(#{1,4})\s+(.*)$/.exec(trimmed)
          if (head) {
            flushList()
            out.push(h(`h${Math.min(4, head[1].length)}`, { key: `h${i}` }, inline(head[2], `h${i}`)))
            i++
            continue
          }
          if (/^\|/.test(trimmed)) {
            flushList()
            const rows = []
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
              const cells = lines[i]
                .trim()
                .replace(/^\|/, '')
                .replace(/\|$/, '')
                .split('|')
                .map((c) => c.trim())
              if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
              i++
            }
            if (rows.length) {
              const [header, ...body] = rows
              out.push(
                h(
                  'table',
                  { key: `t${i}` },
                  h('thead', null, h('tr', null, header.map((c, k) => h('th', { key: k }, inline(c, `th${i}-${k}`))))),
                  h(
                    'tbody',
                    null,
                    body.map((r, k) =>
                      h('tr', { key: k }, r.map((c, j) => h('td', { key: j }, inline(c, `td${i}-${k}-${j}`)))),
                    ),
                  ),
                ),
              )
            }
            continue
          }
          if (/^[-*+]\s+/.test(trimmed)) {
            if (!list) list = []
            list.push(trimmed.replace(/^[-*+]\s+/, ''))
            i++
            continue
          }
          if (/^>\s?/.test(trimmed)) {
            flushList()
            const quoted = []
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
              quoted.push(lines[i].replace(/^\s*>\s?/, ''))
              i++
            }
            out.push(h('blockquote', { key: `q${i}` }, inline(quoted.join(' '), `q${i}`)))
            continue
          }
          if (/^---+$/.test(trimmed)) {
            flushList()
            out.push(h('p', { key: `hr${i}` }, '—'))
            i++
            continue
          }
          flushList()
          out.push(h('p', { key: `p${i}` }, inline(trimmed, `p${i}`)))
          i++
        }
        flushList()
        return out
      }, [text])
      return h('div', { className: 'ca-md' }, blocks)
    }

    /* -------------------------------- pieces -------------------------------- */

    const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

    const qualityLabel = (q) => {
      if (!q) return ''
      const label = { good: '可读', fair: '一般', unusable: '不可用' }[q.tier] || q.tier
      const m = q.metrics || {}
      return `${label}（${m.charsPerUnit || 0} 字/${m.pageBased ? '页' : '节'}，全文 ${m.chars || 0} 字）`
    }

    function DropZone({ onFiles, busy }) {
      const [hot, setHot] = useState(false)
      const inputRef = useRef(null)
      const pick = () => inputRef.current?.click()
      const handleDrop = (e) => {
        e.preventDefault()
        e.stopPropagation()
        setHot(false)
        if (busy) return
        const files = [...(e.dataTransfer?.files || [])]
        if (files.length) onFiles(files)
      }
      return h(
        'div',
        {
          className: `ca-drop${hot ? ' hot' : ''}`,
          onClick: pick,
          onDragOver: (e) => {
            e.preventDefault()
            setHot(true)
          },
          onDragLeave: () => setHot(false),
          onDrop: handleDrop,
          role: 'button',
          tabIndex: 0,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') pick()
          },
        },
        h('div', { className: 'ca-drop-icon' }, '🎓'),
        h('div', { className: 'ca-drop-title' }, hot ? '松手即可上传' : '把课程文件拖到这里'),
        h('div', { className: 'ca-drop-hint' }, '支持 .pptx / .pdf / .docx / .md / .txt，可一次多个；也可以点击选择文件'),
        h('input', {
          ref: inputRef,
          type: 'file',
          multiple: true,
          accept: ACCEPT,
          style: { display: 'none' },
          onChange: (e) => {
            const files = [...(e.target.files || [])]
            if (files.length) onFiles(files)
            e.target.value = ''
          },
        }),
      )
    }

    function Progress({ job }) {
      if (!job) return null
      const pct = Math.round((job.progress || 0) * 100)
      const tone = job.status === 'error' ? 'err' : job.status === 'done' ? 'ok' : 'warn'
      return h(
        'div',
        { className: 'ca-card' },
        h(
          'div',
          { className: 'ca-row' },
          h('span', { className: `ca-tag ${tone}` }, job.status === 'done' ? '完成' : job.status === 'error' ? '失败' : '进行中'),
          h('span', { className: 'ca-phase' }, job.message || ''),
          h('span', { className: 'ca-sp' }),
          h('span', { className: 'ca-phase' }, `${pct}%`),
          job.elapsedMs ? h('span', { className: 'ca-phase' }, `· ${(job.elapsedMs / 1000).toFixed(1)}s`) : null,
        ),
        h('div', { className: 'ca-prog' }, h('i', { style: { width: `${Math.max(3, pct)}%` } })),
        job.quality
          ? h(
              'div',
              { className: 'ca-phase', style: { marginTop: 6 } },
              `文本可读性：${qualityLabel(job.quality)}`,
            )
          : null,
        job.domain
          ? h(
              'div',
              { className: 'ca-phase', style: { marginTop: 4 } },
              `领域锚定：${job.domain.name}${job.domain.source === 'config' ? '（配置）' : '（自动识别）'} · 网课检索与排序按此校正`,
            )
          : null,
        job.error ? h('div', { className: 'ca-err' }, job.error) : null,
        (job.warnings || []).slice(0, 4).map((w, i) => h('div', { className: 'ca-note', key: i }, w)),
      )
    }

    const pointText = (p) => (typeof p === 'string' ? p : String(p?.text ?? ''))
    const confidenceText = (c) => {
      const conf = c?.confidence || c?.summary?.confidence
      if (!conf) return c?.support != null ? `与原文重合 ${Math.round(c.support * 100)}%` : ''
      const ev = conf.evidence || {}
      const bits = []
      if (ev.checked) bits.push(`引文核对 ${ev.exact + ev.fuzzy}/${ev.checked} 条`)
      if (conf.overlap != null) bits.push(`词面重合 ${Math.round(conf.overlap * 100)}%`)
      return bits.join(' · ')
    }
    const confidenceClass = (c) => {
      const tier = c?.confidence?.tier || c?.summary?.tier
      return tier === 'suspect' ? 'err' : tier === 'weak' ? 'warn' : 'ok'
    }

    function ChapterList({ job, busy, onRerunChapter }) {
      const chapters = job?.chapters || []
      if (!chapters.length) return h('div', { className: 'ca-empty' }, '目录识别完成后会在这里逐章显示。')
      const canRerun = typeof onRerunChapter === 'function' && job?.status === 'done'
      return h(
        'div',
        null,
        chapters.map((c) => {
          const diff = c.diff
          const changed = diff && (diff.added?.length || diff.removed?.length)
          return h(
            'div',
            { className: 'ca-ch', key: c.index },
            h(
              'div',
              { className: 'ca-ch-head' },
              h(
                'div',
                null,
                h('div', { className: 'ca-ch-title' }, `第 ${c.index} 章 ${c.title}`),
                c.subs?.length ? h('div', { className: 'ca-ch-subs' }, c.subs.slice(0, 5).join(' · ')) : null,
                c.support != null || c.confidence
                  ? h('div', { className: `ca-ch-subs ca-conf ${confidenceClass(c)}` }, confidenceText(c))
                  : null,
              ),
              h(
                'div',
                { className: 'ca-ch-actions' },
                canRerun
                  ? h(
                      'button',
                      {
                        className: 'ca-btn small',
                        title: '只用这一章重新总结，其余章节保持不变',
                        disabled: busy,
                        onClick: () => onRerunChapter(c.index),
                      },
                      '重跑本章',
                    )
                  : null,
                h('span', { className: `ca-tag ${c.status === 'done' ? 'ok' : 'warn'}` }, c.status === 'done' ? '已总结' : '处理中'),
              ),
            ),
            c.summary
              ? h(
                  'ul',
                  { className: 'ca-ul' },
                  (c.summary.key_points || []).map((p, i) =>
                    h('li', { key: `k${i}` }, pointText(p) + (p?.page ? `（p.${p.page}）` : '')),
                  ),
                  (c.summary.important || []).map((p, i) => h('li', { key: `i${i}` }, `⭐ 重点：${p}`)),
                  (c.summary.difficult || []).map((p, i) => h('li', { key: `d${i}` }, `⚠️ 难点：${p}`)),
                )
              : h('div', { className: 'ca-empty' }, '排队中…'),
            c.summary?.keywords?.length
              ? h('div', { style: { marginTop: 6 } }, c.summary.keywords.map((k, i) => h('span', { className: 'ca-tag', key: i, style: { marginRight: 6 } }, k)))
              : null,
            diff
              ? h(
                  'div',
                  { className: 'ca-diff' },
                  h(
                    'div',
                    { className: 'ca-diff-h' },
                    `第 ${c.index} 章重跑于 ${String(c.rerunAt || '').slice(11, 16)}：+${diff.added?.length || 0} −${diff.removed?.length || 0} 条要点` +
                      (changed ? '' : '（内容一致）'),
                  ),
                  diff.added?.length
                    ? h('ul', null, diff.added.map((b, i) => h('li', { key: `a${i}`, className: 'add' }, `+ [${b.kind}] ${b.text}`)))
                    : null,
                  diff.removed?.length
                    ? h('ul', null, diff.removed.map((b, i) => h('li', { key: `r${i}`, className: 'del' }, `− [${b.kind}] ${b.text}`)))
                    : null,
                  diff.keywordsAdded?.length
                    ? h('div', { className: 'ca-ch-subs' }, `新增关键词：${diff.keywordsAdded.join('、')}`)
                    : null,
                )
              : null,
          )
        }),
      )
    }

    function VideoList({ job }) {
      const byChapter = job?.byChapter || {}
      const series = job?.series || []
      return h(
        'div',
        null,
        job?.fallback
          ? h('div', { className: 'ca-note' }, 'B 站检索触发风控，报告附录使用搜索链接；点“报告”页可复制。')
          : null,
        h('h3', { style: { margin: '4px 0 8px', fontSize: 13.5 } }, '系列课程'),
        series.length
          ? h(
              'ul',
              { className: 'ca-ul' },
              series.map((s, i) =>
                h(
                  'li',
                  { key: i },
                  h('a', { href: s.url, target: '_blank', rel: 'noreferrer' }, s.title),
                  h('span', { className: 'ca-file-meta', style: { marginLeft: 6 } }, `${s.author || ''} · ${s.play || 0} 播放`),
                ),
              ),
            )
          : h('div', { className: 'ca-empty' }, '暂无（或检索中）'),
        h('h3', { style: { margin: '14px 0 8px', fontSize: 13.5 } }, '分章节视频'),
        Object.keys(byChapter).length
          ? Object.entries(byChapter).map(([idx, row]) =>
              h(
                'div',
                { className: 'ca-card', key: idx },
                h('div', { style: { fontWeight: 600, marginBottom: 4 } }, `第 ${idx} 章`),
                (row.videos || []).length
                  ? h(
                      'ul',
                      { className: 'ca-ul' },
                      row.videos.map((v, i) =>
                        h(
                          'li',
                          { key: i },
                          h('a', { href: v.bestPart ? `${v.url}?p=${v.bestPart.page}` : v.url, target: '_blank', rel: 'noreferrer' }, v.title + (v.bestPart ? `（第 ${v.bestPart.page}P）` : '')),
                          h('span', { className: 'ca-file-meta', style: { marginLeft: 6 } }, `${v.author} · ${v.play} 播放 · 评分 ${v.score}`),
                        ),
                      ),
                    )
                  : h('div', { className: 'ca-empty' }, `无结果，可搜：${(row.queries || []).join(' / ')}`),
              ),
            )
          : h('div', { className: 'ca-empty' }, '暂无（或检索中）'),
      )
    }

    function Toc({ job }) {
      const chapters = job?.chapters || []
      if (!chapters.length) return h('div', { className: 'ca-empty' }, '暂无目录')
      return h(
        'div',
        null,
        h('div', { className: 'ca-sub', style: { marginBottom: 8 } }, `${job.courseTitle || '课程'} · ${chapters.length} 章`),
        h(
          'ul',
          { className: 'ca-ul' },
          chapters.map((c) =>
            h(
              'li',
              { key: c.index },
              h('b', null, `${c.index}. ${c.title}`),
              c.subs?.length
                ? h(
                    'ul',
                    { className: 'ca-ul', style: { marginTop: 2 } },
                    c.subs.slice(0, 6).map((s, i) => h('li', { key: i, className: 'ca-sub' }, s)),
                  )
                : null,
            ),
          ),
        ),
      )
    }

    function Feedback({ job, health, busy, onRerun, onPickFiles }) {
      const [ack, setAck] = useState(false)
      const [open, setOpen] = useState(false)
      if (!job || job.status !== 'done') return null
      const q = job.quality
      const poor = q && q.tier !== 'good'
      if (ack) {
        return h('div', { className: 'ca-feed' }, h('div', { className: 'ca-feed-q' }, '已确认，这份报告可以直接用。'))
      }
      return h(
        'div',
        { className: `ca-feed${poor ? ' warn' : ''}` },
        h('div', { className: 'ca-feed-q' }, poor ? '结果可能不太对：这份文件的文字没读全，要继续吗？' : '这次结果符合你的预期吗？'),
        poor && q.reasons?.length
          ? h('ul', { className: 'ca-reason' }, q.reasons.slice(0, 3).map((r, i) => h('li', { key: i }, r)))
          : null,
        h(
          'div',
          { className: 'ca-row', style: { marginTop: 10 } },
          h('button', { className: 'ca-btn pri', onClick: () => setAck(true) }, '符合，就这样'),
          h('button', { className: 'ca-btn', onClick: () => setOpen((v) => !v) }, open ? '收起' : '不太行，换个方式'),
        ),
        open
          ? h(
              'div',
              { style: { marginTop: 10 } },
              h(
                'div',
                { className: 'ca-row' },
                h(
                  'button',
                  {
                    className: 'ca-btn',
                    disabled: busy,
                    onClick: () => {
                    onRerun({ withVideos: false })
                  },
                  },
                  '关闭网课检索后重跑',
                ),
                h('button', { className: 'ca-btn', disabled: busy, onClick: onPickFiles }, '换源文件（.pptx/.docx）'),
                h(
                  'button',
                  {
                    className: 'ca-btn',
                    disabled: busy || !health?.ocr,
                    title: health?.ocr ? '用 OCR 重新读取页面' : '当前环境未启用 OCR',
                    onClick: () => onRerun({ ocr: true }),
                  },
                  health?.ocr ? 'OCR 重读' : 'OCR 重读（未启用）',
                ),
              ),
              h(
                'div',
                { className: 'ca-note', style: { marginTop: 8 } },
                poor
                  ? '优先换源文件：导出型 PDF 的汉字常以字形编号存储，转格式也救不回来；原始 .pptx/.docx 能 100% 读到文字。'
                  : '如果章节切得太碎或太粗，换源文件通常比调参更有效。',
              ),
            )
          : null,
      )
    }

    /* --------------------------------- app --------------------------------- */

    function Panel() {
      const [files, setFiles] = useState([])
      const [withVideos, setWithVideos] = useState(true)
      const [job, setJob] = useState(null)
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState('')
      const [tab, setTab] = useState('points')
      const [report, setReport] = useState('')
      const [health, setHealth] = useState(null)
      const timer = useRef(null)

      useEffect(() => {
        let dead = false
        fetch(`${ROUTE}/health`, { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((j) => {
            if (!dead) setHealth(j)
          })
          .catch(() => {})
        return () => {
          dead = true
        }
      }, [])

      useEffect(
        () => () => {
          if (timer.current) clearInterval(timer.current)
        },
        [],
      )

      const addFiles = useCallback((list) => {
        setError('')
        setFiles((prev) => {
          const merged = [...prev]
          for (const f of list) {
            const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
            if (!EXT.includes(ext)) {
              setError(`不支持的文件：${f.name}`)
              continue
            }
            if (f.size > 60 * 1024 * 1024) {
              setError(`文件过大（>60MB）：${f.name}`)
              continue
            }
            if (!merged.some((x) => x.name === f.name && x.size === f.size)) merged.push(f)
          }
          return merged.slice(0, 12)
        })
      }, [])

      const stopPolling = () => {
        if (timer.current) {
          clearInterval(timer.current)
          timer.current = null
        }
      }

      const poll = useCallback((jobId) => {
        stopPolling()
        timer.current = setInterval(async () => {
          try {
            const res = await fetch(`${ROUTE}/job?id=${encodeURIComponent(jobId)}`, { credentials: 'same-origin' })
            const data = await res.json()
            if (!data.ok) throw new Error(data.reason || '查询失败')
            setJob(data.job)
            if (data.job.status !== 'running') {
              stopPolling()
              setPhase(data.job.status === 'done' ? 'done' : 'error')
              if (data.job.status === 'error') setError(data.job.error || '分析失败')
              if (data.job.status === 'done') {
                setTab('points')
                fetch(`${ROUTE}/report?id=${encodeURIComponent(jobId)}&format=md`, { credentials: 'same-origin' })
                  .then((r) => (r.ok ? r.text() : ''))
                  .then((t) => setReport(t))
                  .catch(() => {})
              }
            }
          } catch (e) {
            stopPolling()
            setPhase('error')
            setError(String(e.message || e))
          }
        }, 900)
      }, [])

      const start = async () => {
        if (!files.length || phase === 'uploading' || phase === 'running') return
        setError('')
        setReport('')
        setJob(null)
        setPhase('uploading')
        try {
          const uploaded = []
          for (const f of files) {
            const res = await fetch(`${ROUTE}/upload?name=${encodeURIComponent(f.name)}`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/octet-stream' },
              body: f,
            })
            const data = await res.json()
            if (!data.ok) throw new Error(data.reason || `上传失败：${f.name}`)
            uploaded.push(data.file)
          }
          const res = await fetch(`${ROUTE}/run`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ files: uploaded.map((u) => ({ id: u.id })), options: { withVideos } }),
          })
          const data = await res.json()
          if (!data.ok) throw new Error(data.reason || '任务启动失败')
          setPhase('running')
          setJob({ id: data.jobId, status: 'running', phase: 'queued', message: '已提交，正在解析…', progress: 0.01, chapters: [], byChapter: {}, series: [] })
          poll(data.jobId)
        } catch (e) {
          setPhase('error')
          setError(String(e.message || e))
        }
      }

      const reset = () => {
        stopPolling()
        setFiles([])
        setJob(null)
        setReport('')
        setError('')
        setPhase('idle')
      }

      const rerun = async (options, chapterIndex) => {
        const jobId = job?.id
        if (!jobId || phase === 'running') return
        setError('')
        setPhase('running')
        try {
          const res = await fetch(`${ROUTE}/rerun`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId, options, chapterIndex }),
          })
          const data = await res.json()
          if (!data.ok) throw new Error(data.reason || '重跑失败')
          setReport('')
          if (chapterIndex) {
            // keep the other chapters on screen; only this one is being redone
            setJob({ ...job, id: data.jobId, status: 'running', phase: 'rerun', message: `重跑第 ${chapterIndex} 章…` })
          } else {
            setJob({ id: data.jobId, status: 'running', phase: 'queued', message: '重新解析…', progress: 0.01, chapters: [], byChapter: {}, series: [] })
          }
          poll(data.jobId)
        } catch (e) {
          setPhase('error')
          setError(String(e.message || e))
        }
      }

      const busy = phase === 'uploading' || phase === 'running'
      const jobId = job?.id
      const download = (fmt) => {
        if (jobId) window.open(`${ROUTE}/report?id=${encodeURIComponent(jobId)}&format=${fmt}`, '_blank')
      }

      return h(
        'div',
        { className: 'ca-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          { className: 'ca-head' },
          h('h2', { className: 'ca-title' }, '课程助手'),
          h('span', { className: 'ca-sub' }, '课程文件 → 目录 · 知识点 · B 站网课 · 学习报告'),
          h('span', { className: 'ca-sp' }),
          health && !health.llm ? h('span', { className: 'ca-tag warn' }, '模型不可用：将用本地兜底摘要') : null,
          health && !health.pdf ? h('span', { className: 'ca-tag' }, 'PDF 导出不可用') : null,
          h('button', { className: 'ca-btn small', onClick: reset, disabled: busy }, '清空'),
        ),
        h(
          'div',
          { className: 'ca-body' },
          h(
            'div',
            { style: { display: phase === 'idle' || busy || error ? 'block' : 'none' } },
            h(DropZone, { onFiles: addFiles, busy }),
            files.length
              ? h(
                  'div',
                  { className: 'ca-files' },
                  files.map((f, i) =>
                    h(
                      'div',
                      { className: 'ca-file', key: `${f.name}-${i}` },
                      h('span', { className: 'ca-file-name' }, f.name),
                      h('span', { className: 'ca-file-meta' }, fmtSize(f.size)),
                      h('span', { className: 'ca-sp' }),
                      h(
                        'button',
                        {
                          className: 'ca-btn small',
                          disabled: busy,
                          onClick: () => setFiles((prev) => prev.filter((_, k) => k !== i)),
                        },
                        '移除',
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'ca-row', style: { marginTop: 10 } },
              h(
                'label',
                { className: 'ca-opt' },
                h('input', { type: 'checkbox', checked: withVideos, onChange: (e) => setWithVideos(e.target.checked), disabled: busy }),
                '检索 B 站网课',
              ),
              h('span', { className: 'ca-sp' }),
              h(
                'button',
                { className: 'ca-btn pri', onClick: start, disabled: !files.length || busy },
                busy ? '处理中…' : `开始分析${files.length ? `（${files.length} 个文件）` : ''}`,
              ),
            ),
            error ? h('div', { className: 'ca-err' }, error) : null,
          ),
          h(Progress, { job }),
          h(Feedback, { job, health, busy, onRerun: rerun, onPickFiles: reset }),
          job?.chapters?.length
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'ca-tabs' },
                  ['points', 'toc', 'videos', 'report'].map((key) =>
                    h(
                      'button',
                      { key, className: 'ca-tab', 'data-on': tab === key ? '1' : '0', onClick: () => setTab(key) },
                      { points: '知识点', toc: '目录', videos: 'B 站网课', report: '报告' }[key],
                    ),
                  ),
                  h('span', { className: 'ca-sp' }),
                  tab === 'report'
                    ? h(
                        'span',
                        { className: 'ca-row' },
                        h('button', { className: 'ca-btn small', onClick: () => download('md'), disabled: !job?.hasReport }, '下载 MD'),
                        h('button', { className: 'ca-btn small', onClick: () => download('pdf'), disabled: !job?.hasReport || (health && !health.pdf) }, '导出 PDF'),
                        h('button', { className: 'ca-btn small', title: 'Anki 闪卡（CSV）', onClick: () => download('csv'), disabled: !job?.hasReport }, 'Anki 卡片'),
                        h('button', { className: 'ca-btn small', title: '结构化 course.json', onClick: () => download('json'), disabled: !job?.hasReport }, 'course.json'),
                        h(
                          'button',
                          {
                            className: 'ca-btn small',
                            disabled: !report,
                            onClick: () => navigator.clipboard?.writeText(report),
                          },
                          '复制',
                        ),
                      )
                    : null,
                ),
                tab === 'points'
                  ? h(ChapterList, { job, busy, onRerunChapter: (index) => rerun({ withVideos }, index) })
                  : null,
                tab === 'toc' ? h(Toc, { job }) : null,
                tab === 'videos' ? h(VideoList, { job }) : null,
                tab === 'report'
                  ? report
                    ? h(Markdown, { text: report })
                    : h('div', { className: 'ca-empty' }, job.status === 'done' ? '报告生成中…' : '完成后可查看完整报告')
                  : null,
              )
            : null,
        ),
      )
    }

    /* ------------------------------- entries ------------------------------- */

    function PanelIcon({ size = 18, active = false }) {
      return h(
        'svg',
        {
          className: 'ca-panel-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
        },
        h('rect', {
          x: 2.5,
          y: 3.5,
          width: 19,
          height: 15,
          rx: 3,
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.6,
          opacity: active ? 1 : 0.85,
        }),
        h('path', { d: 'M9.5 8.2v5.6l4.8-2.8-4.8-2.8Z', fill: 'currentColor' }),
        h('path', { d: 'M7.5 21h9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function Dock({ open }) {
      return h(
        'div',
        { className: 'ca-dock' },
        h('span', null, '🎓 课程助手'),
        h('button', { onClick: open }, '打开面板 →'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const off = []
        const layout = (() => {
          try {
            return ctx.get?.('layout') || ctx.layout
          } catch {
            return null
          }
        })()
        const open = () => {
          try {
            layout?.selectPanel?.('course-assistant')
          } catch {}
        }
        try {
          off.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'course-assistant' }, Panel)))
        } catch {}
        try {
          off.push(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register({ name: 'sidebar.panellist', id: 'course-assistant', order: 20, label: () => '课程助手' }, PanelIcon),
            ),
          )
        } catch {}
        try {
          off.push(
            ctx.slots.inject('conversation.composer.dock', () =>
              ctx.slots.register({ name: 'conversation.composer.dock', id: 'course-assistant-dock', order: 60 }, (props) =>
                h(Dock, { ...props, open }),
              ),
            ),
          )
        } catch {}
        ctx.effect?.(() => () => {
          for (const d of off) {
            try {
              typeof d === 'function' ? d() : d?.dispose?.()
            } catch {}
          }
        })
      },
    }
  },
})
}