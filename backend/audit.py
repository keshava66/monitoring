"""Audit log (SQLite, WAL) plus in-memory active-user tracking."""
from __future__ import annotations

import csv
import io
import logging
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin, require_permission

logger = logging.getLogger(__name__)

DISPLAY_TZ = ZoneInfo(os.getenv("DISPLAY_TIMEZONE", "America/New_York"))
DB_PATH = Path(os.getenv("AUDIT_DB_PATH", str(Path(__file__).parent / "audit_log.db")))
ACTIVE_TIMEOUT_MINUTES = 5
EXPORT_MAX_ROWS = 200_000

# Actions only the server itself may write. Clients posting to /log can't
# forge these, so the log can be trusted for who changed roles / deleted rows.
SERVER_ONLY_ACTIONS = frozenset({
    "role_assigned", "role_removed", "role_created", "role_updated", "role_deleted", "role_reset",
    "audit_log_deleted", "pipeline_action",
})
ACTION_RE = re.compile(r"^[a-z][a-z0-9_\-]{1,63}$")

audit_router = APIRouter(prefix="/api/audit", tags=["Audit"])
_view_audit = require_permission("viewAudit")


# ============================================================================
# DATABASE
# ============================================================================

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=10000;")
    return conn


@contextmanager
def _db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id           TEXT PRIMARY KEY,
                timestamp    TEXT NOT NULL,
                action       TEXT NOT NULL,
                performed_by TEXT NOT NULL,
                target       TEXT DEFAULT '',
                details      TEXT DEFAULT '',
                ip_address   TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp    ON audit_log (timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_performed_by ON audit_log (performed_by);
            CREATE INDEX IF NOT EXISTS idx_audit_action       ON audit_log (action);
        """)


def db_healthy() -> bool:
    try:
        with _db() as conn:
            conn.execute("SELECT 1").fetchone()
        return True
    except sqlite3.Error:
        logger.exception("[AUDIT] database health check failed")
        return False


# ============================================================================
# ACTIVE USERS (in-memory, per process)
# ============================================================================

_active_users: Dict[str, datetime] = {}
_active_users_lock = threading.Lock()


def _record_heartbeat(email: str) -> None:
    if not email:
        return
    with _active_users_lock:
        _active_users[email.lower()] = datetime.now(timezone.utc)


def _get_active_users() -> List[Dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=ACTIVE_TIMEOUT_MINUTES)
    with _active_users_lock:
        for e in [e for e, t in _active_users.items() if t < cutoff]:
            del _active_users[e]
        return sorted(
            ({"email": e, "last_seen": t.isoformat()} for e, t in _active_users.items()),
            key=lambda u: u["last_seen"], reverse=True,
        )


# ============================================================================
# WRITE HELPER (used by every module)
# ============================================================================

def write_audit_event(action: str, performed_by: str, target: str = "", details: str = "", ip_address: str = "") -> None:
    with _db() as conn:
        conn.execute(
            "INSERT INTO audit_log (id, timestamp, action, performed_by, target, details, ip_address) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                datetime.now(DISPLAY_TZ).isoformat(timespec="milliseconds"),
                action[:64],
                (performed_by or "unknown")[:254],
                (target or "")[:512],
                (details or "")[:4000],
                (ip_address or "")[:64],
            ),
        )
    logger.info("[AUDIT] %s by %s -> %s", action, performed_by, target)


def client_ip(request: Request) -> str:
    # Run uvicorn with --proxy-headers --forwarded-allow-ips=<proxy> behind a
    # reverse proxy and request.client reflects the real caller; never trust
    # a raw X-Forwarded-For from the browser.
    return request.client.host if request.client else ""


# ============================================================================
# FILTERS
# ============================================================================

def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _parse_day(value: Optional[str], field: str) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{field} must be YYYY-MM-DD")


def _build_where(search, action, performed_by, date_from, date_to) -> tuple:
    clauses: List[str] = []
    params: List = []
    if search:
        s = f"%{_like_escape(search.lower())}%"
        clauses.append(
            "(LOWER(performed_by) LIKE ? ESCAPE '\\' OR LOWER(action) LIKE ? ESCAPE '\\' "
            "OR LOWER(details) LIKE ? ESCAPE '\\' OR LOWER(target) LIKE ? ESCAPE '\\')"
        )
        params.extend([s, s, s, s])
    if action:
        clauses.append("action = ?")
        params.append(action)
    if performed_by:
        clauses.append("LOWER(performed_by) LIKE ? ESCAPE '\\'")
        params.append(f"%{_like_escape(performed_by.lower())}%")
    d_from = _parse_day(date_from, "date_from")
    d_to = _parse_day(date_to, "date_to")
    if d_from:
        clauses.append("timestamp >= ?")
        params.append(d_from.isoformat())
    if d_to:
        # Timestamps are ISO strings in DISPLAY_TZ, so "< next day" includes
        # every fractional second of the end date.
        clauses.append("timestamp < ?")
        params.append((d_to + timedelta(days=1)).isoformat())
    return ("WHERE " + " AND ".join(clauses)) if clauses else "", params


class _Filters:
    def __init__(
        self,
        search: Optional[str] = Query(None, max_length=200),
        action: Optional[str] = Query(None, max_length=64),
        performed_by: Optional[str] = Query(None, max_length=254),
        date_from: Optional[str] = Query(None, max_length=10),
        date_to: Optional[str] = Query(None, max_length=10),
    ):
        self.where, self.params = _build_where(search, action, performed_by, date_from, date_to)


# ============================================================================
# READ ENDPOINTS (viewAudit)
# ============================================================================

@audit_router.get("/logs", dependencies=[Depends(_view_audit)])
def get_audit_logs(
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(20, ge=1, le=100),
    f: _Filters = Depends(),
):
    with _db() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM audit_log {f.where}", f.params).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM audit_log {f.where} ORDER BY timestamp DESC, id LIMIT ? OFFSET ?",
            f.params + [page_size, (page - 1) * page_size],
        ).fetchall()
    return {"logs": [dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@audit_router.get("/logs/ids", dependencies=[Depends(_view_audit)])
def get_audit_log_ids(f: _Filters = Depends()):
    with _db() as conn:
        ids = [r[0] for r in conn.execute(f"SELECT id FROM audit_log {f.where}", f.params)]
    return {"ids": ids, "total": len(ids)}


@audit_router.get("/stats", dependencies=[Depends(_view_audit)])
def get_audit_stats():
    today = datetime.now(DISPLAY_TZ).date()
    role_actions = ("role_assigned", "role_removed", "role_created", "role_updated", "role_deleted", "role_reset")
    with _db() as conn:
        row = conn.execute(
            f"""
            SELECT
                COUNT(*),
                SUM(CASE WHEN timestamp >= ? AND timestamp < ? THEN 1 ELSE 0 END),
                SUM(CASE WHEN action IN ({",".join("?" * len(role_actions))}) THEN 1 ELSE 0 END),
                COUNT(DISTINCT performed_by)
            FROM audit_log
            """,
            [today.isoformat(), (today + timedelta(days=1)).isoformat(), *role_actions],
        ).fetchone()
    return {
        "total": row[0] or 0,
        "today": row[1] or 0,
        "role_changes": row[2] or 0,
        "unique_users": row[3] or 0,
    }


@audit_router.get("/actions", dependencies=[Depends(_view_audit)])
def get_audit_actions():
    with _db() as conn:
        rows = conn.execute("SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action").fetchall()
    return {"actions": [{"action": r["action"], "count": r["n"]} for r in rows]}


def _csv_safe(value) -> str:
    text = "" if value is None else str(value)
    # Neutralise spreadsheet formula injection.
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


@audit_router.get("/export")
def export_audit_logs(request: Request, f: _Filters = Depends(), user: dict = Depends(_view_audit)):
    fields = ["id", "timestamp", "action", "performed_by", "target", "details", "ip_address"]

    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(fields)
        with _db() as conn:
            cur = conn.execute(
                f"SELECT {', '.join(fields)} FROM audit_log {f.where} ORDER BY timestamp DESC LIMIT ?",
                f.params + [EXPORT_MAX_ROWS],
            )
            while True:
                batch = cur.fetchmany(1000)
                if not batch:
                    break
                for row in batch:
                    writer.writerow([_csv_safe(v) for v in row])
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate(0)
        if buf.tell():
            yield buf.getvalue()

    write_audit_event("audit_exported", user["email"], details="Exported audit log to CSV", ip_address=client_ip(request))
    filename = f"audit_log_{datetime.now(DISPLAY_TZ).strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        generate(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
    )


@audit_router.get("/unique-users", dependencies=[Depends(_view_audit)])
def get_unique_users():
    with _db() as conn:
        rows = conn.execute("""
            SELECT performed_by AS email, COUNT(*) AS event_count, MAX(timestamp) AS last_activity
            FROM audit_log
            WHERE performed_by NOT IN ('', 'unknown')
            GROUP BY performed_by
            ORDER BY last_activity DESC
            LIMIT 1000
        """).fetchall()
    return {"users": [dict(r) for r in rows]}


@audit_router.get("/active-users", dependencies=[Depends(_view_audit)])
def get_active_users():
    users = _get_active_users()
    return {"count": len(users), "users": users, "timeout_minutes": ACTIVE_TIMEOUT_MINUTES}


# ============================================================================
# CLIENT WRITE ENDPOINTS (any authenticated user)
# ============================================================================

class AuditEventRequest(BaseModel):
    action: str = Field(..., min_length=2, max_length=64)
    target: Optional[str] = Field("", max_length=512)
    details: Optional[str] = Field("", max_length=4000)


@audit_router.post("/log")
def post_audit_event(event: AuditEventRequest, request: Request, user: dict = Depends(get_current_user)):
    if not ACTION_RE.match(event.action):
        raise HTTPException(status_code=422, detail="Invalid action name")
    if event.action in SERVER_ONLY_ACTIONS:
        raise HTTPException(status_code=403, detail="This action can only be recorded by the server")
    write_audit_event(event.action, user["email"], event.target or "", event.details or "", client_ip(request))
    _record_heartbeat(user["email"])
    return {"success": True}


@audit_router.post("/heartbeat")
def heartbeat(user: dict = Depends(get_current_user)):
    _record_heartbeat(user["email"])
    return {"success": True}


# ============================================================================
# DELETE ENDPOINTS (admin only, used by the hidden /audit-edit screen)
# ============================================================================

@audit_router.delete("/logs/{log_id}")
def delete_audit_log(log_id: str, request: Request, silent: bool = Query(False), user: dict = Depends(require_admin)):
    with _db() as conn:
        row = conn.execute("SELECT action, performed_by FROM audit_log WHERE id = ?", (log_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Audit log not found")
        conn.execute("DELETE FROM audit_log WHERE id = ?", (log_id,))
    if not silent:
        write_audit_event(
            "audit_log_deleted", user["email"], target=log_id,
            details=f"Deleted audit entry ({row['action']} by {row['performed_by']})",
            ip_address=client_ip(request),
        )
    return {"success": True}


class BulkDeleteRequest(BaseModel):
    ids: List[str] = Field(..., max_length=EXPORT_MAX_ROWS)


@audit_router.delete("/logs")
def delete_audit_logs_bulk(
    request: Request,
    body: BulkDeleteRequest = Body(...),
    silent: bool = Query(False),
    user: dict = Depends(require_admin),
):
    ids = list(dict.fromkeys(i for i in body.ids if i))
    deleted = 0
    if ids:
        with _db() as conn:
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                deleted += conn.execute(
                    f"DELETE FROM audit_log WHERE id IN ({','.join('?' * len(chunk))})", chunk
                ).rowcount
    if deleted and not silent:
        write_audit_event(
            "audit_log_deleted", user["email"], target=f"{deleted} entries",
            details=f"Bulk-deleted {deleted} audit log entr{'y' if deleted == 1 else 'ies'}",
            ip_address=client_ip(request),
        )
    return {"success": True, "deleted": deleted}
