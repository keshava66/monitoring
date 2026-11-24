import configparser
import json
import secrets
import subprocess
import os
import re
import stat
import tempfile
import time
from pathlib import Path
from typing import Optional

import psutil
import requests
from dotenv import load_dotenv

from pydantic import BaseModel
from fastapi import FastAPI, APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Header, Depends, Request
from starlette.responses import Response as StarletteResponse
from fastapi.responses import JSONResponse
import asyncio
import signal as _signal
import uvicorn

BASE_DIR          = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")
CONFIG_FILE       = BASE_DIR / "config.ini"
SERVICE_DIRS_FILE = BASE_DIR / "service_directories.json"

SERVICES = {"backend", "frontend"}


# ── AUTH ─────────────────────────────────────────────────────────────────────
# This panel starts/stops services, runs git pull with stored credentials, and
# gives a raw shell over WebSocket — it used to have NO auth check at all.
# Every HTTP route now requires a valid Microsoft Graph token belonging to
# someone in the configured admin AD group. Same model as backend/auth.py,
# duplicated here on purpose since this runs standalone on its own box with
# no shared library to import from.

_TOKEN_CACHE: dict = {}
_TOKEN_CACHE_TTL = 60


def _is_admin_token(token: str) -> bool:
    cached = _TOKEN_CACHE.get(token)
    if cached and cached[0] > time.time():
        return cached[1]

    me = requests.get(
        "https://graph.microsoft.com/v1.0/me",
        headers={"Authorization": f"Bearer {token}"}, timeout=10,
    )
    if me.status_code == 401:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not me.ok:
        raise HTTPException(status_code=me.status_code, detail="Failed to validate token")

    admin_group = os.environ.get("AD_GROUP_ADMIN", "")
    is_admin = False
    if admin_group:
        g = requests.get(
            "https://graph.microsoft.com/v1.0/me/memberOf",
            headers={"Authorization": f"Bearer {token}"}, timeout=10,
        )
        if g.ok:
            for grp in g.json().get("value", []):
                if grp.get("displayName") == admin_group or grp.get("id") == admin_group:
                    is_admin = True
                    break
    else:
        # No admin group configured — nobody gets in. Misconfiguration
        # should fail closed, not silently grant access to everyone.
        is_admin = False

    _TOKEN_CACHE[token] = (time.time() + _TOKEN_CACHE_TTL, is_admin)
    return is_admin


def require_admin(request: Request, authorization: Optional[str] = Header(None)):
    # /health is the one intentionally-open route — start.sh, load balancers,
    # and uptime checks hit it with no token and just need a liveness signal.
    # It reveals nothing sensitive (see the handler below).
    if request.url.path == "/health":
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization[7:]
    if not _is_admin_token(token):
        raise HTTPException(status_code=403, detail="Admin role required")


app = FastAPI(title="Server Manager")
_protected = APIRouter(dependencies=[Depends(require_admin)])

# ── CORS ─────────────────────────────────────────────────────────────────────
# Pure ASGI middleware — the only reliable way to skip WebSocket connections.
# BaseHTTPMiddleware and Starlette's CORSMiddleware both have version-dependent
# bugs that reject WebSocket upgrades with HTTP 403.  A raw ASGI middleware
# lets us gate on scope["type"] before any Starlette machinery runs.
class _CORSMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        # WebSocket (and lifespan) — pass straight through, no CORS check
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        origin = dict(scope.get("headers", [])).get(b"origin", b"").decode()
        allow_origin = origin if (origin and origin in _ALLOWED_ORIGINS) else (_ALLOWED_ORIGINS[0] if _ALLOWED_ORIGINS else "")

        # OPTIONS preflight — respond immediately
        if scope.get("method") == "OPTIONS":
            response = StarletteResponse(
                status_code=200,
                headers={
                    "Access-Control-Allow-Origin":  allow_origin,
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Max-Age":       "600",
                },
            )
            await response(scope, receive, send)
            return

        # All other HTTP — inject CORS header into the response
        async def _inject(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                if allow_origin:
                    headers.append((b"access-control-allow-origin", allow_origin.encode()))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, _inject)

_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(_CORSMiddleware)


