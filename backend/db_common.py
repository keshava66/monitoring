"""Postgres access, config.ini loading and the shared ingestion-stats engine
used by both the EPOD and RIMDOCS routers."""
from __future__ import annotations

import configparser
import json
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Callable, Dict, Iterator, List, Optional, Tuple
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.errors
import psycopg2.extras
from fastapi import HTTPException
from psycopg2 import pool as pg_pool
from psycopg2 import sql

logger = logging.getLogger(__name__)

DISPLAY_TZ = ZoneInfo(os.getenv("DISPLAY_TIMEZONE", "America/New_York"))
# Timezone assumed for `timestamp without time zone` columns.
NAIVE_DB_TZ = ZoneInfo(os.getenv("DB_NAIVE_TIMEZONE", "UTC"))
STALL_THRESHOLD_MINS = int(os.getenv("STALL_THRESHOLD_MINS", "30"))
POOL_ACQUIRE_TIMEOUT = float(os.getenv("PG_POOL_ACQUIRE_TIMEOUT", "20"))
STATEMENT_TIMEOUT_MS = int(os.getenv("PG_STATEMENT_TIMEOUT_MS", "120000"))
DEFAULT_COLORS = ["#29B5E8", "#00cc96", "#ffa500", "#EF553B", "#a855f7", "#ec4899", "#14b8a6", "#f97316"]
NO_STORE = {"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")

_config_lock = threading.Lock()
_CONFIG_CACHE: Optional[configparser.ConfigParser] = None
_CONFIG_SOURCE: Optional[Tuple[str, float]] = None


# ============================================================================
# CONFIG
# ============================================================================

def _find_config() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.environ.get("EPOD_CONFIG_PATH", ""),
        os.path.join(here, "config", "config.ini"),
        os.path.join(os.path.dirname(here), "config", "config.ini"),
        os.path.join(os.getcwd(), "config", "config.ini"),
        os.path.join(os.getcwd(), "config.ini"),
        os.path.join(here, "config.ini"),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return ""


def load_config() -> configparser.ConfigParser:
    """config.ini, re-read automatically whenever the file changes on disk."""
    global _CONFIG_CACHE, _CONFIG_SOURCE
    path = _find_config()
    if not path:
        raise FileNotFoundError("config.ini not found. Set EPOD_CONFIG_PATH or place it at config/config.ini.")
    mtime = os.path.getmtime(path)
    with _config_lock:
        if _CONFIG_CACHE is not None and _CONFIG_SOURCE == (path, mtime):
            return _CONFIG_CACHE
        cfg = configparser.ConfigParser(interpolation=None)
        cfg.read(path, encoding="utf-8")
        if not cfg.has_section("POSTGRES"):
            raise KeyError(f"[POSTGRES] section missing in {path}.")
        _CONFIG_CACHE, _CONFIG_SOURCE = cfg, (path, mtime)
        return cfg


def epod_schema() -> str:
    return load_config()["POSTGRES"].get("schema", "public").strip()


def rimdocs_schema() -> str:
    pg = load_config()["POSTGRES"]
    return pg.get("rimdocs_schema", pg.get("schema", "public")).strip()


def table_identifier(name: str, default_schema: str) -> sql.Composable:
    """'schema.table' or 'table' (qualified with default_schema) as a safely
    quoted identifier. Rejects anything that isn't a plain identifier."""
    parts = [p.strip() for p in name.split(".")] if "." in name else [default_schema, name.strip()]
    if len(parts) != 2 or not all(_IDENT_RE.match(p) for p in parts):
        raise ValueError(f"Invalid table name in config.ini: {name!r}")
    return sql.Identifier(*parts)


def qualify(table: str, schema: str) -> str:
    return table if "." in table else f"{schema}.{table}"


def load_table_section(section: str, schema: str) -> List[Dict]:
    cfg = load_config()
    if not cfg.has_section(section):
        raise KeyError(f"[{section}] section missing in config.ini.")
    tables = []
    for idx, (key, raw) in enumerate(cfg[section].items()):
        parts = [p.strip() for p in raw.split("|")]
        name = qualify(parts[0], schema)
        table_identifier(name, schema)  # validates
        color = parts[2] if len(parts) > 2 and _COLOR_RE.match(parts[2]) else DEFAULT_COLORS[idx % len(DEFAULT_COLORS)]
        tables.append({
            "key": key,
            "table": name,
            "label": parts[1] if len(parts) > 1 and parts[1] else parts[0].split(".")[-1].replace("_", " ").title(),
            "color": color,
        })
    if not tables:
        raise ValueError(f"[{section}] section is empty — add at least one table.")
    return tables


# ============================================================================
# CONNECTION POOL
# ============================================================================

