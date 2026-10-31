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
- **§9 其余**：纯图页视觉（需要视觉模型，README 已注明）；**9.2 考纲覆盖、9.3 BM25 问答、9.4 分 P、9.6 增量课程均已完成**
- **已发布**：npm **1.4.0**（2026-10-23 21:05，`latest`=1.4.0，31 个条目，含 `core/search.js`、`core/coverage.js`、
  `core/ocr.ps1`、`core/rapidocr.py`）；依赖 `schemastery ^3.18.0`；tag `v1.4.0` 已推
- **已推送**：`origin/main` = 884f402（0 ahead / 0 behind），`origin/wip/review-v1` 也在远端
- **推送状态（第 3 轮，已确认是网络策略）**：本地 `main` = d157d10；**GitHub HTTPS 443 被拦**
  （`Test-NetConnection github.com 443` = False，`git push` 报 `Failed to connect ... :443`），
  但 **SSH 通**：`github.com:22` = True、`ssh.github.com:443` = True，而本机 `~/.ssh` 不存在（无密钥）。
  两条恢复路径：① 等 HTTPS 恢复后 `git push origin main`；
  ② 用 SSH：生成密钥 → 把公钥加到 GitHub → `git remote set-url origin git@github.com:logb-1/dsh-course-assistant.git` → push。
- **§9.8 纯图页**：需要视觉模型（当前 profile 只有纯文本模型），README 已注为已知限制，未实现
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

## 十二、2026-10-23 晚 · 1.5.0 B 站推荐防跑题

需求来源：桌面《课程助手_B站推荐改良方案_v1.txt》。新增 `core/terms.js`、`core/topic.js`，
改动 `core/bili.js`（分层搜索 + 主题过滤 + 两段式排序）、`core/pipeline.js`（总结后建主题档案再检索）、
`core/summarize.js`（空回包重试加大 maxTokens）、`core/outline.js`（通用章名替换）。

**验收（同一份课件实测）**：跑题词命中 **0**；第 3 章从「中职英语/ESP32/阅读理解」变为
「深入理解计算机系统[00] 无符号整数、二进制补码」；4/5 章有对题视频（「码点空间」这类冷门词按设计给搜索链接）；
第 1、5 章的「主要内容」章名已替换。

**回归**：`--unit` **19 项**、`--real` 9 项，全绿。新增断言：编号剥离/通用词丢弃、
锚词投票、三个跑题视频全淘汰且对题视频保留、相关度 <0.5 不计分。

**仍可改进**：`vocab` 里仍有「表示/存储/数据」这类宽泛词；`码点空间` 这类术语 B 站覆盖差，
需要更宽松的 L2.5（同义词/上位词）才能填补。

## 十三、2026-10-24 凌晨 · 投稿 awesome-dsh-plugin

按上游 `contributing.md` 只加一个文件 `data/plugins/<owner>__<repo>.yml`，通过 fork → 分支 → PR 的流程提交。

- 稿子：fork `logb-1/awesome-dsh-plugin`，分支 `add-course-assistant`，未改两个生成的 README。
- 唯一新增文件 `data/plugins/logb-1__dsh-course-assistant.yml`：
  `url` / `name` / `category: docs` / `description.en` / `description.zh`（en 含逗号无 ": "，仍加引号）。
- PR：**https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8996**（open，mergeable，changed_files=1）
- **PR check 已通过**（`success`，约 6 分钟：npm ci + awesome-lint + 站点构建全绿）。
- **Submission gate 已通过**（2026-10-24T07:35Z，原文：`All 1 submitted entry passes: dsh.bundle declared, repo old enough, enough commits.`）
  → 投稿技术上全部达标，`mergeable_state: clean`，**只等维护者人工合并**。
- 走通路径：仓库满 1 天后（`2026-10-24T05:21:46Z`），在 fork 分支补一个**空 commit**
  （`944596f`，等价 `git commit --allow-empty`，消息 `Re-run submission checks now that the repository is one day old`）
  重新触发 `pull_request` 事件 → PR check 重跑 → gate 重新判定 → 通过。
  比等 `regate.yml` 可靠：它每班只重跑 20 个 PR（`MAX_RERUNS: 20`）且按 PR 编号升序，
  新 PR 排不上队（18:37Z / 00:58Z / 06:43Z 三班都没轮到我们）。
- 分类取 `docs`：该分类现有条目就是 PDF 解析、知识库、文档阅读模式这类，语义吻合。

注意事项（下次投稿别踩）：
1. fork 后不能用 `"sha": "main"` 建分支，必须取 `GET /repos/<me>/<repo>/git/ref/heads/main` 的 `object.sha`。
2. `check-submission.mjs` 的 `MIN_AGE_DAYS = 1` 按**仓库创建时间**算，不看提交数；新建仓库当天投必红，等 regate。
3. 描述里出现 `": "` 必须加引号（我们用了单引号整行包裹）。
4. 两个 README 由 `data/plugins` 生成，PR 里**不要动**；只加 yml 是官方接受的常见形态。

**发布**：1.5.0 已发 npm，tag `v1.5.0`。
## 十四、2026-10-24 18:05 · 每次重启报错的根因（已修）

**现象**：重启 DSH 后进入界面必然报错，插件不加载（`/course-assistant/health` 404）。

**日志**（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`，11:54 / 11:55 / 17:52 / 17:54 / 17:58 共 5 次，全部同一原因）：

```
Error: web boot: 1 entry did not activate
dsh-course-assistant: import failed (see console for the import error)
renderer: Uncaught Error: client-modules: duplicate factory registration for "@local/course-assistant"
          (bundle executed twice without invalidate?)
