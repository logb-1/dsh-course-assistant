# 工作日志 · dsh-course-assistant

按时间倒序。每条只记：改了什么、证据/数字、踩了什么坑。

## 2026-10-31 · 1.12.0 页级 OCR 分诊 + 三个静默 bug

- `core/ocr-triage.js`（`planOcrPages` / `applyOcrPages`）+ `core/ocr-score.js`（成词率/可疑字符/碎片行打分）：
  先给每页文本层打分，只把空页、几乎没字、字形乱码的页交给 OCR；每页各自择优，可读页不被覆盖。
- 引擎支持按页读取：`ocr.ps1 -Pages`、`rapidocr.py --pages`、RapidOCR 逐页报置信度；`ocrPdfDeep` 可对低分页
  调第二个引擎复读并取高分（`ocrPick: best`，默认 `first`）。
- Config 新增 `ocrMode`（auto/all/off，默认 auto）与 `ocrPick`；去重键纳入 OCR 设置。
- **修复三个"报成功、没干活"的 bug**：
  1. `prepareDocs` 引用了不存在的 `options` → 1.11.1 起幻灯片图片 OCR 从未执行（异常被 try/catch 吞掉）；
  2. `store.readOcr()` 只认 `{pages}` → 图片 OCR 缓存从未命中；
  3. PDF/PPTX 里只有图片的页被整页丢弃 → **L12 实际 67 页，之前只解析出 54 页**（13 页纯图片幻灯片
     从未进报告），且后面的页码全部错位。现在有图即内容、页号不压缩；pptx 按 `p:sldIdLst` 顺序编号，
     `media.js` 也用同一顺序找图片。
- 实测：`L12`（67 页）分诊只读 26 页、6.7 秒，25 页换成 OCR 文本，正文 5 502 → **8 214 字**，成词率 0.80；
  `实验1-高质量编程基础.pptx` 两张图全读（186 字，2/14 个提示词带 `[图片]`）。
- 测试：`--unit` **44 项**（新增 7：分诊两种模式、扫描件上限、择优不覆盖可读页、页号不重排、双引擎择优、
  图片 OCR 缓存与 python 透传、合成扫描件 PDF 全保留并判为扫描）、`--real` **11 项**（新增：67 页不丢图片页、
  真实课件分诊 ≤60%）、`e2e-fake`、client 契约全绿。
- 发布：npm **1.12.0**（45 个文件 / 447 KB unpacked，新模块都在包里），`latest` 已更新；
  GitHub `main` = `ba3e7b7`，tag `v1.12.0`。
- 小瑕疵：发布后又加了一条单测（合成扫描件 PDF），npm 页面上的 README 仍是「53 项 / 44 项」之前的数字；
  GitHub 上的 README 是最新的，下次发版自动对齐。
- 坑：`Select-Object -First N` 截断原生命令输出会让 PowerShell 报 exit code 1（不是命令失败）；
  npm 新版本号约 40 秒后才能在 `/<pkg>/<version>` 查到。
- 环境问题：`python` 在 PATH 上只有 Windows Store 的占位程序，`rapidocr` 引擎因此报 `available:false`
  （需要在配置里用 `ocrPython` 指向真的解释器）。

## 2026-10-31 · 交接（版本 1.11.1）

- 当前状态：npm `latest = 1.11.1`，GitHub `main` 与远端同步，tag `v1.11.1`。
- 测试：`--unit` **37 项**、`--real` 9 项、`e2e-fake` 1 项、client 契约，全绿。
- 交接文档：`HANDOFF.md` 第二十四节（现状速览 + 模块地图 + 未完成事项）。
- 外部事实：插件已收录进 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  （PR #8996 于 2026-10-24 合并），官网中英页面均在。
- 提醒：聊天里出现过两个 npm token，**应撤销重建**（需勾 Bypass 2FA 才能发布）。

## 2026-10-31 · 1.11.1 RapidOCR 图片通道跑通

- 安装 `pymupdf` + `rapidocr_onnxruntime`（约 150 MB），验证 `rapidocr.py --image` 一次输出正确中文。
- 修两个 bug：`recognizeImage` 调了不存在的 `spawnPython`；参数构建硬编码 `--pdf`。
- pipeline 把 `ocrPython` 传给图片 OCR（否则调系统 `python` 报 9009）。
- 双引擎对比：Windows vs RapidOCR 在 4 张基准图上 **CER 都是 1.1%**；RapidOCR 胜在跨平台、原始输出不需要偏旁合并。

## 2026-10-30 · 1.11.0 OCR 质量（P1 预处理 + P2 基准）

- `ocr.ps1`：短边 <500px 才放大（≤3×）、32×32 缩略图算亮度、**只有深色图**才灰度+反色；新增 `-NoPreprocess` 用于 A/B。
- `core/ocr-text.js`：拆词合并（`i nt`→`int`，关键字白名单）、`lEEE754`→`IEEE754`、代码行全角转半角、中文偏旁合并（`衤卜`→补 等）。
- `tools/ocr-bench.mjs` + `_gen_ocr_bench.py`：4 张合成图 + 金标文本，CER 平均 **9.9% → 1.1%**（深色中文 30.8% → 0%）。
- 坑：一开始无条件灰度，浅色图 CER 反而 8%→12%；改成条件化后恢复。

