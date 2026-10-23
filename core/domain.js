/**
 * Course domain anchoring.
 *
 * A course deck rarely says "this is C++" in words, but its code fragments do:
 * `#include`, `std::`, `cout`. Without this anchor the summarizer guesses a
 * language ("Python 异常处理") and Bilibili happily returns Java/Python courses
 * for a C++ lecture, because "异常处理" is language-neutral.
 *
 * Detection is deterministic and local: weighted signals over the extracted
 * text, with a margin requirement so ambiguous files (try/catch alone) stay
 * unanchored instead of being mislabeled.
 */

const DOMAINS = [
  {
    id: 'cpp',
    name: 'C++',
    aliases: ['c++', 'cpp', 'c＋＋', 'c plus plus'],
    conflicts: ['java', 'python', 'javascript', 'typescript', 'c#', 'csharp', 'golang', 'rust', 'kotlin', 'swift'],
    signals: [
      [/#\s*include\b/g, 3],
      [/std\s*::/g, 3],
      [/iostream|fstream|sstream|iomanip/g, 2],
      [/\bcout\b|\bcin\b|\bcerr\b/g, 2],
      [/\btemplate\s*</g, 2],
      [/\bpublic\s*:/g, 2],
      [/\bnullptr\b|\bnoexcept\b|\bconstexpr\b/g, 2],
      [/\bthrow\b|\btry\b|\bcatch\b/g, 1],
      [/\bclass\s+\w+\s*:\s*(public|private|protected)\b/g, 2],
    ],
  },
  {
    id: 'java',
    name: 'Java',
    aliases: ['java'],
    conflicts: ['c++', 'cpp', 'python', 'javascript', 'c#', 'golang', 'rust'],
    signals: [
      [/System\s*\.\s*out\b/g, 3],
      [/public\s+static\s+void\s+main\b/g, 3],
      [/import\s+java\./g, 3],
      [/\bpublic\s+class\b/g, 2],
      [/@Override\b/g, 2],
      [/\bArrayList\b|\bHashMap\b/g, 2],
      [/\bthrows\s+\w+Exception\b/g, 1],
    ],
  },
  {
    id: 'python',
    name: 'Python',
    aliases: ['python', 'py'],
    conflicts: ['c++', 'cpp', 'java', 'javascript', 'c#', 'golang', 'rust'],
    signals: [
      [/^\s*def\s+\w+\s*\(/gm, 3],
      [/\bself\s*\./g, 3],
      [/^\s*(?:import|from)\s+\w+/gm, 1],
      [/\bprint\s*\(/g, 1],
      [/\belif\b|\blambda\s+\w*\s*:/g, 2],
    ],
  },
  {
    id: 'csharp',
    name: 'C#',
    aliases: ['c#', 'csharp', '.net', 'dotnet'],
    conflicts: ['c++', 'cpp', 'java', 'python', 'golang', 'rust'],
    signals: [
      [/using\s+System\b/g, 3],
      [/Console\s*\.\s*Write/g, 3],
      [/\bnamespace\s+\w+\s*\{/g, 1],
      [/\basync\s+Task\b/g, 1],
    ],
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    aliases: ['javascript', 'js', 'node.js', 'nodejs', 'typescript', 'ts'],
    conflicts: ['c++', 'cpp', 'java', 'python', 'c#', 'golang', 'rust'],
    signals: [
      [/console\s*\.\s*log/g, 3],
      [/\brequire\s*\(\s*['"]/g, 2],
      [/=>\s*\{/g, 1],
      [/\bexport\s+(default|const|function)\b/g, 1],
    ],
  },
  {
    id: 'go',
    name: 'Go',
    aliases: ['golang', ' go '],
    conflicts: ['c++', 'cpp', 'java', 'python', 'c#', 'rust'],
    signals: [
      [/\bpackage\s+main\b/g, 3],
      [/\bfunc\s+\w+\s*\(/g, 3],
      [/:=/g, 1],
    ],
  },
]

const MIN_SCORE = 6
const MARGIN = 2

/**
 * @param {Array<{pages?:Array, blocks?:Array, text?:string}>} docs
 * @param {string} [override] explicit domain name from config ("C++")
 * @returns {{id:string,name:string,aliases:string[],conflicts:string[],score:number,source:'config'|'detected'}|null}
 */
export function detectDomain(docs, override) {
  if (override) {
    const hit = DOMAINS.find((d) => d.name.toLowerCase() === String(override).toLowerCase() || d.aliases.includes(String(override).toLowerCase()))
    return {
      id: hit?.id || 'custom',
      name: hit?.name || String(override),
      aliases: hit?.aliases || [String(override).toLowerCase()],
      conflicts: hit?.conflicts || [],
      score: 999,
      source: 'config',
    }
  }
  const text = docs
    .flatMap((d) => (d.pages ? d.pages.map((p) => p.text) : (d.blocks || []).map((b) => `${b.title}\n${b.text}`)))
    .join('\n')
  if (!text) return null

  const scored = DOMAINS.map((domain) => {
    let score = 0
    for (const [re, weight] of domain.signals) {
      const hits = (text.match(re) || []).length
      if (hits) score += Math.min(6, hits) * weight
    }
    return { domain, score }
  }).sort((a, b) => b.score - a.score)

  const best = scored[0]
  const second = scored[1]
  if (!best || best.score < MIN_SCORE) return null
  if (second && best.score < second.score + MARGIN) return null
  return {
    id: best.domain.id,
    name: best.domain.name,
    aliases: best.domain.aliases,
    conflicts: best.domain.conflicts,
    score: Math.round(best.score),
    source: 'detected',
  }
}

/** Does this text belong to the anchored domain? */
export function mentionsDomain(text, domain) {
  if (!domain) return false
  const lower = String(text || '').toLowerCase()
  return domain.aliases.some((a) => lower.includes(a))
}

/** Does this text belong to a *different* language than the anchored one? */
export function conflictsDomain(text, domain) {
  if (!domain?.conflicts?.length) return false
  const lower = String(text || '').toLowerCase()
  if (mentionsDomain(lower, domain)) return false
  return domain.conflicts.some((c) => lower.includes(c))
}

/** "异常处理" + C++ → "C++ 异常处理"; "Python 异常处理" + C++ → "C++ 异常处理" */
export function anchorQuery(keyword, domain) {
  const kw = String(keyword || '').trim()
  if (!domain || !kw) return kw
  if (conflictsDomain(kw, domain)) {
    let stripped = kw
    for (const conflict of domain.conflicts) {
      stripped = stripped.replace(new RegExp(escapeRe(conflict), 'gi'), ' ')
    }
    stripped = stripped.replace(/\s{2,}/g, ' ').trim()
    return stripped ? `${domain.name} ${stripped}` : domain.name
  }
  return mentionsDomain(kw, domain) ? kw : `${domain.name} ${kw}`
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