# ── helpers ───────────────────────────────────────────────────────────────────

def read_config() -> configparser.ConfigParser:
    cfg = configparser.ConfigParser()
    if not CONFIG_FILE.exists():
        raise RuntimeError(f"config.ini not found at {CONFIG_FILE}")
    cfg.read(CONFIG_FILE)
    return cfg


def run_script(script_path: str, args: Optional[list] = None, timeout: int = 30) -> dict:
    if not script_path or not Path(script_path).exists():
        return {"stdout": "", "stderr": f"Script not found: {script_path}", "returncode": -1}
    try:
        result = subprocess.run(
            ["bash", script_path] + (args or []),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": "Script timed out", "returncode": -1}
    except Exception as exc:
        return {"stdout": "", "stderr": str(exc), "returncode": -1}


def read_pid(svc_dir: str) -> Optional[int]:
    """Read the pidfile inside the service's own directory and confirm it's alive."""
    if not svc_dir:
        return None
    pid_file = None
    for name in ("backend.pid", "frontend.pid", "service.pid"):
        candidate = Path(svc_dir) / name
        if candidate.exists():
            pid_file = candidate
            break
    if not pid_file:
        return None
    try:
        pid = int(pid_file.read_text().strip())
        return pid if psutil.pid_exists(pid) else None
    except Exception:
        return None





def fmt_uptime(create_time: float) -> str:
    secs = int(time.time() - create_time)
    d, r = divmod(secs, 86400)
    h, r = divmod(r, 3600)
    m, _ = divmod(r, 60)
    if d: return f"{d}d {h}h"
    if h: return f"{h}h {m}m"
    return f"{m}m"


def proc_stats(pid: Optional[int]) -> dict:
    """Best-effort CPU/mem/uptime for a known PID. None fields if unavailable
    (process from another user, already exited, or psutil not permitted)."""
    if not pid:
        return {"cpu": None, "mem": None, "uptime": None}
    try:
        p = psutil.Process(pid)
        return {
            "cpu":    round(p.cpu_percent(interval=0.1), 1),
            "mem":    round(p.memory_percent(), 1),
            "uptime": fmt_uptime(p.create_time()),
        }
    except Exception:
        return {"cpu": None, "mem": None, "uptime": None}


def validate_service(service: str):
    if service not in SERVICES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown service '{service}'. Valid: {sorted(SERVICES)}"
        )


# ── routes ────────────────────────────────────────────────────────────────────

@_protected.get("/health")
async def health():
    return {"status": "healthy"}


@_protected.get("/api/services")
async def get_services():
    """Return display metadata for each service (name, port, dir).
    No credentials, SSL details, or internal config are exposed.
    """
    cfg = read_config()
    result = {}
    for svc in SERVICES:
        section = cfg[svc] if svc in cfg else {}
        result[svc] = {
            "name": section.get("name", ""),
            "port": section.get("port", ""),
            "dir":  section.get("dir", ""),
        }
    return result


@_protected.get("/api/status/{service}")
def status(service: str):
    validate_service(service)
    cfg     = read_config()
    svc_dir = cfg[service].get("dir", "") if service in cfg else ""
    pid     = read_pid(svc_dir)
    stats   = proc_stats(pid)
    return {
        "service":    service,
        "running":    pid is not None,
        "pid":        pid,
        "cpu":        stats["cpu"],
        "mem":        stats["mem"],
        "uptime":     stats["uptime"],
    }


@_protected.post("/api/start/{service}")
def start(service: str):
    validate_service(service)
    cfg    = read_config()
    script = cfg["scripts"].get(service, "")
    dir_   = cfg[service].get("dir", "") if service in cfg else ""
    port_  = cfg[service].get("port", "") if service in cfg else ""
    if not dir_:
        raise HTTPException(status_code=400, detail=f"{service}.dir not set in config.ini")
    if not port_:
        raise HTTPException(status_code=400, detail=f"{service}.port not set in config.ini")
    script_args = ["start", dir_, port_]
    if service == "backend":
        entry_ = cfg[service].get("entry", "")
        if not entry_:
            raise HTTPException(status_code=400, detail="backend.entry not set in config.ini")
        script_args.append(entry_)
    result = run_script(script, args=script_args)
    output = (result["stdout"] or result["stderr"]).strip()
    return {
        "service":    service,
        "action":     "start",
        "output":     output,
        "returncode": result["returncode"],
    }