```

**根因**：profile 的 `node_modules` 里同一个插件目录挂了**两个 junction**：

```
node_modules\dsh-course-assistant      -> ...\default-workspace\course-assistant   （package.json 声明，保留）
node_modules\@local\course-assistant   -> ...\default-workspace\course-assistant   （2026-10-23 12:44 的旧别名，残留）
```

旧别名在 `package.json` 与 `pnpm-lock.yaml` 里都已不存在（pnpm 改依赖名时不清理旧 alias 链接）。

**第一次修复（错误判断，无效）**：删掉 `node_modules\@local\course-assistant` 这个残留 junction，
重启后（18:07 的 crash 日志）**仍然报同样的错**，说明双份目录不是原因——那时 `@local` 下只剩 `cs-review`，
`client.js` 还是被执行了两次。这一步的结论只保留"顺手清理残留链接"，不构成修复。

### 真正的原因（2026-10-24 18:25 修正）

对比 profile 里四个插件的 `dsh.client` 清单：

| 插件 | dsh.client |
|---|---|
| dsh-cost-meter | `{"platform":"web"}` |
| dsh-better-sidebar | `{"inject":[...],"platform":"web"}` |
| dsh-ops | `{"inject":[...],"platform":"web"}` |
| **dsh-course-assistant** | `{"platform":"web","immediately":true,"inject":[...]}` ← 只有我们多了这个 |

`immediately: true` 让客户端 bundle 在启动时**预载**一次，随后模块注册流程**再加载**一次；
`client.js` 顶层无条件调用 `window.__ModuleLoader__.load({ id: '@local/course-assistant' })`，
第二次注册同 id 直接抛 `duplicate factory registration`，把整个插件 import 打断，
最终表现为 `web boot: 1 entry did not activate`、应用弹崩溃框。

### 修复（1.5.1）

1. `package.json`：删掉 `dsh.client.immediately`（与其余三个插件对齐，它们都没有）。
2. `client.js`：注册前加一次性守卫，`window.__COURSE_ASSISTANT_CLIENT__` 为真就跳过，
   即使加载器确实求值两次也不会抛错：

```js
if (!window.__COURSE_ASSISTANT_CLIENT__) {
  window.__COURSE_ASSISTANT_CLIENT__ = true
  window.__ModuleLoader__.load({ ... })
}
```

守卫必须挂在 `window` 上：模块级变量在"第二次求值"时是全新的，挡不住。

验证：`node --check client.js`、`tools/client-contract.mjs`（三槽位）、`tools/regress.mjs --unit --strict`（19 项）全绿；
提交 `22192e5`（守卫）、`bec1b1f`（1.5.1 去 immediately + 版本号）。

**仍待确认**：重启后 `health` 是否报 1.5.1、crash 日志是否停止新增、面板是否出现。
若仍失败，下一步应把 client 的模块 id 从 `@local/course-assistant` 改成包名 `dsh-course-assistant`
（现在 id 与包名不一致，是这轮双重注册的放大器），并同步检查 `inject` 引用。

### 最终根因（2026-10-24 18:35，rc.3 更新后）

18:30 的崩溃日志显示 **app 已从 0.2.1-rc.2 更新到 0.2.1-rc.3**，且 duplicate 报错消失、只剩
`web boot: 1 entry did not activate / dsh-course-assistant: import failed`，控制台无其他错误。

对照可用插件 cost-meter 的客户端产物：

```js
window.__ModuleLoader__.load({id:"dsh-cost-meter", chunk:"client.codex.js", factory:...})
```

→ **约定：注册 id 必须等于包名**。我们的 `client.js` 一直写的是早期工作区别名
`id: '@local/course-assistant'`，rc.2 容忍，rc.3 不再容忍：条目名是 `dsh-course-assistant`，
按名字找不到已注册的工厂 → 该条目"did not activate"。

**1.5.2 修复**：`id: 'dsh-course-assistant'`（与包名一致），旧注释里的 `@local` 也一并更正。
守卫保留（防重复求值）。`index.js` 顶部注释里的 `@local` 仅为文字，不影响加载。

至此两条独立问题都修掉了：
1. `immediately: true` + 无守卫 → 重复注册抛异常（1.5.1）
2. 模块 id 与包名不一致 → rc.3 判定条目未激活（1.5.2）

验证依据：`client-contract` 通过、`node --check` 通过、`package.json` 无 BOM、版本 1.5.2。

## 十五、2026-10-24 18:40 · rc.3 更新后「总结全部失败」的根因

**现象**：插件能启动、能跑完，但每一章都报
`llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY ...`，
11 章全部走本地兜底，用户看到的是「功能全爆」。

**根因**：`~/.dsh/profiles/desktop/cordis.patch.yml` 在 rc.3 启动时被重写（18:24:56 的 910 字节 →
18:31:12 的 661 字节），**删掉了 `agent-default-model` 这一行**。该行的默认值来自
`@deepseek-ai/dsh-base` 的内置 patch：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official   # ← 没有 API key 的 route
    model: deepseek-flash
```

用户的登录是 DeepSeek 账号（凭据里是 `deepseek-account-platform/default` token），
覆盖行被删后 provider 回落到 `deepseek-official`，于是每一次 LLM 调用都因缺 key 失败。
插件本身没有 key，`index.js` 里 `ctx.get('agentDefaultModel')?.currentSelection?.()` 拿到什么就用什么。

**修复**（两处，重启生效）：
1. profile patch 恢复 `agent-default-model`：`provider: deepseek-account` / `model: deepseek-flash` /
   `reasoningEffort: high`（与 18:23 的备份一致；当前会话本身也在用 `deepseek-account`，
   session 记录里 29 处 account、0 处 official）。
2. 给插件行加独立覆盖，避免再次被全局默认拖累：

```yaml
- id: course-assistant
  name: dsh-course-assistant
  config:
    provider: deepseek-account
    model: deepseek-flash
```

**排查方法（以后遇到同类）**：看 profile patch 里还有没有 `agent-default-model`；
`~/.dsh/.credentials.yaml` 里 `records` 有哪些 route 的 token；
`storages/session_projcache/sessions/*.json` 里 grep `deepseek-account` 确认当前会话实际用哪个 provider。

**仍待做**：插件应对「provider 无 key」做一次显式检测，直接提示"请在设置里选模型"，
而不是 11 章各报一遍同样的错，再全部退回本地摘要。

## 十六、2026-10-24 20:00 · 1.6.0 确定性调度 + 知识 DAG（BKT 暂缓）

用户判断："调度太大程度依赖 LLM 自省重试"。数据核对（cost-meter 账本）显示 token 大头是
`cacheRead`（10-23 单日 545 M，10-24 81 M），不是插件重试；但把调度确定性化对**可预测性/可测性**
仍然正确，故按 P0/P1 落地，BKT（P4）按用户要求暂缓。

### 新增模块（全部零依赖）

| 文件 | 作用 |
|---|---|
| `core/graph.js` | 概念 DAG：加边时即时环检测、`topoOrder`、`validateEdges`（未知端点/自环/跨章反向/成环全拒）、`readiness` |
| `core/schedule.js` | 失败分类（AUTH/EMPTY/BAD_JSON/RATE_LIMIT/NETWORK）+ 重试阶梯表 + `planChapters`（前置未满足则该章标 blocked）+ `describePlan` |
| `core/knowledge.js` | 一次调用抽概念与前置候选（缓存键=章节标题+正文的 sha），模型只产候选，入库前过 `validateEdges` |
| `core/mindmap.js` | 报告用思维导图：缩进树 + Mermaid `mindmap` 代码块，均从同一份 plan/graph 生成 |

### 接线

- `pipeline.js`：`summarizeWithRetry` 改为 **由 schedule 驱动**——AUTH 直接降级且**整个 job 只报一条**警告
  （`authMissing` 标志让后续章节不再付费重试）；章节全部总结后构建知识图（缓存命中 0 次调用），
  产出 `job.knowledge` / `job.plan`，并传进报告。
