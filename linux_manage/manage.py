"""Server manager: start / stop / restart the backend and frontend services on
this host, tail their logs, git pull, and an interactive admin terminal.

Every route except /health requires a Microsoft Graph token whose user is a
member of AD_GROUP_ADMIN (comma-separated names or object ids). The terminal
WebSocket authenticates with a short-lived one-time ticket obtained from
POST /api/terminal/ticket, so no bearer token ever appears in a URL.
"""
from __future__ import annotations

import asyncio
import configparser
import hashlib
import json
import logging
import os
import re
import secrets
import signal as _signal
import stat
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import httpx
import psutil
import uvicorn
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response as StarletteResponse

BASE_DIR = Path(__file__).resolve().parent
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
    return {"SSL_CERTFILE": ssl.get("certfile", ""), "SSL_KEYFILE": ssl.get("keyfile", "")}


def allowed_roots(cfg: configparser.ConfigParser) -> List[Path]:
    roots = [Path.home().resolve()]
    roots += [Path(p.strip()).resolve() for p in _section(cfg, "search_paths").values() if p.strip()]
    return roots


def within_roots(path: Path, roots: List[Path]) -> bool:
    return any(path == r or r in path.parents for r in roots)


def run_script(script_path: str, args: List[str], env_extra: Dict[str, str], timeout: int = 60) -> dict:
    if not script_path or not Path(script_path).is_file():
        return {"stdout": "", "stderr": f"Script not found: {script_path}", "returncode": -1}
    try:
        result = subprocess.run(["bash", script_path, *args], capture_output=True, text=True, timeout=timeout,
                                env={**os.environ, **{k: v for k, v in env_extra.items() if v}})
        return {"stdout": result.stdout.strip(), "stderr": result.stderr.strip(), "returncode": result.returncode}
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"Script timed out after {timeout}s", "returncode": -1}
    except OSError as exc:
        return {"stdout": "", "stderr": str(exc), "returncode": -1}


