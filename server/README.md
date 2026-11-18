# 课程助手 · 网页版

同一套解析/分章/总结流水线，外面套一层 **FastAPI + 账号 + 任务队列**，让没有装 DSH 的人也能上传课件、在线看报告。

```
browser ── /api/auth/* /api/jobs/*  ── FastAPI（SQLAlchemy + SQLite/Postgres）
                                          └─ JobRunner（asyncio 队列，1 并发）
                                              └─ node bin/run-job.mjs --spec …
                                                  └─ core/pipeline.js
                                                      └─ core/llm-http.js → DeepSeek /chat/completions
```

## 目录

| 路径 | 作用 |
|---|---|
| `server/app/main.py` | 应用装配、lifespan（建库 + 恢复中断任务 + 启动 worker）、安全响应头、静态页 |
| `server/app/config.py` | 全部配置（环境变量或 `server/.env`） |
| `server/app/routers/auth.py` | 注册 / 登录 / 登出 / 我是谁（含今日配额） |
| `server/app/routers/jobs.py` | 上传、列表、轮询、报告（md / html）、删除 |
| `server/app/worker.py` | 子进程跑 Node 流水线，JSONL 进度写库，超时杀进程 |
| `server/app/static/` | 单页前端（原生 JS，无构建步骤） |
| `bin/run-job.mjs` | 无头入口：读 spec、跑 `runPipeline`、stdout 输出 JSONL |
| `core/llm-http.js` | 把 Host 的 `llm` 接口实现成 OpenAI 兼容 SSE 客户端 |
| `server/tests/` | pytest（假 runner，不调模型、不需要 Node） |
| `tools/stub-llm.mjs` | 本地替身模型（固定 JSON，SSE 流式返回） |
| `tools/smoke-server.mjs` | 端到端冒烟：注册 → 上传 → 轮询 → 取报告 HTML |

## 本地开发

需要 Node 22、Python 3.12。Windows 下把 `bin/` 换成 `Scripts/`。

```bash
python -m venv server/.venv
server/.venv/bin/pip install -r server/requirements-dev.txt

cp server/.env.example server/.env      # 填 LLM_API_KEY（DeepSeek 的 key）
server/.venv/bin/python -m uvicorn app.main:app --app-dir server --port 8099
```

打开 <http://127.0.0.1:8099>。本地默认 SQLite 落在 `data/app.db`，上传件在 `data/uploads/`。

不花钱联调：另开一个终端跑替身模型，再跑冒烟脚本。

```bash
node tools/stub-llm.mjs                                   # http://127.0.0.1:8787/v1
LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=stub \
  node tools/smoke-server.mjs http://127.0.0.1:8099 ~/Downloads/某章.pdf          # Normal
LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=stub \
  node tools/smoke-server.mjs http://127.0.0.1:8099 ~/Downloads/某实验.pptx max   # MAX
LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=stub \
  node tools/smoke-server.mjs http://127.0.0.1:8099 ~/Downloads/某章.pdf plus 10 80 120  # PLUS
```

PLUS 会额外检查合并报告里 `## 01`…`## 05` 五册齐全。网页版目前把五册合并成一份 Markdown 下载；
独立五册文件写在 `DATA_DIR/reports/`（Render 免费档磁盘是临时的，重启即失，合并报告存在数据库里不受影响）。

测试：

```bash
server/.venv/bin/python -m pytest server/tests -q          # 11 项
```

`server/tests/fake_runner.py` 冒充 `bin/run-job.mjs`：同样的 `--spec` 参数、同样的 JSONL 事件、写一份假报告，所以 API 测试不依赖 Node、不依赖模型。

## 部署到 Render（免费档）