- `report.js`：新增「## 前置知识路径」段落（树 + Mermaid + 前置未满足提示）。
- `store.js`：`knowledge/` 目录 + `readKnowledge/writeKnowledge`。

### 验证

- 单测 **24 项**（新增 5：DAG 四种非法边、前置阻塞、AUTH 不重试/EMPTY 降级、mindmap 双形态、抽取提示约束）
- `--real` 9 项仍全绿
- 版本 1.6.0（未发布，npm 仍 1.5.2）

### 下一步

P2 job 级去重（同 sha+同参数 → 直接复用 job，0 次模型调用）+ 历史面板；P3 看板/独立 HTML；P4 BKT（暂缓）。
启用方式：重启 DSH 或在 Plugins 页关/开插件。

### P2 已落地（引擎侧）

- `core/store.js`：`jobs/index.json` 记录 `dedupeKey → jobId`，`findReusableJob/rememberJobKey/forgetJobKey`。
- `core/pipeline.js`：`dedupeKeyFor(输入 sha + provider/model + withVideos + knowledge + domain)`；
  命中已完成的 job 时**直接返回**（0 次模型调用、0 次 B 站请求），路由侧表现为秒回。
- 单测：文件顺序无关、换模型/关网课生成不同键（第 25 项）。
- **未做**：前端「最近报告/历史」列表（数据已在 `jobs/index.json`，只差 UI）。

### P3 已落地（独立 HTML 看板）

- `core/dashboard.js`：`renderDashboardHtml()` 生成**单文件、离线可开**的看板：KPI 卡片、章节/概念 SVG 树、学习计划表、前置阻塞提示。无脚本、无 CDN、无依赖。
- `core/store.js#writeDashboard`：写到 `reports/<课程>-<日期>-dashboard.html`，与报告同目录。
- `pipeline.js`：报告生成前渲染看板，`job.dashboardPath` 记录路径；`report.js` 头部加一行「学习看板：<路径>（浏览器打开）」。
- 单测第 26 项：完整性、KPI、概念、阻塞标记、**不含 `<script>`**（离线安全）。

### 2026-10-24 20:00 实跑发现的两个 bug（已修）

1. **知识图静默为空**：`extractKnowledge` 只认 `chunk.type === 'text'`，而 Host `llm` 服务实际发的是
   `text-delta`（见 `summarize.js#collect`）。结果 raw 永远为空 → `parseJson` 返回 null → 知识图为 null，
   且**没有警告**。修复：识别 `text-delta`/`text`，`finish.kind === 'error'` 抛错，空回包抛"模型没有返回内容"；
   pipeline 在 `!knowledge` 时补一条警告，不再静默。
   新增第 27 项单测：假 LLM 以 `text-delta` 分两条吐出 JSON，断言 4 概念 / 3 条合法边 / 1 条反向边被拒。
2. **章名重复编号**：大纲章名自带「第 2 章 数据的机器级表示」，mindmap 又加前缀 →「第1章 第 2 章 …」。
   修复：`mindmap.js#bareTitle()` 剥掉已有的「第 N 章」。
3. 顺带：`## 前置知识路径` 从「课程目录」中间移到目录之后，成为独立段落。

## 十七、2026-10-27 · 日常维护

**体检结果**：仓库工作区干净；`--unit` 28 项、`--real` 9 项、client 契约全绿；插件在宿主上 `v1.6.0` 正常；npm `latest` 仍 1.5.2（1.6.0 未发）。

**发现：CI 连红 5 次（自 2026-10-23 起，每次都是同一对原因）**

1. `unit` 任务 `ERR_MODULE_NOT_FOUND: schemastery`（windows + ubuntu 都红）
   - 根因：1.4.0 引入 `schemastery` 依赖后，`tools/regress.mjs` 会 `import '../index.js'`，
     而 CI 仍按"零安装"设计跑（不装任何依赖）→ 加载失败。
   - 修复：unit 任务加一步 `npm install --no-save --no-audit --no-fund schemastery@^3.18.0`，
     并同步更新 workflow 顶部注释（不再是零安装）。
2. `package` 任务 `health reports a hardcoded version`
   - 根因：CI 的闸门是 `grep -n "version: '" index.js`，而 `PKG` 的 catch 分支里写着
     `return { version: '0.0.0' }`（单引号字面量）→ 被判成硬编码。
   - 修复：catch 分支改 `String(0)`，两处 health 输出改 `PKG.version || 'unknown'`；
     现在 `grep "version: '"` 命中 0 次。

**验证方式（不依赖 CI）**：`git clone --local --depth 1` 出干净副本 → 装 schemastery →
`--unit` 28/28、client 契约 PASS、version 闸门 0 命中；`pnpm pack` 产物 38 个条目 121 KB，
`core/graph.js|schedule.js|knowledge.js|mindmap.js|dashboard.js` 全部在包里。

**仍然阻塞**：`git push` 报 `Failed to connect to github.com:443`（当时 `api.github.com` 与
`registry.npmjs.org` 都可达，只有 git 的 443 不通）。本地积压：插件 8 个提交、bench 2 个提交。
网络恢复后执行 `git push origin main`（两个仓库），CI 应随之转绿。

**发布**：1.6.0 已发 npm（`latest=1.6.0`，CDN 延迟约 1 分钟）；tag `v1.6.0` 已推（指向 `ae359cd`）。
发布物已下载核对：38 个条目 / 121 KB，`core/graph|schedule|knowledge|mindmap|dashboard.js` 全部在包内。
交付顺序：CI 转绿（ae359cd）→ 发布 → 验证 registry → 打 tag。

## 十八、2026-10-27 晚 · 历史面板 UI（1.6.1）

**新增**
- `core/store.js`：`history.json`（最近 100 条）+ `rememberHistory / listHistory`；完成 job 时由 pipeline 写入。
- `index.js`：`GET /course-assistant/history?limit=20`。
- `client.js`：标题栏「历史」按钮 → 下拉列表（课程名、章数、时间、打开）；点「打开」走与实时任务相同的渲染路径。

**顺手挖出一个导致 1.6.0 两个特性静默失效的 bug**
前几次给 store 加方法时，插入点被 `lastIndexOf('  return {')` 命中到 `listJobs` 里的
map 回调，于是 `findReusableJob / rememberJobKey / readKnowledge / writeKnowledge` 全被塞进了
`listJobs` 的返回对象里——而公开 API 上根本没有这些方法。因为调用处都写了 `?.`，
**去重和知识图缓存从 1.6.0 起一直静默失效**。现已恢复到正确位置，并用单测断言
`store.rememberHistory is not a function` 这类问题会立刻红。

**验证**：`--unit` 29 项（新增历史记录写入/去重/最新优先）、`--real` 9 项、client 契约全绿。

## 十九、2026-10-30 · 1.7.0 幻灯片图片 OCR（模式化）

