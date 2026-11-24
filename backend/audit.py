import csv
import io
import uuid
import logging
import sqlite3
import threading
import pytz
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict

from fastapi import APIRouter, Query, Header, Body, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import get_current_user, require_admin

logger = logging.getLogger(__name__)

EASTERN = pytz.timezone('America/New_York')

# ── Database path — sits next to this file, same as the old audit_log.json ──
DB_PATH = Path(__file__).parent / "audit_log.db"

audit_router = APIRouter(prefix="/api/audit", tags=["Audit"], dependencies=[Depends(get_current_user)])


# ============================================================================
# DATABASE SETUP
# ============================================================================

def _get_connection() -> sqlite3.Connection:
    """
    Open a SQLite connection with:
      - WAL mode   → concurrent reads never block writes (and vice-versa)
      - NORMAL sync → safe on crash, faster than FULL
      - Row factory → rows behave like dicts
    """
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


@contextmanager
def _db():
    """Context manager that yields a connection and commits on success."""
    conn = _get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _init_db():
    """Create tables if they don't exist. Called once at startup."""
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id          TEXT PRIMARY KEY,
                timestamp   TEXT NOT NULL,
                action      TEXT NOT NULL,
                performed_by TEXT NOT NULL,
                target      TEXT DEFAULT '',
                details     TEXT DEFAULT '',
                ip_address  TEXT DEFAULT ''
            )
        """)
        # Index on timestamp for fast date-range queries and sorting
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp
            ON audit_log (timestamp DESC)
        """)
        # Index on performed_by for fast user filtering
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_audit_performed_by
            ON audit_log (performed_by)
        """)
        # Index on action for fast action filtering
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_audit_action
            ON audit_log (action)
        """)




# Run DB init at import time (FastAPI imports this module once at startup)
_init_db()


# ============================================================================
# ACTIVE USERS TRACKING  (in-memory — unchanged from original)
# ============================================================================

_active_users: Dict[str, datetime] = {}
_active_users_lock = threading.Lock()
ACTIVE_TIMEOUT_MINUTES = 5  # consider user inactive after 5 min without heartbeat


def _record_heartbeat(email: str):
    with _active_users_lock:
        _active_users[email] = datetime.utcnow()


def _get_active_users() -> List[Dict]:
    cutoff = datetime.utcnow() - timedelta(minutes=ACTIVE_TIMEOUT_MINUTES)
    with _active_users_lock:
        stale = [e for e, t in _active_users.items() if t < cutoff]
        for e in stale:
            del _active_users[e]
        return [
            {"email": email, "last_seen": ts.isoformat() + "Z"}
            for email, ts in _active_users.items()
        ]


# ============================================================================
# PUBLIC HELPER — called from Backend.py and other modules
# ============================================================================