1. 代码推到 GitHub（Render 直接从仓库构建）。
2. Render → **New → Blueprint**，选这个仓库；`render.yaml` 会创建一个 free Docker web service。
3. 在 Neon（或 Supabase）建一个免费 Postgres，拿到连接串。
4. 在 Render 服务的 Environment 里填：

   | 变量 | 值 |
   |---|---|
   | `LLM_API_KEY` | DeepSeek 的 key（必填） |
   | `DATABASE_URL` | `postgresql+psycopg://…?sslmode=require`（必填；免费档磁盘是临时的，别用 SQLite） |
   | `SIGNUP_CODE` | 邀请码；留空 = 谁都能注册 |
   | `SECURE_COOKIES` | `true`（已经在 render.yaml 里） |

   其余（`JOBS_PER_DAY=3`、`MAX_FILES=3`、`MAX_UPLOAD_MB=40`、`LLM_MODEL=deepseek-chat`）都在 `render.yaml` 里。

5. 首次构建约 3-5 分钟（Python 依赖 + Node 二进制 + `npm install`），健康检查走 `/healthz`。
6. 冒烟：`node tools/smoke-server.mjs https://<your-app>.onrender.com 课件.pdf`。

### 免费档的脾气

- 15 分钟没人访问会休眠，下一次请求冷启动 20-40 秒（页面会先转圈）。
- 512 MB / 0.1 CPU：`worker_concurrency=1`，大 PDF（>30 MB）会很慢；`JOB_TIMEOUT_SECONDS` 默认 1800 秒。
- 磁盘是临时的：重启/重新部署会清掉上传件；任务与报告在 Postgres 里不丢，但**正在跑的任务会变成「服务重启，任务已中断」**。
- 免费 Postgres（Neon）会休眠，冷启动多 1-2 秒。

## 安全与限额

- 密码 scrypt（N=2^14, r=8, p=1），会话 token 只存 sha256，登出即删库里的行。
- Cookie：`HttpOnly` + `SameSite=Lax`，线上 `Secure`；14 天滑动过期。
- 写操作校验 `Origin` 与 `Host` 一致（CSRF）；响应带 CSP / nosniff / frame-options。
- 上传：扩展名白名单 + magic 头校验；文件名清洗；单文件 40 MB、每次 3 个。
- 缓存：任务 options 里强制 `noReuse: true`，避免 A 用户命中 B 用户的报告。
- 报告 HTML 由服务端 markdown 渲染；CSP 不允许内联脚本。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | `{email,password,code?}` → 201 + Cookie |
| POST | `/api/auth/login` | `{email,password}` → 200 + Cookie（10 分钟 8 次限流） |
| POST | `/api/auth/logout` | 删会话 |
| GET | `/api/auth/me` | `{email,quota:{used_today,limit},invite_required}` |
| POST | `/api/jobs` | multipart：`files`、`report_level=normal|max|plus`、`with_videos`；PLUS 另带 `days` / `target` / `minutes` |
| GET | `/api/jobs?limit=20` | 当前用户的任务列表 |
| GET | `/api/jobs/{id}` | 状态 / 进度 / 错误 |
| GET | `/api/jobs/{id}/report` | 报告 Markdown（`text/markdown`） |
| GET | `/api/jobs/{id}/report.html` | 报告 HTML 片段 |
| GET | `/api/jobs/{id}/report.pdf` | PDF（封面 + 结构图 + 正文）；按需生成并缓存，无 `.meta.json` 的旧报告返回 409 |
| DELETE | `/api/jobs/{id}` | 删除（运行中返回 409） |
| GET | `/healthz` | `{ok:true,version}` |

## 排错

| 现象 | 处理 |
|---|---|
| 启动报 `unable to open database file` | SQLite 路径的父目录不存在；`Database` 现在会自动建目录，仍失败就检查 `DATABASE_URL` 拼写 |
| 任务失败 `找不到 Node 运行时` | 设置 `NODE_BIN`（Docker 镜像里是 `/usr/local/bin/node`） |
| 生成失败 `模型接口 401` | `LLM_API_KEY` 过期或没填；402 是余额不足，429 是限流 |
| 页面一直「排队中」 | 看服务日志里有没有子进程崩溃；`run-job.mjs` 的 stderr 会进任务的 error 字段 |
| 部署后 500 | 看 Render Logs；常见是 `DATABASE_URL` 少了 `+psycopg` 或没开 `sslmode` |