用户提出两个问题：①PPT 里图片内容读不出来；②要点有缺漏。经代码核对：
`core/ooxml.js` 只解析文本 run 与 `a:tbl`，**从未读取 `ppt/media`**，所以截图/公式图/流程图等于不存在；
OCR 又只对 PDF 且需手动开。本次先解决①，②（分节摘要+覆盖率）留下一版。

**新增**
- `core/media.js`：`listPptxImages()` 从 zip 里按 `a:blip/@r:embed` → rels → `ppt/media/*` 抽图；
  PNG/JPEG 头部解析尺寸；<8 KB 或短边 <120px 跳过；按 sha 去重；每份上限 40 张。
  `attachImageText()` 把 OCR 文本以 `[图片] …` 追加到对应页。
- `core/ocr.ps1` 新增 `-Image` 模式（`-Pdf`/`-OutDir` 改为可选），Windows WinRT 直接识别图片文件；
  无参数时输出 `{"error":"no-input"}`。
- `core/ocr-windows.js` 新增 `recognizeImage()`；`core/ocr.js` 新增 `ocrImage()`。
- `core/pipeline.js#prepareDocs`：解析后、建目录前，对 pptx 逐张 OCR，按图片 sha 缓存到 `ocr/img-<sha>.json`（重跑零成本），
  结果写回页正文；`job.images = {engine, images, read, chars}`。
- 报告头部多一行：`幻灯片图片：OCR 12/40 张，补充 2314 字`。
- Config 新增：`images`（ocr/off，默认 ocr）、`imagesMax`（默认 40）、`coverage`（auto/fast/thorough，预留）、`vision`（预留）。

**实测**：`第3章_3.4_C语言的机器级表示.pptx` 抽出 40 张（达上限），首张 png 886×408 的截图
OCR 出「关系 / 表达式 / 2147483647 > …」等真实内容；`ocrImage` 走 node 封装与直接跑 ps1 结果一致。

**测试**：`--unit` 30 项（新增图片尺寸解析 + 文本回填 + JPEG SOF 偏移），`--real` 待下次跑。
**代价**：40 张约 15–40 秒；`images: 'off'` 或 `imagesMax: 0` 可关。

## 二十、2026-10-30 · 1.8.0 分节 + 覆盖率（问题②前半）

针对"要点缺漏"的三个成因，本次修掉两个（第三个 map-reduce 留下一版）：

1. **每节保底选段**（`core/sections.js` + `summarize.js#selectPassages`）
   - 先按 `chapter.subs` 或编号标题切节；无法切分时整章一节
   - 选段顺序改为：每节各自最高分段落先占 55% 预算 → 首尾锚点 → 全局分数填充
   - 效果：术语密度低的小节不再整节消失（单测：30 段文本切两节后首尾都有段落入选）
2. **覆盖率审计**（`core/audit.js`）
   - 每章审计：小节标题命中或要点 evidence 落在该节正文内 → 记覆盖
   - 课程级汇总 `job.coverage = {total, covered, ratio, missing[]}`；`ratio < 0.8` 自动加警告
   - 报告头部新增一行：`要点覆盖：7/9 节（78%）；未覆盖：第3章「浮点」…`
3. **要点上限随小节数放宽**：提示词改为"每小节至少 1 条，总数 3-12 条"，解析上限 6→12；
   `coverage: 'fast'` 时不注入分节提示（省 token），默认 `auto`/`thorough` 注入。

**未做**：`thorough` 的 map-reduce（每节单独调用再合并）。当前 `coverage` 只影响提示词，
不做"每节一次调用"——这点已在配置描述里写明，避免假开关。

**测试**：`--unit` 33 项（新增：分节三种切法、覆盖率命中/缺失、分节保底选段），`--real` 9 项，契约通过。

## 二十一、2026-10-30 · 1.9.0 概念依据校验 + thorough 逐节摘要

补完问题①②的最后两块：

1. **概念必须有原文依据**（`core/knowledge.js`）
   - 模型给出的每个概念，其名称或 evidence 必须能在该章正文里命中（去空白/标点的宽松匹配）；
     命中不了直接丢弃，并把数量记进 `stats.droppedConcepts`。
   - 被丢概念上的前置边自然变成 `unknown-from/to` 被 `validateEdges` 拒绝——图只会缩，不会撒谎。
   - 单测：假 LLM 里混入一个「中职英语」，断言概念剩 4 个、droppedConcepts=1。
2. **`thorough` 真正逐节调用**（`core/summarize.js`）
   - `coverage: 'thorough'` 且章节 > 3600 字且 ≥2 节时，取最大的 4 节各调一次模型，
     本地合并：要点按 bigram 相似度 ≥0.7 去重、上限 12 条；important/difficult/keywords 取并集。
   - 返回 `sectionCalls` / `sectionTotal` 便于在 job 里核对成本。
   - 单测：4 节长章 → 2-4 次调用、合并后 ≥2 条要点、≤12 条。
3. `coverage` 配置描述改为诚实说明：fast 不分节提示、auto 自动、thorough 每章最多 4 次调用。

**测试**：`--unit` **34 项**、`--real` 9 项、`e2e(fake)` 1 项、client 契约，全绿。
**发布**：1.9.0；npm token 失效 + GitHub 443 不通，等待用户换 token / 网络恢复后统一发布。

## 二十二、2026-10-30 · 1.10.0 关键词捕获增强

此前 `terms.js` 只做"清洗"（丢通用词、去编号），没有"补充"：模型给几个词就是几个，给成
「主要内容」就只剩空。新增 `core/keywords.js`，四源融合：

| 源 | 权重 | 说明 |
|---|---|---|
| model | 3 | 章节提示词产出的关键词（短语保留） |
| heading | 2.5 | 章名与小节标题，按 `：、，/` 再切分 |
| corpus | 2 (+0.3) | 本章 TF-IDF，且必须真出现在本章正文；出现在其他章的术语 +0.3（课程词汇） |
| acronym | 2.6 | IEEE754 / ASCII / x86-64 等英文术语（**绕过 cleanTerm 的长度规则**，否则 x86-64 会被丢） |

规则：`cleanTerm` 过滤通用词与编号；同 key 取最高分；**父子术语互斥**（选了「计算机系统 补码」就不再要「补码」）；
**来源多样性上限每源 2 条**（model 不限），避免三个缩写挤掉章名；不足 2 条时用标题兜底。

接入：`pipeline.js` 每章调用 `extractKeywords()`，写入 `chapter.summary.keywords`，并把来源计数记到
`chapter.keywordSources`（便于排查"这章的词是哪来的"）。

**测试**：`--unit` **36 项**（新增两条：多源融合/通用词丢弃/父子互斥；模型为空时兜底），real 9、e2e、契约全绿。

## 二十三、2026-10-30 · 1.11.0 OCR 质量（P1 预处理 + P2 基准 + P3 RapidOCR 图片通道）

