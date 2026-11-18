/* 课程助手 web console — no framework, no build step. */

const $ = (id) => document.getElementById(id);
const state = { me: null, mode: "login", jobs: [], currentId: null, timer: null };

const STATUS_TEXT = { queued: "排队中", running: "生成中", done: "完成", error: "失败" };

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  if (!res.ok) {
    let detail = `请求失败（${res.status}）`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) { /* not JSON */ }
    if (res.status === 401 && !path.startsWith("/api/auth/")) showAuth();
    throw new Error(detail);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("application/json") ? res.json() : res.text();
}

function setMsg(el, text, kind = "") {
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function fmtTime(value) {
  if (!value) return "";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value + "Z";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

function showAuth() {
  state.me = null;
  $("app").hidden = true;
  $("who").hidden = true;
  $("auth").hidden = false;
  stopPolling();
}

function showApp(me) {
  state.me = me;
  $("auth").hidden = true;
  $("app").hidden = false;
  $("who").hidden = false;
  $("who-email").textContent = me.email;
  renderQuota();
  loadJobs();
}

function renderQuota() {
  if (!state.me) return;
  const q = state.me.quota;
  $("quota").textContent = `今日 ${q.used_today}/${q.limit} 份`;
}

/* ---------- auth ---------- */

function setMode(mode) {
  state.mode = mode;
  $("tab-login").classList.toggle("active", mode === "login");
  $("tab-register").classList.toggle("active", mode === "register");
  $("auth-submit").textContent = mode === "login" ? "登录" : "注册";
  $("code-row").hidden = !(mode === "register" && state.inviteRequired);
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  setMsg($("auth-msg"), "");
}

async function submitAuth(event) {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || password.length < 8) {
    setMsg($("auth-msg"), "邮箱要填，密码至少 8 位", "bad");
    return;
  }
  const body = { email, password };
  if (state.mode === "register") body.code = $("code").value.trim();
  $("auth-submit").disabled = true;
  try {
    await api(`/api/auth/${state.mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const me = await api("/api/auth/me");
    showApp(me);
  } catch (error) {
    setMsg($("auth-msg"), error.message, "bad");
  } finally {
    $("auth-submit").disabled = false;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (_) { /* ignore */ }
  showAuth();
}

/* ---------- jobs ---------- */

function activeJobs() {
  return state.jobs.filter((job) => job.status === "queued" || job.status === "running").length;
}

function renderJobs() {
  const list = $("jobs");
  list.innerHTML = "";
  $("jobs-empty").hidden = state.jobs.length > 0;
  for (const job of state.jobs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job" + (job.id === state.currentId ? " active" : "");
    button.addEventListener("click", () => openJob(job.id));

    const name = document.createElement("span");
    name.className = "job-name";
    name.textContent = job.filename || job.id;
    const chip = document.createElement("span");
    chip.className = `chip ${job.status}`;
    chip.textContent = STATUS_TEXT[job.status] || job.status;
    const meta = document.createElement("span");
    meta.className = "job-meta";
    meta.textContent = [job.phase, fmtTime(job.created_at)].filter(Boolean).join(" · ");

    button.append(name, chip, meta);
    item.append(button);
    list.append(item);
  }
}

async function loadJobs() {
  try {
    const data = await api("/api/jobs");
    state.jobs = data.jobs || [];
    renderJobs();
    syncPolling();
  } catch (error) {
    setMsg($("upload-msg"), error.message, "bad");
  }
}

function syncPolling() {
  const active = activeJobs();
  if (active && !state.timer) {
    state.timer = setInterval(async () => {
      await loadJobs();
      if (state.currentId) await openJob(state.currentId, true);
    }, 2500);
  } else if (!active) {
    stopPolling();
  }
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

async function upload(event) {
  event.preventDefault();
  const files = $("files").files;
  if (!files.length) {
    setMsg($("upload-msg"), "先选一份课件", "bad");
    return;
  }
  const form = new FormData();
  for (const file of files) form.append("files", file);
  form.append("report_level", $("level").value);
  form.append("with_videos", $("videos").checked ? "true" : "false");
  if ($("level").value === "plus") {
    form.append("days", $("plus-days").value || "14");
    form.append("target", $("plus-target").value || "80");
    form.append("minutes", $("plus-minutes").value || "120");
  }

  $("submit").disabled = true;
  setMsg($("upload-msg"), "上传中…");
  try {
    const job = await api("/api/jobs", { method: "POST", body: form });
    setMsg($("upload-msg"), "已排队，正在生成…", "ok");
    $("files").value = "";
    $("picked").textContent = "还没有选文件";
    state.currentId = job.id;
    await loadJobs();
    await openJob(job.id);
    try { state.me = await api("/api/auth/me"); renderQuota(); } catch (_) { /* ignore */ }
  } catch (error) {
    setMsg($("upload-msg"), error.message, "bad");
  } finally {
    $("submit").disabled = false;
  }
}

async function openJob(id, quiet = false) {
  state.currentId = id;
  renderJobs();
  $("report-empty").hidden = true;
  try {
    const job = await api(`/api/jobs/${id}`);
    $("report-title").textContent = job.filename || job.id;
    $("report-meta").textContent = [STATUS_TEXT[job.status] || job.status, job.phase, fmtTime(job.created_at)]
      .filter(Boolean).join(" · ");

    const isRunning = job.status === "queued" || job.status === "running";
    $("progress").hidden = !isRunning;
    $("bar").style.width = `${Math.round((job.progress || 0) * 100)}%`;
    $("progress-text").textContent = job.message || "";
    $("download").hidden = job.status !== "done";
    $("delete").hidden = job.status === "running";
    if (job.status === "done") {
      $("download").href = `/api/jobs/${job.id}/report`;
      $("download").setAttribute("download", `${(job.filename || "report").replace(/\.[^.]+$/, "")}.md`);
      const html = await api(`/api/jobs/${job.id}/report.html`);
      $("report-body").innerHTML = html;
      $("report-empty").hidden = true;
    } else if (job.status === "error") {
      $("report-body").innerHTML = "";
      $("report-empty").hidden = false;
      $("report-empty").textContent = `生成失败：${job.error || job.message || "未知原因"}`;
    } else {
      $("report-body").innerHTML = "";
      $("report-empty").hidden = false;
      $("report-empty").textContent = "正在生成，页面会自动刷新…";
    }
  } catch (error) {
    if (!quiet) setMsg($("upload-msg"), error.message, "bad");
  }
}

async function removeJob() {
  if (!state.currentId) return;
  if (!window.confirm("删除这份报告？")) return;
  try {
    await api(`/api/jobs/${state.currentId}`, { method: "DELETE" });
    state.currentId = null;
    $("report-body").innerHTML = "";
    $("report-title").textContent = "报告";
    $("report-meta").textContent = "从左边选一份报告查看。";
    $("download").hidden = true;
    $("delete").hidden = true;
    $("report-empty").hidden = false;
    $("report-empty").textContent = "报告已删除。";
    await loadJobs();
  } catch (error) {
    setMsg($("upload-msg"), error.message, "bad");
  }
}

/* ---------- wiring ---------- */

function wire() {
  $("tab-login").addEventListener("click", () => setMode("login"));
  $("tab-register").addEventListener("click", () => setMode("register"));
  $("auth-form").addEventListener("submit", submitAuth);
  $("logout").addEventListener("click", logout);
  $("upload").addEventListener("submit", upload);
  $("level").addEventListener("change", () => {
    $("plus-row").hidden = $("level").value !== "plus";
  });
  $("refresh").addEventListener("click", () => { loadJobs(); if (state.currentId) openJob(state.currentId); });
  $("delete").addEventListener("click", removeJob);
  $("files").addEventListener("change", () => {
    const files = $("files").files;
    $("picked").textContent = files.length
      ? [...files].map((file) => `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`).join("、")
      : "还没有选文件";
  });
  $("drop").addEventListener("click", (event) => {
    if (event.target.id !== "files") $("files").click();
  });
}

async function boot() {
  wire();
  try {
    const me = await api("/api/auth/me");
    state.inviteRequired = me.invite_required;
    showApp(me);
  } catch (_) {
    state.inviteRequired = true;
    showAuth();
  }
}

document.addEventListener("DOMContentLoaded", boot);
