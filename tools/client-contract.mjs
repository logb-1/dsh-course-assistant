#!/usr/bin/env node
/**
 * Client-loader contract test: proves the browser half still loads and still
 * registers the three slots with the expected ids.
 *
 * `client.js` is a `window.__ModuleLoader__.load({ factory(require) })` module,
 * not an ES module, so a tiny stub provides the two globals it expects. This
 * catches "panel silently disappeared" regressions on a machine with no browser;
 * it does NOT test rendering — that is the nightly aria snapshot's job.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const SRC = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

let entry = null
const fakeWindow = { __ModuleLoader__: { load: (value) => (entry = value) } }

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

const require = (id) => {
  if (id === 'react') return react
  throw new Error(`unexpected require('${id}')`)
}

globalThis.window = fakeWindow
// eslint-disable-next-line no-new-func
new Function('window', SRC)(fakeWindow)

const fail = (message) => {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}
if (!entry) fail('client.js 没有调用 window.__ModuleLoader__.load')
if (!entry.id) fail('loader entry 缺少 id')
const plugin = entry.factory(require)
if (typeof plugin?.apply !== 'function') fail('factory 没有返回带 apply 的插件对象')
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) fail('inject 缺少 slots')

const registrations = []
const ctx = {
  slots: {
    inject: (_name, fn) => {
      fn()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  get: () => null,
  effect: () => {},
  logger: { warn: () => {}, info: () => {} },
}

plugin.apply(ctx)

const expected = [
  { name: 'main', id: null, key: 'course-assistant' },
  { name: 'sidebar.panellist', id: 'course-assistant' },
  { name: 'conversation.composer.dock', id: 'course-assistant-dock' },
]

for (const want of expected) {
  const hit = registrations.find((r) => r.options?.name === want.name && (want.id ? r.options.id === want.id : r.options.key === want.key))
  if (!hit) fail(`缺少槽位注册：${want.name} ${want.id || want.key}`)
  if (typeof hit.component !== 'function') fail(`槽位 ${want.name} 没有组件`)
}

if (registrations.length !== expected.length) {
  fail(`槽位数量是 ${registrations.length}，期望 ${expected.length}`)
}

console.log(`PASS  client 契约：${registrations.map((r) => r.options.id || r.options.key).join(', ')}`)