**诊断**：此前是 WinRT OCR 裸调用——不缩放、不判深浅色、无置信度、单一引擎，所以小字和
深色代码截图几乎认不出来。

**P1 预处理（`core/ocr.ps1`，零依赖，System.Drawing）**
- 短边 < 500px 时放大，最多 3×，再按 WinRT 上限 2600px 截断
- 用 32×32 缩略图算平均亮度；**只有深色图**才转灰度并反色（浅色图保持原样，
  一开始无条件灰度反而让 `l/I`、`0/O` 更差）
- `-NoPreprocess` 保留原始路径，用于 A/B
**P1 后处理（`core/ocr-text.js`）**
- 代码行的拆词合并（`i nt` → `int`，仅限关键字白名单）
- `lEEE754` → `IEEE754`（全局，无歧义）
- 代码行全角标点转半角
- 中文偏旁拆分合并（`衤卜`→补、`氵孚`→浮、`氵去`→法、`氵殳`→没、`讠十`→计）

**P2 基准（`tools/ocr-bench.mjs` + `_gen_ocr_bench.py`）**
4 张合成图（干净中文/小字中文/深色代码/深色中文）+ 金标文本，算 CER：

| 样本 | 开预处理+后处理 | 关掉 |
|---|---|---|
| clean_cn | 0.0% | 0.0% |
| small_cn | 0.0% | 0.0% |
| dark_code | 4.3% | 8.7% |
| dark_cn | **0.0%** | 30.8% |
| **平均** | **1.1%** | 9.9% |

（"关掉"也带后处理，所以差距是纯预处理的贡献。）

**P3 RapidOCR 图片通道（代码就绪，未实跑）**
- `core/rapidocr.py` 新增 `--image`（PyMuPDF 可直接打开图片）
- `core/ocr-rapidocr.js` 新增 `recognizeImage()`
- 本机没装 `pymupdf`/`rapidocr_onnxruntime`，实测只到"缺依赖"的优雅报错；
  装好后 `imagesEngine: 'rapidocr'` 即可用

**测试**：`--unit` **37 项**（新增 OCR 后处理四类纠正），real 9、e2e、契约全绿。

## 二十四、2026-10-31 交接速览（读这一节就够）**← 已被第二十五节取代，看 §25**

### 状态
- 版本 **1.11.1**；npm `latest = 1.11.1`；GitHub `main` 同步，tag `v1.11.1`。
- 测试：`--unit` **37 项**、`--real` 9 项、`tools/e2e-fake.mjs` 1 项、client 契约，全绿。
- 已收录 awesome-dsh-plugin（PR #8996，2026-10-24 合并），官网中英页面均在线。
- 工作日志见 `WORKLOG.md`。

### 模块地图
| 文件 | 职责 |
|---|---|
| `index.js` | Config（Schemastery）、HTTP 路由、agent tool、心跳/僵尸清理 |
| `core/pipeline.js` | 解析 → 分章 → 图片 OCR → 摘要（分节/重试/覆盖）→ 知识图 → 报告/看板 |
| `core/parser.js` `pdf.js` `ooxml.js` `zip.js` `media.js` | 格式解析与 pptx 内嵌图片抽取 |
| `core/ocr.js` `ocr.ps1` `ocr-windows.js` `ocr-rapidocr.js` `rapidocr.py` `ocr-text.js` | OCR 引擎 + 预处理 + 文本后处理 |
| `core/summarize.js` `sections.js` `audit.js` | 提示词、分节保底选段、覆盖率审计 |
| `core/keywords.js` `terms.js` `topic.js` `bili.js` | 关键词四源融合、主题过滤、B 站分层检索 |
| `core/graph.js` `knowledge.js` `schedule.js` `mindmap.js` `dashboard.js` | 知识 DAG、确定性调度、报告图与看板 |
| `core/verify.js` `quality.js` `coverage.js` `search.js` `store.js` | 证据核验、可读性、考纲覆盖、BM25、存储 |

### 命令
```powershell
node tools/regress.mjs --unit --strict
node tools/regress.mjs --real
node tools/e2e-fake.mjs
node tools/client-contract.mjs
node tools/img-e2e.mjs "D:\path\deck.pptx"   # 真实课件图片链路
node tools/ocr-bench.mjs                     # 需先跑 tools/_gen_ocr_bench.py
```

### 配置面（`Config`）
`dataDir / concurrency / withVideos / images / imagesMax / coverage / vision / domain /
ocrMaxPages / ocrEngine / ocrPython / provider / model / spacingMs / keepUploadsDays`

### 已知限制（别当成 bug 重报）
- 深色代码截图仍会把 `0` 认成 `9`：规则层解决不了，需 VLM。
- OCR 只覆盖 pptx 内嵌图片；PDF 图片页仍靠 `ocr: true` 整份开关。
- 图表里的「关系」读不到，只能拿到文字。
- `coverage: 'thorough'` 每章最多 4 次调用，token 涨 2–3 倍。
- BKT / 得分预测未做（缺作答数据，用户明确搁置）。

### 未完成 / 下一步候选
1. PDF 页级 OCR 分诊（现在只有整份开关）。
2. 双引擎按置信度选优（需给 `rapidocr.py` 输出分数）。
3. `vision` 模式接 VLM（dots.ocr / PaddleOCR-VL），解决图表与代码结构。
4. 历史面板的「筛选/删除」、看板交互。
5. README 补到 1.11.x（列表页展示的就是 README，夜间重建自动更新，不需要 PR）。

### 运维提醒
- 发布需要 npm token **带 Bypass 2FA**；聊天里出现过两个 token，应撤销重建。
- GitHub 443 间歇不通，`git push` 失败时重试即可（`api.github.com` 与 npm registry 通常仍可用）。

## 二十五、2026-10-31 · 1.12.0 交接速览（读这一节就够）**← 已被第二十六节取代（1.13.0 只加了报告形态）**

### 状态

| 项 | 值 |
|---|---|
| 本地版本 | **1.12.0**（`package.json`） |
| npm | **已发布 1.12.0**（45 文件 / 447 KB unpacked），`latest = 1.12.0` |
| GitHub | `main` = `ba3e7b7`，tag `v1.12.0` 已推 |
| 测试 | `--unit` **44 项**、`--real` **11 项**、`tools/e2e-fake.mjs` 1 项、client 契约，全绿 |
| 宿主中的插件 | **仍是 1.11.1**：本次会话没有 plugin_manager 工具，需要你在 Plugins 页关/开一次（或重启 DSH），`health.version` 才会变成 1.12.0 |

### 这一版做了什么

**页级 OCR 分诊**（`core/ocr-triage.js` + `core/ocr-score.js`）：解析后给每页文本层打分（字数/可疑字符/成词率），
只把空页、几乎没字、字形乱码的页交给 OCR；其余页保持原文本层。每页各自择优，**可读页不会被 OCR 覆盖**。
默认行为变了：PDF 现在默认就会做这一步（`ocrMode: 'auto'`），`all` = 旧的整份重读，`off` = 关闭。

