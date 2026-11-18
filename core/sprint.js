/**
 * PLUS 模式：把复习资料（MAX 的每章 review）重排成 review-sprint 技能的五册。
 *
 *   01 复习计划   02 主册   03 答案册   04 速记手册   05 刷题宝典
 *
 * 这里只做确定性重排：排期、题号集合、来源、评分点都从已有数据算出来，
 * 不额外调用模型，也不编造页码/答案。格式对齐 review-sprint 的 books.py。
 */
import { resolveSprint } from './report-level.js'

const str = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const oneLine = (value, max = 400) => str(value, max)

const PHASES = [
  { key: 'build', name: '构建期', ratio: 0.55, note: '铺面：定义、条件、公式，先会做基础题' },
  { key: 'strengthen', name: '强化期', ratio: 0.3, note: '刷题：按题型过真题，错题回炉' },
  { key: 'sprint', name: '冲刺期', ratio: 0.15, note: '整卷模拟 + 速记，砍掉低收益内容' },
]

/** 科目画像只有领域名；不给它编造不存在的专业画像。 */
function profileLabel(domain) {
  return domain?.name ? `${domain.name}（按课件领域识别）` : '通用（未识别到领域画像）'
}

function fmtMinutes(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0))
  if (n < 60) return `${n} 分钟`
  const h = Math.floor(n / 60)
  const m = n % 60
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

function targetLevelIndex(target) {
  if (target >= 90) return 4
  if (target >= 80) return 3
  if (target >= 60) return 2
  return 1
}

const LEVEL_LABEL = { 0: 'L0 放弃', 1: 'L1 认识', 2: 'L2 基础', 3: 'L3 真题', 4: 'L4 变式' }

/** 每章 review → 平铺的知识点与习题；id 保持模型给的 K/E/Q 编号。 */
export function collectSprintData(chapters = []) {
  const points = []
  const exercises = []
  for (const chapter of chapters) {
    const review = chapter.summary?.review
    if (!review) continue
    for (const module of review.modules || []) {
      for (const point of module.points || []) {
        points.push({
          id: point.id || `K${chapter.index}.?`,
          name: point.name || '未命名知识点',
          chapter: chapter.index,
          chapterTitle: chapter.title,
          module: module.name,
          definition: point.definition || '',
          plain: point.plain || '',
          conditions: point.conditions || '',
          formula: point.formula || '',
          pitfalls: point.pitfalls || '',
          links: point.links || '',
          mastery: point.mastery || '',
          source: point.source || '',
          page: point.page ?? null,
          sourceOk: point.sourceOk ?? null,
          tag: point.tag || '整理',
          quote: point.quote || '',
        })
      }
    }
    for (const exercise of review.exercises || []) {
      const answer = (review.answers || []).find((item) => item.id === exercise.id)
      exercises.push({
        id: exercise.id,
        chapter: chapter.index,
        chapterTitle: chapter.title,
        stem: exercise.stem || '',
        options: exercise.options || [],
        kpIds: exercise.points || [],
        type: exercise.type || '未分类',
        difficulty: exercise.difficulty || '',
        origin: exercise.origin || '',
        answer: answer?.text || '',
        note: answer?.note || '',
        status: !answer?.text ? '待确认（无答案）' : /参考/.test(answer.note || '') ? '参考解答（非课件原答案）' : '模型给出⚠️（未经官方/重算核验）',
      })
    }
  }
  // F = 该知识点在题里被引用的比例；没有引用记录时记 0，不假装是考频
  const total = exercises.length || 1
  const hits = new Map()
  for (const exercise of exercises) for (const id of exercise.kpIds || []) hits.set(id, (hits.get(id) || 0) + 1)
  for (const point of points) point.f = Math.round(((hits.get(point.id) || 0) / total) * 100) / 100
  const types = []
  const byType = new Map()
  for (const exercise of exercises) {
    const list = byType.get(exercise.type) || []
    list.push(exercise)
    byType.set(exercise.type, list)
  }
  for (const [name, list] of byType) types.push({ name, count: list.length, exercises: list })
  return { points, exercises, types }
}

