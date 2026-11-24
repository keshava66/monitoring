from __future__ import annotations

import logging
from typing import Dict, List

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

import db_common as dbc
from auth import get_current_user, require_admin

logger = logging.getLogger(__name__)

STALL_THRESHOLD_MINS = 30
DEFAULT_COLORS = ["#29B5E8", "#00cc96", "#ffa500", "#EF553B", "#a855f7", "#ec4899", "#14b8a6", "#f97316"]

# Every route on this router requires a valid, server-validated caller.
# (No more unauthenticated reads of pipeline data.)
epod_router = APIRouter(prefix="/api/epod", tags=["EPOD"], dependencies=[Depends(get_current_user)])


# ============================================================================
# CONFIG
# ============================================================================

def load_tables() -> List[Dict]:
    cfg = dbc.load_config()
    if not cfg.has_section("TABLES"):
        raise KeyError("[TABLES] section missing in config.ini.")
    schema = dbc.epod_schema()
    tables = []
    for idx, (key, raw) in enumerate(cfg["TABLES"].items()):
        parts = [p.strip() for p in raw.split("|")]
        tables.append({
            "key":   key,
            "table": dbc.qualify(parts[0], schema),
            "label": parts[1] if len(parts) > 1 else parts[0].replace("_", " ").title(),
            "color": parts[2] if len(parts) > 2 else DEFAULT_COLORS[idx % len(DEFAULT_COLORS)],
        })
    if not tables:
        raise ValueError("[TABLES] section is empty — add at least one table.")
    return tables


# ============================================================================
# QUERY HELPERS
# ============================================================================

def _status_counts(table: str, cur) -> Dict:
    cur.execute(f"""
        SELECT
            COUNT(*)                                           AS total,
            COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS') AS success,
            COUNT(*) FILTER (WHERE UPPER(status) = 'ERROR')   AS error,
            COUNT(*) FILTER (WHERE UPPER(status) = 'RUNNING') AS running
        FROM {table}
    """)
    row = cur.fetchone()
    return {
        "total":   int(row["total"]   or 0),
        "success": int(row["success"] or 0),
        "error":   int(row["error"]   or 0),
        "running": int(row["running"] or 0),
    }


def _size_stats(table: str, cur) -> Dict:
    cur.execute(f"""
        SELECT
            SUM(file_size)                                                AS total_size,
            SUM(file_size) FILTER (WHERE UPPER(status) = 'SUCCESS')      AS ingested_size,
            SUM(file_size) FILTER (WHERE UPPER(status) = 'RUNNING')      AS remaining_size,
            SUM(file_size) FILTER (WHERE UPPER(status) = 'ERROR')        AS error_size,
            MAX(file_size) FILTER (WHERE UPPER(status) = 'SUCCESS')      AS largest_ingested
        FROM {table}
    """)
    row     = cur.fetchone()
    total   = row["total_size"]
    ingested = row["ingested_size"] or 0
    pct = round(float(ingested) / float(total), 4) if total and float(total) > 0 else 0
    return {
        "total_size":        dbc.fmt_size(total),
        "ingested_size":     dbc.fmt_size(ingested),
        "remaining_size":    dbc.fmt_size(row["remaining_size"]),
        "error_size":        dbc.fmt_size(row["error_size"]),
        "largest_ingested":  dbc.fmt_size(row["largest_ingested"]),
        "pct_ingested":      pct,
    }


def _timeline(table: str, cur) -> Dict:
    cur.execute(f"""
        SELECT
            MIN(ingested_at)  AS started_at,
            MAX(updated_at)   AS completed_at,
            EXTRACT(EPOCH FROM (MAX(updated_at) - MIN(ingested_at))) AS duration_secs
        FROM {table}
    """)
    row      = cur.fetchone()
    started  = dbc.fmt_ts(row["started_at"])
    updated  = dbc.fmt_ts(row["completed_at"])
    duration = row["duration_secs"]
    return {
        "started_at":   started,
        "completed_at": updated,
        "duration":     dbc.fmt_duration(duration),
        "duration_secs": float(duration) if duration is not None else None,
        "started_ago":  dbc.time_ago(started),
        "updated_ago":  dbc.time_ago(updated),
    }


# ============================================================================
# ENDPOINTS
# ============================================================================

