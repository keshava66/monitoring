"""Server manager: start / stop / restart the backend and frontend services on
this host, tail their logs, git pull, and an interactive admin terminal.
Action and git pull output streams as NDJSON when the client sends
Accept: application/x-ndjson.

Every route except /health requires a Microsoft Graph token whose user is a
member of AD_GROUP_ADMIN (comma-separated names or object ids). The terminal
WebSocket authenticates with a short-lived one-time ticket obtained from
POST /api/terminal/ticket, so no bearer token ever appears in a URL.
"""
from __future__ import annotations

import asyncio
import codecs
import configparser
import hashlib
import json
import logging
import os
import queue
import re
import secrets
import shlex
import shutil
import signal as _signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict, deque
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import httpx
import psutil
import uvicorn
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket
from pydantic import BaseModel, Field
from starlette.responses import Response as StarletteResponse, StreamingResponse

BASE_DIR = Path(__file__).resolve().parent
# Services, git and the terminal get the environment the manager was started
# with. The manager's own .env (its ALLOWED_ORIGINS, admin group, repo
# credentials) must not leak into them: the backend would inherit the
# manager's ALLOWED_ORIGINS in place of the one in its own .env.
CHILD_ENV = dict(os.environ)
load_dotenv(BASE_DIR / ".env")
CONFIG_FILE = Path(os.environ.get("MANAGE_CONFIG", BASE_DIR / "config.ini"))
SERVICE_DIRS_FILE = BASE_DIR / "service_directories.json"
SERVICES = ("backend", "frontend")
GRAPH_BASE = os.getenv("GRAPH_BASE_URL", "https://graph.microsoft.com/v1.0").rstrip("/")
ENTRY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("manage")


# ── AUTH ─────────────────────────────────────────────────────────────────────

_graph = httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0))
_ADMIN_GROUPS = {g.strip() for g in os.environ.get("AD_GROUP_ADMIN", "").split(",") if g.strip()}
if not _ADMIN_GROUPS:
    logger.warning("AD_GROUP_ADMIN is not set — every request will be rejected.")


class _TokenCache:
    def __init__(self, ttl: int = 60, max_entries: int = 1024):
        self.ttl, self.max_entries = ttl, max_entries
        self._data: "OrderedDict[str, Tuple[float, Optional[str]]]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, token: str):
        k = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            hit = self._data.get(k)
            if hit and hit[0] > time.monotonic():
                return True, hit[1]
            self._data.pop(k, None)
            return False, None

    def put(self, token: str, email: Optional[str]):
        k = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            self._data[k] = (time.monotonic() + self.ttl, email)
            while len(self._data) > self.max_entries:
                self._data.popitem(last=False)


_tokens = _TokenCache()