class BlockingPool:
    """ThreadedConnectionPool raises immediately when exhausted; this waits
    (bounded) for a free connection instead, so bursts queue rather than 500."""

    def __init__(self, minconn: int, maxconn: int, **kwargs):
        self._pool = pg_pool.ThreadedConnectionPool(minconn, maxconn, **kwargs)
        self._slots = threading.BoundedSemaphore(maxconn)

    def getconn(self):
        if not self._slots.acquire(timeout=POOL_ACQUIRE_TIMEOUT):
            raise HTTPException(status_code=503, detail="Database busy, please retry")
        try:
            conn = self._pool.getconn()
            if conn.closed:
                self._pool.putconn(conn, close=True)
                conn = self._pool.getconn()
            return conn
        except Exception:
            self._slots.release()
            raise

    def putconn(self, conn, close: bool = False):
        try:
            self._pool.putconn(conn, close=close or bool(conn.closed))
        finally:
            self._slots.release()

    def closeall(self):
        self._pool.closeall()


_POOL: Optional[BlockingPool] = None
_pool_lock = threading.Lock()


def _get_pool() -> BlockingPool:
    global _POOL
    if _POOL is not None:
        return _POOL
    with _pool_lock:
        if _POOL is None:
            pg = load_config()["POSTGRES"]
            schemas = ",".join(dict.fromkeys([epod_schema(), rimdocs_schema(), "public"]))
            _POOL = BlockingPool(
                int(os.environ.get("PG_POOL_MIN", "1")),
                int(os.environ.get("PG_POOL_MAX", "20")),
                host=pg.get("host", "localhost"),
                port=pg.getint("port", 5432),
                dbname=pg.get("dbname"),
                user=pg.get("user"),
                password=pg.get("password"),
                sslmode=pg.get("sslmode", "prefer"),
                connect_timeout=10,
                application_name="rdi-monitoring",
                options=f"-c search_path={schemas} -c statement_timeout={STATEMENT_TIMEOUT_MS}",
                keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
            )
    return _POOL


def close_pool() -> None:
    global _POOL
    with _pool_lock:
        if _POOL is not None:
            _POOL.closeall()
            _POOL = None


@contextmanager
def db_conn():
    """Borrow a read-only autocommit connection. Autocommit matters: without
    it every SELECT leaves the session 'idle in transaction', pinning an old
    snapshot and blocking vacuum on the ingestion tables."""
    pool = _get_pool()
    conn = pool.getconn()
    broken = False
    try:
        if not conn.autocommit:
            conn.set_session(readonly=True, autocommit=True)
        yield conn
    except (psycopg2.OperationalError, psycopg2.InterfaceError):
        broken = True
        raise
    finally:
        pool.putconn(conn, close=broken)


@contextmanager
def db_cursor() -> Iterator[psycopg2.extras.RealDictCursor]:
    with db_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur


def db_healthy() -> bool:
    try:
        with db_cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            return cur.fetchone()["ok"] == 1
    except Exception:
        logger.exception("[DB] health check failed")
        return False


def db_unavailable(exc: Exception) -> HTTPException:
    logger.error("[DB] connection failed: %s", str(exc).strip().splitlines()[0] if str(exc).strip() else exc)
    return HTTPException(status_code=503, detail="Database unavailable")


# ============================================================================
# FORMATTING
# ============================================================================

def fmt_size(b) -> str:
    if b is None:
        return "N/A"
    b = float(b)
    for unit, factor in (("TB", 1024 ** 4), ("GB", 1024 ** 3), ("MB", 1024 ** 2), ("KB", 1024)):
        if b >= factor:
            return f"{b / factor:.2f} {unit}"
    return f"{b:.0f} B"


def fmt_duration(secs) -> str:
    if secs is None:
        return "N/A"
    secs = max(0, int(secs))
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    mins, secs = divmod(rem, 60)
    if days:
        return f"{days}d {hours}h {mins}m"
    if hours:
        return f"{hours}h {mins}m {secs}s"
    if mins:
        return f"{mins}m {secs}s"
    return f"{secs}s"


def to_aware(val) -> Optional[datetime]:
    if val is None:
        return None
    if isinstance(val, str):
        val = datetime.fromisoformat(val)
    if val.tzinfo is None:
        val = val.replace(tzinfo=NAIVE_DB_TZ)
    return val


def fmt_ts(val) -> str:
    ts = to_aware(val)
    return ts.astimezone(DISPLAY_TZ).strftime("%Y-%m-%d %H:%M:%S %Z") if ts else "N/A"


def iso(val) -> Optional[str]:
    ts = to_aware(val)
    return ts.astimezone(timezone.utc).isoformat() if ts else None