## 2026-10-30 · 1.10.0 关键词捕获增强

- 新增 `core/keywords.js`：模型 / 标题 / 本章 TF-IDF / 英文缩写四源融合。
- 权重：model 3、acronym 2.6、heading 2.5、corpus 2(+0.3 若跨章)。
- 规则：缩写绕过 `cleanTerm` 长度规则（否则 `x86-64` 被丢）、父子术语互斥、**每源最多 2 条**保证多样性、虚词黑名单、不足 2 条用标题兜底。
- 实测输出：`计算机系统 补码 / IEEE754 / x86-64 / 数据的机器级表示`。

## 2026-10-30 · 1.9.0 概念依据校验 + thorough 逐节摘要

- `knowledge.js`：概念名或 evidence 必须能在该章正文命中，否则丢弃并计入 `stats.droppedConcepts`；被丢概念上的边自然被 `validateEdges` 拒绝。
- `summarize.js`：`coverage: 'thorough'` 时取最大 4 节各调一次模型，本地按 bigram 相似度 ≥0.7 合并、上限 12 条。
- 单测：混入「中职英语」断言被丢；4 节长章断言 2–4 次调用。

## 2026-10-30 · 0.1 历史面板 + 一个真 bug

- 新增 `history.json` + `store.rememberHistory/listHistory` + `GET /history` + 标题栏「历史」下拉。
- **挖出 1.6.0 的静默缺陷**：前几次给 store 加方法时插入点落进了 `listJobs` 的 map 回调，`findReusableJob/readKnowledge/rememberJobKey` 全在公开 API 上不存在；调用处都写了 `?.`，导致**去重和知识图缓存从 1.6.0 起一直没生效**。单测 `store.rememberHistory is not a function` 把它顶出来。
- 教训：给对象字面量加方法不要用 `lastIndexOf('return {')` 猜位置。

## 2026-10-30 · 0.0.1 分节 + 覆盖率审计（1.8.0）

- `core/sections.js`：按 `chapter.subs` 或编号标题切节；切不出整章一节。
- `selectPassages` 改为三段式：每节最高分先占 55% 预算 → 首尾锚点 → 全局分数填充。
- `core/audit.js`：小节标题命中或要点 evidence 落在该节正文即算覆盖；课程级汇总，`ratio < 0.8` 自动警告；报告头部输出「要点覆盖 X/Y 节」。
- 要点上限 3-6 → 3-12，并在提示词里要求「每节至少 1 条」。

## 2026-10-30 · 1.7.0 幻灯片图片 OCR

- `core/media.js`：从 pptx zip 按 `a:blip/@r:embed` → rels → `ppt/media/*` 抽图；PNG/JPEG 头部解析尺寸；<8KB 或短边 <120px 丢弃；按 sha 去重；上限 40 张。
- `ocr.ps1` 新增 `-Image`；`ocr.js` 新增 `ocrImage()`；pipeline 按图片 sha 缓存到 `ocr/img-<sha>.json`。
- 实测（第3章 3.4 课件）：12 张图全读、补 6461 字、20 次模型提示词里 7 次带上 `[图片]` 文本。

## 2026-10-24 · 1.6.1 历史面板；1.6.0 知识图/调度

- 1.6.0：`graph.js`（环检测/拓扑/validateEdges）、`schedule.js`（失败分类 + 重试阶梯表 + planChapters）、`knowledge.js`（一次调用抽概念与前置）、`mindmap.js`（树 + Mermaid）、`dashboard.js`（离线 HTML 看板）、job 级去重。
- 1.6.0 实际运行发现**知识图静默为空**：`extractKnowledge` 只认 `chunk.type === 'text'`，而 Host `llm` 发的是 `text-delta`；空串 → 解析失败 → null，且没有警告。修复后加了一条"假 LLM 全流程"e2e 测试防复发。

## 2026-10-23 · 1.5.0 B 站推荐防跑题

- `terms.js`（通用词表 + 编号剥离）、`topic.js`（锚词/术语表/负面词）、《B站推荐改良方案》五层落地。
- 验收：跑题词命中 3 → **0**；第 3 章从「中职英语/ESP32/阅读理解」变为「深入理解计算机系统[00] 补码」；4/5 章有对题视频。

## 2026-10-23 · 1.4.0 证据机检 / 可续跑 / Config

- `verify.js` 报价核验（overlap/faithfulness 分档）、manifest 与心跳、Schemastery `Config`、CI 门禁、长章节节选。

## 2026-10-24 · 发布与收录

- npm 1.4.0 / 1.5.0 / 1.5.2 / 1.6.0 / 1.9.0 / 1.10.0 / 1.11.0 / 1.11.1 依次发布。
- 2026-10-24 PR #8996 合并进 awesome-dsh-plugin；官网中英页面生成。
- 事故：DSH 升级 0.2.1-rc.3 后插件启动崩溃，两个独立原因——① `dsh.client.immediately` + 无条件 `load()` 导致重复注册；② client 注册 id 用的是工作区别名 `@local/course-assistant`，rc.3 要求等于包名。修成 1.5.1/1.5.2。
- 事故：rc.3 重写 profile patch 时删掉 `agent-default-model`，导致所有章节「no API key」失败；恢复该行并给插件行单独钉 provider/model。
