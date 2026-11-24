from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

import db_common as dbc
from auth import get_current_user, require_admin

logger = logging.getLogger(__name__)

STALL_THRESHOLD_MINS = 30
DEFAULT_COLORS = ["#29B5E8", "#00cc96", "#ffa500", "#EF553B", "#a855f7", "#ec4899", "#14b8a6", "#f97316"]

rimdocs_router = APIRouter(prefix="/api/rimdocs", tags=["RIMDOCS"], dependencies=[Depends(get_current_user)])


# ============================================================================
# CONFIG
# ============================================================================

def load_tables() -> List[Dict]:
    cfg = dbc.load_config()
    if not cfg.has_section("RIMDOCS_TABLES"):
        raise KeyError("[RIMDOCS_TABLES] section missing in config.ini.")
    schema = dbc.rimdocs_schema()
    tables = []
    for idx, (key, raw) in enumerate(cfg["RIMDOCS_TABLES"].items()):
        parts = [p.strip() for p in raw.split("|")]
        tables.append({
            "key":   key,
            "table": dbc.qualify(parts[0], schema),
            "label": parts[1] if len(parts) > 1 else parts[0].replace("_", " ").title(),
            "color": parts[2] if len(parts) > 2 else DEFAULT_COLORS[idx % len(DEFAULT_COLORS)],
        })
    if not tables:
        raise ValueError("[RIMDOCS_TABLES] section is empty — add at least one table.")
    return tables


# ============================================================================
# QUERY HELPERS
# ============================================================================

def _table_stats(table: str, cur) -> Dict:
    cur.execute(f"""
        SELECT
            COUNT(*)                                                  AS total,
            COUNT(*) FILTER (WHERE UPPER(status) = 'SUCCESS')        AS success,
            COUNT(*) FILTER (WHERE UPPER(status) = 'ERROR')          AS error,
            COUNT(*) FILTER (WHERE UPPER(status) = 'RUNNING')        AS running,
            SUM(file_size)                                            AS total_size,
            SUM(file_size) FILTER (WHERE UPPER(status) = 'SUCCESS') AS ingested_size,
            SUM(file_size) FILTER (WHERE UPPER(status) = 'RUNNING') AS remaining_size,
            SUM(file_size) FILTER (WHERE UPPER(status) = 'ERROR')   AS error_size,
            MAX(file_size) FILTER (WHERE UPPER(status) = 'SUCCESS') AS largest_ingested,
            MIN(ingested_at)                                          AS started_at,
            MAX(updated_at)                                           AS completed_at,
            EXTRACT(EPOCH FROM (MAX(updated_at) - MIN(ingested_at)))  AS duration_secs
        FROM {table}
    """)
    row = cur.fetchone()

    total    = row["total_size"]
    ingested = row["ingested_size"] or 0
    pct      = round(float(ingested) / float(total), 4) if total and float(total) > 0 else 0

    counts = {
        "total":   int(row["total"]   or 0),
        "success": int(row["success"] or 0),
        "error":   int(row["error"]   or 0),
        "running": int(row["running"] or 0),
    }
    sizes = {
        "total_size":       dbc.fmt_size(total),
        "ingested_size":    dbc.fmt_size(ingested),
        "remaining_size":   dbc.fmt_size(row["remaining_size"]),
        "error_size":       dbc.fmt_size(row["error_size"]),
        "largest_ingested": dbc.fmt_size(row["largest_ingested"]),
        "pct_ingested":     pct,
        # Raw byte values too — formatted strings above can't be summed
        # across tables, the /dashboard KPI row needs these.
        "total_size_bytes": float(total) if total is not None else 0,
    }
    started  = dbc.fmt_ts(row["started_at"])
    updated  = dbc.fmt_ts(row["completed_at"])
    duration = row["duration_secs"]
    timeline = {
        "started_at":    started,
        "completed_at":  updated,
        "duration":      dbc.fmt_duration(duration),
        "duration_secs": float(duration) if duration is not None else None,
        "started_ago":   dbc.time_ago(started),
        "updated_ago":   dbc.time_ago(updated),
    }
    return counts, sizes, timeline