@_protected.post("/api/stop/{service}")
def stop(service: str):
    validate_service(service)
    cfg    = read_config()
    script = cfg["scripts"].get(service, "")
    dir_   = cfg[service].get("dir", "") if service in cfg else ""
    port_  = cfg[service].get("port", "") if service in cfg else ""
    if not dir_:
        raise HTTPException(status_code=400, detail=f"{service}.dir not set in config.ini")
    if not port_:
        raise HTTPException(status_code=400, detail=f"{service}.port not set in config.ini")
    result = run_script(script, args=["stop", dir_, port_])
    output = (result["stdout"] or result["stderr"]).strip()
    return {
        "service":    service,
        "action":     "stop",
        "output":     output,
        "returncode": result["returncode"],
    }


@_protected.post("/api/restart/{service}")
def restart(service: str):
    validate_service(service)
    cfg    = read_config()
    script = cfg["scripts"].get(service, "")
    dir_   = cfg[service].get("dir", "") if service in cfg else ""
    port_  = cfg[service].get("port", "") if service in cfg else ""
    if not dir_:
        raise HTTPException(status_code=400, detail=f"{service}.dir not set in config.ini")
    if not port_:
        raise HTTPException(status_code=400, detail=f"{service}.port not set in config.ini")
    script_args = ["restart", dir_, port_]
    if service == "backend":
        entry_ = cfg[service].get("entry", "")
        if not entry_:
            raise HTTPException(status_code=400, detail="backend.entry not set in config.ini")
        script_args.append(entry_)
    # frontend rebuilds inside the script itself on restart, so give it more time
    result = run_script(script, args=script_args, timeout=300)
    output = (result["stdout"] or result["stderr"]).strip()
    return {
        "service":    service,
        "action":     "restart",
        "output":     output,
        "returncode": result["returncode"],
    }


@_protected.get("/api/logs/{service}")
def logs(service: str, lines: int = 100):
    validate_service(service)
    cfg      = read_config()
    svc_dir  = cfg[service].get("dir", "") if service in cfg else ""
    log_name = "backend.log" if service == "backend" else "frontend.log"
    log_file = str(Path(svc_dir) / log_name) if svc_dir else ""
    if not log_file or not Path(log_file).exists():
        return {"service": service, "logs": f"Log file not found: {log_file}"}
    result = subprocess.run(
        ["tail", "-n", str(min(lines, 500)), log_file],
        capture_output=True, text=True,
    )
    return {"service": service, "logs": result.stdout}


@_protected.get("/api/scripts")
def list_scripts():
    """
    Return .sh scripts found in service directories and the home directory.
    Used by the Terminal palette to populate the Scripts category.
    """
    cfg = read_config()
    search_dirs: set[str] = {str(Path.home())}

    for section in SERVICES:
        try:
            d = cfg[section].get("dir", "").strip() if section in cfg else ""
            if d and Path(d).exists():
                search_dirs.add(d)
        except Exception:
            pass

    scripts: list[dict] = []
    seen: set[str]      = set()

    for d in sorted(search_dirs):
        try:
            result = subprocess.run(
                ["find", d, "-maxdepth", "1", "-name", "*.sh", "-type", "f"],
                capture_output=True, text=True, timeout=5,
            )
            for line in result.stdout.strip().splitlines():
                path = line.strip()
                if path and path not in seen:
                    seen.add(path)
                    scripts.append({
                        "name": Path(path).name,
                        "path": path,
                        "cmd":  f"bash {path}",
                    })
        except Exception:
            pass

    return {"scripts": sorted(scripts, key=lambda s: s["name"])}


def _make_askpass(username: str, password: str) -> str:
    """
    Write a temporary Python GIT_ASKPASS script and return its path.
    The caller is responsible for deleting the file when done.
    """
    content = (
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "prompt = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        f"print({repr(username)} if 'Username' in prompt else {repr(password)})\n"
    )
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(content)
        path = f.name
    os.chmod(path, stat.S_IRWXU)
    return path




