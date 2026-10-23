#!/usr/bin/env node
/**
 * Nightly real-panel check (run by Windows Task Scheduler, not by CI).
 *
 * The CI matrix has no Harness Host and no launch token, so the visual/ARIA
 * snapshot of the real panel can only run on the machine where the GUI lives.
 * This runner keeps the token out of the repository:
 *
 *   <dataDir>/web-token.txt      first line = the ?token=… value
 *   DSH_WEB_URL                  e.g. http://127.0.0.1:54763
 *
 * Usage:  node tools/nightly-visual.mjs [--update]
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const ROOT = join(HERE, '..')
const UPDATE = process.argv.includes('--update')

const tokenFiles = [
  process.env.DSH_WEB_TOKEN_FILE,
  join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'course-assistant', 'web-token.txt'),
  join(ROOT, '.nightly-token'),
].filter(Boolean)

const token = process.env.DSH_WEB_TOKEN || tokenFiles.map((p) => (existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/)[0].trim() : '')).find(Boolean)

if (!token) {
  console.error(
    'SKIP  没有 token：把 dsh web 打印的地址里 token=… 的值写进\n' +
      `      ${tokenFiles[1]}\n` +
      '      或设置环境变量 DSH_WEB_TOKEN（仓库里不保存）。',
  )
  process.exit(0)
}

const env = { ...process.env, DSH_WEB_TOKEN: token }
if (!env.DSH_WEB_URL) env.DSH_WEB_URL = 'http://127.0.0.1:54763'

const cli = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
if (!existsSync(cli)) {
  console.error('SKIP  没有安装 @playwright/test：pnpm add -D @playwright/test')
  process.exit(0)
}

const args = [cli, 'test', ...(UPDATE ? ['--update-snapshots'] : [])]
console.log(`running: node ${args.join(' ')}`)
const result = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' })
process.exit(result.status ?? 1)
