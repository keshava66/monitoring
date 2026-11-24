import configparser
import secrets
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import psutil
import uvicorn
from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# ── Config ────────────────────────────────────────────────────────────────────
_cfg_path = Path(__file__).parent / "config.ini"
if not _cfg_path.exists():
    raise RuntimeError(f"config.ini not found at {_cfg_path}")

_cfg = configparser.ConfigParser()
_cfg.read(str(_cfg_path))
_app_cfg = _cfg["app"]

SCRIPT_PATH  = _app_cfg["SCRIPT_PATH"]
SCRIPT_ARGS  = _app_cfg.get("SCRIPT_ARGS", "", raw=True).split()
LOG_PATH     = _app_cfg["LOG_PATH"]
TERMINAL_LOG = _app_cfg["TERMINAL_LOG"]
PYTHON_EXE   = _app_cfg["PYTHON_EXE"]
SERVER_NAME  = _app_cfg.get("SERVER_NAME", "EPOD Server")
PORT         = int(_app_cfg.get("PORT", "8090"))
SCRIPT_NAME  = os.path.basename(SCRIPT_PATH)

AGENT_TOKEN  = _app_cfg.get("AGENT_TOKEN", "").strip()
if not AGENT_TOKEN:
    raise RuntimeError(
        "AGENT_TOKEN not set in config.ini [app]. Generate one (e.g. `python -c \"import secrets; print(secrets.token_urlsafe(32))\"`) and put it in both this agent's config.ini and the matching *_AGENT_*_TOKEN env var on the backend."
    )

# ── App ───────────────────────────────────────────────────────────────────────
def _require_token(request: Request, authorization: str = Header(None)):
    """Every route needs the shared secret — this replaced running
    wide open with no auth at all. /health is exempt: start.sh's own
    readiness probe hits it with no token, and it returns nothing
    sensitive (see the handler below)."""
    if request.url.path == "/health":
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization[7:]
    if not secrets.compare_digest(token, AGENT_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid token")

app = FastAPI(title="EPOD Agent", version="1.0.0", dependencies=[Depends(_require_token)])
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

# ── Helpers ───────────────────────────────────────────────────────────────────
def find_proc() -> Optional[psutil.Process]:
    script_name = os.path.normcase(SCRIPT_NAME)
    script_dir  = os.path.normcase(os.path.normpath(os.path.dirname(SCRIPT_PATH)))
    for p in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
        try:
            if "python" in (p.info["name"] or "").lower():
                cmdline = [os.path.normcase(c) for c in (p.info["cmdline"] or []) if c]
                has_script = any(script_name == os.path.basename(c) for c in cmdline)
                has_dir    = any(script_dir in c for c in cmdline)
                if has_script and has_dir:
                    return p
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return None

def read_tail(path: str, n: int = 50):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return [l.rstrip() for l in lines[-n:]], len(lines)
    except FileNotFoundError:
        return [], 0

def fmt_uptime(create_time: float) -> str:
    secs = int(time.time() - create_time)
    h, r = divmod(secs, 3600)
    m, s = divmod(r, 60)
    if h: return f"{h}h {m}m {s}s"
    if m: return f"{m}m {s}s"
    return f"{s}s"

def fmt_mem(b: int) -> str:
    return f"{b / (1024 * 1024):.1f} MB"

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
    }

@app.get("/status")
def status():
    proc = find_proc()
    if not proc:
        return {"running": False, "pid": None, "uptime": None, "memory": None, "cpu": None}
    try:    mem = fmt_mem(proc.memory_info().rss)
    except: mem = None
    try:    cpu = f"{proc.cpu_percent(interval=0.1):.1f}%"
    except: cpu = None
    return {"running": True, "pid": proc.pid, "uptime": fmt_uptime(proc.create_time()), "memory": mem, "cpu": cpu}

@app.get("/logs")
def get_logs(n: int = 20):
    lines, total = read_tail(LOG_PATH, n)
    return {"lines": lines, "total": total, "path": LOG_PATH}

@app.get("/terminal")
def get_terminal(n: int = 50):
    lines, total = read_tail(TERMINAL_LOG, n)
    return {"lines": lines, "total": total, "path": TERMINAL_LOG}

@app.get("/terminal/stream")
def stream_terminal():
    def generator():
        try:
            with open(TERMINAL_LOG, encoding="utf-8", errors="replace") as f:
                for line in f.readlines()[-50:]:
                    yield f"data: {line.rstrip()}\n\n"
                f.seek(0, 2)
                while True:
                    line = f.readline()
                    if line:
                        yield f"data: {line.rstrip()}\n\n"
                    else:
                        yield "data: \n\n"
                        time.sleep(0.3)
        except FileNotFoundError:
            yield "data: [Terminal log not found — start the script first]\n\n"
    return StreamingResponse(generator(), media_type="text/event-stream")

@app.post("/start")
def start_script():
    if find_proc():
        raise HTTPException(status_code=409, detail="Script is already running")
    log_dir = os.path.dirname(TERMINAL_LOG)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
    with open(TERMINAL_LOG, "w", encoding="utf-8") as f:
        f.write(f"{'='*60}\n  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n{'='*60}\n")
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    script_dir = os.path.dirname(os.path.abspath(SCRIPT_PATH))
    with open(TERMINAL_LOG, "ab") as out:
        kwargs = {}
        if os.name == "nt":  # Windows — suppress console window
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        subprocess.Popen([PYTHON_EXE, "-u", SCRIPT_PATH] + SCRIPT_ARGS,
            stdout=out, stderr=out, env=env, cwd=script_dir, **kwargs)
    return {"success": True}

@app.post("/stop")
def stop_script():
    proc = find_proc()
    if not proc:
        raise HTTPException(status_code=404, detail="Script is not running")
    proc.terminate()
    return {"success": True}

@app.post("/clear-terminal")
def clear_terminal():
    try:
        open(TERMINAL_LOG, "w").close()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("epod_agent:app", host="0.0.0.0", port=PORT, reload=False)