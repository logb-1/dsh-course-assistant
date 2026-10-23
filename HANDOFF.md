# HANDOFF — 课程助手插件（dsh-course-assistant）

> 写于 2026-10-23，上下文接近上限时落盘。新会话直接读这份文件即可继续，不需要翻聊天记录。

## 一、当前状态

| 项 | 值 |
|---|---|
| 本地版本 | **1.3.0**（`package.json`，已装进 desktop profile，`health` 返回 1.3.0） |
| 安装形态 | `link:` 指向 `C:\Users\ThinkPad\Documents\deepseek-harness\default-workspace\course-assistant` |
| npm | **已发布 1.2.0**（2026-10-23 18:52，26 个文件含 `core/ocr.ps1`）；1.3.0 本地就绪未发布；token 在 `~/.npmrc`（granular，whoami=logb-1） |
| GitHub | 仓库 `logb-1/dsh-course-assistant`，**已同步**：`rebase --onto origin/main` 后用 credential helper 推上去（`4f9db4a..5270ba3`，含 tag `v1.2.0`）。沙箱解除后 helper 就能用，之前失败是沙箱不让建管道 |
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
2. **GitHub 已同步**：`4f9db4a` 与本地旧 `bcd0b9a` 树完全相同（历史被重写过），所以用
   `git rebase --onto origin/main bcd0b9a main` 而非普通 rebase，避免重复提交；之后 push 成功（`4f9db4a..5270ba3` + tag `v1.2.0`）。
   之前 push 失败纯粹是沙箱不让 credential helper 建管道，**解除沙箱后同一条命令直接过**。
3. **README 面板图**原来写 `docs/panel.png`，而 `files` 里没有 `docs/`，npm 页面是裂图；已改成 raw.githubusercontent 绝对链接。
   这条改动要等**下一次发版**才会体现在 npm 页面。
4. **HANDOFF 没有 A–G 字母编号**：任务只在「三、待办（按优先级）」1–6 条里。按上下文把 A/B 当作第 1、2 条（GitHub 同步、发 npm）处理。

## 九、2026-10-23 19:0x 会话：E / F / G

字母口径由用户确认：**E** = OcrEngine 抽象 + 列检测，**F** = 章节级重跑 + 差异视图，**G** = Playwright 视觉回归。版本升到 1.3.0（未发布）。

1. **E1 OCR 引擎注册表** `core/ocr.js`：引擎对象 = `{ id, label, platform, available(), availableSync?(), recognize() }`，
   `registerOcrEngine` / `listOcrEngines` / `ocrStatus` / `pickOcrEngine` / `ocrPdf`。文本归一化只在注册表里做一次。
   - `core/ocr-windows.js`：原 WinRT 逻辑原样搬过去（`availableSync` 直接返回 `platform === 'win32'`）。
   - `core/ocr-rapidocr.js` + `core/rapidocr.py`：PyMuPDF 渲染 + RapidOCR 识别，跨平台；探测命令是
     `python -c "import rapidocr_onnxruntime, fitz"`，**本机未安装所以报 `available:false`**，装上就能用，不需要改代码。
   - `health.ocrEngines` 逐个报可用性；配置新增 `ocrEngine` / `ocrPython`。
2. **E2 列检测** `core/pdf.js`：`contentToText` 改成输出「行 = 若干 frag」
   （x 间距 > 3 em 就断开 frag），`detectGutter` 找纵向沟槽（≥3 行左、≥3 行右、跨栏 <18%），命中才按栏重排；
   整页宽的 frag 先冲掉两栏缓冲。**没命中就原样返回**，所以单栏页面与幻灯片零影响。
   合成 PDF 夹具（`makePdf`）在 regress 里同时验「双栏按栏读」和「单栏保持原序」。
3. **F 单章重跑** `core/pipeline.js` 的 `rerunChapter()` + `POST /rerun {chapterIndex}`：
   重解析拿回该章正文（解析是确定性的，不必把每章正文落盘）→ 绕过缓存重算 → 其余章节/课程总结/系列课沿用 →
   `buildReport` 重建整份报告。差异由 `diffSummary()` 算（要点/重点/难点按「kind + 去空白文本」比对），
   写在 `chapter.diff`，面板在章节下方显示 `+ / −` 与新增关键词。