# ── DIRECTORY / REPO MANAGEMENT ──────────────────────────────────────────────

class ServiceDirUpdate(BaseModel):
    dir: str
    port: Optional[int] = None
    entry: Optional[str] = None   # e.g. "app:app" — only needed if auto-detect can't find it


@_protected.get("/api/repos")
def list_repos():
    """
    Walk configured search paths (config.ini [search_paths]) looking for git
    repos (directories that contain a .git folder).  Falls back to the home
    directory if no search paths are configured.

    config.ini example:
        [search_paths]
        dev  = /home/sa-prd-rdi-react-dev
        data = /opt/projects
    """
    cfg = read_config()

    search_dirs = []
    if "search_paths" in cfg:
        for key in cfg["search_paths"]:
            p = cfg["search_paths"][key].strip()
            if p and Path(p).exists():
                search_dirs.append(p)

    if not search_dirs:
        search_dirs = [str(Path.home())]

    repos: set[str] = set()
    for base in search_dirs:
        try:
            result = subprocess.run(
                ["find", base, "-maxdepth", "5", "-name", ".git", "-type", "d",
                 "-not", "-path", "*/node_modules/*",
                 "-not", "-path", "*/.venv/*",
                 "-not", "-path", "*/venv/*"],
                capture_output=True, text=True, timeout=15,
            )
            for line in result.stdout.strip().splitlines():
                git_dir = line.strip()
                if git_dir:
                    repos.add(str(Path(git_dir).parent))
        except Exception:
            pass

    return {"repos": sorted(repos)}


@_protected.get("/api/service-directories")
def list_service_directories():
    if not SERVICE_DIRS_FILE.exists():
        return {svc: [] for svc in SERVICES}

    try:
        with open(SERVICE_DIRS_FILE) as f:
            data = json.load(f)
    except Exception:
        raise HTTPException(status_code=500, detail="service_directories.json is not valid JSON.")

    result = {}
    for svc in SERVICES:
        out = []
        for entry in data.get(svc, []):
            path = (entry.get("path") or "").strip()
            if not path:
                continue
            out.append({
                "path":   path,
                "label":  entry.get("label") or path,
                "notes":  entry.get("notes", ""),
                "port":   entry.get("port"),
                "entry":  entry.get("entry", ""),
                "exists": Path(path).exists(),
            })
        result[svc] = out
    return result


@_protected.post("/api/service/{service}/dir")
async def update_service_dir(service: str, body: ServiceDirUpdate):
    """Persist a new working directory for a service in config.ini."""
    validate_service(service)
    new_dir = body.dir.strip()

    if not new_dir:
        raise HTTPException(status_code=400, detail="Directory path is required.")
    resolved = Path(new_dir).resolve()
    if not resolved.exists():
        raise HTTPException(status_code=400, detail=f"Directory does not exist: {new_dir}")

    # This directory becomes a `cwd` that later gets a shell script run in
    # it — restrict it to somewhere the operator actually configured
    # (search_paths / home dir) instead of accepting any path on the box.
    cfg = read_config()
    allowed_roots = [Path.home().resolve()]
    if "search_paths" in cfg:
        for key in cfg["search_paths"]:
            p = cfg["search_paths"][key].strip()
            if p:
                allowed_roots.append(Path(p).resolve())
    if not any(resolved == root or root in resolved.parents for root in allowed_roots):
        raise HTTPException(
            status_code=400,
            detail="Directory is outside the configured search_paths / home directory.",
        )
    new_dir = str(resolved)

    if service not in cfg:
        cfg[service] = {}
    cfg[service]["dir"] = new_dir
    if body.port:
        cfg[service]["port"] = str(body.port)
    if body.entry:
        cfg[service]["entry"] = body.entry
    elif "entry" in cfg[service]:
        del cfg[service]["entry"]

    with open(CONFIG_FILE, "w") as f:
        cfg.write(f)

    return {"success": True, "service": service, "dir": new_dir, "port": cfg[service].get("port", "")}

class GitPullRequest(BaseModel):
    dir: Optional[str] = None   # target directory; falls back to repo.dir in config if omitted


