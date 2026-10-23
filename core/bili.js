/**
 * Bilibili video search: WBI signing, relevance scoring, 24h cache, fallback.
 *
 * The WBI algorithm follows bilibili-API-collect
 * (https://github.com/SocialSisterYi/bilibili-API-collect, archived reference).
 * Nemo2011/bilibili-api is archived too, so we sign in-tree instead of pinning
 * an unmaintained package; only the public web search endpoint is used, with
 * no account data and no login.
 */
import { createHash } from 'node:crypto'
import { anchorQuery, conflictsDomain, mentionsDomain } from './domain.js'

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
  42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
  60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const API = 'https://api.bilibili.com'
const MIN_DURATION_SEC = 180
const SERIES_HINT = /合集|系列|全集|全套|完整版|全\s*\d+\s*[集讲]|课程|教程|速成|系统课|从零|入门到|精讲/
const STOP_WORDS = new Set(['的', '了', '和', '与', '及', '在', '是', '为', 'the', 'and', 'of', 'for', 'a', 'an'])

export const searchLink = (keyword) =>
  `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`

/** Course titles carry cover-page noise ("课程汇报", "复习&自学大纲"); strip it. */
function cleanTitle(title) {
  return String(title || '')
    .replace(/[《》「」“”"'〔〕【】]/g, '')
    .replace(/[_·]+/g, ' ')
    .replace(/(课程汇报|课程设计|复习\s*&\s*自学大纲|复习大纲|自学大纲|学习报告|课件|讲义|PPT|ppt)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
}

function md5(s) {
  return createHash('md5').update(s, 'utf8').digest('hex')
}

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
}

function signedQuery(params, key) {
  const all = { ...params, wts: Math.round(Date.now() / 1000) }
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  return `${query}&w_rid=${md5(query + key)}`
}

function parseDuration(s) {
  if (typeof s === 'number') return s
  const parts = String(s || '0')
    .split(':')
    .map((n) => Number(n) || 0)
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

const fmtDuration = (sec) => {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '')

function cjkTerms(run) {
  if (run.length <= 4) return [run]
  const out = new Set([run])
  for (let i = 0; i + 3 <= run.length && out.size < 10; i++) out.add(run.slice(i, i + 3))
  for (let i = 0; i + 2 <= run.length && out.size < 16; i += 2) out.add(run.slice(i, i + 2))
  return [...out]
}

function tokens(text) {
  const cleaned = stripTags(text)
  const cjkRuns = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const cjk = cjkRuns.flatMap(cjkTerms)
  const latin = cleaned.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) || []
  return [...new Set([...cjk, ...latin].filter((t) => !STOP_WORDS.has(t)))].slice(0, 24)
}

function matchScore(item, keywords) {
  if (!keywords.length) return 0
  const hay = `${stripTags(item.title)} ${item.description || ''} ${item.tag || ''}`.toLowerCase()
  const hits = keywords.filter((k) => hay.includes(k.toLowerCase())).length
  const titleHit = keywords.filter((k) => stripTags(item.title).toLowerCase().includes(k.toLowerCase())).length
  return Math.min(1, (hits / keywords.length) * 0.6 + (titleHit / keywords.length) * 0.4)
}

function scoreItem(item, keywords) {
  const play = Number(item.play) || 0
  const like = Number(item.like) || 0
  const fav = Number(item.favorites) || 0
  const m = matchScore(item, keywords)
  const playPart = Math.min(1, Math.log10(play + 1) / 7)
  const favPart = like > 0 ? Math.min(1, fav / like) : Math.min(1, (Number(item.video_review) || 0) / Math.max(1, play / 100))
  const series = SERIES_HINT.test(`${stripTags(item.title)} ${item.description || ''}`) ? 1 : 0
  return 0.5 * m + 0.2 * playPart + 0.2 * favPart + 0.1 * series
}

/**
 * @param {{ cache: {get,set}, log?: (msg:string)=>void, spacingMs?: number }} deps
 */
export function createBiliClient({ cache, log = () => {}, spacingMs = 1000 }) {
  let keys = null
  let lastRequest = 0
  let blocked = false
  const blockedReason = { value: '' }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function throttle() {
    const wait = spacingMs - (Date.now() - lastRequest)
    if (wait > 0) await sleep(wait)
    lastRequest = Date.now()
  }

  async function ensureKeys() {
    if (keys) return keys
    const cached = await cache.get('bili:keys')
    if (cached && cached.imgKey && cached.subKey) {
      keys = cached
      return keys
    }
    const cookie = cached?.cookie || (await bootCookie())
    const res = await rawFetch(`${API}/x/web-interface/nav`, {
      headers: { Referer: 'https://www.bilibili.com/', Cookie: cookie },
    })
    const img = res?.data?.wbi_img?.img_url || ''
    const sub = res?.data?.wbi_img?.sub_url || ''
    if (!img || !sub) throw new Error('无法获取 WBI 密钥（B 站接口未返回 wbi_img）')
    const key = {
      imgKey: img.slice(img.lastIndexOf('/') + 1).split('.')[0],
      subKey: sub.slice(sub.lastIndexOf('/') + 1).split('.')[0],
      cookie,
    }
    keys = key
    await cache.set('bili:keys', key, 6 * 3600 * 1000)
    return key
  }

  async function bootCookie() {
    try {
      const spi = await rawFetch(`${API}/x/frontend/finger/spi`, {
        headers: { Referer: 'https://www.bilibili.com/' },
      })
      const b3 = spi?.data?.b_3
      const b4 = spi?.data?.b_4
      if (b3) return `buvid3=${b3}; buvid4=${b4 || ''}`
    } catch {}
    return ''
  }

  async function rawFetch(url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.bilibili.com',
        ...(init.headers || {}),
      },
    })
    if (res.status === 412 || res.status === 403) {
      const err = new Error(`B 站风控（HTTP ${res.status}）`)
      err.code = 'RISK'
      throw err
    }
    const json = await res.json().catch(() => null)
    if (!json) throw new Error('B 站接口返回非 JSON')
    if (json.code === -352 || json.code === -412 || json.code === -403) {
      const err = new Error(`B 站风控（code ${json.code}）`)
      err.code = 'RISK'
      throw err
    }
    if (json.code !== 0 && json.code !== -101) {
      const err = new Error(`B 站接口错误 code=${json.code} ${json.message || ''}`.trim())
      err.code = 'API'
      throw err
    }
    return json
  }

  async function searchOnce(keyword, pageSize = 20) {
    const key = await ensureKeys()
    await throttle()
    const query = signedQuery(
      { search_type: 'video', keyword, page: 1, page_size: pageSize },
      mixinKey(key.imgKey, key.subKey),
    )
    const url = `${API}/x/web-interface/wbi/search/type?${query}`
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const json = await rawFetch(url, {
          headers: { Referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`, Cookie: key.cookie },
        })
        const list = json?.data?.result || []
        return Array.isArray(list) ? list : []
      } catch (error) {
        lastError = error
        if (error.code === 'RISK') throw error
        await sleep(800 * (attempt + 1))
      }
    }
    throw lastError || new Error('B 站搜索失败')
  }

  async function search(keyword, pageSize = 20) {
    if (blocked) return { ok: false, reason: blockedReason.value, items: [] }
    const cacheKey = `bili:search:${keyword}:${pageSize}`
    const hit = await cache.get(cacheKey)
    if (hit) return { ok: true, cached: true, items: hit }
    try {
      const raw = await searchOnce(keyword, pageSize)
      const items = raw
        .filter((it) => it && it.bvid)
        .map((it) => ({
          bvid: it.bvid,
          title: stripTags(it.title).replace(/\s+/g, ' ').trim(),
          author: it.author || '',
          play: Number(it.play) || 0,
          like: Number(it.like) || 0,
          favorites: Number(it.favorites) || 0,
          duration: parseDuration(it.duration),
          description: stripTags(it.description || '').slice(0, 160),
          pubdate: Number(it.pubdate) || 0,
          url: `https://www.bilibili.com/video/${it.bvid}`,
        }))
      await cache.set(cacheKey, items, 24 * 3600 * 1000)
      return { ok: true, cached: false, items }
    } catch (error) {
      if (error.code === 'RISK') {
        blocked = true
        blockedReason.value = error.message
        log(`[bili] ${error.message}，降级为搜索链接`)
        return { ok: false, reason: error.message, items: [] }
      }
      log(`[bili] 搜索失败 ${keyword}: ${error.message}`)
      return { ok: false, reason: error.message, items: [] }
    }
  }

  /** Rank candidates for one query set; drops short, unrelated and cross-language videos. */
  function rank(items, keywords, { minDuration = MIN_DURATION_SEC, domain = null } = {}) {
    const seen = new Set()
    return items
      .filter((it) => {
        if (seen.has(it.bvid)) return false
        seen.add(it.bvid)
        if (it.duration && it.duration < minDuration) return false
        // a Java tutorial must not answer a C++ chapter
        if (conflictsDomain(`${it.title} ${it.description || ''} ${it.tag || ''}`, domain)) return false
        if (!keywords.length) return true
        return matchScore(it, keywords) > 0
      })
      .map((it) => {
        const boosted = scoreItem(it, keywords) + (mentionsDomain(it.title, domain) ? 0.06 : 0)
        return { ...it, score: Number(Math.min(1, boosted).toFixed(3)), series: SERIES_HINT.test(it.title) }
      })
      .sort((a, b) => b.score - a.score)
  }

  /**
   * Search series courses for the whole course.
   * @param {string} courseTitle
   * @param {{limit?:number, extraQueries?:string[]}} [opts] extraQueries come from
   *        the chapter keywords, which are only known after summarization.
   */
  async function recommendSeries(courseTitle, { limit = 3, extraQueries = [], domain = null } = {}) {
    const base = cleanTitle(courseTitle)
    const anchored = domain ? anchorQuery(base, domain) : base
    const queries = [
      ...new Set([
        `${anchored} 合集`,
        ...extraQueries.map((q) => `${anchorQuery(q, domain)} 教程`),
        `${anchored} 全套`,
      ].filter(Boolean)),
    ].slice(0, 4)
    const keywords = tokens(`${base} ${domain ? domain.name : ''} ${extraQueries.join(' ')}`).slice(0, 14)
    const pool = []
    let ok = false
    let reason = ''
    for (const q of queries) {
      const res = await search(q, 20)
      if (res.ok) ok = true
      else reason = res.reason
      pool.push(...res.items)
    }
    const ranked = rank(pool, keywords, { minDuration: 600, domain })
    // a series must be an actual collection *and* on topic; near-hits stay out
    const series = ranked.filter((it) => (it.series && it.score >= 0.3) || it.score >= 0.52).slice(0, limit)
    const links = [...new Set([...queries, base])].slice(0, 3).map((q) => ({ label: q, url: searchLink(q) }))
    return { ok, fallback: !ok, reason, series, queries, links }
  }

  /**
   * Search one chapter's videos using the model-provided keywords.
   * Every query is anchored to the course domain ("C++ 异常处理"), and results
   * from a different language are dropped — the "Java videos for a C++ lecture"
   * failure mode.
   * @param {string[]} keywords 1–2 search terms
   */
  async function recommendChapter(keywords, { limit = 3, domain = null } = {}) {
    const queries = [
      ...new Set(
        keywords
          .map((k) => String(k || '').trim())
          .filter(Boolean)
          .map((k) => anchorQuery(k, domain)),
      ),
    ].slice(0, 2)
    const pool = []
    let ok = false
    let reason = ''
    for (const q of queries) {
      const res = await search(q, 10)
      if (res.ok) ok = true
      else reason = res.reason
      pool.push(...res.items)
    }
    const kw = tokens(`${queries.join(' ')} ${domain ? domain.name : ''}`)
    // one incidental word match is not enough: require a real hit score
    return {
      ok,
      fallback: !ok,
      reason,
      queries,
      videos: rank(pool, kw, { domain }).filter((v) => v.score >= 0.28).slice(0, limit),
    }
  }

  return {
    search,
    rank,
    recommendSeries,
    recommendChapter,
    get blocked() {
      return blocked
    },
    get blockedReason() {
      return blockedReason.value
    },
    stats: { formatDuration: fmtDuration },
  }
}

export { fmtDuration, parseDuration, scoreItem, matchScore }