/** 阶段天数用最大余数法，和恒等于 days。 */
function splitPhases(days) {
  const list = PHASES.map((phase) => ({ ...phase, days: 0 }))
  if (days <= 0) return list
  const mode = days <= 3 ? 'emergency' : days <= 7 ? 'compressed' : days <= 30 ? 'standard' : 'long'
  if (mode === 'emergency') return [{ ...PHASES[2], key: 'sprint', name: '急救期', days }]
  const source = mode === 'compressed' ? [list[0], list[1]] : mode === 'long' ? [list[0], list[1], list[2]] : list
  const raw = source.map((phase) => phase.ratio * days)
  const base = raw.map((value) => Math.floor(value))
  let left = days - base.reduce((a, b) => a + b, 0)
  const order = raw.map((value, i) => ({ i, frac: value - base[i] })).sort((a, b) => b.frac - a.frac)
  for (const item of order) {
    if (left <= 0) break
    base[item.i] += 1
    left -= 1
  }
  return source.map((phase, i) => ({ ...phase, days: base[i] })).filter((phase) => phase.days > 0)
}

/** 按权重把知识点分到各学习日；最后一天留给整卷模拟。 */
function assignDays(points, days) {
  const studyDays = Math.max(0, days - 1)
  const buckets = Array.from({ length: studyDays }, () => [])
  if (!points.length || !studyDays) return buckets
  const weightOf = (point) => 1 + point.f * 3 + (point.tag === '待确认' ? 0 : 0.5)
  const totalWeight = points.reduce((sum, point) => sum + weightOf(point), 0)
  let running = 0
  let day = 0
  for (const point of points) {
    running += weightOf(point)
    // 每章开头尽量换到新的一天，避免同一天塞两章的全部内容
    while (day < studyDays - 1 && buckets[day].length && running / totalWeight > (day + 1) / studyDays) day += 1
    buckets[day].push(point)
  }
  // 不允许有空日：从后面借一个点
  for (let i = 0; i < buckets.length; i += 1) {
    if (buckets[i].length) continue
    const donor = buckets.map((bucket, j) => ({ j, n: bucket.length })).filter((item) => item.n > 1).sort((a, b) => b.n - a.n)[0]
    if (donor) buckets[i].push(buckets[donor.j].pop())
  }
  return buckets
}

/**
 * 计划 + 估算。评分模型是透明的线性近似：每知识点 18 分钟、每题 12 分钟，
 * 目标越高按 1.3 次幂放大；报告里明确写「估算，不是承诺」。
 */
