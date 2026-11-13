"""Shared FastAPI dependencies: database session and the logged-in user."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .models import AuthSession, User, utcnow
from .security import hash_token


def get_settings(request: Request):
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    session = request.app.state.db.session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _aware(value: datetime | None) -> datetime | None:
    """SQLite drops tzinfo; treat stored timestamps as UTC."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(request.app.state.settings.session_cookie)
    if not token:
        raise HTTPException(status_code=401, detail="请先登录")
    row = db.get(AuthSession, hash_token(token))
    if not row or _aware(row.expires_at) <= utcnow():
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    user = db.get(User, row.user_id)
    if not user or user.disabled:
        raise HTTPException(status_code=401, detail="账号不可用")
    # sliding expiry, so an active user is not logged out mid-week
    remaining = _aware(row.expires_at) - utcnow()
    if remaining < timedelta(days=7):
        row.expires_at = utcnow() + timedelta(days=request.app.state.settings.session_days)
        db.add(row)
    return user
