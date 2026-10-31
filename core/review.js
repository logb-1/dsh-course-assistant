/**
 * Review document ("复习资料") — the opt-in report style.
 *
 * The default brief mode answers "这章讲了什么" in a dozen bullets. A review
 * document answers "我该怎么复习": modules → numbered knowledge points (K),
 * worked examples from the slides (E), and exercises with answers kept apart (Q).
 *
 * Three rules from the request shape every decision here:
 *   • courseware is the source of truth — every block carries a tag
 *     (原文/整理/补充/待确认) and a page reference, never an invented one;
 *   • answers never sit next to the question (self-test), and a solved answer is
 *     labelled 参考解答，非课件原答案;
 *   • what the courseware does not contain stays empty instead of being padded.
 *
 * Parsing is deliberately forgiving: a reply cut by maxTokens still yields the
 * modules/exercises it managed to produce.
 */
import { parseJsonObject } from './json-repair.js'

export const REVIEW_PROMPT_VERSION = 1
/** Review needs detail the brief prompt deliberately drops. */
export const REVIEW_MAX_CHARS = 6000
/**
 * A review answer is 3-5x longer than six bullets, and a reasoning model spends
 * part of the budget thinking. Truncation is salvaged by json-repair, but the
 * budget should be generous enough that a normal chapter never needs it.
 */
export const REVIEW_MAX_TOKENS = 8192
export const REVIEW_TAGS = ['原文', '整理', '补充', '待确认']

const str = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const list = (value, max = 8, each = 120) => {
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[；;\n]/) : []
  return rows.map((v) => str(v, each)).filter(Boolean).slice(0, max)
}
const objects = (value, max = 8) => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : []).slice(0, max)

/** Map the many ways a model words the tag onto the four the request allows. */
function tagOf(value) {
  const raw = str(value, 12)
  if (/待确认|不确定|存疑|unknown|unsure/i.test(raw)) return '待确认'
  if (/补充|扩展|additional|extra/i.test(raw)) return '补充'
  if (/原文|课件|quote|source-text/i.test(raw)) return '原文'
  return '整理'
}

function originOf(value) {
  return /原题|课件|ppt|slide|课堂|讨论|思考/i.test(str(value, 20)) ? 'PPT 原题' : '补充练习'
}

function difficultyOf(value) {
  const raw = str(value, 8)
  if (/难|hard|高/i.test(raw)) return '难'
  if (/易|easy|低|简单/i.test(raw)) return '易'
  return '中'
}

/**
 * Pull a page number out of "第 12 页" / "p.12" / "幻灯片 12".
 * `allowed` (the chapter's own pages) turns a citation into a checkable fact:
 * a page outside the chapter is kept but flagged, never silently trusted.
 */
export function parsePageRef(source, allowed) {
  const raw = str(source, 80)
  const match = /(?:第\s*(\d{1,4})\s*页|p\.?\s*(\d{1,4})|幻灯片\s*(\d{1,4}))/i.exec(raw)
  const page = match ? Number(match[1] || match[2] || match[3]) : null
  const ok = page === null || !allowed?.size ? null : allowed.has(page)
  return { source: raw, page, sourceOk: ok }
}