export function planSprint({ chapters = [], days, target, minutes, domain } = {}) {
  const sprint = resolveSprint({ days, target, minutes })
  const data = collectSprintData(chapters)
  const n = data.points.length
  const q = data.exercises.length
  const budget = sprint.days * sprint.minutes
  const baseNeed = n * 18 + q * 12
  const needFor = (t) => Math.round(baseNeed * Math.pow(t / 80, 1.3))
  const achievedFor = (t) => {
    if (!baseNeed) return 0
    return Math.max(0, Math.min(100, Math.round(80 * Math.pow(budget / needFor(t), 1 / 1.3))))
  }
  const matrix = [60, 70, 80, 90, 95].map((t) => {
    const required = needFor(t)
    const achieved = achievedFor(t)
    const dailyMinutes = Math.round(sprint.minutes * Math.min(1, budget / Math.max(1, required)))
    return {
      target: t,
      required,
      achieved,
      minutes: Math.min(budget, required),
      dailyMinutes,
      dailyQuestions: Math.max(1, Math.round((q / Math.max(1, sprint.days)) * (t / 80))),
      selected: t === sprint.target,
    }
  })
  const selected = matrix.find((row) => row.selected) || matrix[2]
  const shortfall = Math.max(0, Math.round(sprint.target * 0.95) - selected.achieved)
  // 时间不够时先砍 F 最低的知识点（最多 30%），并让它们真的从每日包里消失；
  // 不靠压缩讲解时间假装能覆盖全部内容。
  const abandoned = []
  const abandonedIds = new Set()
  if (shortfall > 0 && n) {
    const ranked = [...data.points].sort(
      (a, b) => a.f - b.f || Number(Boolean(a.definition)) - Number(Boolean(b.definition)),
    )
    const limit = Math.max(1, Math.floor(n * 0.3))
    let need = baseNeed
    for (const point of ranked) {
      if (abandoned.length >= limit) break
      const reachable =
        need > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round(80 * Math.pow(budget / (need * Math.pow(sprint.target / 80, 1.3)), 1 / 1.3)),
              ),
            )
          : 100
      if (reachable >= Math.round(sprint.target * 0.95)) break
      abandoned.push({ id: point.id, title: point.name, lostScore: Math.max(1, Math.round(100 / Math.max(1, n))) })
      abandonedIds.add(point.id)
      need -= 18
    }
  }
  const keptPoints = abandonedIds.size ? data.points.filter((point) => !abandonedIds.has(point.id)) : data.points
  const buckets = assignDays(keptPoints, sprint.days)
  const phases = splitPhases(sprint.days)
  const phaseAt = (day) => {
    let cursor = 0
    for (const phase of phases) {
      cursor += phase.days
      if (day <= cursor) return phase
    }
    return phases[phases.length - 1]
  }
  const dayPlan = []
  for (let day = 1; day <= sprint.days; day += 1) {
    const isMock = day === sprint.days
    const kps = isMock ? [] : buckets[day - 1] || []
    const qids = []
    if (isMock) {
      qids.push(...data.exercises.slice(0, Math.min(10, data.exercises.length)).map((item) => item.id))
    } else {
      const ids = new Set(kps.map((point) => point.id))
      for (const exercise of data.exercises) if ((exercise.kpIds || []).some((id) => ids.has(id))) qids.push(exercise.id)
    }
    const load = kps.length * 18 + qids.length * 12
    dayPlan.push({
      day,
      phase: isMock ? '模拟日' : phaseAt(day).name,
      kps,
      qids: [...new Set(qids)].slice(0, 12),
      minutes: sprint.minutes,
      load: isMock ? sprint.minutes : Math.min(sprint.minutes, load || 30),
      levels: kps.map((point) => ({ id: point.id, level: LEVEL_LABEL[targetLevelIndex(sprint.target)] })),
      mock: isMock,
      note: isMock
        ? `整卷模拟（${Math.max(1, Math.round(q / Math.max(1, sprint.days)))} 题量参考），限时 ${sprint.minutes} 分钟，做完只对答案不刷新题`
        : '',
    })
  }
  const totalLoad = dayPlan.reduce((sum, day) => sum + day.load, 0)
  const overflow = Math.max(0, totalLoad - budget)
  return {
    ...sprint,
    domain,
    profile: profileLabel(domain),
    data,
    budget,
    totalLoad,
    overflow,
    matrix,
    selected,
    shortfall,
    abandoned,
    phases,
    days: dayPlan,
    level: LEVEL_LABEL[targetLevelIndex(sprint.target)],
    baseNeed,
  }
}

/* ------------------------------ 01 复习计划 ------------------------------ */