def write_audit_event(
    action: str,
    performed_by: str,
    target: str = "",
    details: str = "",
    ip_address: str = "",
):
    """
    Write a single audit event to the database.
    Thread-safe: SQLite + WAL handles concurrent writers without any extra lock.
    """
    with _db() as conn:
        conn.execute(
            """
            INSERT INTO audit_log (id, timestamp, action, performed_by, target, details, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                datetime.now(EASTERN).isoformat(),
                action,
                performed_by,
                target or "",
                details or "",
                ip_address or "",
            ),
        )
    logger.info(f"[AUDIT] {action} by {performed_by} → {target}")


# ============================================================================
# REQUEST / RESPONSE MODELS
# ============================================================================

class AuditEventRequest(BaseModel):
    action: str
    target: Optional[str] = ""
    details: Optional[str] = ""


# ============================================================================
# SHARED FILTER HELPER
# ============================================================================

def _build_where(
    search: Optional[str],
    action: Optional[str],
    performed_by: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[str, list]:
    """
    Build a parameterised WHERE clause from the common filter fields.
    Returns (where_sql, params_list).
    """
    clauses = []
    params = []

    if search:
        s = f"%{search.lower()}%"
        clauses.append(
            "(LOWER(performed_by) LIKE ? OR LOWER(action) LIKE ? OR LOWER(details) LIKE ? OR LOWER(target) LIKE ?)"
        )
        params.extend([s, s, s, s])

    if action:
        clauses.append("action = ?")
        params.append(action)

    if performed_by:
        clauses.append("LOWER(performed_by) LIKE ?")
        params.append(f"%{performed_by.lower()}%")

    if date_from:
        clauses.append("timestamp >= ?")
        params.append(date_from)

    if date_to:
        # Include the full day by going up to 23:59:59
        clauses.append("timestamp <= ?")
        params.append(date_to + "T23:59:59")

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


# ============================================================================
# ENDPOINTS
# ============================================================================

@audit_router.get("/logs")
def get_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    performed_by: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    x_user_email: Optional[str] = Header(None),
):
    """Return paginated, filtered audit log entries (newest first)."""
    where, params = _build_where(search, action, performed_by, date_from, date_to)

    with _db() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM audit_log {where}", params
        ).fetchone()[0]

        offset = (page - 1) * page_size
        rows = conn.execute(
            f"SELECT * FROM audit_log {where} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
            params + [page_size, offset],
        ).fetchall()

    return {
        "logs": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@audit_router.get("/logs/ids")
def get_audit_log_ids(
    search: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    performed_by: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    x_user_email: Optional[str] = Header(None),
):
    where, params = _build_where(search, action, performed_by, date_from, date_to)
    with _db() as conn:
        rows = conn.execute(f"SELECT id FROM audit_log {where}", params).fetchall()
    ids = [r["id"] for r in rows]
    return {"ids": ids, "total": len(ids)}


@audit_router.get("/stats")
def get_audit_stats(x_user_email: Optional[str] = Header(None)):
    """Return summary statistics for the audit dashboard cards."""
    today = datetime.now(EASTERN).date().isoformat()

    role_actions = (
        "role_assigned", "role_removed",
        "role_created", "role_updated", "role_deleted", "role_reset",
    )
    placeholders = ",".join("?" * len(role_actions))

    with _db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
        today_count = conn.execute(
            "SELECT COUNT(*) FROM audit_log WHERE timestamp LIKE ?", (today + "%",)
        ).fetchone()[0]
        role_changes = conn.execute(
            f"SELECT COUNT(*) FROM audit_log WHERE action IN ({placeholders})",
            list(role_actions),
        ).fetchone()[0]
        unique_users = conn.execute(
            "SELECT COUNT(DISTINCT performed_by) FROM audit_log"
        ).fetchone()[0]

    return {
        "total": total,
        "today": today_count,
        "role_changes": role_changes,
        "unique_users": unique_users,
    }


@audit_router.get("/export")
def export_audit_logs(
    search: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    performed_by: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    x_user_email: Optional[str] = Header(None),
):
    """Export filtered audit logs as a CSV download."""
    where, params = _build_where(search, action, performed_by, date_from, date_to)

    with _db() as conn:
        rows = conn.execute(
            f"SELECT * FROM audit_log {where} ORDER BY timestamp DESC", params
        ).fetchall()

    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["id", "timestamp", "action", "performed_by", "target", "details", "ip_address"],
        extrasaction="ignore",
    )
    writer.writeheader()
    writer.writerows([dict(r) for r in rows])

    filename = f"audit_log_{datetime.now(EASTERN).strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@audit_router.post("/log")
def post_audit_event(
    event: AuditEventRequest,
    user: dict = Depends(get_current_user),
    x_forwarded_for: Optional[str] = Header(None),
):
    ip = x_forwarded_for.split(",")[0].strip() if x_forwarded_for else ""
    performed_by = user["email"] or "unknown"
    write_audit_event(
        action=event.action,
        performed_by=performed_by,
        target=event.target or "",
        details=event.details or "",
        ip_address=ip,
    )
    _record_heartbeat(performed_by)
    return {"success": True}


# ============================================================================
# DELETE ENDPOINTS — admin-only. Used by the hidden /audit-edit screen.
# Deleting a log entry is itself written to the audit log, so removals are
# never silent. Admin check is now server-resolved (auth.require_admin) —
# no longer trusts a client-supplied X-User-Role header.
# ============================================================================

@audit_router.delete("/logs/{log_id}")
def delete_audit_log(
    log_id: str,
    silent: bool = Query(False),
    user: dict = Depends(require_admin),
):
    """Delete a single audit log entry. Admin-only."""
    with _db() as conn:
        row = conn.execute("SELECT action, performed_by FROM audit_log WHERE id = ?", (log_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Audit log not found")
        conn.execute("DELETE FROM audit_log WHERE id = ?", (log_id,))
    if not silent:
        write_audit_event(
            "audit_log_deleted", user["email"] or "unknown", target=log_id,
            details=f"Deleted audit entry ({row['action']} by {row['performed_by']})",
        )
    return {"success": True}


@audit_router.delete("/logs")
def delete_audit_logs_bulk(
    ids: List[str] = Body(..., embed=True),
    silent: bool = Query(False),
    user: dict = Depends(require_admin),
):
    """Delete multiple audit log entries at once. Admin-only."""
    if not ids:
        return {"success": True, "deleted": 0}
    BATCH = 500
    deleted = 0
    with _db() as conn:
        for i in range(0, len(ids), BATCH):
            chunk = ids[i:i + BATCH]
            placeholders = ",".join("?" * len(chunk))
            cur = conn.execute(f"DELETE FROM audit_log WHERE id IN ({placeholders})", chunk)
            deleted += cur.rowcount
    if not silent:
        write_audit_event(
            "audit_log_deleted", user["email"] or "unknown", target=f"{deleted} entries",
            details=f"Bulk-deleted {deleted} audit log entr{'y' if deleted == 1 else 'ies'}",
        )
    return {"success": True, "deleted": deleted}


# ============================================================================
# HEARTBEAT — called every 30 s by the frontend to signal the user is active
# ============================================================================

@audit_router.post("/heartbeat")
def heartbeat(user: dict = Depends(get_current_user)):
    """Record that a user is currently active. Called periodically by the frontend."""
    _record_heartbeat(user["email"])
    return {"success": True}


@audit_router.get("/unique-users")
def get_unique_users(x_user_email: Optional[str] = Header(None)):
    """Return all unique users with their total event count and last activity timestamp."""
    with _db() as conn:
        rows = conn.execute("""
            SELECT
                performed_by  AS email,
                COUNT(*)      AS event_count,
                MAX(timestamp) AS last_activity
            FROM audit_log
            WHERE performed_by != '' AND performed_by != 'unknown'
            GROUP BY performed_by
            ORDER BY last_activity DESC
        """).fetchall()
    return {"users": [dict(r) for r in rows]}


@audit_router.get("/active-users")
def get_active_users(x_user_email: Optional[str] = Header(None)):
    """Return currently active users and a count."""
    users = _get_active_users()
    return {
        "count": len(users),
        "users": users,
        "timeout_minutes": ACTIVE_TIMEOUT_MINUTES,
    }