def minutes_since(val) -> Optional[int]:
    ts = to_aware(val)
    if not ts:
        return None
    mins = int((datetime.now(timezone.utc) - ts).total_seconds() // 60)
    return mins if mins >= 0 else None


def time_ago(val) -> str:
    ts = to_aware(val)
    if not ts:
        return ""
    secs = int((datetime.now(timezone.utc) - ts).total_seconds())
    if secs < 0:
        return ""
    if secs < 60:
        return f"{secs}s ago"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m ago"
    hours, rem = divmod(mins, 60)
    if hours < 24:
        return f"{hours}h {rem}m ago" if rem else f"{hours}h ago"
    days, rem_h = divmod(hours, 24)
    return f"{days}d {rem_h}h ago" if rem_h else f"{days}d ago"


def _first_line(exc: Exception) -> str:
    text = str(exc).strip()
    return text.splitlines()[0] if text else exc.__class__.__name__


# ============================================================================
# INGESTION STATS ENGINE (shared by EPOD and RIMDOCS)
# ============================================================================

_STATS_SQL = """
    SELECT
        COUNT(*)                                                 AS total,
        COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS')        AS success,
        COUNT(*) FILTER (WHERE UPPER(status) = 'ERROR')          AS error,
        COUNT(*) FILTER (WHERE UPPER(status) = 'RUNNING')        AS running,
        SUM(file_size)                                           AS total_size,
        SUM(file_size) FILTER (WHERE UPPER(status) = 'SUCCESS')  AS ingested_size,
        SUM(file_size) FILTER (WHERE UPPER(status) = 'RUNNING')  AS remaining_size,
        SUM(file_size) FILTER (WHERE UPPER(status) = 'ERROR')    AS error_size,
        MAX(file_size) FILTER (WHERE UPPER(status) = 'SUCCESS')  AS largest_ingested,
        MIN(ingested_at)                                         AS started_at,
        MAX(updated_at)                                          AS completed_at
    FROM {table}
"""


def _num(v) -> float:
    return float(v) if v is not None else 0.0


def table_stats(cur, table: str, schema: str) -> Tuple[Dict, Dict, Dict]:
    cur.execute(sql.SQL(_STATS_SQL).format(table=table_identifier(table, schema)))
    row = cur.fetchone()
    total_bytes = row["total_size"]
    ingested = _num(row["ingested_size"])
    started, updated = to_aware(row["started_at"]), to_aware(row["completed_at"])
    duration = (updated - started).total_seconds() if started and updated else None

    counts = {k: int(row[k] or 0) for k in ("total", "success", "error", "running")}
    sizes = {
        "total_size": fmt_size(total_bytes),
        "ingested_size": fmt_size(ingested),
        "remaining_size": fmt_size(row["remaining_size"]),
        "error_size": fmt_size(row["error_size"]),
        "largest_ingested": fmt_size(row["largest_ingested"]),
        "pct_ingested": round(ingested / float(total_bytes), 4) if total_bytes and float(total_bytes) > 0 else 0,
        "total_size_bytes": _num(total_bytes),
        "ingested_size_bytes": ingested,
        "remaining_size_bytes": _num(row["remaining_size"]),
        "error_size_bytes": _num(row["error_size"]),
        "largest_ingested_bytes": _num(row["largest_ingested"]),
    }
    timeline = {
        "started_at": fmt_ts(started),
        "completed_at": fmt_ts(updated),
        "started_at_iso": iso(started),
        "completed_at_iso": iso(updated),
        "duration": fmt_duration(duration),
        "duration_secs": duration,
        "started_ago": time_ago(started),
        "updated_ago": time_ago(updated),
        "_updated": updated,
    }
    return counts, sizes, timeline


def stall_info(info: Dict, counts: Dict, timeline: Dict) -> Optional[Dict]:
    if counts.get("running", 0) <= 0:
        return None
    mins = minutes_since(timeline.get("_updated"))
    if mins is None or mins < STALL_THRESHOLD_MINS:
        return None
    hrs, rem = divmod(mins, 60)
    return {
        "label": info["label"],
        "color": info["color"],
        "running": counts["running"],
        "last_updated": timeline["completed_at"],
        "ago": timeline["updated_ago"],
        "duration_str": f"{hrs}h {rem}m" if hrs else f"{rem}m",
        "mins_since": mins,
    }


def _empty_row(info: Dict, status: str, message: str) -> Dict:
    return {
        "label": info["label"], "table": info["table"], "color": info["color"],
        "status": status, "error": message,
        "counts": {"total": 0, "success": 0, "error": 0, "running": 0},
        "sizes": {
            "total_size": "N/A", "ingested_size": "N/A", "remaining_size": "N/A", "error_size": "N/A",
            "largest_ingested": "N/A", "pct_ingested": 0, "total_size_bytes": 0, "ingested_size_bytes": 0,
            "remaining_size_bytes": 0, "error_size_bytes": 0, "largest_ingested_bytes": 0,
        },
        "timeline": {
            "started_at": "N/A", "completed_at": "N/A", "started_at_iso": None, "completed_at_iso": None,
            "duration": "N/A", "duration_secs": None, "started_ago": "", "updated_ago": "",
        },
        "stall": None,
    }


def fetch_table_row(info: Dict, schema: str, product: str) -> Dict:
    try:
        with db_cursor() as cur:
            counts, sizes, timeline = table_stats(cur, info["table"], schema)
    except psycopg2.errors.UndefinedTable:
        return _empty_row(info, "not_started", "Ingestion not started")
    except (psycopg2.OperationalError, psycopg2.InterfaceError) as exc:
        logger.error("[%s] DB connection failed for %s: %s", product, info["table"], _first_line(exc))
        return _empty_row(info, "error", "Database unavailable")
    except HTTPException as exc:
        return _empty_row(info, "error", exc.detail)
    except psycopg2.Error as exc:
        logger.warning("[%s] Query failed for %s: %s", product, info["table"], _first_line(exc))
        return _empty_row(info, "error", "Query failed — check the table definition")
    row = {
        "label": info["label"], "table": info["table"], "color": info["color"],
        "status": "ok", "error": None,
        "counts": counts, "sizes": sizes,
        "stall": stall_info(info, counts, timeline),
        "timeline": {k: v for k, v in timeline.items() if not k.startswith("_")},
    }
    return row


def aggregate(results: List[Dict]) -> Dict:
    chart_bar = [
        {"table": r["label"], "status": s, "count": r["counts"][s.lower()]}
        for r in results for s in ("Success", "Error", "Running")
    ]
    sums = {k: sum(r["counts"][k] for r in results) for k in ("total", "success", "error", "running")}
    total_bytes = sum(r["sizes"].get("total_size_bytes") or 0 for r in results)
    ingested_bytes = sum(r["sizes"].get("ingested_size_bytes") or 0 for r in results)
    return {
        "chart_bar": chart_bar,
        "chart_donut": {k: sums[k] for k in ("success", "error", "running")},
        "kpis": {
            "total_docs": sums["total"],
            "success": sums["success"],
            "error": sums["error"],
            "running": sums["running"],
            "success_pct": round(sums["success"] / sums["total"] * 100, 1) if sums["total"] else 0,
            "total_bytes": total_bytes,
            "ingested_bytes": ingested_bytes,
            "total_size": fmt_size(total_bytes),
            "ingested_size": fmt_size(ingested_bytes),
            "total_gb": round(total_bytes / 1e9, 2),
        },
    }


def parallel(tables: List[Dict], fn: Callable[[Dict], Dict]) -> Iterator[Dict]:
    workers = max(1, min(len(tables), int(os.getenv("STATS_PARALLELISM", "8"))))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="stats") as pool:
        futures = [pool.submit(fn, info) for info in tables]
        for fut in as_completed(futures):
            yield fut.result()