export function renderSprintPlan(plan, { courseTitle = '课程' } = {}) {
  const { data } = plan
  const lines = [`# ${courseTitle} · 复习计划`, '']
  lines.push(`- 科目画像：${plan.profile}`)
  lines.push(`- 复习天数：${plan.days.length} 天（脚本按 N 排期，不含考试日）`)
  lines.push(`- 每日预算：${fmtMinutes(plan.minutes)}`)
  lines.push(`- 目标分：${plan.target}；安全系数：0.95`)
  lines.push(`- 可达预期分：${plan.selected.achieved} / 需要 ${Math.round(plan.target * 0.95)}（估算，不是承诺）`)
  lines.push(`- 知识点：${data.points.length} 个；习题：${data.exercises.length} 道；题位覆盖：${data.exercises.length ? '有' : '待确认（课件未给出可识别习题）'}`)
  lines.push(`- 总任务量：${plan.totalLoad} 分钟；预算 ${plan.budget} 分钟；超预算 ${plan.overflow} 分钟`)
  if (plan.shortfall > 0) lines.push(`- ⚠️ 缺口：${plan.shortfall} 分；当前时间预算下无法达到安全目标，见「放弃项」。`)
  lines.push('')
  lines.push('## 目标分–掌握度矩阵')
  lines.push('')
  lines.push('| 目标分 | 安全后需要 | 可达 | 总分钟 | 每日分钟 | 每日题量 | 标记 |')
  lines.push('|---|---:|---:|---:|---:|---:|---|')
  for (const row of plan.matrix) {
    lines.push(`| ${row.target} | ${row.required} | ${row.achieved} | ${row.minutes} | ${row.dailyMinutes} | ${row.dailyQuestions} | ${row.selected ? '★ 当前' : ''} |`)
  }
  lines.push('')
  if (plan.abandoned.length) {
    lines.push('## 放弃项')
    lines.push('')
    lines.push('| 知识点 | 估算丢分 |')
    lines.push('|---|---:|')
    for (const item of plan.abandoned) lines.push(`| ${item.id} ${item.title} | ${item.lostScore} |`)
    lines.push('')
    lines.push('> 放弃的部分不会在本次复习的每日包里出现；考前只保底过一眼速记。')
    lines.push('')
  }
  lines.push('## 阶段')
  lines.push('')
  lines.push('| 阶段 | 天数 | 目标 |')
  lines.push('|---|---:|---|')
  for (const phase of plan.phases) lines.push(`| ${phase.name} | ${phase.days} | ${phase.note} |`)
  lines.push('')
  lines.push('## 按天计划')
  lines.push('')
  lines.push('> 题号与《03-答案册》《05-刷题宝典》共用；无题的题位标「待确认」，不编题号。')
  lines.push('')
  lines.push('| 天 | 阶段 | 知识点 | 题号 | 预估分钟 | 目标等级 |')
  lines.push('|---|---|---|---|---:|---|')
  for (const day of plan.days) {
    const kps = day.kps.map((point) => point.id).join('、') || (day.mock ? '整卷模拟' : '—')
    const qids = day.qids.join('、') || '—'
    const levels = day.levels.map((item) => `${item.id}:${item.level.split(' ')[0]}`).join('、') || '—'
    lines.push(`| D${String(day.day).padStart(2, '0')} | ${day.phase} | ${kps} | ${qids} | ${day.load} | ${levels} |`)
  }
  lines.push('')
  lines.push('## 每日学习包')
  lines.push('')
  for (const day of plan.days) {
    lines.push(`### D${String(day.day).padStart(2, '0')} · ${day.phase}`)
    lines.push('')
    if (day.mock) {
      lines.push(`- 整卷模拟：${day.qids.join('、') || '待确认（题库为空）'}`)
      lines.push(`- 用时：${fmtMinutes(day.minutes)}；做完只对答案，错题记入下一天`)
    } else {
      lines.push(`- 知识点：${day.kps.map((point) => `${point.id} ${point.name}`).join('；') || '—'}`)
      lines.push(`- 做题：${day.qids.join('、') || '待确认（该知识点暂无习题）'}`)
      lines.push(`- 用时：${fmtMinutes(day.load)} / 预算 ${fmtMinutes(day.minutes)}`)
      lines.push('- 先做题后看讲解；错题当天回炉一次')
    }
    lines.push('')
  }
  return lines.join('\n')
}

/* -------------------------------- 02 主册 -------------------------------- */

function sourceLabel(point) {
  const file = point.fileLabel || ''
  if (point.page) return `${file ? `${file}—` : ''}第 ${point.page} 页`
  return point.source ? oneLine(point.source, 60) : '待确认'
}