4. **G 视觉回归** `tests/visual.spec.mjs` + `playwright.config.mjs`：`channel: 'msedge'` 用系统 Edge，不下载 Chromium；
   打开面板、断言标题/拖拽区/主按钮 disabled，再对 `.ca-root` 做基线截图（`maxDiffPixelRatio: 0.02`）。
5. **回归脚本** 13 项全绿（新增：单章差异、单章重跑端到端（无模型，含报告重建与其他章节不变）、双栏、单栏）。`node --check` 全过。
6. **线上验证**（走 HTTP 路由，真模型）：上传 3 章 md → `/run` → done；`/rerun {chapterIndex:2}` → done，
   `diff = +1 −3`，`rerunOf` 指向原任务，其余两章要点逐字未变，报告重建（`hasReport: true`）。

**踩坑（第 9 节新增）**：

- **pnpm 的软链接在旧沙箱下会写成 `Global\...` 形态**，Node 解析不到传递依赖（`Cannot find package 'playwright'`）。
  沙箱放开后 `rm -rf node_modules && pnpm install` 链接就正常了；判断办法是 `(Get-Item 路径).Target` 是不是绝对路径。
- **`pnpm exec` 会被 pnpm 自己的 module hook 干扰**，跑 playwright 直接用 `node node_modules/@playwright/test/cli.js`。
- **GUI 需要 `dsh web` 启动时打印的带 token 地址**：直接 `page.goto('/')` 会拿到 401 纯文本
  「dsh web authentication required」，spec 里要带 `?token=`（或让用户从地址栏复制整条 URL）。

## 十、2026-10-23 晚：审阅意见落地（**进行中，wip 分支**）

需求来源是桌面两份文件，后续一切以它们为准：
`C:\Users\ThinkPad\Desktop\课程助手_改进计划_v1.txt` 和 `课程助手_审阅意见_v1.txt`。

### 状态（务必先看）

| 项 | 值 |
|---|---|
| `main` | 203850d，1.3.0，`regress` **13/13**，插件当前跑的就是它（稳定） |
| `wip/review-v1` | 1d36142，已推 origin，`regress` **13/13**，含阶段 0 + 1 主体 + 阶段 4 的数据层 |
| 是否可以合 main | **还不可以**：index.js 的接线没做完（见下），合过去只是半成品 |

切分支：`git checkout wip/review-v1`；回稳定：`git checkout main`。

### 已完成（在 wip 分支）

1. **B1 缓存引用污染**：写缓存前 `structuredClone`，读缓存后也 clone，缓存里只存模型原始输出。
2. **B2 OCR 重放**：`prepareDocs()` 抽成共用（twins 去重 + OCR），OCR 结果按
   `sha256 + 引擎 + 页数` 缓存到 `<dataDir>/ocr/<hash>.json`，重跑命中缓存不再跑 OCR。
3. **B3 重跑可信度**：新增 `applyAssessment()`，首跑与重跑共用；它同时写
   `chapter.summary / status / confidence`（**之前漏了前两个，导致章节 summary 为 null，
   回归里表现为「重跑总有差异」**）。
4. **证据机检**：`core/verify.js` 重写
   - `THRESHOLDS` 单一常量：overlap 0.55/0.3、faithfulness 0.8/0.6、evidenceMinChars 10、fuzzy 0.85、link 0.2
   - `supportScore` 空文本返回 **null**（原来返回 1，等于「没有原文反而满分」）
   - `matchEvidence` → `exact / fuzzy(4-gram 覆盖≥0.85) / short / missing`
   - `evaluateSummary` → `{tier, reasons, overlap, faithfulness, evidence, points}`
   - `describeConfidence` 只陈述测量值，**不再出现"编造/推断"**；`report.js` 的
     `legacyConfidence()` 兼容老 job
5. **prompt v4**：`key_points` 改成 `[{text, evidence}]`，删掉 `unsupported_idx`
   （解析器仍兼容老格式）；`localSummary` 也带 evidence（原文行本身）；
   `CHAPTER_PROMPT_VERSION` 3→4；缓存键改成 `sum:v4:<hash>:<provider/model>:<domainId>`。
