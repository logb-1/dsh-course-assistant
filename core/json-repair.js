/**
 * Tolerant JSON extraction for model output.
 *
 * Reasoning models wrap JSON in prose or markdown fences, and a reply cut by
 * maxTokens can end mid-string. Both are recoverable: take the outermost object
 * and close whatever is still open. Shared by the chapter summarizer and the
 * review-document generator so both salvage the same way.
 */

function tryParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** Close a JSON document truncated by maxTokens so partial output survives. */
export function repairJson(text) {
  const start = String(text).indexOf('{')
  if (start < 0) return null
  const s = String(text).slice(start)
  const stack = []
  let inStr = false
  let esc = false
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    out += c
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') {
      stack.pop()
      if (!stack.length) break
    }
  }
  if (inStr) out += '"'
  const close = (src) => {
    let tail = ''
    for (let i = stack.length - 1; i >= 0; i--) tail += stack[i] === '{' ? '}' : ']'
    return src + tail
  }
  const direct = tryParse(close(out.replace(/[,\s]+$/, '')))
  if (direct) return direct
  // still truncated inside a token (e.g. `"key_po`): drop tokens from the end
  for (let cut = out.length - 1; cut > 20; cut -= 8) {
    const slice = out.slice(0, cut).replace(/[,\s]+$/, '')
    const parsed = tryParse(close(slice))
    if (parsed) return parsed
  }
  return null
}

/**
 * @param {string} raw model output, with or without fences and prose
 * @returns {object|null} the first JSON object found, repaired if truncated
 */
export function parseJsonObject(raw) {
  const cleaned = String(raw ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  let value = tryParse(cleaned)
  if (!value) {
    const from = cleaned.indexOf('{')
    const to = cleaned.lastIndexOf('}')
    if (from >= 0 && to > from) value = tryParse(cleaned.slice(from, to + 1))
  }
  if (!value) value = repairJson(cleaned)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