export const REVIEW_SYSTEM = [
  '你是大学课程的复习助教。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要 JSON 以外的任何文字。',
  '目标：把本章课件整理成「模块 → 知识点 → 实例 → 习题」的复习资料，保留课件的术语、定义、公式与符号，不改变原意。',
  '每一个知识点都要带 tag（只能取 原文 / 整理 / 补充 / 待确认）：',
  '  原文 = 课件里的定义、结论或原话；整理 = 对课件内容的归纳与通俗说明；补充 = 你额外补的背景或练习；待确认 = 看不清、缺失或有疑问。',
  'source 写「第 N 页」：只能用原文里【第 N 页】标记出现过的页码，禁止虚构；不确定页码就写小节标题。',
  'definition 尽量贴近课件原话；plain 用大白话解释；conditions 写成立前提、适用范围与例外；mastery 写 记忆/理解/应用 之一。',
  'formula 不要只写结果，按「何时用｜各项含义｜易错点」写；没有公式就留空字符串。',
  '实例（examples）只收课件里真实出现的例子、演示或例题；课件没有就给空数组，不要编。',
  '习题（exercises）优先收课件原题（origin 写「PPT 原题」）；课件没有答案时不要编造原答案，答案放 answers，note 写「参考解答，非课件原答案」。',
  '答案必须与题目分开：exercises 里不要出现答案。',
  '只允许引用给定原文；原文没提的内容要么不写，要么 tag 标 补充。原文信息不足时（例如整页只有图），宁可少写。',
  'JSON 结构：',
  '{"chapter": string, "keywords": string[],',
  ' "overview": {"question": string, "why": string, "abilities": string[], "links": string},',
  ' "modules": [{"name": string, "points": [{"id": string, "name": string, "definition": string, "plain": string, "conditions": string, "mastery": string, "formula": string, "links": string, "pitfalls": string, "source": string, "tag": string, "quote": string}]}],',
  ' "examples": [{"id": string, "name": string, "source": string, "background": string, "points": string[], "purpose": string, "steps": string, "result": string, "transfer": string, "pitfalls": string}],',
  ' "exercises": [{"id": string, "origin": string, "stem": string, "options": string[], "points": string[], "type": string, "difficulty": string}],',
  ' "answers": [{"id": string, "text": string, "note": string}],',
  ' "summary": {"oneLine": string, "logic": string[], "remember": string[], "understand": string[], "tasks": string[], "priority": [{"what": string, "why": string}]}}',
  '约束：modules 2-6 个；每个模块 points 2-6 个；examples 0-6 个；exercises 0-8 个；answers 与 exercises 按 id 一一对应；',
  'id 形如 K3.1 / E3.1 / Q3.1（章号.序号）；definition 与 plain 各不超过 120 字；steps 用「1. 2. 3.」分步；',
  'summary.logic 是本章逻辑链（3-6 步），summary.priority 是优先复习项与依据。',
  'keywords 2-4 个，用「学科领域 + 具体概念」的组合词，直接在 B 站能搜到该章网课。',
].join('\n')

export const FRAMEWORK_SYSTEM = [
  '你是大学课程的复习助教。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
  '根据给出的章节目录与各章要点，写这份课程的复习框架：',
  '{"theme": string, "goals": string[], "summary": string}',
  'theme 是课程总体主题（不超过 80 字）；goals 是 3-6 条学习目标；summary 是全课程总结（不超过 300 字，中文）。',
  '只依据给出的目录与要点，不要补充目录之外的内容。',
].join('\n')

/**
 * @param {{courseTitle:string, chapter:object, pageText?:string, body:string,
 *          sections?:Array, outline?:string[], domain?:object, pageRange?:string}} input
 */
