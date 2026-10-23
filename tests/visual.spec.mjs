import { test, expect } from '@playwright/test'

/**
 * One spec, two jobs: prove the panel actually mounts inside the GUI, and catch
 * unintended visual drift (spacing, contrast, missing slot) between releases.
 */
test('课程助手面板：能打开、结构完整、外观稳定', async ({ page }) => {
  // the GUI is cookie-authenticated: the token from the URL `dsh web` prints is
  // exchanged for a signed cookie on first load
  const token =
    process.env.DSH_WEB_TOKEN ||
    (() => {
      try {
        return new URL(process.env.DSH_WEB_URL || '').searchParams.get('token') || ''
      } catch {
        return ''
      }
    })()
  const response = await page.goto(token ? `/?token=${encodeURIComponent(token)}` : '/')
  test.skip(
    response?.status() === 401,
    '面板需要鉴权：把 dsh web 打印的地址里 token=… 的值传进 DSH_WEB_TOKEN（或直接用 DSH_WEB_URL 带上整条 URL）',
  )

  // the dock entry lives under the composer; it is the most reliable anchor
  const dock = page.locator('.ca-dock')
  await expect(dock).toBeVisible({ timeout: 60_000 })
  await expect(dock).toContainText('课程助手')
  await dock.getByRole('button', { name: /打开面板/ }).click()

  const panel = page.locator('.ca-root').first()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.ca-title')).toHaveText('课程助手')

  // idle panel = drop zone + options + primary button, nothing half-rendered
  await expect(panel.locator('.ca-drop-title')).toHaveText('把课程文件拖到这里')
  await expect(panel.locator('.ca-drop-hint')).toContainText('.pptx')
  await expect(panel.getByRole('button', { name: '开始分析' })).toBeDisabled()

  // structure first: an ARIA snapshot is stable across fonts and DPR, and is the
  // half that can be committed even though the pixels cannot travel between hosts
  await expect(panel).toMatchAriaSnapshot(`
    - heading "课程助手" [level=2]
  `)

  // stable screenshot: no caret, no animation, fixed viewport
  await expect(panel).toHaveScreenshot('panel.png', { caret: 'hide' })
})
