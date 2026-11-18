/**
 * Fake OpenAI-compatible endpoint for local product testing.
 *
 *   node tools/stub-llm.mjs            # listens on 127.0.0.1:8787
 *   LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=stub node bin/run-job.mjs ...
 *
 * It streams the same generic chapter JSON that tools/e2e-fake.mjs feeds the
 * pipeline, so summaries, keywords and the report all come out non-empty
 * without spending a token.
 */
import { createServer } from 'node:http'

const port = Number(process.env.STUB_PORT || 8787)
const reply = JSON.stringify({
  chapter: '测试章',
  title: '测试章',
  summary: '这是替身模型生成的测试摘要，用来说明报告链路是通的。',
  overview: '测试概览',
  key_points: [
    { name: '要点一', detail: '第一条要点的说明。' },
    { name: '要点二', detail: '第二条要点的说明。' },
  ],
  modules: [
    {
      name: '测试模块',
      points: [
        { id: 'K1.1', name: '知识点一', definition: '定义一', plain: '通俗解释一', tag: '整理' },
      ],
    },
  ],
  examples: [],
  exercises: [],
  answers: [],
  important: [],
  difficult: [],
  pitfalls: [],
  questions: [],
  keywords: ['测试', '课程助手'],
})

// MAX / PLUS 的每章复习资料（review JSON）；没有它 PLUS 的五册会是空的
const reviewReply = JSON.stringify({
  chapter: '测试章',
  title: '测试章',
  overview: '测试概览',
  modules: [
    {
      name: '测试模块',
      points: [
        {
          id: 'K1.1',
          name: '知识点一',
          definition: '定义一',
          plain: '通俗解释一',
          conditions: '适用条件',
          mastery: '理解',
          formula: '',
          links: '',
          pitfalls: '易错点一',
          source: '第 1 页',
          tag: '整理',
          quote: '原文摘录',
        },
      ],
    },
  ],
  examples: [],
  exercises: [{ id: 'Q1.1', origin: '补充练习', stem: '题干一', options: [], points: ['K1.1'], type: '简答', difficulty: '中' }],
  answers: [{ id: 'Q1.1', text: '第一步写出定义；第二步代入条件；第三步得出结论', note: '参考解答，非课件原答案' }],
  summary: { oneLine: '一句话', logic: [], remember: [], understand: [], tasks: [] },
})

const frameworkReply = JSON.stringify({ theme: '测试主题', goals: ['理解测试知识点'], summary: '测试总结' })

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    if (!req.url || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"not found"}}')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // 报告档位不同，提示词不同：框架、复习资料、普通要点各回各的 JSON
    const answer = body.includes('复习框架') ? frameworkReply : body.includes('复习资料') ? reviewReply : reply
    const pieces = answer.match(/[\s\S]{1,64}/g) || []
    let index = 0
    const timer = setInterval(() => {
      if (index < pieces.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[index++] } }] })}\n\n`)
        return
      }
      clearInterval(timer)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }, 5)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`stub llm listening on http://127.0.0.1:${port}/v1`)
})
