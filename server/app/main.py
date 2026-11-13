"""Application factory: routes, security headers, lifespan-managed worker."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import Settings, get_settings
from .db import Database
from .routers import auth, jobs
from .worker import JobRunner, recover_interrupted

STATIC_DIR = Path(__file__).parent / "static"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = Database(settings.database_url)
        db.create_all()
        recovered = recover_interrupted(db)
        if recovered:
            print(f"[startup] marked {recovered} interrupted job(s) as error", flush=True)
        runner = JobRunner(settings, db)
        app.state.db = db
        app.state.runner = runner
        await runner.start()
        try:
            yield
        finally:
            await runner.stop()
            db.close()

    app = FastAPI(title=settings.app_name, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin")
            if origin and urlparse(origin).netloc != request.headers.get("host", ""):
                return JSONResponse({"detail": "跨站请求被拒绝"}, status_code=403)
        response = await call_next(request)
        response.headers.setdefault("x-content-type-options", "nosniff")
        response.headers.setdefault("referrer-policy", "same-origin")
        response.headers.setdefault("x-frame-options", "DENY")
        response.headers.setdefault(
            "content-security-policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'",
        )
        return response

    app.include_router(auth.router)
    app.include_router(jobs.router)

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "version": __version__}

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    return app


app = create_app()
