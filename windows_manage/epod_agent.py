"""Pipeline agent: start / stop / observe one extraction script on this host.

The monitoring backend is the only client. Every route except /health
requires `Authorization: Bearer <AGENT_TOKEN>`.

config.ini ([app] section, next to this file or at $AGENT_CONFIG):
    SCRIPT_PATH     absolute path of the pipeline entry script (required)
    SCRIPT_ARGS     arguments passed to the script
    PYTHON_EXE      interpreter used to run it (required)
    LOG_PATH        the pipeline's own log file (required)
    TERMINAL_LOG    file that captures the script's stdout/stderr (required)
    SERVER_NAME     display name shown in the UI
    PORT / HOST     listen address (default 0.0.0.0:8090)
    AGENT_TOKEN     shared secret, must match the backend's *_AGENT_*_TOKEN (required)
    RUN_AS_MODULE   run as `python -m <script>` from the script directory (default False)
    STOP_TIMEOUT    seconds to wait for a graceful stop before killing (default 20)
    SSL_CERTFILE / SSL_KEYFILE   serve HTTPS when both are set
"""
from __future__ import annotations

import asyncio
import configparser
import logging
import os
import secrets
import shlex
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import psutil
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("agent")

BASE_DIR = Path(__file__).resolve().parent
_cfg_path = Path(os.environ.get("AGENT_CONFIG", BASE_DIR / "config.ini"))
if not _cfg_path.is_file():
    raise RuntimeError(f"config.ini not found at {_cfg_path}")

_cfg = configparser.ConfigParser(interpolation=None)
_cfg.read(_cfg_path, encoding="utf-8")
if not _cfg.has_section("app"):
    raise RuntimeError(f"[app] section missing in {_cfg_path}")
_app_cfg = _cfg["app"]


def _required(key: str) -> str:
    value = (_app_cfg.get(key) or "").strip()
    if not value:
        raise RuntimeError(f"{key} must be set in {_cfg_path} [app]")
    return value


def _flag(key: str, default: bool) -> bool:
    return (_app_cfg.get(key) or str(default)).strip().lower() in ("1", "true", "yes", "on")


SCRIPT_PATH = os.path.abspath(_required("SCRIPT_PATH"))
SCRIPT_ARGS = shlex.split(_app_cfg.get("SCRIPT_ARGS", ""), posix=os.name != "nt")
LOG_PATH = _required("LOG_PATH")
TERMINAL_LOG = _required("TERMINAL_LOG")
PYTHON_EXE = _required("PYTHON_EXE")
SERVER_NAME = (_app_cfg.get("SERVER_NAME") or "Pipeline Server").strip()
HOST = (_app_cfg.get("HOST") or "0.0.0.0").strip()
PORT = int(_app_cfg.get("PORT", "8090"))
AGENT_TOKEN = _required("AGENT_TOKEN")
RUN_AS_MODULE = _flag("RUN_AS_MODULE", False)
STOP_TIMEOUT = float(_app_cfg.get("STOP_TIMEOUT", "20"))
SSL_CERTFILE = (_app_cfg.get("SSL_CERTFILE") or "").strip()
SSL_KEYFILE = (_app_cfg.get("SSL_KEYFILE") or "").strip()

if len(AGENT_TOKEN) < 24:
    raise RuntimeError("AGENT_TOKEN is too short; generate one with: python -c \"import secrets; print(secrets.token_urlsafe(32))\"")

SCRIPT_NAME = os.path.basename(SCRIPT_PATH)
SCRIPT_DIR = os.path.dirname(SCRIPT_PATH)
MODULE_NAME = os.path.splitext(SCRIPT_NAME)[0]
PID_FILE = BASE_DIR / f".{MODULE_NAME}.pid"
MAX_LINES = 10_000
STREAM_BACKLOG = 50
STREAM_BACKLOG_MAX = 2000
STREAM_POLL_SECS = 0.25
STREAM_KEEPALIVE_SECS = 15

_control_lock = threading.Lock()


