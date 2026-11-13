"""Auth router: register / login / logout / me. Cookie sessions, scrypt hashes."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..deps import get_current_user, get_db
from ..models import AuthSession, Job, User, utcnow
from ..security import (
    email_problem,
    hash_password,
    hash_token,
    new_session_token,
    normalize_email,
    password_problem,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# in-memory throttle: good enough for one instance, resets on deploy
_attempts: dict[str, deque[float]] = defaultdict(deque)
WINDOW = 600
MAX_ATTEMPTS = 8


def _throttled(key: str) -> bool:
    now = time.time()
    bucket = _attempts[key]
    while bucket and now - bucket[0] > WINDOW:
        bucket.popleft()
    return len(bucket) >= MAX_ATTEMPTS


def _remember(key: str) -> None:
    _attempts[key].append(time.time())


class RegisterIn(BaseModel):
    email: str
    password: str
    code: str = ""


class LoginIn(BaseModel):
    email: str
    password: str


def _issue_session(db: Session, settings, user: User, response: Response) -> None:
    token = new_session_token()
    db.add(
        AuthSession(
            token_hash=hash_token(token),
            user_id=user.id,
            expires_at=utcnow() + timedelta(days=settings.session_days),
        )
    )
    response.set_cookie(
        settings.session_cookie,
        token,
        max_age=settings.session_days * 86400,
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookies,
        path="/",
    )


@router.post("/register", status_code=201)
def register(payload: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    settings = request.app.state.settings
    email = normalize_email(payload.email)
    for problem in (email_problem(email), password_problem(payload.password)):
        if problem:
            raise HTTPException(status_code=422, detail=problem)
    if settings.signup_code and payload.code.strip() != settings.signup_code:
        raise HTTPException(status_code=403, detail="邀请码不对")
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(status_code=409, detail="这个邮箱已经注册过了")
    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    db.flush()
    _issue_session(db, settings, user, response)
    db.commit()
    return {"email": user.email}


@router.post("/login")
def login(payload: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    settings = request.app.state.settings
    email = normalize_email(payload.email)
    client = request.client.host if request.client else "?"
    key = f"{client}:{email}"
    if _throttled(key):
        raise HTTPException(status_code=429, detail="尝试太频繁，请十分钟后再试")
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if not user or not verify_password(payload.password, user.password_hash):
        _remember(key)
        raise HTTPException(status_code=401, detail="邮箱或密码不对")
    db.query(AuthSession).filter(AuthSession.user_id == user.id, AuthSession.expires_at < utcnow()).delete()
    _issue_session(db, settings, user, response)
    db.commit()
    return {"email": user.email}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    settings = request.app.state.settings
    token = request.cookies.get(settings.session_cookie)
    if token:
        db.query(AuthSession).filter(AuthSession.token_hash == hash_token(token)).delete()
        db.commit()
    response.delete_cookie(settings.session_cookie, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    settings = request.app.state.settings
    since = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    used = db.scalar(select(func.count(Job.id)).where(Job.user_id == user.id, Job.created_at >= since)) or 0
    return {
        "email": user.email,
        "created_at": user.created_at,
        "quota": {"used_today": int(used), "limit": settings.jobs_per_day},
        "invite_required": bool(settings.signup_code),
    }