@_protected.post("/api/gitpull")
def gitpull(body: GitPullRequest = GitPullRequest()):
    cfg = read_config()

    # Resolve target directory: request body → config.ini [repo] dir → error
    repo_dir = (body.dir or "").strip()
    if not repo_dir:
        repo_dir = cfg["repo"].get("dir", "").strip() if "repo" in cfg else ""
    if not repo_dir or not Path(repo_dir).exists():
        raise HTTPException(
            status_code=400,
            detail='No target directory. Pass dir in the request body or set repo.dir in config.ini.',
        )

    username = cfg["repo"].get("username", "", vars=None, raw=True) if "repo" in cfg else ""
    password = cfg["repo"].get("password", "", vars=None, raw=True) if "repo" in cfg else ""

    if not username or not password:
        raise HTTPException(status_code=400, detail="repo.username / repo.password not set in config.ini")

    askpass_file = None
    try:
        askpass_file = _make_askpass(username, password)
        env                        = os.environ.copy()
        env["GIT_ASKPASS"]         = askpass_file
        env["GIT_TERMINAL_PROMPT"] = "0"

        result = subprocess.run(
            ["git", "-C", repo_dir, "pull"],
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )

        output = (result.stdout + result.stderr).strip()
        output = output.replace(username, "***").replace(password, "***")

        return {"output": output, "returncode": result.returncode}

    except subprocess.TimeoutExpired:
        return {"output": "git pull timed out after 120 seconds.", "returncode": -1}
    except Exception as exc:
        return {"output": str(exc), "returncode": -1}
    finally:
        if askpass_file and Path(askpass_file).exists():
            os.unlink(askpass_file)


# ── TERMINAL ──────────────────────────────────────────────────────────────────

app.include_router(_protected)