def read_pid(svc_dir: str, service: str) -> Optional[int]:
    if not svc_dir:
        return None
    try:
        pid = int((Path(svc_dir) / f"{service}.pid").read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if psutil.pid_exists(pid) else None


def fmt_uptime(create_time: float) -> str:
    secs = max(0, int(time.time() - create_time))
    d, r = divmod(secs, 86400)
    h, r = divmod(r, 3600)
    m, _ = divmod(r, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


def proc_stats(pid: Optional[int]) -> dict:
    if not pid:
        return {"cpu": None, "mem": None, "uptime": None}
    try:
        p = psutil.Process(pid)
        return {"cpu": round(p.cpu_percent(interval=0.1), 1), "mem": round(p.memory_percent(), 1),
                "uptime": fmt_uptime(p.create_time())}
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return {"cpu": None, "mem": None, "uptime": None}


def validate_service(service: str) -> None:
    if service not in SERVICES:
        raise HTTPException(status_code=400, detail=f"Unknown service '{service}'. Valid: {list(SERVICES)}")


def _service_args(cfg, service: str, action: str) -> Tuple[str, List[str]]:
    sec = _section(cfg, service)
    script = _section(cfg, "scripts").get(service, "")
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


def _service_action(service: str, action: str, email: str, timeout: int) -> dict:
    validate_service(service)
    cfg = read_config()
    script, args = _service_args(cfg, service, action)
    logger.info("%s requested %s %s", email, action, service)
    result = run_script(script, args, _ssl_env(cfg), timeout=timeout)
    output = "\n".join(x for x in (result["stdout"], result["stderr"]) if x).strip()
    logger.info("%s %s finished with code %s", action, service, result["returncode"])
    return {"service": service, "action": action, "output": output, "returncode": result["returncode"]}


# ── routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "healthy"}


@_protected.get("/api/services")
def get_services():
    cfg = read_config()
    return {svc: {k: _section(cfg, svc).get(k, "") for k in ("name", "port", "dir")} for svc in SERVICES}


@_protected.get("/api/status/{service}")
def status(service: str):
    validate_service(service)
    svc_dir = _section(read_config(), service).get("dir", "")
    pid = read_pid(svc_dir, service)
    return {"service": service, "running": pid is not None, "pid": pid, **proc_stats(pid)}


@_protected.post("/api/start/{service}")
def start(service: str, email: str = Depends(require_admin)):
    return _service_action(service, "start", email, timeout=600)


@_protected.post("/api/stop/{service}")
def stop(service: str, email: str = Depends(require_admin)):
    return _service_action(service, "stop", email, timeout=60)


@_protected.post("/api/restart/{service}")
def restart(service: str, email: str = Depends(require_admin)):
    return _service_action(service, "restart", email, timeout=900)


@_protected.get("/api/logs/{service}")
def logs(service: str, lines: int = Query(200, ge=1, le=5000)):
    validate_service(service)
    svc_dir = _section(read_config(), service).get("dir", "")
    log_file = Path(svc_dir) / f"{service}.log" if svc_dir else None
    if not log_file or not log_file.is_file():
        return {"service": service, "logs": f"Log file not found: {log_file or '(service dir not set)'}"}
    result = subprocess.run(["tail", "-n", str(lines), str(log_file)], capture_output=True, text=True, timeout=10)
    return {"service": service, "logs": result.stdout}


@_protected.get("/api/scripts")
def list_scripts():
    cfg = read_config()
    dirs = {str(Path.home())}
    for svc in SERVICES:
        d = _section(cfg, svc).get("dir", "").strip()
        if d and Path(d).is_dir():
            dirs.add(d)
    scripts, seen = [], set()
    for d in sorted(dirs):
        for path in sorted(Path(d).glob("*.sh")):
            if path.is_file() and str(path) not in seen:
                seen.add(str(path))
                scripts.append({"name": path.name, "path": str(path), "cmd": f"bash {json.dumps(str(path))}"})
    return {"scripts": sorted(scripts, key=lambda s: s["name"])}


@_protected.get("/api/repos")
def list_repos():
    cfg = read_config()
    bases = [p for p in (v.strip() for v in _section(cfg, "search_paths").values()) if p and Path(p).is_dir()]
    repos = set()
    for base in bases or [str(Path.home())]:
        try:
            result = subprocess.run(
                ["find", base, "-maxdepth", "5", "-name", ".git", "-type", "d",
                 "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.venv/*", "-not", "-path", "*/venv/*"],
                capture_output=True, text=True, timeout=15,
            )
            repos.update(str(Path(l.strip()).parent) for l in result.stdout.splitlines() if l.strip())
        except subprocess.TimeoutExpired:
            logger.warning("Repo scan under %s timed out", base)
    return {"repos": sorted(repos)}


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
    logger.info("%s set %s dir to %s", email, service, resolved)
    return {"success": True, "service": service, "dir": str(resolved), "port": cfg[service].get("port", "")}


def _make_askpass(username: str, password: str) -> str:
    """Temporary 0700 GIT_ASKPASS helper; the caller deletes it."""
    content = (
        "#!/usr/bin/env python3\nimport sys\n"
        "prompt = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        f"print({username!r} if 'username' in prompt.lower() else {password!r})\n"
    )
    fd, path = tempfile.mkstemp(prefix="askpass_", suffix=".py")
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
def gitpull(body: GitPullRequest = GitPullRequest(), email: str = Depends(require_admin)):
    cfg = read_config()
    repo_dir = (body.dir or _section(cfg, "repo").get("dir", "")).strip()
    if not repo_dir:
        raise HTTPException(status_code=400, detail="No target directory. Pass dir or set repo.dir in config.ini.")
    target = Path(repo_dir).resolve()
    if not (target / ".git").exists():
        raise HTTPException(status_code=400, detail=f"Not a git repository: {repo_dir}")
    if body.dir and not within_roots(target, allowed_roots(cfg)):
        raise HTTPException(status_code=400, detail="Repository is outside the configured search_paths / home directory.")
    username, password = _repo_credentials(cfg)
    if not username or not password:
        raise HTTPException(status_code=400, detail="repo.username / repo.password not set")
    askpass = _make_askpass(username, password)
    try:
        env = {**os.environ, "GIT_ASKPASS": askpass, "GIT_TERMINAL_PROMPT": "0"}
        result = subprocess.run(["git", "-C", str(target), "pull", "--ff-only"], capture_output=True, text=True,
                                timeout=180, env=env)
        output = (result.stdout + result.stderr).strip().replace(password, "***")
        logger.info("%s ran git pull in %s (code %s)", email, target, result.returncode)
        return {"output": output, "returncode": result.returncode}
    except subprocess.TimeoutExpired:
        return {"output": "git pull timed out after 180 seconds.", "returncode": -1}
    finally:
        Path(askpass).unlink(missing_ok=True)


@_protected.post("/api/terminal/ticket")
def terminal_ticket(email: str = Depends(require_admin)):
    return {"ticket": _mint_ticket(email), "expires_in": TICKET_TTL}


app.include_router(_protected)


# ── TERMINAL ─────────────────────────────────────────────────────────────────

_LS_COLORS = ":".join([
    "rs=0", "di=01;34", "ln=01;36", "pi=40;33", "so=01;35", "bd=40;33;01", "cd=40;33;01", "or=40;31;01",
    "ex=01;32", "*.tar=01;31", "*.tgz=01;31", "*.zip=01;31", "*.gz=01;31", "*.jpg=01;35", "*.png=01;35",
    "*.json=00;33", "*.yaml=00;33", "*.yml=00;33", "*.ini=00;33", "*.py=00;33", "*.js=00;33", "*.jsx=00;33",
    "*.sql=00;33", "*.md=00;36", "*.txt=00;36", "*.log=00;90", "*.pem=01;33", "*.key=01;33",
])
_COLOR_INIT = (
    'ls(){ command ls --color=always "$@"; }; '
    'grep(){ command grep --color=always "$@"; }; '
)
MAX_OUTPUT_CHUNK = 16 * 1024


def _kill_group(proc, sig=_signal.SIGTERM) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.send_signal(sig)
        except ProcessLookupError:
            pass


@app.websocket("/ws/terminal")
async def terminal_ws(websocket: WebSocket):
    """Client → server: {"cmd": "..."} or {"type": "signal", "signal": "SIGINT"}.
    Server → client: cwd / stdout / stderr / exit / clear messages."""
    await websocket.accept()
    email = _redeem_ticket(websocket.query_params.get("ticket", ""))
    if not email:
        await websocket.close(code=4401, reason="Not authorized")
        return

    cwd = str(Path.home())
    await websocket.send_json({"type": "cwd", "cwd": cwd})
    logger.info("%s opened a terminal session", email)

    askpass = None
    try:
        username, password = _repo_credentials(read_config())
        if username and password:
            askpass = _make_askpass(username, password)
    except HTTPException:
        pass

    env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "CLICOLOR": "1",
           "CLICOLOR_FORCE": "1", "FORCE_COLOR": "3", "GIT_COLOR_UI": "always", "LS_COLORS": _LS_COLORS}
    if askpass:
        env.update({"GIT_ASKPASS": askpass, "GIT_TERMINAL_PROMPT": "0"})

    inbox: asyncio.Queue = asyncio.Queue()

    async def receiver():
        try:
            while True:
                await inbox.put(await websocket.receive_json())
        except Exception:
            await inbox.put({"type": "_disconnect"})

    recv_task = asyncio.create_task(receiver())
    current = None

    try:
        while True:
            msg = await inbox.get()
            if msg.get("type") == "_disconnect":
                break
            if msg.get("type") == "signal":
                continue
            cmd = str(msg.get("cmd", "")).strip()
            if not cmd:
                continue
            if cmd in ("clear", "cls"):
                await websocket.send_json({"type": "clear"})
                continue
            if re.match(r"^cd(\s|$)", cmd):
                raw = cmd.split(None, 1)[1].strip() if len(cmd.split(None, 1)) > 1 else "~"
                target = os.path.normpath(os.path.join(cwd, os.path.expanduser(raw.strip("'\""))))
                if os.path.isdir(target):
                    cwd = target
                    await websocket.send_json({"type": "exit", "code": 0, "cwd": cwd})
                else:
                    await websocket.send_json({"type": "stderr", "data": f"cd: {raw}: No such file or directory\n"})
                    await websocket.send_json({"type": "exit", "code": 1, "cwd": cwd})
                continue

            logger.info("%s ran in %s: %s", email, cwd, cmd[:500])
            try:
                current = await asyncio.create_subprocess_shell(
                    _COLOR_INIT + cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    stdin=asyncio.subprocess.DEVNULL, cwd=cwd, env=env, start_new_session=True,
                )
            except OSError as exc:
                await websocket.send_json({"type": "stderr", "data": f"{exc}\n"})
                await websocket.send_json({"type": "exit", "code": -1, "cwd": cwd})
                continue

            proc = current

            async def pump(stream, kind):
                while True:
                    chunk = await stream.read(MAX_OUTPUT_CHUNK)
                    if not chunk:
                        return
                    await websocket.send_json({"type": kind, "data": chunk.decode("utf-8", errors="replace")})

            output = asyncio.gather(pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr"))
            disconnected = False
            deferred = []
            while True:
                getter = asyncio.create_task(inbox.get())
                done, _ = await asyncio.wait({output, getter}, return_when=asyncio.FIRST_COMPLETED)
                if getter not in done and getter.cancel():
                    break
                m = getter.result()
                if m.get("type") == "_disconnect":
                    disconnected = True
                    _kill_group(proc, _signal.SIGKILL)
                    output.cancel()
                    break
                if m.get("type") == "signal":
                    if m.get("signal") == "SIGINT":
                        _kill_group(proc, _signal.SIGINT)
                else:
                    deferred.append(m)
                if output.done():
                    break
            for m in deferred:
                inbox.put_nowait(m)
            if disconnected:
                break
            try:
                await output
            except Exception:
                break
            await proc.wait()
            current = None
            await websocket.send_json({"type": "exit", "code": proc.returncode, "cwd": cwd})
    except Exception as exc:
        try:
            await websocket.send_json({"type": "stderr", "data": f"Terminal error: {exc}\n"})
        except Exception:
            pass
    finally:
        recv_task.cancel()
        if current and current.returncode is None:
            _kill_group(current, _signal.SIGKILL)
        if askpass:
            Path(askpass).unlink(missing_ok=True)
        logger.info("%s closed the terminal session", email)


# ── entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cfg = read_config()
    mgr = _section(cfg, "manager")
    ssl = _section(cfg, "ssl")
    cert, key = ssl.get("certfile", ""), ssl.get("keyfile", "")
    use_ssl = bool(cert and key and Path(cert).is_file() and Path(key).is_file())
    host, port = mgr.get("host", "0.0.0.0"), int(mgr.get("port", "8001"))
    logger.info("Starting manager on %s://%s:%s", "https" if use_ssl else "http", host, port)
    uvicorn.run(app, host=host, port=port, ssl_certfile=cert if use_ssl else None, ssl_keyfile=key if use_ssl else None)
