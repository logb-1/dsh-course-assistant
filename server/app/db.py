"""Database bootstrap: SQLite by default, Postgres when DATABASE_URL says so."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def sqlite_file(url: str) -> Path | None:
    """Return the on-disk path of a sqlite URL, or None for memory/other DBs."""
    if not url.startswith("sqlite"):  # covers sqlite:// and sqlite+pysqlite://
        return None
    raw = url.split("///", 1)[-1].split("?", 1)[0]
    if not raw or raw == ":memory:":
        return None
    return Path(raw)


class Database:
    def __init__(self, url: str) -> None:
        path = sqlite_file(url)
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
        kwargs: dict = {"pool_pre_ping": True, "future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        self.engine = create_engine(url, **kwargs)
        self._session = sessionmaker(bind=self.engine, expire_on_commit=False, future=True)

    def create_all(self) -> None:
        # no Alembic for v1: the schema is small and additive changes are cheap
        from . import models  # noqa: F401  (registers the tables)

        Base.metadata.create_all(self.engine)

    def session(self) -> Session:
        return self._session()

    def close(self) -> None:
        self.engine.dispose()


def session_scope(db: Database) -> Iterator[Session]:
    session = db.session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
