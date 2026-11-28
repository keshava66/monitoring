"""Audit log and per-user preferences (PostgreSQL, see core_db) plus in-memory
active-user tracking."""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import threading
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import core_db
from auth import get_current_user, require_admin, require_permission

logger = logging.getLogger(__name__)

DISPLAY_TZ = ZoneInfo(os.getenv("DISPLAY_TIMEZONE", "America/New_York"))
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

_db = core_db.transaction


def _iso(ts: Optional[datetime]) -> Optional[str]:
    """Timestamps leave the API as ISO strings in DISPLAY_TZ, as they always have."""
    return ts.astimezone(DISPLAY_TZ).isoformat(timespec="milliseconds") if ts else None


def _row(r) -> Dict:
    out = dict(r)
    for key in ("timestamp", "last_activity"):
        if isinstance(out.get(key), datetime):
            out[key] = _iso(out[key])
    return out


def _day_start(d: date) -> datetime:
    return datetime.combine(d, time.min, DISPLAY_TZ)


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
    with _db() as cur:
        cur.execute(
            'INSERT INTO audit_log (id, "timestamp", action, performed_by, target, details, ip_address) '
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (
                str(uuid.uuid4()),
                datetime.now(timezone.utc),
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
            "(LOWER(performed_by) LIKE %s ESCAPE '\\' OR LOWER(action) LIKE %s ESCAPE '\\' "
            "OR LOWER(details) LIKE %s ESCAPE '\\' OR LOWER(target) LIKE %s ESCAPE '\\')"
        )
        params.extend([s, s, s, s])
    if action:
        clauses.append("action = %s")
        params.append(action)
    if performed_by:
        clauses.append("LOWER(performed_by) LIKE %s ESCAPE '\\'")
        params.append(f"%{_like_escape(performed_by.lower())}%")
    d_from = _parse_day(date_from, "date_from")
    d_to = _parse_day(date_to, "date_to")
    # Days are calendar days in DISPLAY_TZ; "< next day" includes every
    # fraction of a second of the end date.
    if d_from:
        clauses.append('"timestamp" >= %s')
        params.append(_day_start(d_from))
    if d_to:
        clauses.append('"timestamp" < %s')
        params.append(_day_start(d_to + timedelta(days=1)))
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
    with _db() as cur:
        cur.execute(f"SELECT COUNT(*) FROM audit_log {f.where}", f.params)
        total = cur.fetchone()[0]
        cur.execute(
            f'SELECT * FROM audit_log {f.where} ORDER BY "timestamp" DESC, id LIMIT %s OFFSET %s',
            f.params + [page_size, (page - 1) * page_size],
        )
        rows = cur.fetchall()
    return {"logs": [_row(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@audit_router.get("/logs/ids", dependencies=[Depends(_view_audit)])
def get_audit_log_ids(f: _Filters = Depends()):
    with _db() as cur:
        cur.execute(f"SELECT id FROM audit_log {f.where}", f.params)
        ids = [r[0] for r in cur.fetchall()]
    return {"ids": ids, "total": len(ids)}


@audit_router.get("/stats", dependencies=[Depends(_view_audit)])
def get_audit_stats():
    today = datetime.now(DISPLAY_TZ).date()
    role_actions = ("role_assigned", "role_removed", "role_created", "role_updated", "role_deleted", "role_reset")
    with _db() as cur:
        cur.execute(
            """
            SELECT
                COUNT(*),
                COUNT(*) FILTER (WHERE "timestamp" >= %s AND "timestamp" < %s),
                COUNT(*) FILTER (WHERE action = ANY(%s)),
                COUNT(DISTINCT performed_by)
            FROM audit_log
            """,
            [_day_start(today), _day_start(today + timedelta(days=1)), list(role_actions)],
        )
        row = cur.fetchone()
    return {
        "total": row[0] or 0,
        "today": row[1] or 0,
        "role_changes": row[2] or 0,
        "unique_users": row[3] or 0,
    }


@audit_router.get("/actions", dependencies=[Depends(_view_audit)])
def get_audit_actions():
    with _db() as cur:
        cur.execute("SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action")
        rows = cur.fetchall()
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
        with _db() as cur:
            cur.execute(
                "SELECT " + ", ".join(f'"{c}"' for c in fields) + f' FROM audit_log {f.where} ORDER BY "timestamp" DESC LIMIT %s',
                f.params + [EXPORT_MAX_ROWS],
            )
            while True:
                batch = cur.fetchmany(1000)
                if not batch:
                    break
                for row in batch:
                    writer.writerow([_csv_safe(_iso(v) if isinstance(v, datetime) else v) for v in row])
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
    with _db() as cur:
        cur.execute("""
            SELECT performed_by AS email, COUNT(*) AS event_count, MAX("timestamp") AS last_activity
            FROM audit_log
            WHERE performed_by NOT IN ('', 'unknown')
            GROUP BY performed_by
            ORDER BY last_activity DESC
            LIMIT 1000
        """)
        rows = cur.fetchall()
    return {"users": [_row(r) for r in rows]}


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
# PER-USER PREFERENCES (follow the person across machines)
# ============================================================================

class PreferencesUpdate(BaseModel):
    reduce_motion: Optional[bool] = None


def _load_preferences(cur, email: str, lock: bool = False) -> Dict:
    cur.execute("SELECT preferences FROM user_preferences WHERE email = %s" + (" FOR UPDATE" if lock else ""), (email,))
    row = cur.fetchone()
    return row[0] if row and isinstance(row[0], dict) else {}


@audit_router.get("/preferences")
def get_preferences(user: dict = Depends(get_current_user)):
    with _db() as cur:
        return {"preferences": _load_preferences(cur, user["email"])}


@audit_router.put("/preferences")
def put_preferences(update: PreferencesUpdate, user: dict = Depends(get_current_user)):
    changes = update.model_dump(exclude_none=True)
    with _db() as cur:
        prefs = {**_load_preferences(cur, user["email"], lock=True), **changes}
        cur.execute(
            "INSERT INTO user_preferences (email, preferences, updated_at) VALUES (%s, %s, now()) "
            "ON CONFLICT (email) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at",
            (user["email"], json.dumps(prefs)),
        )
    return {"preferences": prefs}


# ============================================================================
# DELETE ENDPOINTS (admin only, used by the hidden /audit-edit screen)
# ============================================================================

@audit_router.delete("/logs/{log_id}")
def delete_audit_log(log_id: str, request: Request, silent: bool = Query(False), user: dict = Depends(require_admin)):
    with _db() as cur:
        cur.execute("DELETE FROM audit_log WHERE id = %s RETURNING action, performed_by", (log_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Audit log not found")
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
        with _db() as cur:
            for i in range(0, len(ids), 5000):
                cur.execute("DELETE FROM audit_log WHERE id = ANY(%s)", (ids[i:i + 5000],))
                deleted += cur.rowcount
    if deleted and not silent:
        write_audit_event(
            "audit_log_deleted", user["email"], target=f"{deleted} entries",
            details=f"Bulk-deleted {deleted} audit log entr{'y' if deleted == 1 else 'ies'}",
            ip_address=client_ip(request),
        )
    return {"success": True, "deleted": deleted}