export function buildReviewPrompt({ courseTitle, chapter, body, sections = [], outline = [], domain, pageRange = '' }) {
  const outlineLine = outline?.length
    ? `全课程目录（只用于判断本章定位，不要复述）：${outline.slice(0, 24).join(' / ')}`
    : ''
  return [
    `课程名：${courseTitle}`,
    domain ? `课程领域：${domain.name}（keywords 必须以「${domain.name}」开头，不要写成其它语言/学科）` : '',
    outlineLine,
    `本章：第 ${chapter.index} 章 ${chapter.title}${pageRange ? `（课件范围：${pageRange}）` : ''}`,
    pageRange ? '' : '注意：本章没有可靠的页码（多份课件合并或纯文本文件），source 请写小节标题或文件名，不要写「第 N 页」。',
    sections.length > 1
      ? `本章分 ${sections.length} 个小节：${sections.slice(0, 12).map((s) => s.title).join(' / ')}。请按小节组织模块，不要漏掉没有考点的节（可在 points 里写 1 条「本节无考点」并标 待确认）。`
      : chapter.subs?.length
        ? `本节标题：${chapter.subs.slice(0, 8).join(' / ')}`
        : '',
    '以下是本章原文（每页以【第 N 页】开头；source 只能引用这些页码）：',
    '"""',
    body,
    '"""',
    '请按系统提示的 JSON 结构输出本章复习资料。',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * @param {string|object} raw model output or an already-parsed object
 * @param {{chapter?:object, pages?:number[]}} [options]
 * @returns {null|{chapter:string, overview:object, modules:Array, examples:Array,
 *                 exercises:Array, answers:Array, summary:object, keywords:string[]}}
 */
export function parseReview(raw, options = {}) {
  const value = typeof raw === 'string' ? parseJsonObject(raw) : raw
  if (!value || typeof value !== 'object') return null
  const chapterIndex = Number(options.chapter?.index) || 0
  const allowed = new Set((options.pages || []).map(Number).filter((n) => Number.isInteger(n)))

  const modules = objects(value.modules ?? value.sections ?? value.blocks, 8)
    .map((module, mi) => {
      const points = objects(module.points ?? module.knowledge ?? module.items, 8)
        .map((point, pi) => {
          const ref = parsePageRef(point.source ?? point.page, allowed)
          return {
            id: str(point.id ?? point.code, 12) || `K${chapterIndex}.${pi + 1}`,
            name: str(point.name ?? point.title, 40),
            definition: str(point.definition ?? point.def ?? point.conclusion, 200),
            plain: str(point.plain ?? point.explain, 200),
            conditions: str(point.conditions ?? point.scope ?? point.premise, 160),
            mastery: /记忆|理解|应用/.test(str(point.mastery ?? point.level, 12)) ? str(point.mastery ?? point.level, 12) : '',
            formula: str(point.formula, 200),
            links: str(point.links ?? point.relation, 160),
            pitfalls: str(point.pitfalls ?? point.mistake, 160),
            source: ref.source,
            page: ref.page,
            sourceOk: ref.sourceOk,
            tag: tagOf(point.tag ?? point.kind),
            quote: str(point.quote ?? point.evidence, 160),
          }
        })
        .filter((point) => point.name && (point.definition || point.plain || point.conditions))
      return { name: str(module.name ?? module.title, 60) || `模块 ${mi + 1}`, points }
    })
    .filter((module) => module.points.length)

  const examples = objects(value.examples ?? value.cases, 10)
    .map((example, i) => {
      const ref = parsePageRef(example.source, allowed)
      return {
        id: str(example.id ?? example.code, 12) || `E${chapterIndex}.${i + 1}`,
        name: str(example.name ?? example.title, 60),
        source: ref.source,
        page: ref.page,
        sourceOk: ref.sourceOk,
        background: str(example.background ?? example.scene ?? example.stem, 300),
        points: list(example.points, 6, 16),
        purpose: str(example.purpose ?? example.why, 200),
        steps: str(example.steps ?? example.analysis, 600),
        result: str(example.result ?? example.conclusion, 300),
        transfer: str(example.transfer, 200),
        pitfalls: str(example.pitfalls ?? example.mistake, 200),
      }
    })
    .filter((example) => example.name && (example.background || example.steps))

  const exercises = objects(value.exercises ?? value.questions, 12)
    .map((exercise, i) => ({
      id: str(exercise.id ?? exercise.code, 12) || `Q${chapterIndex}.${i + 1}`,
      origin: originOf(exercise.origin ?? exercise.source),
      stem: str(exercise.stem ?? exercise.question ?? exercise.text, 400),
      options: list(exercise.options ?? exercise.choices, 6, 200),
      points: list(exercise.points, 6, 16),
      type: str(exercise.type ?? exercise.kind, 12),
      difficulty: difficultyOf(exercise.difficulty),
    }))
    .filter((exercise) => exercise.stem)

  const answers = objects(value.answers ?? value.solutions, 12)
    .map((answer) => ({
      id: str(answer.id ?? answer.code, 12),
      text: str(answer.text ?? answer.answer ?? answer.content, 900),
      note: str(answer.note, 60),
    }))
    .filter((answer) => answer.id && answer.text)

  if (!modules.length) return null

  const summaryBlock = value.summary && typeof value.summary === 'object' ? value.summary : {}
  return {
    chapter: str(value.chapter, 60),
    keywords: list(value.keywords ?? value.keyword, 5, 20),
    overview: {
      question: str(value.overview?.question ?? value.overview?.what, 300),
      why: str(value.overview?.why ?? value.overview?.value, 300),
      abilities: list(value.overview?.abilities, 6),
      links: str(value.overview?.links ?? value.overview?.relation, 240),
    },
    modules,
    examples,
    exercises,
    answers,
    summary: {
      oneLine: str(summaryBlock.oneLine ?? summaryBlock.one_line, 160),
      logic: list(summaryBlock.logic ?? summaryBlock.chain, 6),
      remember: list(summaryBlock.remember ?? summaryBlock.conclusions, 6),
      understand: list(summaryBlock.understand ?? summaryBlock.principles, 6),
      tasks: list(summaryBlock.tasks ?? summaryBlock.abilities, 6),
      priority: objects(summaryBlock.priority, 6).map((item) => ({
        what: str(item.what ?? item.item, 100),
        why: str(item.why ?? item.reason, 160),
      })),
    },
  }
}

/**
 * Legacy key points, so the existing verification, coverage audit, keyword
 * extraction and Bilibili search keep working on a review document.
 */
export function reviewKeyPoints(review) {
  const points = []
  for (const module of review?.modules || []) {
    for (const point of module.points) {
      const body = point.definition || point.plain
      const text = [point.name, body].filter(Boolean).join('：')
      points.push({ text: text.slice(0, 100), evidence: point.quote || '', k: point.id, page: point.page ?? undefined })
    }
  }
  return points.slice(0, 16)
}

/** Every pitfall in the chapter — the brief report's "难点" for review mode. */
export function reviewPitfalls(review) {
  const out = []
  for (const module of review?.modules || []) {
    for (const point of module.points) if (point.pitfalls) out.push(`${point.id} ${point.pitfalls}`.trim())
  }
  for (const example of review?.examples || []) if (example.pitfalls) out.push(`${example.id} ${example.pitfalls}`.trim())
  return [...new Set(out)].slice(0, 4)
}

export function reviewStats(review) {
  const modules = review?.modules?.length || 0
  const points = (review?.modules || []).reduce((n, module) => n + module.points.length, 0)
  const examples = review?.examples?.length || 0
  const exercises = review?.exercises?.length || 0
  const answers = new Set((review?.answers || []).map((answer) => answer.id))
  const byTag = {}
  for (const tag of REVIEW_TAGS) byTag[tag] = 0
  for (const module of review?.modules || []) {
    for (const point of module.points) byTag[point.tag] = (byTag[point.tag] || 0) + 1
  }
  return {
    modules,
    points,
    examples,
    exercises,
    answered: (review?.exercises || []).filter((exercise) => answers.has(exercise.id)).length,
    byTag,
    sources: (review?.modules || []).reduce(
      (acc, module) => {
        for (const point of module.points) {
          if (!point.source) acc.none += 1
          else if (point.sourceOk === false) acc.outside += 1
          else acc.ok += 1
        }
        return acc
      },
      { ok: 0, none: 0, outside: 0 },
    ),
  }
}

/** One line for the report header and the panel. */
export function describeReview(stats) {
  if (!stats) return ''
  const tags = REVIEW_TAGS.filter((tag) => stats.byTag?.[tag]).map((tag) => `${tag} ${stats.byTag[tag]}`)
  const bits = [
    `${stats.points} 个知识点（${stats.modules} 个模块）`,
    `${stats.examples} 个实例`,
    `${stats.exercises} 道习题（${stats.answered} 道带答案）`,
  ]
  if (tags.length) bits.push(`来源标签：${tags.join(' / ')}`)
  return bits.join('；')
}
