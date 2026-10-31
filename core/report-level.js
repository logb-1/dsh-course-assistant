/**
 * Report levels — the user-facing choice between a cheap brief and a full review.
 *
 *   normal  → brief  : 每章 3-6 条要点，一次调用，约 2600 token
 *   max     → review : 复习资料（模块/知识点/实例/习题+参考答案），约 8192 token
 *
 * The internals (`reportStyle`) predate the UI option and appear in saved jobs,
 * cache keys and the dedupe key, so the mapping lives in one place instead of
 * being spread across config, HTTP options and the panel.
 */
export const LEVELS = { normal: 'brief', max: 'review' }
export const LEVEL_NAMES = Object.keys(LEVELS)

/** Accepts the level ('normal'|'max') or a legacy style ('brief'|'review'). */
export function resolveLevel(value, fallback = 'normal') {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'max' || raw === 'review') return 'max'
  if (raw === 'normal' || raw === 'brief') return 'normal'
  return LEVEL_NAMES.includes(fallback) ? fallback : 'normal'
}

export function styleOfLevel(level) {
  return LEVELS[resolveLevel(level)]
}

export function levelOfStyle(style) {
  return style === 'review' ? 'max' : 'normal'
}

/** One line for the panel tooltip and the docs. */
export function describeLevel(level) {
  const name = resolveLevel(level)
  return name === 'max'
    ? 'MAX：复习资料（模块 / 知识点 / 实例 / 习题 + 参考答案），token 约 2-3 倍'
    : 'Normal：要点式学习报告，快且省 token'
}