6. **store**：`ocrDir / readOcr / writeOcr`；`uploads/index.json`（`findUpload` / `touchUploads`）；
   `pruneUploads` 改按 `lastUsedAt` 而不是文件 mtime。
7. **manifest**：`job.inputs`（相对路径 + sha256 + uploadId）、`job.outline`
   （boundaries + hash）、`job.schemaVersion = 2`、`job.ocr`。
8. **客户端**：`key_points` 对象渲染、置信度按 tier 着色（ok/warn/err）。

### 未接线（下一步第一件事）

`index.js` 只加了常量（`HERE` / `PKG` / `hostname` / `isAbsolute` / `BOOT_ID` /
`HEARTBEAT_MS` / `STALE_MS`），以下**都还没实现**：

- 心跳：每 15s 写 `job.heartbeatAt` + `job.owner{pid,hostname,bootId}`（`timer.unref()`）
- 启动僵尸扫描：`running` 且心跳 > 90s 且同主机 pid 不存在 → 标 `interrupted`
- `/rerun` 从 `job.inputs` 恢复输入（相对路径拼 `dataDir`；缺失返回 **410** 并带文件名）
- `health.version` 改成读 `PKG.version`（不再写死）
- run / rerun 时调 `store.touchUploads(inputs.map(i => i.uploadId))`
- `/run` 构造 inputs 时补 `uploadId`

### 下一步（按审阅意见顺序）

```
0  接线 index.js（上面 6 条）           → 阶段 4 收尾
5a regress 拆 unit/real + --strict
1  同名章节合并：2.1 只在标题变化时开新章；2.2 加前缀前按文件合并；2.8 附页码区间
3  Config（schemastery，11 字段）+ 设置页 + 现有 patch 必须通过校验
G  gold 集 + NLTK windowdiff 的页级改造
2  PDF 字号（Tm×CTM 聚类，BaseFont 字重）+ PPTX p14:sectionLst / sldLayout secHead
5b CI（win+ubuntu 矩阵、pack 清单、stub 契约）+ nightly aria（Windows 计划任务，不走 self-hosted）
8  §8.1 长章节抽取式预选（当前只发前 80%+后 18%，14000 字的章约 75% 模型看不到）
9  §9 功能（页码回链、考纲覆盖、BM25 问答、分 P、Anki、course.json）
```

### 调研结论（省得重新查）

- **PPTX 节**：`p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"` 下的
  `p14:sectionLst > p14:section name= > p14:sldIdLst > p14:sldId id=`，
  **id 是 slide id，要 join `p:sldIdLst` 的顺序**（MS-PPTX 3.3 示例里 id 是非单调的）
- **分章评估**：TextTiling（Hearst 1997）+ `nltk.metrics.windowdiff`
- **字号**：pdf.js / pdfplumber 都从文本矩阵推有效字号；**Tz 只影响宽度，不要乘进字号**
- **Zombie**：BullMQ 的 stalled-job 锁续约；**不要用 bootId**（多实例互判死）
- **缓存/GC**：npm/cacache（内容寻址）、bazel-remote
- **长文**：Lost in the Middle（2307.03172）+ TextRank（W04-3252）
- **BM25**：minisearch（零依赖 JS）；中文分词用 Node 内置 `Intl.Segmenter`
- **B 站分 P**：`/x/web-interface/view` 的 `data.pages[].part`，参考
  `SocialSisterYi/bilibili-API-collect`

### 本轮踩坑

- **ESM 调试脚本必须放仓库目录内**：放 `%TEMP%` 里相对 import 会 `ERR_MODULE_NOT_FOUND`。
- **`git checkout` 在 pwsh 里 exit code 1 是假报警**：git 把 `Switched to...` 写到 stderr，
  PowerShell 当成错误流，命令本身是成功的。
- **桌面 .txt 用 CRLF + UTF-8 无 BOM** 写，记事本才不会一行到底。

## 十一、2026-10-23 晚 · 1.4.0 完成（**取代第十节的状态表**）

`main` = 57ce4e7，版本 **1.4.0**，`regress` **19 项全绿**（`--unit` 11 + `--real` 8），
插件已装并运行在 1.4.0（`health.version` 读 `package.json`）。任务本《审阅意见_v1》按下表收口。

