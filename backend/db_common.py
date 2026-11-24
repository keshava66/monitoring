from __future__ import annotations

import configparser
import logging
import os
from contextlib import contextmanager
from datetime import datetime
from typing import Dict, List

import pandas as pd
import psycopg2
import psycopg2.extras
import pytz
from psycopg2 import pool as pg_pool

logger = logging.getLogger(__name__)

EASTERN = pytz.timezone("America/New_York")

_CONFIG_CACHE: configparser.ConfigParser | None = None
_POOL: pg_pool.ThreadedConnectionPool | None = None


def _find_config() -> str:
    candidates = [
        os.environ.get("EPOD_CONFIG_PATH", ""),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "config.ini"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "config.ini"),
        os.path.join(os.getcwd(), "config", "config.ini"),
        os.path.join(os.getcwd(), "config.ini"),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return ""


def load_config(force: bool = False) -> configparser.ConfigParser:
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None and not force:
        return _CONFIG_CACHE
    path = _find_config()
    if not path:
        raise FileNotFoundError(
            "config.ini not found. Set EPOD_CONFIG_PATH env var or place it at config/config.ini."
        )
    cfg = configparser.ConfigParser()
    cfg.read(path)
    if not cfg.has_section("POSTGRES"):
        raise KeyError(f"[POSTGRES] section missing in {path}.")
    _CONFIG_CACHE = cfg
    return cfg


def epod_schema() -> str:
    return load_config()["POSTGRES"].get("schema", "public").strip()


def rimdocs_schema() -> str:
    # Falls back to the EPOD schema if not set separately, so a single-schema
    # config.ini (both products in the same schema) still works unchanged.
    cfg = load_config()["POSTGRES"]
    return cfg.get("rimdocs_schema", cfg.get("schema", "public")).strip()


def qualify(table: str, schema: str) -> str:
    """Prefix a config.ini table name with its product's schema, unless the
    config already spelled it out as schema.table itself."""
    return table if "." in table else f"{schema}.{table}"


def _get_pool() -> pg_pool.ThreadedConnectionPool:
    global _POOL
    if _POOL is not None:
        return _POOL
    cfg = load_config()["POSTGRES"]
    minconn = int(os.environ.get("PG_POOL_MIN", "2"))
    maxconn = int(os.environ.get("PG_POOL_MAX", "20"))
    _POOL = pg_pool.ThreadedConnectionPool(
        minconn, maxconn,
        host=cfg.get("host", "localhost"),
        port=cfg.getint("port", 5432),
        dbname=cfg.get("dbname"),
        user=cfg.get("user"),
        password=cfg.get("password"),
        options=f"-c search_path={epod_schema()},{rimdocs_schema()}",
        connect_timeout=10,
    )
    return _POOL


@contextmanager
def db_conn():
    """Borrow a pooled connection instead of opening a fresh TCP/TLS
    handshake to Postgres on every single request/table."""
    pool = _get_pool()
    conn = pool.getconn()
    try:
        yield conn
    finally:
        # Bad connections (e.g. left mid-transaction after an error the
        # caller didn't roll back) get closed instead of recycled.
        if conn.closed:
            pool.putconn(conn, close=True)
        else:
            pool.putconn(conn)


# ============================================================================
# FORMATTING HELPERS
# ============================================================================

def fmt_size(b) -> str:
    if b is None:
        return "N/A"
    b = float(b)
    if b >= 1_073_741_824:
        return f"{b / 1_073_741_824:.2f} GB"
    if b >= 1_048_576:
        return f"{b / 1_048_576:.2f} MB"
    if b >= 1_024:
        return f"{b / 1_024:.2f} KB"
    return f"{b:.0f} B"


def fmt_duration(secs) -> str:
    if secs is None:
        return "N/A"
    secs = int(secs)
    days,  rem  = divmod(secs, 86400)
    hours, rem  = divmod(rem,  3600)
    mins,  secs = divmod(rem,  60)
    if days:
        return f"{days}d {hours}h {mins}m"
    if hours:
        return f"{hours}h {mins}m {secs}s"
    if mins:
        return f"{mins}m {secs}s"
    return f"{secs}s"


def fmt_ts(val) -> str:
    """Returns a timezone-aware Eastern string for display."""
    if val is None:
        return "N/A"
    ts = pd.to_datetime(val, utc=True).tz_convert(EASTERN)
    return ts.strftime("%Y-%m-%d %H:%M:%S %Z")


def _parse_eastern(ts_str: str):
    """Parse the string fmt_ts produces back into a tz-aware Eastern
    datetime. Fixed version of the old bug: this stays timezone-aware
    all the way through instead of being compared against a naive
    datetime.now() (which is wrong on any server not itself running in
    the America/New_York timezone)."""
    clean = ts_str.rsplit(" ", 1)[0] if ts_str.count(" ") >= 2 else ts_str
    naive = datetime.strptime(clean, "%Y-%m-%d %H:%M:%S")
    return EASTERN.localize(naive)


def time_ago(ts_str: str) -> str:
    if not ts_str or ts_str == "N/A":
        return ""
    try:
        ts = _parse_eastern(ts_str)
        now = datetime.now(EASTERN)
        secs = int((now - ts).total_seconds())
        if secs < 0:
            return ""
        if secs < 60:
            return f"{secs}s ago"
        mins = secs // 60
        if mins < 60:
            return f"{mins}m ago"
        hours = mins // 60
        rem   = mins % 60
        if hours < 24:
            return f"{hours}h {rem}m ago" if rem else f"{hours}h ago"
        days  = hours // 24
        rem_h = hours % 24
        return f"{days}d {rem_h}h ago" if rem_h else f"{days}d ago"
    except Exception:
        return ""


def minutes_since(ts_str: str):
    """Timezone-safe replacement for the old inline mins_since blocks
    in epod.py/rimdocs.py's stall detection."""
    if not ts_str or ts_str == "N/A":
        return None
    try:
        ts = _parse_eastern(ts_str)
        now = datetime.now(EASTERN)
        mins = int((now - ts).total_seconds() / 60)
        return mins if mins >= 0 else None
    except Exception:
        return None