export function renderSprintMain(plan, { courseTitle = '课程', fileLabel = '' } = {}) {
  const lines = [`# ${courseTitle} · 主册`, '']
  lines.push('> 题目只放题号与题干；答案见《03-答案册》。来源只来自解析结果，查不到写「待确认」。')
  lines.push('')
  const byChapter = new Map()
  for (const point of plan.data.points) {
    const key = point.chapter
    if (!byChapter.has(key)) byChapter.set(key, [])
    byChapter.get(key).push({ ...point, fileLabel })
  }
  const questionsOf = (id) => plan.data.exercises.filter((exercise) => (exercise.kpIds || []).includes(id))
  for (const [chapter, points] of byChapter) {
    const rawTitle = oneLine(points[0].chapterTitle, 60)
    // 章名已经自带「第 N 章」时不再重复编号
    lines.push(`## ${/^第\s*[一二三四五六七八九十百\d]+\s*章/.test(rawTitle) ? rawTitle : `第 ${chapter} 章 ${rawTitle}`}`)
    lines.push('')
    for (const point of points) {
      lines.push(`### ${point.id} ${point.name}`)
      lines.push('')
      lines.push(`- 目标等级：${plan.level}`)
      lines.push(`- 来源：${sourceLabel(point)}`)
      if (point.quote) lines.push(`- 原文摘录：${oneLine(point.quote, 160)}`)
      if (point.definition) lines.push(`- 定义/要点：${oneLine(point.definition, 400)}`)
      if (point.formula) lines.push(`- 公式：${oneLine(point.formula, 240)}`)
      if (point.conditions) lines.push(`- 适用条件：${oneLine(point.conditions, 240)}`)
      if (point.plain) lines.push(`- 讲解：${oneLine(point.plain, 400)}`)
      if (point.pitfalls) lines.push(`- 易错点：${oneLine(point.pitfalls, 240)}`)
      if (point.links) lines.push(`- 与相邻概念：${oneLine(point.links, 200)}`)
      const related = questionsOf(point.id)
      const example = related[0]
      lines.push(`- 最小例题：${example ? `**${example.id}** ${oneLine(example.stem, 240)}` : '待确认（题库尚未覆盖该知识点）'}`)
      lines.push(`- 相关题号：${related.length ? related.map((item) => item.id).join('、') : '—'}`)
      lines.push('')
    }
  }
  // 主册只放题目，不放答案；答案统一在 03 答案册，题号三册一致。
  if (plan.data.exercises.length) {
    lines.push('## 题目')
    lines.push('')
    for (const exercise of plan.data.exercises) {
      lines.push(`### ${exercise.id}`)
      lines.push('')
      lines.push(`- 题型：${exercise.type}${exercise.difficulty ? `；难度：${exercise.difficulty}` : ''}`)
      lines.push(`- 题干：${oneLine(exercise.stem, 400) || '待确认（题干为空）'}`)
      if (exercise.options?.length) lines.push(`- 选项：${exercise.options.map((option) => oneLine(option, 80)).join(' / ')}`)
      lines.push(`- 知识点：${(exercise.kpIds || []).join('、') || '待确认'}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/* ------------------------------- 03 答案册 ------------------------------- */

function rubricOf(exercise) {
  const text = exercise.answer || ''
  const parts = text
    .split(/\n?\s*(?:\d{1,2}[.、)]|[①②③④⑤⑥])\s*/)
    .map((part) => oneLine(part, 160))
    .filter((part) => part.length >= 4)
  if (parts.length >= 2) {
    const score = exercise.score || 5
    const each = Math.max(1, Math.round(score / parts.length))
    return { items: parts.slice(0, 5).map((part) => ({ point: part, score: each })), derived: true }
  }
  return { items: [], derived: false }
}

export function renderSprintAnswers(plan, { courseTitle = '课程' } = {}) {
  const lines = [`# ${courseTitle} · 答案册`, '']
  lines.push('> 与主册、刷题宝典使用同一套题号；校验状态只写证据支持的结论，不假装官方答案。')
  lines.push('')
  if (!plan.data.exercises.length) {
    lines.push('课件未提供可识别的习题，答案册为空。建议补一份往年题后再跑 PLUS。')
    lines.push('')
  }
  for (const exercise of plan.data.exercises) {
    const point = plan.data.points.find((item) => item.id === (exercise.kpIds || [])[0])
    lines.push(`### ${exercise.id}`)
    lines.push('')
    lines.push(`- 题型：${exercise.type}${exercise.difficulty ? `；难度：${exercise.difficulty}` : ''}`)
    lines.push(`- 题干：${oneLine(exercise.stem, 400)}`)
    lines.push(`- 答案：${oneLine(exercise.answer, 600) || '待确认（无答案）'}`)
    if (point) lines.push(`- 原文依据：${sourceLabel({ ...point }) }`)
    else lines.push('- 原文依据：待确认（题目未绑定知识点）')
    lines.push(`- 步骤/解析：${oneLine(exercise.answer, 1200) || '待确认（模型未给出解析）'}`)
    const rubric = rubricOf(exercise)
    if (rubric.items.length) {
      lines.push('- 评分点（按解析步骤拆分，供自评）：')
      for (const item of rubric.items) lines.push(`  - ${item.point}（${item.score} 分）`)
    } else {
      lines.push('- 评分点：待确认（解析不足两步，未自动拆分）')
    }
    lines.push(`- 分值合计：${exercise.score || 5} 分`)
    lines.push(`- 校验状态：${exercise.status}`)
    lines.push('')
  }
  return lines.join('\n')
}

/* ------------------------------- 04 速记 -------------------------------- */

export function renderSprintCheatsheet(plan, { courseTitle = '课程' } = {}) {
  const lines = [`# ${courseTitle} · 速记手册`, '']
  lines.push('> 每个知识点 ≤5 行；考前最后 3 天涉及的知识点排在前面，可单独打印。')
  lines.push('')
  const last3 = new Set(plan.days.slice(-3).flatMap((day) => day.kps.map((point) => point.id)))
  const ordered = [...plan.data.points].sort((a, b) => Number(last3.has(b.id)) - Number(last3.has(a.id)))
  if (!ordered.length) lines.push('（没有可速记的知识点）')
  for (const point of ordered) {
    lines.push(`## ${point.id} ${point.name}`)
    lines.push('')
    lines.push(`- 来源：${sourceLabel(point)}`)
    const core = point.formula || point.definition || point.plain || '待确认'
    lines.push(`- 定义/公式：${oneLine(core, 200)}`)
    const mnemonic = point.pitfalls || point.links || (point.conditions ? `适用：${point.conditions}` : '待确认')
    lines.push(`- 易混对比/口诀：${oneLine(mnemonic, 160)}`)
    lines.push('')
  }
  return lines.join('\n')
}

/* ------------------------------- 05 刷题 -------------------------------- */

export function renderSprintDrill(plan, { courseTitle = '课程' } = {}) {
  const lines = [`# ${courseTitle} · 刷题宝典`, '']
  lines.push('> 只放题号与题干索引，答案见《03-答案册》；按题型分组，先「识别信号 → 解法套路」。')
  lines.push('')
  for (const group of plan.data.types) {
    lines.push(`## ${group.name}（${group.count} 题）`)
    lines.push('')
    lines.push(`- 识别信号：题干出现「${group.name}」类设问；先判断考的是哪一章的哪个 K 编号`)
    const kpIds = [...new Set(group.exercises.flatMap((exercise) => exercise.kpIds || []))].slice(0, 4)
    lines.push(`- 解法套路：定位 ${kpIds.join('、') || '相关知识点'} → 写定义/条件 → 按步骤作答 → 用评分点自检`)
    lines.push(`- 判分方式：按步骤给分（${group.exercises[0]?.score || 5} 分/题，估算）`)
    lines.push('')
    lines.push('| 题号 | 题干 | 知识点 | 难度 |')
    lines.push('|---|---|---|---|')
    for (const exercise of group.exercises) {
      lines.push(`| ${exercise.id} | ${oneLine(exercise.stem, 60)} | ${(exercise.kpIds || []).join('、') || '—'} | ${exercise.difficulty || '—'} |`)
    }
    lines.push('')
  }
  if (!plan.data.types.length) lines.push('（课件未提供可识别的习题）')
  return lines.join('\n')
}

/** 五册 + 合并版；文件名与 review-sprint 的编号一致。 */
export function buildSprintBooks({ courseTitle = '课程', chapters = [], files = [], sprint, meta = {}, domain } = {}) {
  const plan = planSprint({ chapters, days: sprint?.days, target: sprint?.target, minutes: sprint?.minutes, domain })
  const fileLabel = files.length === 1 ? String(files[0].name || '').replace(/\.[^.]+$/, '').slice(0, 40) : ''
  for (const point of plan.data.points) point.fileLabel = fileLabel
  // 分值：有难度就按难度估，没有就 5 分，报告里明确写「估算」
  for (const exercise of plan.data.exercises) {
    exercise.score = exercise.difficulty === '难' || exercise.difficulty === '困难' ? 8 : exercise.difficulty === '易' || exercise.difficulty === '简单' ? 4 : 5
  }
  const planMd = renderSprintPlan(plan, { courseTitle })
  const mainMd = renderSprintMain(plan, { courseTitle, fileLabel })
  const answersMd = renderSprintAnswers(plan, { courseTitle })
  const cheatMd = renderSprintCheatsheet(plan, { courseTitle })
  const drillMd = renderSprintDrill(plan, { courseTitle })
  const books = [
    { key: 'plan', no: '01', name: '复习计划', file: '01-复习计划.md', markdown: planMd },
    { key: 'main', no: '02', name: '主册', file: '02-主册.md', markdown: mainMd },
    { key: 'answers', no: '03', name: '答案册', file: '03-答案册.md', markdown: answersMd },
    { key: 'cheatsheet', no: '04', name: '速记手册', file: '04-速记手册.md', markdown: cheatMd },
    { key: 'drill', no: '05', name: '刷题宝典', file: '05-刷题宝典.md', markdown: drillMd },
  ]
  const combined = [
    `# 《${courseTitle}》冲刺五册`,
    '',
    `> 生成时间：${meta.generatedAt || ''} ｜ 复习天数：${plan.days.length} 天 ｜ 目标分：${plan.target} ｜ 每日预算：${fmtMinutes(plan.minutes)}`,
    `> 来源文件：${files.map((file) => file.name).join('、') || '（无）'}`,
    `> 五册：${books.map((book) => `${book.no} ${book.name}`).join(' ｜ ')}（每册另存为 .md，可直接打印）`,
    plan.overflow > 0 ? `> ⚠️ 计划总任务量超预算 ${plan.overflow} 分钟：先做「按天计划」里的题，讲解只看错题。` : '',
    '',
    ...books.flatMap((book) => [`## ${book.no} ${book.name}`, '', book.markdown.replace(/^# .*\n+/, ''), '']),
  ]
    .filter((line) => line !== '')
    .join('\n')
  return {
    plan,
    books,
    combined,
    stats: {
      days: plan.days.length,
      target: plan.target,
      minutes: plan.minutes,
      points: plan.data.points.length,
      exercises: plan.data.exercises.length,
      types: plan.data.types.length,
      abandoned: plan.abandoned.length,
      overflow: plan.overflow,
      shortfall: plan.shortfall,
      reachable: plan.selected.achieved,
    },
    warnings: plan.data.points.length ? [] : ['PLUS 需要每章的复习资料（MAX 结构），本次没有可用知识点，五册只保留了空计划'],
  }
}
