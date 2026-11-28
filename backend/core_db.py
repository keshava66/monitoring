"""The app's own PostgreSQL database: every table in one schema
(monitoring_core by default), the same way SmartHub keeps smarthub_core.

Audit log, per-user preferences and RBAC roles / assignments live here, so
several backend instances behind a load balancer share one state. The
ingestion data the dashboards read stays in the database configured in
config.ini [POSTGRES]; this one is only for the app's own records.

Usage:

    import core_db

    with core_db.transaction() as cur:
        cur.execute("SELECT * FROM audit_log WHERE id = %s", (log_id,))
        row = cur.fetchone()          # row["id"] or row[0]

Config (environment):
    MONITORING_DB_DSN                  libpq DSN or URL. Required.
    MONITORING_DB_SCHEMA               default monitoring_core
    MONITORING_DB_POOL_MAX             default 10 connections per process
    MONITORING_DB_STATEMENT_TIMEOUT_MS default 30000

Schema changes are SQL files in migrations/monitoring_core, applied in name
order on first use and recorded in schema_migrations. Every instance runs
them under one advisory lock, so a rolling deploy applies each file once.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

import psycopg2
import psycopg2.extras

from db_common import BlockingPool

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).parent / "migrations" / "monitoring_core"
_LOCK_KEY = 0x6D6F6E69  # advisory lock id for migrations ("moni")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise RuntimeError(f"{name} must be a whole number, got {raw!r}") from None
    if not low <= value <= high:
        raise RuntimeError(f"{name} must be between {low} and {high}, got {value}")
    return value


SCHEMA = (os.environ.get("MONITORING_DB_SCHEMA") or "monitoring_core").strip()
if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", SCHEMA):
    raise RuntimeError("MONITORING_DB_SCHEMA must be a lowercase SQL identifier")
POOL_MAX = _env_int("MONITORING_DB_POOL_MAX", 10, 1, 200)
STATEMENT_TIMEOUT_MS = _env_int("MONITORING_DB_STATEMENT_TIMEOUT_MS", 30000, 0, 3_600_000)


class DatabaseUnavailable(RuntimeError):
    """Not configured or unreachable; callers answer 503."""


_pool: Optional[BlockingPool] = None
_pool_lock = threading.Lock()
_migrated = False


def _dsn() -> str:
    dsn = (os.environ.get("MONITORING_DB_DSN") or "").strip()
    if not dsn:
        raise DatabaseUnavailable("MONITORING_DB_DSN is not set")
    return dsn


def _get_pool() -> BlockingPool:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                try:
                    _pool = BlockingPool(
                        1, POOL_MAX, dsn=_dsn(), connect_timeout=10, application_name="rdi-monitoring-core",
                        options=f"-c search_path={SCHEMA} -c statement_timeout={STATEMENT_TIMEOUT_MS} -c TimeZone=UTC",
                        keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
                    )
                except psycopg2.OperationalError as exc:
                    raise DatabaseUnavailable(str(exc).strip().splitlines()[0]) from exc
    return _pool


def close_pool() -> None:
    global _pool, _migrated
    with _pool_lock:
        if _pool is not None:
            _pool.closeall()
            _pool = None
        _migrated = False


@contextmanager
def _connection() -> Iterator[psycopg2.extensions.connection]:
    pool = _get_pool()
    conn = pool.getconn()
    broken = False
    try:
        yield conn
    except (psycopg2.OperationalError, psycopg2.InterfaceError):
        broken = True
        raise
    finally:
        if not broken and not conn.closed and conn.get_transaction_status() != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
            conn.rollback()
        pool.putconn(conn, close=broken)


@contextmanager
def transaction() -> Iterator[psycopg2.extras.DictCursor]:
    """One transaction: committed when the block ends, rolled back on error.
    Rows answer both row["column"] and row[0]."""
    migrate()
    with _connection() as conn:
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
                yield cur
            conn.commit()
        except BaseException:
            conn.rollback()
            raise


def migrate() -> None:
    """Create the schema and apply pending migrations, once per process."""
    global _migrated
    if _migrated:
        return
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(%s)", (_LOCK_KEY,))
            try:
                cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"')
                cur.execute(f'''CREATE TABLE IF NOT EXISTS "{SCHEMA}".schema_migrations (
                                    version    text PRIMARY KEY,
                                    checksum   text NOT NULL,
                                    applied_at timestamptz NOT NULL DEFAULT now())''')
                conn.commit()
                cur.execute(f'SELECT version, checksum FROM "{SCHEMA}".schema_migrations')
                applied = dict(cur.fetchall())
                for path in files:
                    sql = path.read_text(encoding="utf-8")
                    checksum = hashlib.sha256(sql.encode()).hexdigest()
                    if path.name in applied:
                        if applied[path.name] != checksum:
                            raise RuntimeError(f"Migration {path.name} changed after it was applied; add a new file instead")
                        continue
                    cur.execute(f'SET LOCAL search_path TO "{SCHEMA}"')
                    cur.execute(sql)
                    cur.execute(f'INSERT INTO "{SCHEMA}".schema_migrations (version, checksum) VALUES (%s, %s)',
                                (path.name, checksum))
                    conn.commit()
                    logger.info("[CORE DB] applied migration %s", path.name)
            except BaseException:
                conn.rollback()
                raise
            finally:
                cur.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_KEY,))
                conn.commit()
    _migrated = True


def healthy() -> bool:
    try:
        with transaction() as cur:
            cur.execute("SELECT 1")
            return cur.fetchone()[0] == 1
    except Exception:
        logger.exception("[CORE DB] health check failed")
        return False