@epod_router.get("/tables")
def get_table_list():
    """Return table definitions from config.ini."""
    try:
        return {"tables": load_tables()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@epod_router.get("/dashboard")
def get_dashboard():
    """
    Return all data needed for the EPOD Stats page in a single call:
      - Per-table counts, sizes, and timeline
      - Stall alerts
      - Chart-ready aggregates
    """
    try:
        tables = load_tables()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Config error: {e}")

    results = []
    stalls  = []

    try:
        with dbc.db_conn() as conn:
            for info in tables:
                # Each table gets its own cursor + rollback on failure so one
                # bad table never aborts the transaction for the rest.
                try:
                    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                        counts   = _status_counts(info["table"], cur)
                        sizes    = _size_stats(info["table"],    cur)
                        timeline = _timeline(info["table"],       cur)

                    results.append({
                        "label":    info["label"],
                        "table":    info["table"],
                        "color":    info["color"],
                        "counts":   counts,
                        "sizes":    sizes,
                        "timeline": timeline,
                        "error":    None,
                    })

                    # Stall detection: RUNNING files + last update > threshold
                    running = counts.get("running", 0)
                    if running > 0:
                        last = timeline.get("completed_at", "N/A")
                        mins_since = dbc.minutes_since(last)
                        if mins_since is not None and mins_since >= STALL_THRESHOLD_MINS:
                            hrs, rem = divmod(mins_since, 60)
                            stalls.append({
                                "label":        info["label"],
                                "color":        info["color"],
                                "running":      running,
                                "last_updated": last,
                                "ago":          dbc.time_ago(last),
                                "duration_str": f"{hrs}h {rem}m" if hrs else f"{rem}m",
                                "mins_since":   mins_since,
                            })

                except Exception as table_err:
                    # Roll back so the connection is clean for the next table
                    conn.rollback()
                    err_msg = str(table_err).strip().splitlines()[0]
                    logger.warning(f"[EPOD] Skipping table '{info['table']}': {err_msg}")
                    results.append({
                        "label":    info["label"],
                        "table":    info["table"],
                        "color":    info["color"],
                        "error":    err_msg,
                        "counts":   {"total": 0, "success": 0, "error": 0, "running": 0},
                        "sizes":    {
                            "total_size": "N/A", "ingested_size": "N/A",
                            "remaining_size": "N/A", "error_size": "N/A",
                            "largest_ingested": "N/A", "pct_ingested": 0,
                        },
                        "timeline": {
                            "started_at": "N/A", "completed_at": "N/A",
                            "duration": "N/A", "duration_secs": None,
                            "started_ago": "", "updated_ago": "",
                        },
                    })

    except psycopg2.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {e}")
    except Exception as e:
        logger.exception("EPOD dashboard error")
        raise HTTPException(status_code=500, detail=str(e))

    # Chart aggregates
    chart_bar = [
        {"table": r["label"], "status": s, "count": r["counts"][s.lower()]}
        for r in results
        for s in ("Success", "Error", "Running")
    ]
    chart_donut = {
        "success": sum(r["counts"]["success"] for r in results),
        "error":   sum(r["counts"]["error"]   for r in results),
        "running": sum(r["counts"]["running"]  for r in results),
    }

    return JSONResponse(
        content={
            "tables":      results,
            "stalls":      stalls,
            "chart_bar":   chart_bar,
            "chart_donut": chart_donut,
        },
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma":        "no-cache",
        },
    )


@epod_router.get("/diagnose", dependencies=[Depends(require_admin)])
def diagnose_tables():
    """
    Compares config.ini table names against what actually exists in PostgreSQL.
    Admin-only: this leaks full DB schema and sample data.
    """
    try:
        configured = load_tables()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Config error: {e}")

    try:
        with dbc.db_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT table_schema, table_name
                    FROM information_schema.tables
                    WHERE table_type = 'BASE TABLE'
                      AND table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name
                """)
                existing = {r["table_name"]: r["table_schema"] for r in cur.fetchall()}

                results = []
                for info in configured:
                    table_name = info["table"]
                    found = table_name in existing
                    ci_match = next(
                        (t for t in existing if t.lower() == table_name.lower()),
                        None
                    )
                    results.append({
                        "label":        info["label"],
                        "config_name":  table_name,
                        "exists":       found,
                        "schema":       existing.get(table_name),
                        "ci_match":     ci_match if not found else None,
                        "suggestion":   f"Did you mean '{ci_match}'?" if ci_match and not found else None,
                    })

                return {
                    "configured_tables": results,
                    "all_db_tables": [
                        {"schema": s, "table": t}
                        for t, s in sorted(existing.items())
                    ],
                }
    except psycopg2.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {e}")