### 已按审阅意见完成

| 审阅项 | 结果 |
|---|---|
| 0 / B1 | 写缓存前 `structuredClone`，读后也 clone；缓存只存模型原始输出 |
| 0 / B2 | `prepareDocs()` 共用；OCR 按 `sha256+引擎+页数` 缓存，重跑命中缓存 |
| 0 / B3 | `applyAssessment()` 首跑/重跑共用，写 `chapter.summary/status/confidence` |
| 2.1 同名章节 | `chaptersFromPages` 只在标题变化处开新章；`mergeSameTitle()` 相邻合并、非相邻附页码区间 |
| 2.2 多文件前缀 | 同名合并在加 `文档名｜` 前缀之前、按单文件进行 |
| 2.3-2.8 | 缓存污染已修；prompt v5；缓存键含 provider/model/domain；引文最短 10 字、4-gram 模糊匹配 |
| 3.1-3.5 | manifest（inputs/outline/ocr/schemaVersion）+ 15s 心跳 + 僵尸扫描 + prune 看引用；**未做 boot 自动续跑** |
| 4.x | `Config` 11 字段（Schemastery），`Config.listConfigs` 从 `absent` → `schema`；优先级统一为请求>配置>默认 |
| 5.x 部分 | PPTX `p14:sectionLst` + `secHead` 版式 + 字号信号；PDF `heading{size,bold}` + 字号分章（密度型 PDF） |
| 6.1-6.4 | CI 零安装矩阵（win+ubuntu）、pack 清单门禁、client 契约测试、nightly 本机 runner |
| 8.1 | 长章节改抽取式节选（TF-IDF + df 带过滤），替代"前 80%+后 18%" |
| 8.2-8.5 | cache.prune、报告保留 90 天 + DELETE 接口、Agent 工具补齐 `rerun/export/health`、`job.telemetry` |
| 9.1 | 要点带页码回链（`（p.12）`），面板与报告都显示 |
| 9.5 / 9.7 | Anki CSV（实测 46 张卡）+ `course.json`（`schema: dsh-course-assistant/course@1`） |

### 本轮真实效果（L12，54 页 PDF）

- 9 章；页码回链 **44/46**；可信度 verified/weak/suspect 混合（不再全 suspect）
- 空回包重试后，offline 章节 **4/9 → 1/9**
- 引文核对生效：`exact` 命中即 `verified`，伪造引文降为 `suspect`

### 仍缺（下一轮）

- ~~5.3 gold 集 + WindowDiff~~：**已完成**。`tools/gold/deck-800.json`（边界取自课件自己的 § 编号）
  + `tools/segment-metrics.mjs`（windowdiff / ±1 页边界 F1）；`--real` 组门禁 windowdiff ≤0.25、F1 ≥0.85，
  当前 **windowdiff 0.061 / F1 0.947（章 10 vs gold 11，封面并入）**
- ~~5.1 完整 CTM~~：**已完成**。`q/Q` 维护 CTM，有效字号 = `Tf × √|det(Tm×CTM)|`；新增合成 PDF 断言
- **§9 其余**：考纲覆盖率、B 站分 P、增量课程、纯图页视觉（**9.3 BM25 问答已完成**）
- **未发布**：1.4.0 只在本地与 GitHub，`pnpm publish` 未跑
- **推送状态**：本地 `main` = f70b982（含 G/CTM）；GitHub 443 仍连不上
  （`Failed to connect to github.com:443`），恢复后执行
  `git push origin main` 与 `git push origin wip/review-v1`
- **已知问题**：L12 的文本层混进 PDF 操作符/截断代码（页面标题形如 `#includ fstrea`、
  `cou << (m/n)< en`），所以它的 gold 不能用标题生成；该文件的 content-stream 解析值得单独查

### 关键命令

```powershell
cd C:\Users\ThinkPad\Documents\deepseek-harness\default-workspace\course-assistant
node tools/regress.mjs --unit --strict     # 任何机器
node tools/regress.mjs --real              # 需要桌面课件
node tools/client-contract.mjs             # client 槽位契约
node tools/nightly-visual.mjs              # 真面板（需 web-token.txt）
# 改代码后重载：plugin_manager remove_bundle → install_bundle（同一绝对路径）
```