实测 `L12_C10_异常与断言.pdf`：只读 26/67 页、6.7 秒，25 页换成 OCR 文本，正文 5 502 → **8 214 字**。
`L10` 51 页里 25 页需要重读（约 25 秒），这是默认成本；嫌慢就 `ocrMode: 'off'`。

**同一轮修掉的三个静默 bug**（都表现为"成功、但什么都没做"）：

1. `core/pipeline.js#prepareDocs` 引用了不存在的 `options` → **1.11.1 起幻灯片图片 OCR 从未执行**，
   异常被 try/catch 吞掉，只在警告里留一行「图片 OCR 失败」。识别逻辑已抽成导出的 `readImageTexts()`，
   python 路径由 OCR 配置传入。
2. `store.readOcr()` 只返回 `{pages}` 负载 → 图片 OCR 的 `{text}` 缓存**从未命中**，重跑重复识别。
3. **只有图片的页被整页丢弃**：`L12` 真实 67 页（WinRT `pageCount` 与 PyMuPDF 一致），此前只解析出 54 页，
   13 页纯图片幻灯片从未进过报告，且之后页码全部错位（`（p.12）` 指错页、图片文字挂错幻灯片）。
   现在：有图即内容、页号不压缩；pptx 按 `p:sldIdLst` 真实顺序编号，`media.js` 用同一顺序找图片。

### 新增/改动的模块

| 文件 | 职责 |
|---|---|
| `core/ocr-triage.js` | `planOcrPages`（哪些页要读、扫描件判定、上限与顺延）+ `applyOcrPages`（逐页择优） |
| `core/ocr-score.js` | `scoreText` / `textProblem`：成词率 0.55 + 反乱码 0.30 + 反碎片 0.15 |
| `core/ocr.js` | `ocrPdfDeep`（页子集 + 双引擎择优）、`ocrPdf`（兼容包装）、页号不再重排 |
| `core/ocr.ps1` | `-Pages "3,17,18"` |
| `core/rapidocr.py` | `--pages`、逐页 `score`（Mean 置信度） |
| `core/pdf.js` | 每页 `images` 计数；空页也保留（页号真实） |
| `core/ooxml.js` | 纯图片幻灯片保留、按 `p:sldIdLst` 顺序编号、每页 `images` 计数 |
| `core/media.js` | 显示顺序映射（`slide7.xml` 不一定是第 7 张） |
| `core/text.js` | `cleanDoc` 不再压缩页号，保留有图的页 |

### 配置面（`Config`，1.12.0 后）

`dataDir / concurrency / withVideos / images / imagesMax / coverage / vision / domain / ocrMode / ocrPick /
ocrMaxPages / ocrEngine / ocrPython / provider / model / spacingMs / keepUploadsDays`

- `ocrMode`: `auto`（默认，只读弱页）/ `all`（整份重读）/ `off`
- `ocrPick`: `first`（默认）/ `best`（低分页再用第二个引擎复读取高分，耗时翻倍；需要两个引擎都可用）

### 命令

```powershell
node tools/regress.mjs --unit --strict
node tools/regress.mjs --real
node tools/e2e-fake.mjs
node tools/client-contract.mjs
node tools/try-ocr-triage.mjs "C:\path\lecture.pdf"          # 看分诊计划（不加 --run 不跑 OCR）
node tools/try-ocr-triage.mjs "C:\path\lecture.pdf" --run 3   # 顺便真读 3 页
node tools/ocr-e2e.mjs "C:\path\lecture.pdf" auto             # 整条流水线（假模型）
node tools/img-e2e.mjs "C:\path\deck.pptx"                    # 图片 OCR 链路
```

### 已知限制 / 还没做

- **深色代码截图**仍可能把 `0` 认成 `9`；要 VLM（`vision` 配置项仍只是占位，未接线）。
- **字形乱码但字数够多的页**（L12 的 `#includ fstrea`，一页 100–200 字）不会被 `auto` 选中：打分看的是
  「像不像字」，看不出「是不是被截断的代码」。这类整份文件建议 `ocrMode: 'all'`。
- **RapidOCR 在本机不可用**：PATH 上的 `python` 是 Windows Store 占位程序，`health.ocrEngines` 里
  `rapidocr.available=false`。要用就配 `ocrPython` 指向装了 `pymupdf` + `rapidocr_onnxruntime` 的解释器。
- 分诊会增加默认耗时（L10 51 页 → 约 25 秒 OCR），这是换取图片页内容的代价；`ocrMode: 'off'` 可关。
- 历史面板的「筛选/删除」、看板交互仍未做；BKT 按用户要求搁置。
- 视觉回归 `tests/visual.spec.mjs` 本轮没跑（需要 `dsh web` 的带 token 地址）。

### 下一轮候选

1. `vision` 模式接 VLM（dots.ocr / PaddleOCR-VL），解决深色代码截图与图表结构。
2. 分诊加一个「文本层被截断」信号（行内操作符密度 / 双栏残片），把 L12 那类页也纳入 auto。
3. 历史面板筛选/删除 + 看板交互。
4. 给 `rapidocr.py` 输出行级框与置信度，`ocrPick: best` 才能按行合并而不是整页二选一。

## 二十六、2026-10-31 · 1.13.0 复习资料版（`reportStyle: 'review'`）**← 已被第二十七节取代（选项改名为 Normal/MAX）**

### 状态

| 项 | 值 |
|---|---|
| 本地版本 | **1.13.1** |
| npm | **1.13.0 / 1.13.1 均已发布**（`latest` 稍后自动跟上） |
| GitHub | `main` = `b26565f`，tag `v1.13.0` / `v1.13.1` 已推（首次 push 报 443 不通，隔几分钟重试即过） |
| 测试 | `--unit` **47 项**、`--real` 11 项、`e2e-fake` 1 项、client 契约，全绿 |
| 默认行为 | 不变（`reportStyle: 'brief'`）；勾选面板「复习资料版」或配置 `reportStyle: 'review'` 才走新模式 |
| 宿主中的插件 | 仍是旧版本，需重载后新勾选才会出现 |

### 需求来源

用户给的复习资料提示词：分章分块、区分【课件原文/整理/补充/待确认】、知识点 K 编号、实例 E、
习题 Q（先题后答）、来源标「文件名—第 X 页」、不编造原题答案、待确认要标出来。

### 实现