def _norm(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


_SCRIPT_REAL = _norm(SCRIPT_PATH)
_SCRIPT_DIR_REAL = _norm(SCRIPT_DIR)


# ── Auth ──────────────────────────────────────────────────────────────────────

def _require_token(request: Request, authorization: Optional[str] = Header(None)):
    if request.url.path == "/health":
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    if not secrets.compare_digest(authorization[7:].encode(), AGENT_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Invalid token")


app = FastAPI(title="Pipeline Agent", version="2.0.0", dependencies=[Depends(_require_token)],
              docs_url=None, redoc_url=None, openapi_url=None)


# ── Process discovery ─────────────────────────────────────────────────────────

def _matches(proc: psutil.Process) -> bool:
    try:
        cmdline = [c for c in proc.cmdline() if c]
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return False
    if len(cmdline) < 2 or "python" not in os.path.basename(cmdline[0]).lower():
        return False
    args = cmdline[1:]
    for arg in args:
        if arg.lower().endswith(".py") or os.sep in arg or "/" in arg:
            try:
                candidate = arg if os.path.isabs(arg) else os.path.join(proc.cwd(), arg)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                candidate = arg
            if _norm(candidate) == _SCRIPT_REAL:
                return True
    if "-m" in args:
        i = args.index("-m")
        if i + 1 < len(args) and args[i + 1] == MODULE_NAME:
            try:
                return _norm(proc.cwd()) == _SCRIPT_DIR_REAL
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                return False
    return False


def _read_pidfile() -> Optional[int]:
    try:
        return int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None


def find_proc() -> Optional[psutil.Process]:
    pid = _read_pidfile()
    if pid:
        try:
            proc = psutil.Process(pid)
            if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE and _matches(proc):
                return proc
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    me = os.getpid()
    # Prefer the outermost match (on Windows a venv python.exe launcher and
    # the real interpreter both carry the script on their command line).
    found = [p for p in psutil.process_iter(["pid"]) if p.info["pid"] != me and _matches(p)]
    if not found:
        return None
    pids = {p.pid for p in found}
    for p in found:
        try:
            if p.ppid() not in pids:
                return p
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return found[0]


# ── Log reading ───────────────────────────────────────────────────────────────

def _file_identity(st: os.stat_result) -> int:
    return st.st_ino or st.st_ctime_ns


_line_count_cache: Dict[str, Tuple[int, int, int]] = {}
_line_count_lock = threading.Lock()


def _count_lines(path: str) -> int:
    """Incremental newline count: only bytes appended since the last call are
    scanned, so polling a multi-GB log stays cheap."""
    st = os.stat(path)
    with _line_count_lock:
        offset, count, ino = _line_count_cache.get(path, (0, 0, 0))
        identity = _file_identity(st)
        if st.st_size < offset or identity != ino:
            offset, count = 0, 0
        with open(path, "rb") as f:
            f.seek(offset)
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                count += chunk.count(b"\n")
                offset += len(chunk)
        _line_count_cache[path] = (offset, count, identity)
        return count


def _tail_lines_upto(path: str, n: int, end: int) -> List[str]:
    with open(path, "rb") as f:
        block, data, pos = 64 * 1024, b"", end
        while pos > 0 and data.count(b"\n") <= n:
            step = min(block, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
    lines = data.decode("utf-8", errors="replace").splitlines()
    return [l.rstrip() for l in lines[-n:]]


def _tail_lines(path: str, n: int) -> List[str]:
    return _tail_lines_upto(path, n, os.path.getsize(path))


def read_tail(path: str, n: int) -> Tuple[List[str], int]:
    try:
        return _tail_lines(path, n), _count_lines(path)
    except FileNotFoundError:
        return [], 0


def fmt_uptime(create_time: float) -> str:
    secs = max(0, int(time.time() - create_time))
    d, r = divmod(secs, 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/info")
def info():
    return {
        "server_name": SERVER_NAME,
        "script_name": SCRIPT_NAME,
        "script_args": " ".join(SCRIPT_ARGS) or "—",
        "script_path": SCRIPT_PATH,
        "run_as_module": RUN_AS_MODULE,
        "cpu_count": psutil.cpu_count() or 1,
        "total_memory": psutil.virtual_memory().total,
    }


_STOPPED = {"running": False, "pid": None, "uptime": None, "memory": None, "cpu": None,
            "memory_bytes": None, "cpu_percent": None}

# psutil measures CPU between two calls on the same Process object. Keeping the
# objects between polls gives a reading over the whole poll interval with no
# sleep in the request; only a process seen for the first time needs a short sample.
_cpu_samplers: Dict[Tuple[int, float], psutil.Process] = {}
_cpu_lock = threading.Lock()


def _cpu_total(procs: List[psutil.Process]) -> float:
    with _cpu_lock:
        live, fresh = {}, []
        for p in procs:
            try:
                key = (p.pid, p.create_time())
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            sampler = _cpu_samplers.get(key)
            if sampler is None:
                sampler = p
                try:
                    sampler.cpu_percent(None)
                    fresh.append(key)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            live[key] = sampler
        if fresh:
            time.sleep(0.2)
        total = 0.0
        for sampler in live.values():
            try:
                total += sampler.cpu_percent(None)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        _cpu_samplers.clear()
        _cpu_samplers.update(live)
        return total


@app.get("/running")
def running():
    """Cheap liveness probe for fleet overviews: no CPU or memory sampling."""
    proc = find_proc()
    return {"running": proc is not None, "pid": proc.pid if proc else None}


@app.get("/status")
def status():
    proc = find_proc()
    if not proc:
        return dict(_STOPPED)
    try:
        with proc.oneshot():
            procs = [proc] + proc.children(recursive=True)
            created = proc.create_time()
        rss = 0
        for p in procs:
            try:
                rss += p.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        cpu = _cpu_total(procs)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return dict(_STOPPED)
    return {
        "running": True,
        "pid": proc.pid,
        "uptime": fmt_uptime(created),
        "started_at": datetime.fromtimestamp(created).astimezone().isoformat(),
        "memory": f"{rss / (1024 * 1024):.1f} MB",
        "memory_bytes": rss,
        "cpu": f"{cpu:.1f}%",
        "cpu_percent": round(cpu, 1),
        "processes": len(procs),
    }


@app.get("/logs")
def get_logs(n: int = Query(20, ge=1, le=MAX_LINES)):
    lines, total = read_tail(LOG_PATH, n)
    return {"lines": lines, "total": total, "path": LOG_PATH}


@app.get("/terminal")
def get_terminal(n: int = Query(50, ge=1, le=MAX_LINES)):
    lines, total = read_tail(TERMINAL_LOG, n)
    return {"lines": lines, "total": total, "path": TERMINAL_LOG}


def _read_range(path: str, start: int, size: int) -> bytes:
    """Up to `size` bytes from `start`; empty if the log vanished since the stat."""
    try:
        with open(path, "rb") as f:
            f.seek(start)
            return f.read(size)
    except FileNotFoundError:
        return b""


def _backlog(path: str, n: int, size: int) -> Tuple[List[str], int]:
    """Last n complete lines and the offset just after them. A trailing partial
    line is left for the live loop so it is never sent in two pieces."""
    with open(path, "rb") as f:
        start = max(0, size - (1 << 20))
        f.seek(start)
        tail = f.read(size - start)
    end = start + tail.rfind(b"\n") + 1 if b"\n" in tail else start
    if not n or end == 0:
        return [], end
    return _tail_lines_upto(path, n, end), end


def _parse_resume(token: Optional[str]) -> Optional[Tuple[int, int]]:
    try:
        identity, offset = token.split(":")
        return int(identity), int(offset)
    except (AttributeError, ValueError):
        return None


def _sse(line: str, cursor: Optional[str] = None, event: Optional[str] = None) -> str:
    head = (f"event: {event}\n" if event else "") + (f"id: {cursor}\n" if cursor is not None else "")
    return head + "".join(f"data: {part}\n" for part in (line.split("\n") or [""])) + "\n"


@app.get("/terminal/stream")
async def stream_terminal(
    request: Request,
    n: int = Query(STREAM_BACKLOG, ge=0, le=STREAM_BACKLOG_MAX),
    from_: Optional[str] = Query(None, alias="from", max_length=64),
):
    """Server-sent events of the terminal log. Each line carries `id:
    <file identity>:<byte offset after it>`; a client reconnecting with
    ?from=<last id> resumes exactly where it stopped instead of replaying a
    backlog. `event: reset` marks a new or truncated log (a new run, or the
    log was cleared)."""
    async def generator():
        pos: Optional[int] = None
        identity = None
        buffer = b""
        resume = _parse_resume(from_)
        last_send = time.monotonic()
        announced_missing = False
        while not await request.is_disconnected():
            try:
                st = os.stat(TERMINAL_LOG)
            except FileNotFoundError:
                if not announced_missing:
                    announced_missing = True
                    yield _sse("[Terminal log not found — start the script first]")
                    last_send = time.monotonic()
                pos, resume = None, None
                await asyncio.sleep(1)
                continue
            current = _file_identity(st)
            if pos is None:
                announced_missing = False
                identity, buffer = current, b""
                if resume is not None and resume[0] == current and resume[1] <= st.st_size:
                    pos = resume[1]
                else:
                    if resume is not None:
                        yield _sse("", event="reset")
                    backlog, pos = await asyncio.to_thread(_backlog, TERMINAL_LOG, n, st.st_size)
                    cursor = f"{current}:{pos}"
                    for i, line in enumerate(backlog):
                        yield _sse(line, cursor if i == len(backlog) - 1 else None)
                    if not backlog:
                        yield f"id: {cursor}\n\n"
                resume = None
                last_send = time.monotonic()
            elif st.st_size < pos or current != identity:
                pos, identity, buffer = 0, current, b""
                yield _sse("", event="reset")
            if st.st_size > pos:
                chunk = await asyncio.to_thread(_read_range, TERMINAL_LOG, pos, min(st.st_size - pos, 4 << 20))
                offset = pos - len(buffer)
                pos += len(chunk)
                buffer += chunk
                *complete, buffer = buffer.split(b"\n")
                for raw in complete:
                    offset += len(raw) + 1
                    yield _sse(raw.decode("utf-8", errors="replace").rstrip("\r"), f"{identity}:{offset}")
                if complete:
                    last_send = time.monotonic()
            if time.monotonic() - last_send >= STREAM_KEEPALIVE_SECS:
                yield ": keepalive\n\n"
                last_send = time.monotonic()
            await asyncio.sleep(STREAM_POLL_SECS)

    return StreamingResponse(generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.post("/start")
def start_script():
    with _control_lock:
        if find_proc():
            raise HTTPException(status_code=409, detail="Script is already running")
        log_dir = os.path.dirname(TERMINAL_LOG)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        # A brand-new file per run (not a truncate) gives the stream a new
        # identity, so a client resuming from the previous run starts clean.
        fresh = f"{TERMINAL_LOG}.new"
        with open(fresh, "w", encoding="utf-8") as f:
            f.write(f"{'=' * 60}\n  Started: {stamp}\n{'=' * 60}\n")
        try:
            os.replace(fresh, TERMINAL_LOG)
        except OSError:  # Windows: a reader still holds the old file open
            with open(TERMINAL_LOG, "w", encoding="utf-8") as f, open(fresh, encoding="utf-8") as src:
                f.write(src.read())
            os.unlink(fresh)
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        cmd = [PYTHON_EXE, "-u"] + (["-m", MODULE_NAME] if RUN_AS_MODULE else [SCRIPT_PATH]) + SCRIPT_ARGS
        kwargs: Dict = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        try:
            with open(TERMINAL_LOG, "ab") as out:
                proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                        env=env, cwd=SCRIPT_DIR, **kwargs)
        except OSError as exc:
            logger.error("Failed to start %s: %s", SCRIPT_NAME, exc)
            raise HTTPException(status_code=500, detail=f"Failed to start script: {exc.strerror or exc}")
        PID_FILE.write_text(str(proc.pid))
        try:
            code = proc.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            logger.info("Started %s (pid %s)", SCRIPT_NAME, proc.pid)
            return {"success": True, "pid": proc.pid}
        PID_FILE.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Script exited immediately with code {code}; see terminal output")


@app.post("/stop")
def stop_script():
    with _control_lock:
        proc = find_proc()
        if not proc:
            raise HTTPException(status_code=404, detail="Script is not running")
        try:
            procs = [proc] + proc.children(recursive=True)
        except psutil.NoSuchProcess:
            procs = [proc]
        for p in procs:
            try:
                p.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(procs, timeout=STOP_TIMEOUT)
        for p in alive:
            try:
                p.kill()
            except psutil.NoSuchProcess:
                pass
        if alive:
            psutil.wait_procs(alive, timeout=5)
        PID_FILE.unlink(missing_ok=True)
        logger.info("Stopped %s (pid %s, %d forced)", SCRIPT_NAME, proc.pid, len(alive))
        return {"success": True, "forced": len(alive)}


@app.post("/clear-terminal")
def clear_terminal():
    try:
        with open(TERMINAL_LOG, "w", encoding="utf-8"):
            pass
    except FileNotFoundError:
        return {"success": True}
    except OSError as exc:
        raise HTTPException(status_code=409, detail=f"Terminal log is locked: {exc.strerror or exc}")
    with _line_count_lock:
        _line_count_cache.pop(TERMINAL_LOG, None)
    return {"success": True}


if __name__ == "__main__":
    ssl = {"ssl_certfile": SSL_CERTFILE, "ssl_keyfile": SSL_KEYFILE} if SSL_CERTFILE and SSL_KEYFILE else {}
    uvicorn.run(app, host=HOST, port=PORT, reload=False, log_level="info", **ssl)
