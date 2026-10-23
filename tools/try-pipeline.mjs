import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from '../core/store.js'
import { runPipeline } from '../core/pipeline.js'

const dataDir = join(process.cwd(), 'course-assistant', '.tmp-data')
rmSync(dataDir, { recursive: true, force: true })
const store = createStore(dataDir)

const fakeLlm = {
  provider: 'fake',
  model: 'fake-model',
  stream(options) {
    const prompt = options.messages[0].content[0].text
    let reply
    if (options.system.includes('JSON')) {
      const chapter = /章节：(.*)/.exec(prompt)?.[1] || '章'
      reply = JSON.stringify({
        chapter,
        key_points: ['要点 A：本地解析得到的结构', '要点 B：模型只收到本章文本', '要点 C：关键词直接复用为检索词'],
        important: ['核心恒等式与口径'],
        difficult: ['参数可加性假设'],
        keywords: ['线性代数', '矩阵'],
      })
    } else {
      reply = '这是一段不超过三百字的课程总结，用于验证管线。'
    }
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

const stubBili = {
  async recommendSeries() {
    return {
      ok: true,
      fallback: false,
      series: [
        { bvid: 'BV1xx411c7mD', title: '示例系列课 · 线性代数全集', author: 'UP甲', play: 1234567, duration: 36000, url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      ],
    }
  },
  async recommendChapter(keywords) {
    return {
      ok: true,
      fallback: false,
      queries: keywords,
      videos: [
        {
          bvid: 'BV1yy411c7mE',
          title: `${keywords[0] || '本章'} 精讲`,
          author: 'UP乙',
          play: 45678,
          duration: 1520,
          score: 0.87,
          url: 'https://www.bilibili.com/video/BV1yy411c7mE',
        },
      ],
    }
  },
}

const file = process.argv[2] || '关上800美元的小门_课程汇报.pptx'
const job = await runPipeline({
  id: 'dryrun01',
  inputs: [{ path: file, name: file.split(/[\\/]/).pop() }],
  options: { withVideos: true, concurrency: 4 },
  deps: { store, bili: stubBili, llm: fakeLlm },
  emit: () => {},
})
console.log('status', job.status, 'phase', job.phase, 'elapsed', job.elapsedMs, 'ms')
console.log('chapters', job.chapters.length, 'videos', Object.keys(job.byChapter).length, 'series', job.series.length)
console.log('report', job.reportPath)
console.log('---- head of report ----')
console.log(readFileSync(job.reportPath, 'utf8').split('\n').slice(0, 30).join('\n'))
console.log('---- tail of report ----')
const lines = readFileSync(job.reportPath, 'utf8').split('\n')
console.log(lines.slice(-12).join('\n'))
