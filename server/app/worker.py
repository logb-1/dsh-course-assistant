"""Background job runner: one Node subprocess per job, JSON-lines progress.

Render's free instance is small (512 MB, 0.1 CPU), so the queue is intentionally
dumb: one asyncio task per job, bounded by `worker_concurrency`, no Celery/Redis.
State lives in the database; the filesystem only holds uploads and the spec.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from .config import Settings
from .db import Database
from .models import Job, utcnow


def recover_interrupted(db: Database) -> int:
    """A Render free instance stops when idle; on boot every live job is dead."""
    session = db.session()
    try:
        rows = session.query(Job).filter(Job.status.in_(("queued", "running"))).all()
        for job in rows:
            job.status = "error"
            job.phase = "error"
            job.error = "服务重启，任务已中断，请重新上传"
            job.finished_at = utcnow()
        session.commit()
        return len(rows)
    finally:
        session.close()


class JobRunner:
    def __init__(self, settings: Settings, db: Database) -> None:
        self.settings = settings
        self.db = db
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self._tasks: set[asyncio.Task] = set()
        self._loop_task: asyncio.Task | None = None
        self._procs: dict[str, asyncio.subprocess.Process] = {}

    async def start(self) -> None:
        self._loop_task = asyncio.create_task(self._dispatch())

    async def stop(self) -> None:
        for proc in self._procs.values():
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
        if self._loop_task:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    def enqueue(self, job_id: str) -> None:
        self.queue.put_nowait(job_id)

    async def _dispatch(self) -> None:
        limit = max(1, int(self.settings.worker_concurrency or 1))
        semaphore = asyncio.Semaphore(limit)
        while True:
            job_id = await self.queue.get()
            task = asyncio.create_task(self._run_bounded(job_id, semaphore))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _run_bounded(self, job_id: str, semaphore: asyncio.Semaphore) -> None:
        async with semaphore:
            try:
                await self._run(job_id)
            except Exception as error:  # never let one job kill the dispatcher
                self._fail(job_id, f"内部错误：{error}")

    # ---------------------------------------------------------------- job body

    async def _run(self, job_id: str) -> None:
        session = self._session()
        try:
            job = session.get(Job, job_id)
            if not job or job.status != "queued":
                return
            job.status = "running"
            job.phase = "starting"
            job.started_at = utcnow()
            job.message = "启动分析…"
            session.commit()
            user_id = job.user_id
            options = json.loads(job.options_json or "{}")
        finally:
            session.close()

        work = self.settings.data_path / "jobs" / job_id
        work.mkdir(parents=True, exist_ok=True)
        upload_dir = self.settings.uploads_path / job_id
        names = sorted(p.name for p in upload_dir.iterdir() if p.is_file()) if upload_dir.exists() else []
        if not names:
            self._fail(job_id, "上传文件缺失，请重新上传")
            return

        spec = {
            "id": job_id,
            "dataDir": str(self.settings.data_path),
            "inputs": [{"name": name, "path": str(upload_dir / name)} for name in names],
            "options": options,
            "llm": {
                "baseUrl": self.settings.llm_base_url,
                "model": self.settings.llm_model,
                "provider": self.settings.llm_provider,
            },
        }
        spec_path = work / "spec.json"
        spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")

        env = dict(os.environ)
        env["LLM_BASE_URL"] = self.settings.llm_base_url
        env["LLM_MODEL"] = self.settings.llm_model
        env["LLM_PROVIDER"] = self.settings.llm_provider
        if self.settings.llm_api_key:
            env["LLM_API_KEY"] = self.settings.llm_api_key

        cmd = [self.settings.node_bin, self.settings.runner_path, "--spec", str(spec_path), "--quiet"]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(Path(self.settings.runner_path).resolve().parents[1]),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            self._fail(job_id, f"找不到 Node 运行时：{self.settings.node_bin}")
            return
        self._procs[job_id] = proc
        stderr_tail = bytearray()

        async def drain_stderr() -> None:
            assert proc.stderr is not None
            while chunk := await proc.stderr.read(4096):
                stderr_tail.extend(chunk)
                if len(stderr_tail) > 4000:
                    del stderr_tail[: len(stderr_tail) - 4000]

        drain = asyncio.create_task(drain_stderr())
        done_event: dict | None = None
        error_message = ""
        last_write = 0.0
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(30, int(self.settings.job_timeout_seconds or 1800))
        try:
            assert proc.stdout is not None
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    proc.kill()
                    error_message = "任务超时，已终止（可换更小的文件重试）"
                    break
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
                except asyncio.TimeoutError:
                    proc.kill()
                    error_message = "任务超时，已终止（可换更小的文件重试）"
                    break
                if not line:
                    break
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    event = json.loads(text)
                except json.JSONDecodeError:
                    continue
                now = asyncio.get_running_loop().time()
                if event.get("type") == "done":
                    done_event = event
                elif event.get("type") == "error":
                    error_message = str(event.get("message") or "分析失败")
                elif now - last_write > 0.4:
                    last_write = now
                    self._progress(job_id, event)
            await proc.wait()
        finally:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(drain, timeout=5)
            self._procs.pop(job_id, None)

        stderr_text = stderr_tail.decode("utf-8", "replace").strip()
        if done_event and done_event.get("status") == "done" and not error_message:
            self._complete(job_id, done_event, stderr_text)
            return
        if not error_message:
            error_message = str((done_event or {}).get("error") or "").strip()
        if not error_message:
            error_message = stderr_text[-500:] or f"分析进程退出码 {proc.returncode}"
        self._fail(job_id, error_message)

    def _complete(self, job_id: str, event: dict, stderr_text: str) -> None:
        report_path = Path(str(event.get("reportPath") or ""))
        report = ""
        if report_path.is_file():
            report = report_path.read_text(encoding="utf-8", errors="replace")
        session = self._session()
        try:
            job = session.get(Job, job_id)
            if not job:
                return
            if not report:
                job.status = "error"
                job.phase = "error"
                job.error = "报告文件没有生成"
            else:
                job.status = "done"
                job.phase = "done"
                job.progress = 1.0
                job.report_md = report
                job.message = f"完成：{int(event.get('chapters') or 0)} 章"
            job.finished_at = utcnow()
            session.commit()
        finally:
            session.close()
        with contextlib.suppress(OSError):
            shutil.rmtree(self.settings.uploads_path / job_id, ignore_errors=True)

    def _progress(self, job_id: str, event: dict) -> None:
        session = self._session()
        try:
            job = session.get(Job, job_id)
            if not job or job.status != "running":
                return
            phase = str(event.get("phase") or job.phase)
            progress = float(event.get("progress") or 0)
            message = str(event.get("message") or "")[:500]
            if phase != job.phase or progress - job.progress >= 0.01 or message != job.message:
                job.phase = phase
                job.progress = max(job.progress, min(1.0, progress))
                job.message = message
                session.commit()
        finally:
            session.close()

    def _fail(self, job_id: str, message: str) -> None:
        session = self._session()
        try:
            job = session.get(Job, job_id)
            if not job:
                return
            job.status = "error"
            job.phase = "error"
            job.error = message[:2000]
            job.finished_at = utcnow()
            session.commit()
        finally:
            session.close()

    def _session(self) -> Session:
        return self.db.session()