def dashboard(tables: List[Dict], schema: str, product: str) -> Dict:
    order = {t["table"]: i for i, t in enumerate(tables)}
    results = sorted(parallel(tables, lambda i: fetch_table_row(i, schema, product)), key=lambda r: order[r["table"]])
    agg = aggregate(results)
    return {"tables": results, "stalls": [r["stall"] for r in results if r["stall"]], **agg}


def dashboard_stream(tables: List[Dict], schema: str, product: str) -> Iterator[str]:
    results = []
    yield json.dumps({"type": "meta", "data": {"table_count": len(tables)}}) + "\n"
    for row in parallel(tables, lambda i: fetch_table_row(i, schema, product)):
        results.append(row)
        yield json.dumps({"type": "table", "data": row}) + "\n"
    yield json.dumps({"type": "summary", "data": aggregate(results)}) + "\n"


def diagnose(configured: List[Dict], default_schema: str) -> Dict:
    with db_cursor() as cur:
        cur.execute("""
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name
        """)
        existing = [(r["table_schema"], r["table_name"]) for r in cur.fetchall()]
    exact = {f"{s}.{t}" for s, t in existing}
    lowered = {f"{s}.{t}".lower(): f"{s}.{t}" for s, t in existing}
    results = []
    for info in configured:
        name = qualify(info["table"], default_schema)
        found = name in exact
        ci = lowered.get(name.lower()) if not found else None
        results.append({
            "label": info["label"],
            "config_name": name,
            "exists": found,
            "schema": name.split(".")[0] if found else None,
            "ci_match": ci,
            "suggestion": f"Did you mean '{ci}'?" if ci else None,
        })
    return {
        "configured_tables": results,
        "all_db_tables": [{"schema": s, "table": t} for s, t in existing],
    }