@app.websocket("/ws/terminal")
async def terminal_ws(websocket: WebSocket):
    """
    Interactive terminal over WebSocket.

    Client → Server messages (JSON):
      { "cmd": "ls -la" }                          — run a command
      { "type": "signal", "signal": "SIGINT" }     — send Ctrl+C to running process

    Server → Client messages (JSON):
      { "type": "cwd",    "cwd": "/path" }         — sent on connect and after cd
      { "type": "stdout", "data": "..." }           — streamed stdout chunk
      { "type": "stderr", "data": "..." }           — streamed stderr chunk
      { "type": "exit",   "code": 0, "cwd": "/" }  — process finished
      { "type": "clear" }                           — clear screen (for 'clear' command)
    """
    await websocket.accept()

    # Browsers can't set an Authorization header on a WebSocket handshake, so
    # the token is passed as a query param instead — validated exactly like
    # every REST route (see require_admin above). Reject before doing
    # anything else: this used to accept and run commands with zero checks.
    token = websocket.query_params.get("token", "")
    try:
        if not token or not _is_admin_token(token):
            await websocket.close(code=4401)
            return
    except HTTPException:
        await websocket.close(code=4401)
        return

    cwd = str(Path.home())
    await websocket.send_json({"type": "cwd", "cwd": cwd})

    # Build a process environment that includes git credentials from config.ini.
    # All subprocesses inherit this env so `git pull / push / fetch` work without
    # interactive prompts, exactly like the /api/gitpull endpoint.
    _askpass_file = None
    try:
        _cfg = read_config()
        _username = _cfg["repo"].get("username", "", vars=None, raw=True) if "repo" in _cfg else ""
        _password = _cfg["repo"].get("password", "", vars=None, raw=True) if "repo" in _cfg else ""
        if _username and _password:
            _askpass_file = _make_askpass(_username, _password)
    except Exception:
        pass

    _term_env = os.environ.copy()
    # ── Color environment ─────────────────────────────────────────────────────
    # TERM + COLORTERM tell most programs (git, python CLIs, etc.) to emit ANSI.
    # CLICOLOR / CLICOLOR_FORCE enable color in BSD/macOS ls.
    # FORCE_COLOR=3 enables truecolor in Node.js / some Python tools.
    # GIT_COLOR_UI ensures git always outputs color regardless of TTY detection.
    _LS_COLORS = ":".join([
        "rs=0", "di=01;34", "ln=01;36", "mh=00", "pi=40;33",
        "so=01;35", "do=01;35", "bd=40;33;01", "cd=40;33;01",
        "or=40;31;01", "mi=00", "su=37;41", "sg=30;43", "ca=30;41",
        "tw=30;42", "ow=34;42", "st=37;44", "ex=01;32",
        "*.tar=01;31", "*.tgz=01;31", "*.zip=01;31", "*.gz=01;31",
        "*.bz2=01;31", "*.xz=01;31", "*.zst=01;31", "*.7z=01;31",
        "*.rar=01;31", "*.deb=01;31", "*.rpm=01;31",
        "*.jpg=01;35", "*.jpeg=01;35", "*.png=01;35", "*.gif=01;35",
        "*.svg=01;35", "*.ico=01;35", "*.mp4=01;35", "*.mkv=01;35",
        "*.mp3=00;36", "*.ogg=00;36", "*.wav=00;36",
        "*.json=00;33", "*.yaml=00;33", "*.yml=00;33",
        "*.toml=00;33", "*.ini=00;33", "*.cfg=00;33", "*.conf=00;33",
        "*.env=00;33", "*.xml=00;33", "*.csv=00;33",
        "*.py=00;33", "*.js=00;33", "*.jsx=00;33",
        "*.ts=00;33", "*.tsx=00;33", "*.sql=00;33",
        "*.html=00;33", "*.css=00;33", "*.md=00;36", "*.txt=00;36",
        "*.pem=01;33", "*.key=01;33", "*.crt=01;33", "*.pub=01;33",
        "*.log=00;90", "*.pyc=00;90", "*.o=00;90", "*.so=00;90",
    ])

    _term_env.update({
        "TERM":           "xterm-256color",
        "COLORTERM":      "truecolor",
        "CLICOLOR":       "1",
        "CLICOLOR_FORCE": "1",
        "FORCE_COLOR":    "3",
        "GIT_COLOR_UI":   "always",
        "LS_COLORS":      _LS_COLORS,
    })
    if _askpass_file:
        _term_env["GIT_ASKPASS"]         = _askpass_file
        _term_env["GIT_TERMINAL_PROMPT"] = "0"

    # ── Shell function overrides ───────────────────────────────────────────────
    # GNU ls, grep, diff, ip ignore CLICOLOR_FORCE and only colorize when they
    # detect a real TTY. Wrapping them as shell functions injects --color=always
    # transparently so the user never has to type flags manually.
    _COLOR_INIT = (
        "ls(){    command ls    --color=always \"$@\"; }; "
        "grep(){  command grep  --color=always \"$@\"; }; "
        "diff(){  command diff  --color=always \"$@\" 2>/dev/null "
                "|| command diff \"$@\"; }; "
        "ip(){    command ip    --color=always \"$@\" 2>/dev/null "
                "|| command ip \"$@\"; }; "
    )

    # Decouple WS receiving from command processing so we can handle signals
    # while a process is running.
    inbox: asyncio.Queue = asyncio.Queue()
    current_process = None  # asyncio.subprocess.Process | None

    async def _receiver():
        """Pump all incoming WS messages into the inbox queue."""
        try:
            while True:
                msg = await websocket.receive_json()
                await inbox.put(msg)
        except Exception:
            await inbox.put({"type": "_disconnect"})

    recv_task = asyncio.create_task(_receiver())

    try:
        while True:
            msg = await inbox.get()

            # Connection closed
            if msg.get("type") == "_disconnect":
                break

            # Ctrl+C while a process is running
            if msg.get("type") == "signal":
                if msg.get("signal") == "SIGINT" and current_process:
                    try:
                        os.killpg(os.getpgid(current_process.pid), _signal.SIGINT)
                    except Exception:
                        try:
                            current_process.terminate()
                        except Exception:
                            pass
                continue

            cmd = msg.get("cmd", "").strip()
            if not cmd:
                continue

            # Built-in: clear
            if cmd in ("clear", "cls"):
                await websocket.send_json({"type": "clear"})
                continue

            # Built-in: cd (must be handled in-process to track cwd)
            if re.match(r"^cd(\s|$)", cmd):
                parts = cmd.split(None, 1)
                raw_target = parts[1].strip() if len(parts) > 1 else "~"
                target = os.path.expanduser(raw_target)
                if not os.path.isabs(target):
                    target = os.path.join(cwd, target)
                target = os.path.normpath(target)
                if os.path.isdir(target):
                    cwd = target
                    await websocket.send_json({"type": "exit", "code": 0, "cwd": cwd})
                else:
                    await websocket.send_json({
                        "type": "stderr",
                        "data": f"cd: {raw_target}: No such file or directory\n",
                    })
                    await websocket.send_json({"type": "exit", "code": 1, "cwd": cwd})
                continue

            # General command — run asynchronously and stream output
            try:
                process = await asyncio.create_subprocess_shell(
                    _COLOR_INIT + cmd,   # prepend color overrides
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=_term_env,
                    start_new_session=True,   # lets us kill the whole process group
                )
                current_process = process
                proc_done = asyncio.Event()

                async def _read_out():
                    while True:
                        chunk = await process.stdout.read(1024)
                        if not chunk:
                            break
                        await websocket.send_json({
                            "type": "stdout",
                            "data": chunk.decode("utf-8", errors="replace"),
                        })

                async def _read_err():
                    while True:
                        chunk = await process.stderr.read(1024)
                        if not chunk:
                            break
                        await websocket.send_json({
                            "type": "stderr",
                            "data": chunk.decode("utf-8", errors="replace"),
                        })

                async def _wait_proc():
                    await asyncio.gather(_read_out(), _read_err())
                    await process.wait()
                    proc_done.set()

                async def _watch_signals():
                    """
                    While the process is running, drain the inbox looking for
                    a SIGINT. Any non-signal messages are put back for the
                    outer loop to handle after the process exits.
                    """
                    while not proc_done.is_set():
                        try:
                            sig_msg = await asyncio.wait_for(inbox.get(), timeout=0.05)
                            if sig_msg.get("type") == "_disconnect":
                                await inbox.put(sig_msg)
                                return
                            if (sig_msg.get("type") == "signal"
                                    and sig_msg.get("signal") == "SIGINT"):
                                try:
                                    os.killpg(os.getpgid(process.pid), _signal.SIGINT)
                                except Exception:
                                    process.terminate()
                                return
                            # Any other message (e.g. next command) → keep for later
                            await inbox.put(sig_msg)
                        except asyncio.TimeoutError:
                            continue

                await asyncio.gather(_wait_proc(), _watch_signals())
                current_process = None
                await websocket.send_json({
                    "type": "exit",
                    "code": process.returncode,
                    "cwd": cwd,
                })

            except Exception as exc:
                await websocket.send_json({"type": "stderr", "data": str(exc) + "\n"})
                await websocket.send_json({"type": "exit", "code": -1, "cwd": cwd})
                current_process = None

    except Exception as exc:
        try:
            await websocket.send_json({"type": "stderr", "data": f"Terminal error: {exc}\n"})
        except Exception:
            pass
    finally:
        recv_task.cancel()
        if current_process:
            try:
                current_process.terminate()
            except Exception:
                pass
        if _askpass_file and Path(_askpass_file).exists():
            try:
                os.unlink(_askpass_file)
            except Exception:
                pass


# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cfg = read_config()

    mgr_host = cfg["manager"].get("host", "0.0.0.0")
    mgr_port = int(cfg["manager"].get("port", "9000"))

    ssl_cert = cfg["ssl"].get("certfile", "") if "ssl" in cfg else ""
    ssl_key  = cfg["ssl"].get("keyfile",  "") if "ssl" in cfg else ""

    use_ssl = bool(ssl_cert and ssl_key and
                   Path(ssl_cert).exists() and Path(ssl_key).exists())

    print(f"Starting manager on {'https' if use_ssl else 'http'}://{mgr_host}:{mgr_port}")

    uvicorn.run(
        app,
        host=mgr_host,
        port=mgr_port,
        ssl_certfile=ssl_cert if use_ssl else None,
        ssl_keyfile=ssl_key  if use_ssl else None,
    )