# HANDOFF — 课程助手插件（dsh-course-assistant）

> 写于 2026-10-23，上下文接近上限时落盘。新会话直接读这份文件即可继续，不需要翻聊天记录。

## 一、当前状态

| 项 | 值 |
|---|---|
| 本地版本 | **1.2.0**（`package.json`，已装进 desktop profile，`health` 返回 1.2.0） |
| 安装形态 | `link:` 指向 `C:\Users\ThinkPad\Documents\deepseek-harness\default-workspace\course-assistant` |
| npm | **已发布 1.2.0**（2026-10-23 18:52，`latest`=1.2.0，26 个文件含 `core/ocr.ps1`）；token 在 `~/.npmrc`（granular，whoami=logb-1） |
| GitHub | 仓库 `logb-1/dsh-course-assistant`。已 `rebase --onto origin/main bcd0b9a`（`4f9db4a` 与本地 `bcd0b9a` 树相同，历史被重写过一次）→ 本地领先 5 个提交 + tag `v1.2.0`，**只差 `git push origin main --tags`**（缺 GitHub PAT，本机 credential helper 起不来） |
| 槽位 | `main` key `course-assistant`、`sidebar.panellist` id `course-assistant`、`composer.dock` id `course-assistant-dock`，均 active |

## 二、1.2.0 已完成并验证

1. **质量闸门** `core/quality.js`：每页字数 / 可疑字符率 / 空页率 / 成词率 → `good|fair|unusable`；报告头部与面板都显示，unusable 时加警告块。
2. **OCR 重读** `core/ocr.js` + `core/ocr.ps1`：WinRT 渲染 + Windows OCR(zh-CN)，~1s/页，默认上限 60 页；`health.ocr` 报可用性；仅 Windows。
3. **领域锚定** `core/domain.js`：从代码特征识别语言（L12 → C++ score 40），关键词改写（`Python 异常处理` → `C++ 异常处理`）、查询加域前缀、排序丢弃跨语言结果（Java/Python 视频不再进 C++ 课）。
4. **字形反查** `core/pdf.js`：字体缺 `/ToUnicode` 时解析嵌入 TrueType 的 `cmap` 并反转 GID→Unicode。效果：L10 汉字 0 → **734**，L12 0 → **464**，可疑字符 9% → **0%**。
5. **演讲者备注** `core/ooxml.js`：读 `notesSlides`，34 页 PPT 多出约 6 400 字。
6. **编码还原** `core/pdf.js`：无 cmap 的字体按 GBK/Big5 再解一次（`TextDecoder`，已验证可用）。
7. **同名源文件择优** `core/pipeline.js`：同时拖 `x.pptx` + `x.pdf` 时自动用 pptx 并提示。
8. **要点重合计分** `core/verify.js`：bigram 重合度 < 30% 标「可能有推断成分」，报告里加备注。
9. 配置项：`domain`（强制领域）、`ocrMaxPages`（OCR 上限），写在 `cordis.patch.yml` 注释里。

## 三、待办（按优先级）

1. **GitHub 同步**：网络恢复后 `git fetch origin && git rebase origin/main && git push`；或改用 GitHub API 把 `package.json` / `index.js` / `core/*.js` / `README.md` 一次性提交（之前用过这套流程）。
2. **发 npm 1.2.0**：`pnpm publish --access public --no-git-checks`（`.npmrc` 里已有 granular token，`whoami`=logb-1）。`files` 已包含 `core/ocr.ps1`，`pnpm pack` 验证过 21 个文件。
3. **L12 切章**：54 页讲义只切出 1 章。原因是页标题是「幻灯片 3: 10.1 异常处理」这种混合串。做法：幻灯片型 PDF 走「一页一节 + 按 `10.x` 编号归章」，30 行左右。
4. **`.ppt/.doc` 旧格式**：`officeToPdf.convert({extension:'ppt'})` → PDF → 现有解析器，约 40 行。
5. **多模态（未接）**：宿主接口已具备（`attachments.saveImage` → `ImageAttachmentRef`，`llm.stream` 支持 image block），但 profile 只有 `deepseek-flash`（纯文本）。需先在 Settings 加视觉模型（qwen-vl / gpt-4o / gemini），或本地 Ollama。
6. **awesome-dsh-plugin PR**：本会话设了 2026-10-24 14:29 的提醒（仓库需满 1 天）；**提醒绑定本会话**，若换新会话需手动执行。条目 YAML 在 `C:\Users\ThinkPad\Desktop\awesome-dsh-plugin_提交条目.yml`。

## 四、关键命令

```powershell
# 改代码后必须重载（2 次调用，Host 才会重新 import）
#   plugin_manager remove_bundle  target=dsh-course-assistant
#   plugin_manager install_bundle target=C:\Users\ThinkPad\Documents\deepseek-harness\default-workspace\course-assistant
# 验证
Invoke-RestMethod http://127.0.0.1:54763/course-assistant/health
# 端到端（HTTP 路由，输出 5 行）
node tools/smoke.mjs "课件.pptx"
# 打包检查
node <pnpm> pack --pack-destination ..   # 确认 core/ocr.ps1 在内
```

## 五、踩过的坑（别再踩）