def _graph_get(url: str, token: str, params: Optional[Dict] = None) -> httpx.Response:
    try:
        return _graph.get(url if url.startswith("http") else GRAPH_BASE + url, params=params,
                          headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Identity provider unavailable") from exc


def _admin_email(token: str) -> Optional[str]:
    """Email of the token's user if they're an admin, else None."""
    hit, email = _tokens.get(token)
    if hit:
        return email
    me = _graph_get("/me", token, {"$select": "mail,userPrincipalName"})
    if me.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not me.is_success:
        raise HTTPException(status_code=503, detail="Identity provider unavailable")
    profile = me.json()
    email = (profile.get("mail") or profile.get("userPrincipalName") or "").lower()
    is_admin = False
    url: Optional[str] = "/me/memberOf"
    params: Optional[Dict] = {"$select": "id,displayName", "$top": "999"}
    for _ in range(20):
        if not url or is_admin or not _ADMIN_GROUPS:
            break
        resp = _graph_get(url, token, params)
        if not resp.is_success:
            break
        body = resp.json()
        is_admin = any(g.get("displayName") in _ADMIN_GROUPS or g.get("id") in _ADMIN_GROUPS for g in body.get("value", []))
        url, params = body.get("@odata.nextLink"), None
    result = email if is_admin and email else None
    _tokens.put(token, result)
    return result


def require_admin(authorization: Optional[str] = Header(None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    email = _admin_email(authorization[7:].strip())
    if not email:
        raise HTTPException(status_code=403, detail="Admin role required")
    return email


# One-time terminal tickets: browsers can't send headers on a WebSocket
# handshake, so the authenticated REST call mints a 30-second ticket instead.
_tickets: Dict[str, Tuple[float, str]] = {}
_tickets_lock = threading.Lock()
TICKET_TTL = 30


def _mint_ticket(email: str) -> str:
    ticket = secrets.token_urlsafe(32)
    now = time.monotonic()
    with _tickets_lock:
        for k in [k for k, (exp, _) in _tickets.items() if exp <= now]:
            del _tickets[k]
        _tickets[ticket] = (now + TICKET_TTL, email)
    return ticket


def _redeem_ticket(ticket: str) -> Optional[str]:
    with _tickets_lock:
        entry = _tickets.pop(ticket, None)
    if entry and entry[0] > time.monotonic():
        return entry[1]
    return None


# ── APP / CORS ───────────────────────────────────────────────────────────────

app = FastAPI(title="Server Manager", version="2.0.0", docs_url=None, redoc_url=None, openapi_url=None)
_protected = APIRouter(dependencies=[Depends(require_admin)])
_ALLOWED_ORIGINS = [o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]


class _CORSMiddleware:
    """Minimal CORS for bearer-token APIs. WebSocket and lifespan scopes pass
    straight through untouched."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        origin = dict(scope.get("headers") or []).get(b"origin", b"").decode("latin-1")
        allowed = origin if origin in _ALLOWED_ORIGINS else ""
        if scope.get("method") == "OPTIONS" and origin:
            headers = {"Vary": "Origin"}
            if allowed:
                headers.update({
                    "Access-Control-Allow-Origin": allowed,
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization, Content-Type",
                    "Access-Control-Max-Age": "600",
                })
            await StarletteResponse(status_code=204 if allowed else 403, headers=headers)(scope, receive, send)
            return

        async def _inject(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"vary", b"Origin"))
                headers.append((b"x-content-type-options", b"nosniff"))
                if allowed:
                    headers.append((b"access-control-allow-origin", allowed.encode()))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, _inject)


app.add_middleware(_CORSMiddleware)


# ── helpers ──────────────────────────────────────────────────────────────────

def read_config() -> configparser.ConfigParser:
    if not CONFIG_FILE.is_file():
        raise HTTPException(status_code=500, detail=f"config.ini not found at {CONFIG_FILE}")
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.read(CONFIG_FILE, encoding="utf-8")
    return cfg


def _section(cfg: configparser.ConfigParser, name: str) -> Dict[str, str]:
    return dict(cfg[name]) if cfg.has_section(name) else {}


def _ssl_env(cfg: configparser.ConfigParser) -> Dict[str, str]:
    ssl = _section(cfg, "ssl")
    return {k: v for k, v in (("SSL_CERTFILE", ssl.get("certfile", "")), ("SSL_KEYFILE", ssl.get("keyfile", ""))) if v}


def allowed_roots(cfg: configparser.ConfigParser) -> List[Path]:
    roots = [Path.home().resolve()]
    roots += [Path(p.strip()).resolve() for p in _section(cfg, "search_paths").values() if p.strip()]
    return roots


def within_roots(path: Path, roots: List[Path]) -> bool:
    return any(path == r or r in path.parents for r in roots)


def validate_service(service: str) -> None:
    if service not in SERVICES:
        raise HTTPException(status_code=404, detail=f"Unknown service '{service}'. Valid: {list(SERVICES)}")


def read_pid(svc_dir: str, service: str) -> Optional[int]:
    """PID from <dir>/<service>.pid if that process is still the one the
    script started. A process born well after the pid file was written is a
    recycled PID, not our service."""
    if not svc_dir:
        return None
    pidfile = Path(svc_dir) / f"{service}.pid"
    try:
        pid = int(pidfile.read_text().strip())
        written = pidfile.stat().st_mtime
        born = psutil.Process(pid).create_time()
    except (OSError, ValueError, psutil.Error):
        return None
    return pid if born <= written + 5 else None


def _duration(seconds: int) -> str:
    return f"{seconds // 60} min" if seconds >= 60 else f"{seconds}s"


def fmt_uptime(seconds: float) -> str:
    secs = max(0, int(seconds))
    d, r = divmod(secs, 86400)
    h, r = divmod(r, 3600)
    m, _ = divmod(r, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


# psutil measures CPU between two calls on the same object, so keep the
# Process objects. Readings closer than CPU_MIN_WINDOW apart are noise, so a
# fresh process gets one short sample and quick repeat calls reuse the last.
CPU_MIN_WINDOW = 1.0
_procs: Dict[int, list] = {}  # pid -> [Process, last cpu %, measured at]
_procs_lock = threading.Lock()
_host_cpu = [psutil.cpu_percent(None), time.monotonic()]


def _cpu(entry: list) -> float:
    now = time.monotonic()
    if now - entry[2] >= CPU_MIN_WINDOW:
        entry[1], entry[2] = round(entry[0].cpu_percent(None), 1), now
    return entry[1]


def proc_stats(pids: Dict[str, Optional[int]]) -> Dict[str, dict]:
    empty = {"cpu": None, "mem": None, "uptime": None}
    live = set(filter(None, pids.values()))
    with _procs_lock:
        for pid in [p for p in _procs if p not in live]:
            del _procs[pid]
        fresh = []
        for pid in live - _procs.keys():
            try:
                proc = psutil.Process(pid)
                proc.cpu_percent(None)
                _procs[pid] = [proc, 0.0, 0.0]
                fresh.append(pid)
            except psutil.Error:
                pass
        if fresh:
            time.sleep(0.1)
            for pid in fresh:
                _procs[pid][1], _procs[pid][2] = round(_procs[pid][0].cpu_percent(None), 1), time.monotonic()
        out, now = {}, time.time()
        for svc, pid in pids.items():
            entry = _procs.get(pid) if pid else None
            try:
                out[svc] = {"cpu": _cpu(entry), "mem": round(entry[0].memory_percent(), 1),
                            "uptime": fmt_uptime(now - entry[0].create_time())} if entry else empty
            except psutil.Error:
                _procs.pop(pid, None)
                out[svc] = empty
        return out


def _host_cpu_percent() -> float:
    with _procs_lock:
        now = time.monotonic()
        if now - _host_cpu[1] >= CPU_MIN_WINDOW:
            _host_cpu[0], _host_cpu[1] = psutil.cpu_percent(None), now
        return round(_host_cpu[0], 1)


def host_stats(paths: List[str]) -> dict:
    mount = next((p for p in paths if p and Path(p).is_dir()), str(Path.home()))
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        load = None
    return {
        "hostname": socket.gethostname(),
        "cpu": _host_cpu_percent(),
        "cores": psutil.cpu_count() or 1,
        "load": load,
        "mem": round(psutil.virtual_memory().percent, 1),
        "disk": round(psutil.disk_usage(mount).percent, 1),
        "disk_path": mount,
        "uptime": fmt_uptime(time.time() - psutil.boot_time()),
    }


def tail_file(path: Path, lines: int) -> str:
    """Last `lines` lines of a file, read backwards in blocks."""
    block, data = 64 * 1024, b""
    with path.open("rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        while pos > 0 and data.count(b"\n") <= lines:
            step = min(block, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
    return b"\n".join(data.splitlines()[-lines:]).decode("utf-8", errors="replace")


# ── long-running jobs ────────────────────────────────────────────────────────
# Service actions and git pull run in their own process group. A reader
# thread owns the pipe, so the job always runs to completion and releases its
# claim even when the browser that started it goes away mid-way.

_claims: Dict[str, dict] = {}
_claims_lock = threading.Lock()


def _claim(key: str, action: str, email: str) -> None:
    with _claims_lock:
        held = _claims.get(key)
        if held:
            raise HTTPException(status_code=409, detail=f"{key} is busy: {held['action']} started by {held['by']}.")
        _claims[key] = {"action": action, "by": email, "since": int(time.time())}


def _release(key: str) -> None:
    with _claims_lock:
        _claims.pop(key, None)


def _busy(key: str) -> Optional[dict]:
    with _claims_lock:
        held = _claims.get(key)
        return dict(held) if held else None


def _kill_group(proc, sig=_signal.SIGTERM) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.send_signal(sig)
        except ProcessLookupError:
            pass


class Job:
    _END = object()

    def __init__(self, key: str, argv: List[str], env: Dict[str, str], timeout: int,
                 redact: str = "", cleanup: Optional[str] = None):
        self.key, self.timeout, self.redact, self.cleanup = key, timeout, redact, cleanup
        self.queue: "queue.SimpleQueue" = queue.SimpleQueue()
        self.returncode: Optional[int] = None
        self.proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                     env=env, start_new_session=True)
        threading.Thread(target=self._pump, name=f"job-{key}", daemon=True).start()

    def _pump(self) -> None:
        timed_out = threading.Event()

        def expire():
            timed_out.set()
            _kill_group(self.proc, _signal.SIGKILL)

        timer = threading.Timer(self.timeout, expire)
        timer.daemon = True
        timer.start()
        try:
            for raw in iter(self.proc.stdout.readline, b""):
                # Progress meters rewrite one line with \r: keep its final state.
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n").rsplit("\r", 1)[-1]
                self.queue.put(line.replace(self.redact, "***") if self.redact else line)
            rc = self.proc.wait()
            if timed_out.is_set():
                self.queue.put(f"Timed out after {self.timeout}s.")
                rc = -1
            self.returncode = rc
        finally:
            timer.cancel()
            self.proc.stdout.close()
            if self.cleanup:
                Path(self.cleanup).unlink(missing_ok=True)
            _release(self.key)
            self.queue.put(self._END)

    def lines(self):
        while (item := self.queue.get()) is not self._END:
            yield item


def _respond(request: Request, job: Job, extra: dict):
    """NDJSON stream for clients that ask for it, one JSON document otherwise."""
    if "application/x-ndjson" in request.headers.get("accept", ""):
        def stream():
            for line in job.lines():
                yield json.dumps({"type": "line", "text": line}) + "\n"
            yield json.dumps({"type": "exit", "returncode": job.returncode, **extra}) + "\n"
        return StreamingResponse(stream(), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    output = "\n".join(job.lines()).strip()
    return {**extra, "output": output, "returncode": job.returncode}


def _start_job(key: str, action: str, email: str, argv: List[str], env: Dict[str, str], timeout: int, **kw) -> Job:
    _claim(key, action, email)
    try:
        return Job(key, argv, env, timeout, **kw)
    except OSError as exc:
        _release(key)
        if kw.get("cleanup"):
            Path(kw["cleanup"]).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Could not start {action}: {exc}") from exc


def _service_args(cfg, service: str, action: str) -> Tuple[str, List[str]]:
    sec = _section(cfg, service)
    script = _section(cfg, "scripts").get(service, "")
    if not script or not Path(script).is_file():
        raise HTTPException(status_code=400, detail=f"scripts.{service} not found: {script or '(not set)'}")
    dir_, port_ = sec.get("dir", ""), sec.get("port", "")
    if not dir_:
        raise HTTPException(status_code=400, detail=f"{service}.dir not set in config.ini")
    if not port_.isdigit():
        raise HTTPException(status_code=400, detail=f"{service}.port not set in config.ini")
    args = [action, dir_, port_]
    if service == "backend" and action != "stop":
        entry = sec.get("entry", "")
        if not ENTRY_RE.match(entry):
            raise HTTPException(status_code=400, detail="backend.entry must look like module:app in config.ini")
        args.append(entry)
    return script, args


ACTION_TIMEOUTS = {"start": 600, "stop": 60, "restart": 900}


# ── routes ───────────────────────────────────────────────────────────────────

# Bumped when the HTTP API changes, so the UI can still drive managers that
# have not been redeployed yet (no "api" field means version 1).
API_VERSION = 2


@app.get("/health")
def health():
    return {"status": "healthy", "api": API_VERSION}


# CPU history for the trend line: one sample per service every
# HISTORY_EVERY seconds, the last HISTORY_LEN kept (10 minutes). Started at
# boot; the first overview call starts it too when the module is imported.
HISTORY_EVERY = 10
HISTORY_LEN = 60
_history: Dict[str, deque] = {svc: deque(maxlen=HISTORY_LEN) for svc in SERVICES}
_sampler_started = threading.Event()


def _sample_forever() -> None:
    while True:
        try:
            cfg = read_config()
            pids = {svc: read_pid(_section(cfg, svc).get("dir", ""), svc) for svc in SERVICES}
            for svc, st in proc_stats(pids).items():
                _history[svc].append(st["cpu"] or 0.0)
        except Exception:
            logger.exception("CPU sampler tick failed")
        time.sleep(HISTORY_EVERY)


def _ensure_sampler() -> None:
    if not _sampler_started.is_set():
        _sampler_started.set()
        threading.Thread(target=_sample_forever, name="cpu-sampler", daemon=True).start()


@_protected.get("/api/overview")
def overview():
    """Everything the panel shows in one call: per-service config, process
    state and any action in progress, plus host vitals."""
    _ensure_sampler()
    cfg = read_config()
    sections = {svc: _section(cfg, svc) for svc in SERVICES}
    pids = {svc: read_pid(sec.get("dir", ""), svc) for svc, sec in sections.items()}
    stats = proc_stats(pids)
    services = {
        svc: {"name": sec.get("name", ""), "port": sec.get("port", ""), "dir": sec.get("dir", ""),
              "running": pids[svc] is not None, "pid": pids[svc], **stats[svc], "busy": _busy(svc),
              # Ends with the reading shown next to it, so line and number agree.
              "history": [*_history[svc], stats[svc]["cpu"] or 0.0], "history_every": HISTORY_EVERY}
        for svc, sec in sections.items()
    }
    return {"services": services, "git": _busy("git"),
            "host": host_stats([sec.get("dir", "") for sec in sections.values()])}


def _action_route(action: str):
    def run(service: str, request: Request, email: str = Depends(require_admin)):
        validate_service(service)
        cfg = read_config()
        script, args = _service_args(cfg, service, action)
        logger.info("%s requested %s %s", email, action, service)
        job = _start_job(service, action, email, ["bash", script, *args], {**CHILD_ENV, **_ssl_env(cfg)},
                         ACTION_TIMEOUTS[action])
        return _respond(request, job, {"service": service, "action": action})
    run.__name__ = f"{action}_service"
    return run


for _action in ACTION_TIMEOUTS:
    _protected.add_api_route(f"/api/{_action}/{{service}}", _action_route(_action), methods=["POST"])


@_protected.get("/api/logs/{service}")
def logs(service: str, lines: int = Query(200, ge=1, le=5000)):
    validate_service(service)
    svc_dir = _section(read_config(), service).get("dir", "")
    log_file = Path(svc_dir) / f"{service}.log" if svc_dir else None
    if not log_file or not log_file.is_file():
        return {"service": service, "logs": "", "missing": str(log_file or "(service dir not set)")}
    try:
        return {"service": service, "logs": tail_file(log_file, lines)}
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read {log_file}: {exc}") from exc


@_protected.get("/api/scripts")
def list_scripts():
    cfg = read_config()
    dirs = {str(Path.home())}
    for svc in SERVICES:
        d = _section(cfg, svc).get("dir", "").strip()
        if d and Path(d).is_dir():
            dirs.add(d)
    scripts = {}
    for d in dirs:
        for path in Path(d).glob("*.sh"):
            if path.is_file():
                scripts[str(path)] = {"name": path.name, "path": str(path), "cmd": f"bash {shlex.quote(str(path))}"}
    return {"scripts": sorted(scripts.values(), key=lambda s: (s["name"], s["path"]))}


_repo_cache: Dict[Tuple[str, ...], Tuple[float, List[str]]] = {}
REPO_CACHE_TTL = 120


@_protected.get("/api/repos")
def list_repos(refresh: bool = False):
    cfg = read_config()
    bases = tuple(sorted(p for p in (v.strip() for v in _section(cfg, "search_paths").values()) if p and Path(p).is_dir()))
    bases = bases or (str(Path.home()),)
    hit = _repo_cache.get(bases)
    if hit and hit[0] > time.monotonic() and not refresh:
        return {"repos": hit[1]}
    repos = set()
    for base in bases:
        try:
            result = subprocess.run(
                ["find", base, "-maxdepth", "5", "(", "-name", "node_modules", "-o", "-name", ".venv", "-o", "-name", "venv", ")",
                 "-prune", "-o", "-name", ".git", "-type", "d", "-print", "-prune"],
                capture_output=True, text=True, timeout=15,
            )
            repos.update(str(Path(l.strip()).parent) for l in result.stdout.splitlines() if l.strip())
        except subprocess.TimeoutExpired:
            logger.warning("Repo scan under %s timed out", base)
    _repo_cache[bases] = (time.monotonic() + REPO_CACHE_TTL, sorted(repos))
    return {"repos": _repo_cache[bases][1]}


@_protected.get("/api/service-directories")
def list_service_directories():
    if not SERVICE_DIRS_FILE.is_file():
        return {svc: [] for svc in SERVICES}
    try:
        data = json.loads(SERVICE_DIRS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise HTTPException(status_code=500, detail="service_directories.json is not valid JSON.")
    result = {}
    for svc in SERVICES:
        out = []
        for entry in data.get(svc, []):
            path = (entry.get("path") or "").strip()
            if path:
                out.append({"path": path, "label": entry.get("label") or path, "notes": entry.get("notes", ""),
                            "port": entry.get("port"), "entry": entry.get("entry", ""), "exists": Path(path).is_dir()})
        result[svc] = out
    return result


class ServiceDirUpdate(BaseModel):
    dir: str = Field(..., min_length=1, max_length=1024)
    port: Optional[int] = Field(None, ge=1, le=65535)
    entry: Optional[str] = Field(None, max_length=128)


@_protected.post("/api/service/{service}/dir")
def update_service_dir(service: str, body: ServiceDirUpdate, email: str = Depends(require_admin)):
    validate_service(service)
    cfg = read_config()
    resolved = Path(body.dir.strip()).resolve()
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory does not exist: {body.dir}")
    if not within_roots(resolved, allowed_roots(cfg)):
        raise HTTPException(status_code=400, detail="Directory is outside the configured search_paths / home directory.")
    if body.entry and not ENTRY_RE.match(body.entry):
        raise HTTPException(status_code=400, detail="entry must look like module:app")
    # The pid file lives in the service directory: switching while the old
    # process runs would orphan it where this panel can no longer stop it.
    _claim(service, "switch directory", email)
    try:
        cfg = read_config()
        if read_pid(_section(cfg, service).get("dir", ""), service):
            raise HTTPException(status_code=409, detail=f"Stop {service} before switching its directory.")
        if not cfg.has_section(service):
            cfg.add_section(service)
        cfg[service]["dir"] = str(resolved)
        if body.port:
            cfg[service]["port"] = str(body.port)
        if body.entry:
            cfg[service]["entry"] = body.entry
        elif "entry" in cfg[service]:
            # A different directory almost always means a different app module;
            # never carry the previous one over silently.
            del cfg[service]["entry"]
        fd, tmp = tempfile.mkstemp(dir=str(CONFIG_FILE.parent), prefix=".config_", suffix=".ini")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            cfg.write(f)
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, CONFIG_FILE)
    finally:
        _release(service)
    logger.info("%s set %s dir to %s", email, service, resolved)
    return {"success": True, "service": service, "dir": str(resolved), "port": cfg[service].get("port", "")}


def _make_askpass(username: str, password: str, directory: Optional[str] = None) -> str:
    """0700 GIT_ASKPASS helper; the caller deletes it."""
    content = (
        "#!/usr/bin/env python3\nimport sys\n"
        "prompt = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        f"print({username!r} if 'username' in prompt.lower() else {password!r})\n"
    )
    fd, path = tempfile.mkstemp(prefix="askpass_", suffix=".py", dir=directory)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    os.chmod(path, stat.S_IRWXU)
    return path


def _repo_credentials(cfg) -> Tuple[str, str]:
    repo = _section(cfg, "repo")
    return (os.environ.get("REPO_USERNAME") or repo.get("username", ""),
            os.environ.get("REPO_PASSWORD") or repo.get("password", ""))


class GitPullRequest(BaseModel):
    dir: Optional[str] = Field(None, max_length=1024)


@_protected.post("/api/gitpull")
def gitpull(request: Request, body: GitPullRequest = GitPullRequest(), email: str = Depends(require_admin)):
    cfg = read_config()
    repo_dir = (body.dir or _section(cfg, "repo").get("dir", "")).strip()
    if not repo_dir:
        raise HTTPException(status_code=400, detail="No target directory. Pass dir or set repo.dir in config.ini.")
    target = Path(repo_dir).resolve()
    if body.dir and not within_roots(target, allowed_roots(cfg)):
        raise HTTPException(status_code=400, detail="Repository is outside the configured search_paths / home directory.")
    if not (target / ".git").exists():
        raise HTTPException(status_code=400, detail=f"Not a git repository: {repo_dir}")
    env = {**CHILD_ENV, "GIT_TERMINAL_PROMPT": "0"}
    username, password = _repo_credentials(cfg)
    askpass = _make_askpass(username, password) if username and password else None
    if askpass:
        env["GIT_ASKPASS"] = askpass
    logger.info("%s requested git pull in %s", email, target)
    job = _start_job("git", "git pull", email, ["git", "-C", str(target), "pull", "--ff-only"], env, 180,
                     redact=password, cleanup=askpass)
    return _respond(request, job, {"dir": str(target)})


@_protected.post("/api/terminal/ticket")
def terminal_ticket(email: str = Depends(require_admin)):
    return {"ticket": _mint_ticket(email), "expires_in": TICKET_TTL}


app.include_router(_protected)


# ── TERMINAL ─────────────────────────────────────────────────────────────────
# Every command runs in a fresh `bash -c`. An EXIT trap writes the final
# working directory and environment to a private state dir, so `cd`, `cd -`,
# `export` and `unset` carry over to the next command exactly as in a shell.

_LS_COLORS = ":".join([
    "rs=0", "di=01;34", "ln=01;36", "pi=40;33", "so=01;35", "bd=40;33;01", "cd=40;33;01", "or=40;31;01",
    "ex=01;32", "*.tar=01;31", "*.tgz=01;31", "*.zip=01;31", "*.gz=01;31", "*.jpg=01;35", "*.png=01;35",
    "*.json=00;33", "*.yaml=00;33", "*.yml=00;33", "*.ini=00;33", "*.py=00;33", "*.js=00;33", "*.jsx=00;33",
    "*.sql=00;33", "*.md=00;36", "*.txt=00;36", "*.log=00;90", "*.pem=01;33", "*.key=01;33",
])
# Sourced through BASH_ENV, so the user's command stays on line 1 of its own
# script; it unsets itself so scripts the user runs don't inherit any of it.
_RC = (
    'unset BASH_ENV; __term_state="$__TERM_STATE"; unset __TERM_STATE\n'
    'ls(){ command ls --color=always "$@"; }\n'
    'grep(){ command grep --color=always "$@"; }\n'
    "trap '__rc=$?; pwd -P > \"$__term_state/cwd\" 2>/dev/null; env -0 > \"$__term_state/env\" 2>/dev/null; exit $__rc' EXIT\n"
)
_SHELL_VARS = {"PWD", "SHLVL", "_", "BASH_ENV", "__TERM_STATE"}
MAX_OUTPUT_CHUNK = 16 * 1024
MAX_COMMAND = 16 * 1024
TERMINAL_IDLE = int(os.environ.get("TERMINAL_IDLE_SECONDS", "1800"))
SIGNALS = {"SIGINT": _signal.SIGINT, "SIGTERM": _signal.SIGTERM, "SIGKILL": _signal.SIGKILL}


class _Session:
    def __init__(self, email: str):
        self.email = email
        self.cwd = str(Path.home())
        self.state = tempfile.mkdtemp(prefix="term_")
        self.rc = Path(self.state, "rc")
        self.rc.write_text(_RC)
        self.env = {**{k: v for k, v in CHILD_ENV.items() if not k.startswith("REPO_")},
                    "TERM": "xterm-256color", "COLORTERM": "truecolor", "CLICOLOR": "1", "CLICOLOR_FORCE": "1",
                    "FORCE_COLOR": "3", "GIT_COLOR_UI": "always", "LS_COLORS": _LS_COLORS, "GIT_TERMINAL_PROMPT": "0"}
        self.askpass = None
        try:
            username, password = _repo_credentials(read_config())
        except HTTPException:
            username = password = ""
        if username and password:
            self.askpass = self.env["GIT_ASKPASS"] = _make_askpass(username, password, self.state)

    def files(self) -> Tuple[Path, Path]:
        return Path(self.state, "cwd"), Path(self.state, "env")

    def load_state(self) -> None:
        cwd_file, env_file = self.files()
        try:
            cwd = cwd_file.read_text().strip()
            if cwd and os.path.isdir(cwd):
                self.cwd = cwd
        except OSError:
            pass
        try:
            pairs = (item.split("=", 1) for item in env_file.read_bytes().decode("utf-8", "replace").split("\0") if "=" in item)
            env = {k: v for k, v in pairs if k not in _SHELL_VARS}
        except OSError:
            return
        if env:
            if self.askpass:
                env["GIT_ASKPASS"] = self.askpass
            self.env = env

    def close(self) -> None:
        shutil.rmtree(self.state, ignore_errors=True)


async def _run_command(websocket: WebSocket, inbox: asyncio.Queue, session: _Session, cmd: str) -> bool:
    """Run one command, streaming its output. Returns False if the client left."""
    for f in session.files():
        f.unlink(missing_ok=True)
    if not os.path.isdir(session.cwd):
        session.cwd = str(Path.home())
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", "-c", cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL, cwd=session.cwd, env={**session.env, "BASH_ENV": str(session.rc), "__TERM_STATE": session.state},
            start_new_session=True,
        )
    except OSError as exc:
        await websocket.send_json({"type": "stderr", "data": f"{exc}\n"})
        await websocket.send_json({"type": "exit", "code": -1, "cwd": session.cwd})
        return True

    async def pump(stream, kind):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while chunk := await stream.read(MAX_OUTPUT_CHUNK):
            if text := decoder.decode(chunk):
                await websocket.send_json({"type": kind, "data": text})
        if tail := decoder.decode(b"", final=True):
            await websocket.send_json({"type": kind, "data": tail})

    output = asyncio.gather(pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr"))
    deferred = []
    try:
        while not output.done():
            getter = asyncio.create_task(inbox.get())
            await asyncio.wait({output, getter}, return_when=asyncio.FIRST_COMPLETED)
            if not getter.done():
                getter.cancel()
                break
            m = getter.result()
            if m.get("type") == "_disconnect":
                _kill_group(proc, _signal.SIGKILL)
                output.cancel()
                return False
            if m.get("type") == "signal":
                if m.get("signal") in SIGNALS:
                    _kill_group(proc, SIGNALS[m["signal"]])
            else:
                deferred.append(m)
        await output
    finally:
        if not output.done():
            output.cancel()
        for m in deferred:
            inbox.put_nowait(m)
        if proc.returncode is None:
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                _kill_group(proc, _signal.SIGKILL)
                await proc.wait()
    session.load_state()
    code = proc.returncode if proc.returncode >= 0 else 128 - proc.returncode  # killed by signal N -> 128+N, as bash reports
    await websocket.send_json({"type": "exit", "code": code, "cwd": session.cwd})
    return True


@app.websocket("/ws/terminal")
async def terminal_ws(websocket: WebSocket):
    """Client → server: {"cmd": "..."} or {"type": "signal", "signal": "SIGINT|SIGTERM|SIGKILL"}.
    Server → client: cwd / stdout / stderr / exit / clear messages. Closes with
    4401 on a bad ticket and 4408 after TERMINAL_IDLE seconds without a command."""
    await websocket.accept()
    email = _redeem_ticket(websocket.query_params.get("ticket", ""))
    if not email:
        await websocket.close(code=4401, reason="Not authorized")
        return

    session = _Session(email)
    inbox: asyncio.Queue = asyncio.Queue()

    async def receiver():
        try:
            while True:
                await inbox.put(await websocket.receive_json())
        except Exception:
            await inbox.put({"type": "_disconnect"})

    recv_task = asyncio.create_task(receiver())
    logger.info("%s opened a terminal session", email)
    try:
        await websocket.send_json({"type": "cwd", "cwd": session.cwd})
        while True:
            try:
                msg = await asyncio.wait_for(inbox.get(), TERMINAL_IDLE)
            except asyncio.TimeoutError:
                await websocket.close(code=4408, reason=f"Closed after {_duration(TERMINAL_IDLE)} idle")
                break
            if msg.get("type") == "_disconnect":
                break
            if msg.get("type") == "signal":
                continue
            cmd = str(msg.get("cmd", "")).strip()
            if not cmd:
                continue
            if len(cmd) > MAX_COMMAND:
                await websocket.send_json({"type": "stderr", "data": f"Command longer than {MAX_COMMAND} characters.\n"})
                await websocket.send_json({"type": "exit", "code": 2, "cwd": session.cwd})
                continue
            if cmd in ("clear", "cls"):
                await websocket.send_json({"type": "clear"})
                continue
            logger.info("%s ran in %s: %s", email, session.cwd, cmd[:500])
            if not await _run_command(websocket, inbox, session, cmd):
                break
    except Exception as exc:
        try:
            await websocket.send_json({"type": "stderr", "data": f"Terminal error: {exc}\n"})
        except Exception:
            pass
    finally:
        recv_task.cancel()
        session.close()
        logger.info("%s closed the terminal session", email)


# ── entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    _ensure_sampler()
    cfg = read_config()
    mgr = _section(cfg, "manager")
    ssl = _section(cfg, "ssl")
    cert, key = ssl.get("certfile", ""), ssl.get("keyfile", "")
    use_ssl = bool(cert and key and Path(cert).is_file() and Path(key).is_file())
    host, port = mgr.get("host", "0.0.0.0"), int(mgr.get("port", "8001"))
    logger.info("Starting manager on %s://%s:%s", "https" if use_ssl else "http", host, port)
    uvicorn.run(app, host=host, port=port, ssl_certfile=cert if use_ssl else None, ssl_keyfile=key if use_ssl else None)