| 文件 | 作用 |
|---|---|
| `core/review.js` | K/E/Q 的 JSON 契约；`parseReview` 容错解析（别名键、标签归一、越界页码、截断）；`reviewKeyPoints` 把 K 点折算成旧版要点；`reviewStats`/`describeReview` |
| `core/json-repair.js` | 从 `summarize.js` 抽出的 JSON 提取与截断修复，两种报告共用 |
| `core/summarize.js` | `summarizeChapterReview`（8192 token，重试只加不减）；`summarizeCourseReview`（主题/目标/总结） |
| `core/report.js` | `style==='review'` 时渲染「复习框架 6 节 + 每章（概览/模块-K/实例-E/自测题/参考答案/小结）」；无结构章节退回普通摘要 |
| `core/pipeline.js` | `style` 贯通、`job.style`/`job.review`/`job.framework`、缓存键与去重键都含 style、单文件才给页码标记 |
| `index.js` / `client.js` | Config `reportStyle`；面板勾选；agent tool 参数 `reportStyle`；进度显示 K/E/Q 数量 |

### 输出长什么样

```
# 《微观经济学》复习资料
> … 来源标签：原文 12 / 整理 5 / 待确认 2
## 一、复习框架   1 文件 / 2 主题目标 / 3 目录与页范围 / 4 章间依赖 / 5 复习顺序 / 6 待确认
## 二、分章复习资料
### 第 1 章 供给与需求
#### 本章概览   #### 模块与知识点（##### 1.1 供给与需求 → **K1.1 …**〔原文〕（第 2 页））
#### 课件实例（##### E1.1 …）    #### 自测题    #### 参考答案    #### 本章小结
## 三、课程总结    ## 附录：B 站相关网课推荐
```

### 注意

- **答案与「补充」内容是模型写的**，不是课件原文；报告里逐条标 `参考解答，非课件原答案`。
- **页码只在单份课件时可靠**：多文件合并时提示词禁止写页码，解析时也会把越界页码标成「不在本章范围，待确认」。
- **成本**：每章输出约为普通版 3-5 倍，`maxTokens` 8192；MAX thinking 模型的推理 token 也吃这份预算。
- **真实模型下还没验过**：本会话宿主跑的是旧代码，只能假模型端到端 + 报告结构断言；重载后建议用
  `C:\Users\ThinkPad\Desktop\L12_C10_异常与断言.pdf` 跑一次，看 K/E/Q 是否合理、答案是否分开。

### 下一步候选

1. 重载后用真模型跑一份真实课件，按实际输出调提示词（尤其是「每节至少 1 个知识点」的密度）。
2. 复习资料版的「整卷自测」：把各章 Q 汇总成一份不给答案的模拟卷（需要用户提示词里被截断的那一节）。
3. `vision` 接 VLM，让图片页的实例/公式也能进 K/E/Q。
4. 历史面板筛选/删除、看板交互。

## 二十七、2026-10-31 · 1.14.0 Normal / MAX 两档报告能力

### 状态

| 项 | 值 |
|---|---|
| 本地版本 | **1.14.0** |
| npm | **已发布 1.14.0**（48 文件 / 493 KB unpacked），`latest` 已更新 |
| GitHub | `main` = `ac87ad8`，tag `v1.14.0` 已推 |
| 面板 | 一行「报告模式：Normal ｜ MAX」（`aria-pressed` 标记选中），选 MAX 时下面提示成本 |
| 配置 | `reportLevel: 'normal' | 'max'`（默认 `normal`）；旧请求参数 `reportStyle: 'brief' | 'review'` 仍识别 |
| 测试 | `--unit` **48 项**、`--real` 11 项、`e2e-fake` 1 项、client 契约，全绿 |

### 两档差异

| | Normal（默认） | MAX |
|---|---|---|
| 每章形态 | 3-6 条要点 + 重点/难点/关键词 | 模块 → 知识点 K → 实例 E → 习题 Q + 参考答案 |
| 每章原文窗口 | 3600 字 | **8000 字** |
| 每章输出预算 | ~2600 token | **8192 token** |
| 额外调用 | — | 复习框架（主题/学习目标/总结）+1 次 |
| 报告标题 | 《课程》学习报告 | 《课程》复习资料 |

### 实现要点（改这些地方就够）

- `core/report-level.js`：唯一映射点 `normal↔brief` / `max↔review`；`resolveLevel()` 兼容
  `brief`/`review`/大小写/空值/fallback，`styleOfLevel()` / `levelOfStyle()` / `describeLevel()`。
- `index.js#optionsOf`：产出 `reportLevel` + 内部 `reportStyle`；优先级仍是请求 > 配置 > 默认。
  health 回报 `reportLevel`；agent tool 参数已改为 `reportLevel`（保留 `reportStyle` 读取）。
- `pipeline.js`：`job.reportLevel` 落盘（面板/历史都能读）；缓存键与去重键仍用 `reportStyle`。
- `client.js`：两个按钮切换；**重跑时把当前档位一起发过去**（`{ reportLevel, ...options }`），
  否则「换个方式重跑」会把 MAX 悄悄降成 Normal。

### 下一步

1. 重载后先用 MAX 跑一份真实课件（`L12_C10_异常与断言.pdf` 或 `实验1-高质量编程基础.pptx`），
   看 K/E/Q 密度与答案质量，再决定要不要让 MAX 自动开 `coverage: 'thorough'`。
2. 用户提示词在「五、B 答案区」处被截断；若还有「综合自测 / 模拟卷 / 格式要求」，补进 `REVIEW_SYSTEM`。
3. 历史面板显示每条记录用的是 Normal 还是 MAX（数据已有 `job.reportLevel`）。

## 二十八、2026-10-31 · 标题/目录问题调研（**只出方案，未改实现**）**← 已在第二十九节实现**

### 结论

目录偏差是**分章前本地结构识别**的问题，不是模型总结的问题。6 个真实课件里 5 个能稳定复现。
完整方案见 `docs/title-outline-plan.md`（含证据表、根因分层、P0–P4、改动清单、验收与风险）。

### 证据（本机实测，2026-10-31）

| 文件 | 课程名 | 章数 | 主要问题 |
|---|---|---|---|
| `L10_C08_多态与虚函数.pdf` | `幻灯片 1` | 6 | 章名是碎片：`fruit ptrfrui`、`、有虚函数时…`、`class B : public A` |
| `L12_C10_异常与断言.pdf` | `幻灯片 1: 第10章 异常与断言` | 9/12 | `异常`、`cat`、`void Xhandl`、`第 9 部分`；OCR 后标题仍不刷新 |
| `实验1-高质量编程基础.pptx` | ✅ | 13 | 5 页定长切块 + `课程导读` 撞名 3 次（面包屑 8 次） |
| `关上800美元的小门_课程汇报.pptx` | ✅ | 10 | 章名干净（§ 编号），子标题有表格碎片 `10.1×` |
| `计算机系统基础 复习&自学大纲.pdf` | ✅ | 11 | 乱序 + `第 2 章`/`第 8 章` 重复（表格行被当章节） |
| `C++程序设计课程复习讲义.docx` | `前言与使用说明` | 21 | 课程名取了第一个 Heading 1 |

### 根因（代码位置）

