/**
 * Report levels — the user-facing choice between a cheap brief, a full review
 * and a sprint pack (五册).
 *
 *   normal  → brief  : 每章 3-6 条要点，一次调用，约 2600 token
 *   max     → review : 复习资料（模块/知识点/实例/习题+参考答案），约 8192 token
 *   plus    → sprint : 冲刺五册（计划/主册/答案册/速记/刷题），复用 review 的每章结果
 *
 * The internals (`reportStyle`) predate the UI option and appear in saved jobs,
 * cache keys and the dedupe key, so the mapping lives in one place instead of
 * being spread across config, HTTP options and the panel.
 */
export const LEVELS = { normal: 'brief', max: 'review', plus: 'sprint' }
export const LEVEL_NAMES = Object.keys(LEVELS)

/** Accepts the level ('normal'|'max'|'plus') or a legacy style ('brief'|'review'|'sprint'). */
export function resolveLevel(value, fallback = 'normal') {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'max' || raw === 'review') return 'max'
  if (raw === 'plus' || raw === 'sprint') return 'plus'
  if (raw === 'normal' || raw === 'brief') return 'normal'
  return LEVEL_NAMES.includes(fallback) ? fallback : 'normal'
}

export function styleOfLevel(level) {
  return LEVELS[resolveLevel(level)]
}

export function levelOfStyle(style) {
  if (style === 'review') return 'max'
  if (style === 'sprint') return 'plus'
  return 'normal'
}

/** Sprint inputs: N days, target score and minutes per day. */
export const SPRINT_DEFAULTS = { days: 14, target: 80, minutes: 120 }
export const SPRINT_LIMITS = {
  days: [1, 60],
  target: [30, 100],
  minutes: [30, 600],
}

const clampInt = (value, [min, max], fallback) => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** Normalise the sprint knobs; unknown values fall back instead of failing a run. */
export function resolveSprint(value = {}) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    days: clampInt(raw.days ?? raw.plusDays, SPRINT_LIMITS.days, SPRINT_DEFAULTS.days),
    target: clampInt(raw.target ?? raw.plusTarget, SPRINT_LIMITS.target, SPRINT_DEFAULTS.target),
    minutes: clampInt(raw.minutes ?? raw.plusMinutes, SPRINT_LIMITS.minutes, SPRINT_DEFAULTS.minutes),
  }
}

/** One line for the panel tooltip and the docs. */
export function describeLevel(level) {
  const name = resolveLevel(level)
  if (name === 'max') return 'MAX：复习资料（模块 / 知识点 / 实例 / 习题 + 参考答案），token 约 2-3 倍'
  if (name === 'plus') return 'PLUS：冲刺五册（计划 / 主册 / 答案册 / 速记 / 刷题），按天数、目标分与每天分钟排期'
  return 'Normal：要点式学习报告，快且省 token'
}
