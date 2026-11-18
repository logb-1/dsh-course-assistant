"""Job router: upload, list, poll, read the report, delete."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import markdown as markdown_lib
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, PlainTextResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..deps import get_current_user, get_db
from ..models import Job, User, utcnow
from ..security import job_id as new_job_id

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

ALLOWED_EXT = {".pdf", ".pptx", ".docx", ".md", ".txt"}
SAFE_NAME = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._()\- ]+")


def _safe_name(name: str) -> str:
    base = Path(name or "file").name
    cleaned = SAFE_NAME.sub("_", base).strip(" .") or "file"
    return cleaned[:120]


def _sniff(head: bytes, ext: str) -> bool:
    if ext == ".pdf":
        return head.startswith(b"%PDF")
    if ext in {".pptx", ".docx"}:
        return head.startswith(b"PK\x03\x04")
    return True


def job_json(job: Job, include_report: bool = False) -> dict:
    data = {
        "id": job.id,
        "status": job.status,
        "phase": job.phase,
        "progress": round(float(job.progress or 0), 3),
        "message": job.message,
        "filename": job.filename,
        "size": job.size,
        "error": job.error,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
        "has_report": bool(job.report_md),
    }
    if include_report:
        data["report"] = job.report_md
    return data


@router.post("", status_code=201)
async def create_job(
    request: Request,
    files: list[UploadFile] = File(...),
    report_level: str = Form("normal"),
    with_videos: bool = Form(True),
    days: int = Form(0),
    target: int = Form(0),
    minutes: int = Form(0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = request.app.state.settings
    if not settings.llm_api_key:
        raise HTTPException(status_code=503, detail="服务端还没配置模型 key，暂时不能生成报告")
    if len(files) == 0 or len(files) > settings.max_files:
        raise HTTPException(status_code=422, detail=f"一次最多 {settings.max_files} 个文件")
    if report_level not in {"normal", "max", "plus"}:
        raise HTTPException(status_code=422, detail="report_level 只能是 normal、max 或 plus")

    # PLUS 的排期参数缺省时用与插件一致的默认值，并夹到安全区间
    sprint = None
    if report_level == "plus":
        sprint = {
            "days": max(1, min(60, days or 14)),
            "target": max(30, min(100, target or 80)),
            "minutes": max(30, min(600, minutes or 120)),
        }

    since = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    used = db.scalar(select(func.count(Job.id)).where(Job.user_id == user.id, Job.created_at >= since)) or 0
    if used >= settings.jobs_per_day:
        raise HTTPException(status_code=429, detail=f"今天的额度（{settings.jobs_per_day} 份）用完了，明天再来")

    limit = settings.max_upload_mb * 1024 * 1024
    for upload in files:
        ext = Path(upload.filename or "").suffix.lower()
        if ext not in ALLOWED_EXT:
            raise HTTPException(status_code=422, detail=f"不支持的文件类型：{upload.filename}（支持 PDF/PPTX/DOCX/MD/TXT）")

    job = Job(
        id=new_job_id(),
        user_id=user.id,
        status="queued",
        phase="queued",
        message="排队中…",
        filename=_safe_name(files[0].filename or "file"),
        options_json=json.dumps(
            {
                "reportLevel": report_level,
                "withVideos": with_videos,
                **({"sprint": sprint} if sprint else {}),
                # the Linux image has no OCR engine; scanned PDFs will report low text
                "ocrMode": "off",
                "concurrency": 2,
                # content caching must never hand one user another user's report
                "noReuse": True,
            },
            ensure_ascii=False,
        ),
    )
    folder = settings.uploads_path / job.id
    folder.mkdir(parents=True, exist_ok=False)
    total = 0
    used_names: set[str] = set()
    try:
        for index, upload in enumerate(files):
            name = _safe_name(upload.filename or f"file-{index}")
            stem, suffix = Path(name).stem, Path(name).suffix
            while name in used_names:
                name = f"{stem}-{index}{suffix}"
            used_names.add(name)
            head = await upload.read(8)
            if not _sniff(head, suffix.lower()):
                raise HTTPException(status_code=422, detail=f"文件内容与扩展名不符：{upload.filename}")
            size = len(head)
            with (folder / name).open("wb") as handle:
                handle.write(head)
                while chunk := await upload.read(1024 * 256):
                    size += len(chunk)
                    total += len(chunk)
                    if total > limit:
                        raise HTTPException(status_code=413, detail=f"文件太大（上限 {settings.max_upload_mb} MB）")
                    handle.write(chunk)
            job.size = (job.size or 0) + size
        job.filename = ", ".join(sorted(used_names))[:255]
    except Exception:
        for path in folder.glob("*"):
            path.unlink(missing_ok=True)
        folder.rmdir()
        raise
    finally:
        for upload in files:
            await upload.close()

    db.add(job)
    db.commit()
    request.app.state.runner.enqueue(job.id)
    return job_json(job)


@router.get("")
def list_jobs(limit: int = 20, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    limit = max(1, min(50, int(limit)))
    rows = db.scalars(
        select(Job).where(Job.user_id == user.id).order_by(Job.created_at.desc()).limit(limit)
    ).all()
    return {"jobs": [job_json(row) for row in rows]}


@router.get("/{job_id}")
def get_job(job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="任务不存在")
    return job_json(job)


@router.get("/{job_id}/report", response_class=PlainTextResponse)
def get_report(job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job.status != "done" or not job.report_md:
        raise HTTPException(status_code=409, detail="报告还没生成好")
    return PlainTextResponse(job.report_md, media_type="text/markdown; charset=utf-8")


@router.get("/{job_id}/report.html", response_class=HTMLResponse)
def get_report_html(job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job.status != "done" or not job.report_md:
        raise HTTPException(status_code=409, detail="报告还没生成好")
    body = markdown_lib.markdown(job.report_md, extensions=["tables", "fenced_code", "sane_lists"])
    return HTMLResponse(f'<article class="report">{body}</article>')


@router.delete("/{job_id}")
def delete_job(job_id: str, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job.status == "running":
        raise HTTPException(status_code=409, detail="任务正在运行，等它结束再删")
    db.delete(job)
    db.commit()
    for folder in (request.app.state.settings.uploads_path / job_id,):
        if folder.exists():
            for path in folder.glob("*"):
                path.unlink(missing_ok=True)
            folder.rmdir()
    return {"ok": True}