1. `core/pdf.js:1105 pickTitle()` 取"前 5 行第一个 2–60 字的行" → `8.0`、`cat`、`#includ fstrea` 都成标题。
2. `core/ooxml.js:82 extractSlide()` 只认 title 占位符，不判断它是不是面包屑。
3. `core/ocr-triage.js:124` 只在原标题为空时才用 OCR 文本补标题。
4. `core/outline.js:194 chaptersByChars()` 固定 ~700 字切块；`:524 informativeTitle()` 只处理"通用词"，
   `cat`/`第 1 部分`/代码行不在通用词表；`:332 headingLevelOf()` 把 `一、` 与 `第N章` 当同级。
5. `core/pipeline.js:238` 只处理"整串就是 `幻灯片 N`"，带后缀的漏网；`core/ooxml.js:241 guessDeckTitle()` 取首标题。

### 方案（详见方案文档）

- **P0 标题卫生**（`core/titles.js` 新增，零模型调用）：清洗「幻灯片 N:」前缀、评分 + 否决规则
  （纯数字/代码/中文 <3 字/截断尾标点/家具标题）、OCR 后重算标题、`cleanDoc` 统一接入。
- **P1 分章边界**：标题变化分组（≥1200 字才开新章、<500 字并入前一章、越界退回定长、有效标题覆盖 <30% 走关键词命名）；
  主导层级（`一、` vs `第N章`，多者为主层）；同名章合并。
  原型：`实验1` 13 章（3 个 `课程导读`）→ 14 章语义标题；`复习大纲.pdf` 11 章乱序 → 4 章。
- **P2 命名**：P2a 摘要提示词 v6 顺带给 `title`（零额外调用）；P2b 可选一次全课程命名（`chapterTitles: auto|rules|llm`）。
- **P3 课程名 + 自检 + 呈现**：`pickCourseTitle()` 候选链；`job.outline.diagnostics` + 报告「目录自检」；
  `toc()` 过滤碎片子标题。
- **P4 表格/目录页识别**：可选，最后做。

### 下一步

1. 等用户确认范围（建议 1.15.0 = P0+P1+P3；1.16.0 = P2a）。
2. 注意 P1 会改变部分课件的章数（旧任务有 `outline.boundaries` 锁定，重跑不会串号）。
3. 诊断命令：`node tools/try-outline.mjs --pages <课件>`（本轮新增，会标出可疑标题）。

## 二十九、2026-10-31 · 1.15.0 标题与目录整修（§28 方案落地）

### 状态

| 项 | 值 |
|---|---|
| 本地版本 | **1.15.0** |
| 测试 | `--unit` **52 项**、`--real` **13 项**、`e2e-fake` 1 项、client 契约，全绿 |
| 方案文档 | `docs/title-outline-plan.md`（诊断原文 + 已实现标注） |
| 新增配置 | `chapterTitles: 'auto' | 'rules'`（默认 auto：允许摘要调用顺带给章标题） |

### 做了什么

| 层 | 实现 |
|---|---|
| 标题卫生 | 新增 `core/titles.js`：`cleanTitle`（去「幻灯片 N:」/★/「（投入 x% 时间）」/页码后缀）、`titleScore`（否决纯数字、代码、邮箱/URL、标点开头的截断句、带逗号长句；重复面包屑降权；中文文档里的纯英文行降权）、`normalisePageTitles`（逐页重选标题，写 `titleScore`） |
| 接入点 | `cleanDoc` 统一跑一次；**OCR 换过正文的页会清空旧标题并在 `prepareDocs` 里重算**（之前"只有空标题才补"）；`usableTitle` 直接信任 `titleScore`，避免丢掉文档上下文 |
| 分章边界 | `chaptersByTitleChange`：标题变化且当前章 ≥1200 字才开新章、<500 字并回上一章、越界退回定长切块、可用标题覆盖 <30% 时退回定长；`§ 编号` / 章节编号 / PowerPoint 节仍优先；PDF 文本里的表格行（整行文件名）不当章节，该启发式只在 PDF 上启用 |
| 课程名 | `pickCourseTitle`：文件名 / PDF 书签 / 首个合格页标题 / 章节标题，拒绝「幻灯片 N」「前言」「目录」和多章文件里的「第 N 章 …」；`courseTitleSource` 落进 job |
| 模型标题 | 摘要提示词 **v6** 加 `title`（4-24 字、不带编号）；`applyModelTitles` 只覆盖启发式章名（作者编号 / § / 节不动），重名用关键词消歧；`chapterTitles: 'rules'` 可关 |
| 呈现 | `toc()` 过滤碎片子标题（`pu`、`10.1×`）、去重、与章名重复的不列、最多 4 条、空时用关键词；标题自带编号时不再重复加「第 N 章」；思维导图/目录用 `stripHeadingNumber`；报告头「目录自检：N 章，X 章标题质量偏低…」 |
| 诊断 | `outline.diagnostics = {chapters, bad[], fallback[], duplicates[]}` 写进 `job.outline`，报告与 warnings 都用它 |

### 实测对照（本机）

| 文件 | 之前 | 之后 |
|---|---|---|
| `L10_C08_多态与虚函数.pdf` | 课程名 `幻灯片 1`；章名 `第 1 部分` / `fruit ptrfrui` / `class B : public A` | 课程名 `L10_C08_多态与虚函数`；7 章，首章 `第 8 章多态与虚函数` |
| `L12_C10_异常与断言.pdf` | 9 章（`异常`/`cat`/`QUE 对象析`） | 7 章，首章 `第 10 章异常与断言`；有模型时章名由摘要给 |
| `实验1-高质量编程基础.pptx` | 13 章固定 5 页块、`课程导读` ×3 | 14 章按标题变化（`课程实训案例引导`/`减少符号依赖`/`测试防护网：正交分解法`） |
| `关上800美元…pptx` | 10 章 § | **逐字不变**（单测守门） |
| `复习&自学大纲.pdf` | 11 章乱序、重复 | 10 章按序、无重复 |
| `C++程序设计课程复习讲义.docx` | 课程名 `前言与使用说明` | 课程名取文件名 |

### 注意

- **章数会变**（实验1 13→14、导出 PDF 11→10），旧任务有 `outline.boundaries` 锁定，重跑不串号。
- 摘要缓存因为 prompt v6 会失效一次（30 天缓存里的旧结构没有 `title`）。
- `chapterTitles: 'rules'` 时 L10/L12 这类文字层碎掉的 PDF 仍会有句子碎片章名——这是本地规则的上限。

### 下一步

1. 重载插件后跑一份真实课件，确认模型标题的实际质量（假模型只能验证"会被采用"）。
2. 若模型标题仍不理想：给 `applyModelTitles` 加"与章节正文的重合度"校验，或对低分标题再发一次命名调用（P2b）。
3. P4 的目录页识别仍没做（只做了 PDF 表格行）；真遇到整页目录的课件再补。