1. **`/Resources` 是嵌套字典**：`<<[\s\S]*?>>` 会在 `/ExtGState <<…>>` 处截断，导致字体资源全丢——必须括号配平（`matchDict`）。这是字形反查一开始"无效"的真正原因。
2. **Type0 字体的 FontDescriptor 在后代字体**（`/DescendantFonts`）上，不在字体对象上。
3. **pnpm 不转发 `--otp`**；npm CLI 转发也需 6 位 TOTP（8 位无效）。发布必须用带 bypass-2FA 的 granular token。
4. **npm 有 staged publish**：首次发布会留 `0.0.0-stage` 占位包；重复发布会报 `Cannot publish over previously staged version`，改版本号可绕过。
5. **PowerShell 5.1 读 .ps1 按 ANSI**：脚本里不要写中文；写文件用 `write`/`edit` 工具，别用 `Get-Content | Set-Content` 往返（会写坏 UTF-8）。
6. **`git checkout`/`reset --hard` 会覆盖工作区改动**：先确认有没有未提交内容。
7. **OCR 的 Windows OCR 对公式/数字必错**（`2.3`→`23`、`0.95`→`0．95`），只能用于正文；幻灯片大字效果尚可。
8. **`.git` 曾被掏空过一次**（只剩 objects/refs），恢复方式：`git init` + `remote add` + `fetch` + `reset --mixed origin/main`。
9. **本机 HTTPS 只有 Node 能出去**：pwsh/.NET（`Invoke-WebRequest`、`Test-NetConnection` 之外）与 git 默认的 schannel 后端都报 `SEC_E_NO_CREDENTIALS` / 「基础连接已经关闭」。绕法：
   - git：`git config http.sslBackend openssl`（已写进本仓库 `.git/config`），之后 `fetch`/`ls-remote` 正常；
   - 探网：用 `node -e "fetch(...)"`（自带 TLS 栈），别用 `Invoke-RestMethod` 判网络死活；
   - `Invoke-RestMethod http://127.0.0.1:54763/...` 是本机回环，仍可正常用。
10. **git 的 credential helper（manager）在沙箱里起不来**：`couldn't create signal pipe, Win32 error 5`（不允许建命名管道），push 只会退化成 `could not read Username`。要 push 必须直接带 PAT：
    `git push https://<PAT>@github.com/logb-1/dsh-course-assistant.git main --tags`（用显式 URL，别写进 remote，避免 token 落盘）。
11. **npm 的 packument 有 CDN 缓存**：刚 publish 完查 `registry.npmjs.org/<pkg>` 可能还是旧版本；查 `/<pkg>/<version>` 和 `/<pkg>/latest` 是实时的。

## 六、数据与产物位置

- 报告/上传/缓存：`C:\Users\ThinkPad\.dsh\course-assistant\{reports,uploads,jobs,cache.json}`
- 示例报告：`course-assistant/samples/`（已 gitignore，含个人课件内容，不发布）
- 小红书文案：工作区 `xhs-drafts.json` + `xhs-check.mjs`（校验脚本）
- 精简版提示词 + PDF：桌面 `课程助手插件_提示词_精简版.md/.pdf`

## 七、2026-10-23 追加完成（第 4 轮）

1. **幻灯片型 PDF 切章**：core/outline.js 新增 chaptersFromSectionNumbers / chaptersByChars。L10 51 页 → 6 章，L12 54 页 → 9 章（此前均为 1–2 章）。判据：页数 ≥8 且每页 <260 字视为幻灯片型；页内 10.1 这类编号优先，否则按 700 字累积成章、用每页首行命名。
2. **.ppt/.doc/.xls 支持**：index.js 上传放行旧格式 + prepareInputs 用 officeToPdf.convert 转 PDF 再走现有解析（标签保留原文件名）。实测 2-数据的机器级表示与处理.ppt（3.7 MB / 177 页）→ 转换成功、39,977 字、质量 good。
3. **解析器资源上限**：core/zip.js（单条目 64 MB、总量 256 MB、5000 条目）与 core/pdf.js（20 万对象、流解压 64 MB）拦截压缩炸弹。
4. **回归脚本**：`node tools/regress.mjs`，9 项断言（字形反查、质量闸门、领域锚定、切章、备注、md 切章、可信度），全部通过。

**仍粗糙**：177 页的「第二章」式中文编号课件只切出 2 章（第N章 与长文档的细分策略还没合并）；第 61 章 这类正文数字误判已修（行 ≤40 字、主编号 1–30、标签需 ≥2 汉字）。

## 八、2026-10-23 18:27 会话（发布 + 同步）

1. **npm 1.2.0 已发布并验证**：`latest`=1.2.0，description 为正常中文，tarball 73.9 KB / 26 条目（含 `core/ocr.ps1`）。发布命令：
   `node <pnpm.mjs> publish --access public --no-git-checks`（先 `--dry-run` 跑一遍）。
2. **GitHub 已 rebase 干净**：`4f9db4a` 与本地旧 `bcd0b9a` 树完全相同（历史被重写过），所以用
   `git rebase --onto origin/main bcd0b9a main` 而非普通 rebase，避免重复提交。现在本地领先 5 个提交 + tag `v1.2.0`。
   **push 未完成**——缺 GitHub PAT，见坑 10。
3. **README 面板图**原来写 `docs/panel.png`，而 `files` 里没有 `docs/`，npm 页面是裂图；已改成 raw.githubusercontent 绝对链接。
   这条改动要等**下一次发版**才会体现在 npm 页面。
4. **HANDOFF 没有 A–G 字母编号**：任务只在「三、待办（按优先级）」1–6 条里。按上下文把 A/B 当作第 1、2 条（GitHub 同步、发 npm）处理。