# ============================================================================
# AVAILABLE COUNT — sourced from a *different* table than the ingestion log.
# ============================================================================

INGESTION_LOG_PREFIX = "ingestion_log"
DOC_CHUNKS_PREFIX    = "doc_chunks"


def _doc_chunks_table(ingestion_table: str) -> str:
    # ingestion_table may now be schema-qualified (e.g. "rimdocs1.ingestion_log_x")
    # — do the prefix swap on the bare table name, then re-attach the schema,
    # so this still finds the right sibling table either way.
    schema, sep, table = ingestion_table.rpartition(".")
    if table.startswith(INGESTION_LOG_PREFIX):
        suffix = table[len(INGESTION_LOG_PREFIX):]
    else:
        suffix = f"_{table}"
    chunks_table = f"{DOC_CHUNKS_PREFIX}{suffix}"
    return f"{schema}{sep}{chunks_table}" if sep else chunks_table


def _available_count(ingestion_table: str, cur) -> int:
    chunks_table = _doc_chunks_table(ingestion_table)
    cur.execute(f"SELECT COUNT(DISTINCT doc_id) AS available FROM {chunks_table}")
    row = cur.fetchone()
    return int(row["available"] or 0)


# ============================================================================
# ENDPOINTS
# ============================================================================

@rimdocs_router.get("/tables")
def get_table_list():
    try:
        return {"tables": load_tables()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _fetch_one_available(info: Dict):
    try:
        with dbc.db_conn() as conn:
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    return info["table"], _available_count(info["table"], cur)
            except Exception as avail_err:
                conn.rollback()
                avail_msg = str(avail_err).strip().splitlines()[0]
                logger.warning(f"[RIMDOCS] Available count failed for '{info['table']}' "
                                f"(doc_chunks table missing/broken?): {avail_msg}")
                return info["table"], None
    except psycopg2.OperationalError:
        return info["table"], None


@rimdocs_router.get("/available-counts")
def get_available_counts():
    try:
        tables = load_tables()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Config error: {e}")

    try:
        counts = dict(_fetch_one_available(info) for info in tables)
    except psycopg2.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {e}")

    return JSONResponse(
        content={"available": counts},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


def _available_counts_stream_gen(tables: List[Dict]):
    max_workers = min(len(tables), 8) or 1
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(_fetch_one_available, info) for info in tables]
        for future in as_completed(futures):
            table_name, count = future.result()
            yield json.dumps({"table": table_name, "available": count}) + "\n"


@rimdocs_router.get("/available-counts/stream")
def get_available_counts_stream():
    try:
        tables = load_tables()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Config error: {e}")

    return StreamingResponse(
        _available_counts_stream_gen(tables),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


def _stall_info(info: Dict, counts: Dict, timeline: Dict):
    running = counts.get("running", 0)
    if running <= 0:
        return None
    last = timeline.get("completed_at", "N/A")
    mins_since = dbc.minutes_since(last)
    if mins_since is None or mins_since < STALL_THRESHOLD_MINS:
        return None
    hrs, rem = divmod(mins_since, 60)
    return {
        "label":        info["label"],
        "color":        info["color"],
        "running":      running,
        "last_updated": last,
        "ago":          dbc.time_ago(last),
        "duration_str": f"{hrs}h {rem}m" if hrs else f"{rem}m",
        "mins_since":   mins_since,
    }


def _error_row(info: Dict, err_msg: str) -> Dict:
    return {
        "label":    info["label"],
        "table":    info["table"],
        "color":    info["color"],
        "error":    err_msg,
        "counts":   {"total": 0, "success": 0, "error": 0, "running": 0, "available": None},
        "sizes":    {
            "total_size": "N/A", "ingested_size": "N/A",
            "remaining_size": "N/A", "error_size": "N/A",
            "largest_ingested": "N/A", "pct_ingested": 0,
            "total_size_bytes": 0,
        },
        "timeline": {
            "started_at": "N/A", "completed_at": "N/A",
            "duration": "N/A", "duration_secs": None,
            "started_ago": "", "updated_ago": "",
        },
        "stall": None,
    }


def _fetch_one_table_row(info: Dict) -> Dict:
    try:
        with dbc.db_conn() as conn:
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    counts, sizes, timeline = _table_stats(info["table"], cur)
                counts["available"] = None
                return {
                    "label":    info["label"],
                    "table":    info["table"],
                    "color":    info["color"],
                    "counts":   counts,
                    "sizes":    sizes,
                    "timeline": timeline,
                    "error":    None,
                    "stall":    _stall_info(info, counts, timeline),
                }
            except Exception as table_err:
                conn.rollback()
                err_msg = str(table_err).strip().splitlines()[0]
                logger.warning(f"[RIMDOCS] Skipping table '{info['table']}': {err_msg}")
                return _error_row(info, err_msg)
    except psycopg2.OperationalError as e:
        return _error_row(info, f"Database connection failed: {e}")


def _aggregate(results: List[Dict]) -> Dict:
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
    kpi_total   = sum(r["counts"]["total"]   for r in results)
    kpi_success = sum(r["counts"]["success"] for r in results)
    kpi_error   = sum(r["counts"]["error"]   for r in results)
    kpi_running = sum(r["counts"]["running"] for r in results)
    kpi_bytes   = sum(r["sizes"].get("total_size_bytes") or 0 for r in results)
    kpis = {
        "total_docs":  kpi_total,
        "success":     kpi_success,
        "error":       kpi_error,
        "running":     kpi_running,
        "success_pct": round(kpi_success / kpi_total * 100, 1) if kpi_total else 0,
        "total_gb":    round(kpi_bytes / 1e9, 2),
    }
    return {"chart_bar": chart_bar, "chart_donut": chart_donut, "kpis": kpis}


@rimdocs_router.get("/dashboard")
def get_rimdocs_dashboard():
    try:
        tables = load_tables()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Config error: {e}")

    try:
        results = [_fetch_one_table_row(info) for info in tables]
    except psycopg2.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {e}")
    except Exception as e:
        logger.exception("RIMDOCS dashboard error")
        raise HTTPException(status_code=500, detail=str(e))

    agg    = _aggregate(results)
    stalls = [r["stall"] for r in results if r.get("stall")]

    return JSONResponse(
        content={
            "tables":      results,
            "stalls":      stalls,
            "chart_bar":   agg["chart_bar"],
            "chart_donut": agg["chart_donut"],
            "kpis":        agg["kpis"],
        },
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma":        "no-cache",
        },
    )


def _dashboard_stream_gen(tables: List[Dict]):
    results = []
    max_workers = min(len(tables), 8) or 1
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_fetch_one_table_row, info): info for info in tables}
        for future in as_completed(futures):
            row = future.result()
            results.append(row)
            yield json.dumps({"type": "table", "data": row}) + "\n"

    yield json.dumps({"type": "summary", "data": _aggregate(results)}) + "\n"


@rimdocs_router.get("/dashboard/stream")
def get_rimdocs_dashboard_stream():
    try:
        tables = load_tables()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Config error: {e}")

    return StreamingResponse(
        _dashboard_stream_gen(tables),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma":        "no-cache",
        },
    )


@rimdocs_router.get("/diagnose", dependencies=[Depends(require_admin)])
def diagnose_tables():
    """Admin-only: leaks full DB schema and sample data."""
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
                        "label":       info["label"],
                        "config_name": table_name,
                        "exists":      found,
                        "schema":      existing.get(table_name),
                        "ci_match":    ci_match if not found else None,
                        "suggestion":  f"Did you mean '{ci_match}'?" if ci_match and not found else None,
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