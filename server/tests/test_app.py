"""End-to-end-ish API tests: real FastAPI app, real DB, fake pipeline runner."""

import time

PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"


def register(client, email="a@example.com", password="password123", code=None):
    payload = {"email": email, "password": password}
    if code is not None:
        payload["code"] = code
    return client.post("/api/auth/register", json=payload)


def upload(client, name="ch1.pdf", content=PDF, **form):
    data = {"report_level": "normal", "with_videos": "false", **form}
    return client.post("/api/jobs", files={"files": (name, content, "application/pdf")}, data=data)


def wait_done(client, job_id, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/jobs/{job_id}").json()
        if body["status"] in {"done", "error"}:
            return body
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish in {timeout}s")


def test_register_and_me(make_client):
    client = make_client()
    assert register(client).status_code == 201
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "a@example.com"
    assert me.json()["quota"]["limit"] == 5


def test_register_validation(make_client):
    client = make_client()
    assert register(client, password="short").status_code == 422
    assert register(client, email="not-an-email").status_code == 422
    assert register(client).status_code == 201
    assert register(client).status_code == 409


def test_login_and_logout(make_client):
    client = make_client()
    register(client)
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    bad = client.post("/api/auth/login", json={"email": "a@example.com", "password": "wrong-pass"})
    assert bad.status_code == 401
    ok = client.post("/api/auth/login", json={"email": "A@Example.com", "password": "password123"})
    assert ok.status_code == 200
    assert client.get("/api/auth/me").json()["email"] == "a@example.com"


def test_invite_code(make_client):
    client = make_client(signup_code="let-me-in")
    assert register(client).status_code == 403
    assert register(client, code="nope").status_code == 403
    assert register(client, code="let-me-in").status_code == 201


def test_job_lifecycle(make_client):
    client = make_client()
    register(client)
    created = upload(client)
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]
    done = wait_done(client, job_id)
    assert done["status"] == "done", done
    assert done["has_report"] is True

    report = client.get(f"/api/jobs/{job_id}/report")
    assert report.status_code == 200
    assert "假报告" in report.text

    html = client.get(f"/api/jobs/{job_id}/report.html")
    assert html.status_code == 200
    assert "<table>" in html.text

    listing = client.get("/api/jobs").json()["jobs"]
    assert [item["id"] for item in listing] == [job_id]

    assert client.delete(f"/api/jobs/{job_id}").status_code == 200
    assert client.get(f"/api/jobs/{job_id}").status_code == 404


def test_job_isolation(make_client):
    client = make_client()
    register(client)
    job_id = upload(client).json()["id"]
    wait_done(client, job_id)
    client.post("/api/auth/logout")
    register(client, email="b@example.com")
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert client.get(f"/api/jobs/{job_id}/report").status_code == 404
    assert client.delete(f"/api/jobs/{job_id}").status_code == 404


def test_daily_quota(make_client):
    client = make_client(jobs_per_day=1)
    register(client)
    assert upload(client).status_code == 201
    second = upload(client, name="ch2.pdf")
    assert second.status_code == 429
    assert "额度" in second.json()["detail"]


def test_rejects_bad_files(make_client):
    client = make_client()
    register(client)
    assert upload(client, name="evil.exe", content=b"MZ").status_code == 422
    assert upload(client, name="fake.pdf", content=b"not a pdf").status_code == 422
    assert upload(client).status_code == 201  # the rejected ones never counted


def test_missing_model_key(make_client):
    client = make_client(llm_api_key="")
    register(client)
    assert upload(client).status_code == 503
