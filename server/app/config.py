"""Runtime configuration, all overridable from the environment.

Render injects these from the dashboard; local development uses defaults plus
`server/.env` (see `.env.example`).
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / "server" / ".env", extra="ignore")

    app_name: str = "课程助手"
    # sqlite for local dev; Render uses a Neon/Supabase URL such as
    # postgresql+psycopg://user:pass@host/db?sslmode=require
    database_url: str = f"sqlite:///{(REPO_ROOT / 'data' / 'app.db').as_posix()}"
    data_dir: str = str(REPO_ROOT / "data")

    session_cookie: str = "ca_session"
    session_days: int = 14
    secure_cookies: bool = False
    # empty string = open registration; set it to require an invite code
    signup_code: str = ""

    max_upload_mb: int = 40
    max_files: int = 3
    jobs_per_day: int = 3
    job_timeout_seconds: int = 1800
    worker_concurrency: int = 1

    # the pipeline entry point; tests swap in a fake runner
    node_bin: str = os.environ.get("NODE_BIN", "node")
    runner_path: str = str(REPO_ROOT / "bin" / "run-job.mjs")

    llm_base_url: str = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
    llm_model: str = os.environ.get("LLM_MODEL", "deepseek-chat")
    llm_provider: str = os.environ.get("LLM_PROVIDER", "deepseek")
    llm_api_key: str = os.environ.get("LLM_API_KEY", os.environ.get("DEEPSEEK_API_KEY", ""))

    log_level: str = "info"

    @property
    def data_path(self) -> Path:
        path = Path(self.data_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def uploads_path(self) -> Path:
        path = self.data_path / "uploads"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def reports_path(self) -> Path:
        path = self.data_path / "reports"
        path.mkdir(parents=True, exist_ok=True)
        return path


@lru_cache
def get_settings() -> Settings:
    return Settings()
