import { createBiliClient } from '../core/bili.js'

const mem = new Map()
const cache = {
  async get(k) {
    const v = mem.get(k)
    if (!v) return null
    if (v.exp && v.exp < Date.now()) return null
    return v.value
  },
  async set(k, value, ttl) {
    mem.set(k, { value, exp: ttl ? Date.now() + ttl : 0 })
  },
}

const bili = createBiliClient({ cache, log: (m) => console.log('LOG', m), spacingMs: 1100 })
const t0 = Date.now()
const res = await bili.search(process.argv[2] || '计算机系统基础', 10)
console.log('search ok', res.ok, res.reason || '', 'items', res.items.length, `${Date.now() - t0}ms`)
for (const it of res.items.slice(0, 6)) console.log(` - ${it.play.toString().padStart(9)} ${it.duration}s ${it.bvid} ${it.title.slice(0, 40)} | ${it.author}`)
const ranked = bili.rank(res.items, ['计算机系统', '基础'])
console.log('ranked', ranked.map((r) => `${r.score}:${r.title.slice(0, 24)}`))
const series = await bili.recommendSeries('计算机系统基础')
console.log('series', series.ok, series.series.map((s) => `${s.play} ${s.title.slice(0, 30)}`))
