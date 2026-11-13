import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

FAKE_RUNNER = Path(__file__).parent / "fake_runner.py"


@pytest.fixture
def make_client(tmp_path):
    opened = []

    def _make(**overrides):
        index = len(opened)
        values = {
            "database_url": f"sqlite:///{(tmp_path / f'test-{index}.db').as_posix()}",
            "data_dir": str(tmp_path / f"data-{index}"),
            "llm_api_key": "test-key",
            "node_bin": sys.executable,
            "runner_path": str(FAKE_RUNNER),
            "jobs_per_day": 5,
            "signup_code": "",
        }
        values.update(overrides)
        settings = Settings(**values)
        client = TestClient(create_app(settings))
        client.__enter__()
        opened.append(client)
        return client

    yield _make

    for client in opened:
        client.__exit__(None, None, None)
