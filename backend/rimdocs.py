"""RIMDOCS ingestion stats (config.ini [RIMDOCS_TABLES]) plus the
'available' count sourced from each table's doc_chunks sibling."""
from __future__ import annotations

import json
import logging
from typing import Dict, List, Optional, Tuple

import psycopg2
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from psycopg2 import sql

import db_common as dbc
from auth import require_admin, require_permission

logger = logging.getLogger(__name__)

INGESTION_LOG_PREFIX = "ingestion_log"
DOC_CHUNKS_PREFIX = "doc_chunks"

rimdocs_router = APIRouter(
    prefix="/api/rimdocs", tags=["RIMDOCS"], dependencies=[Depends(require_permission("viewEPODStatsRIMDOCS"))]
)


def load_tables() -> List[Dict]:
    try:
        return dbc.load_table_section("RIMDOCS_TABLES", dbc.rimdocs_schema())
    except (FileNotFoundError, KeyError, ValueError) as exc:
        logger.error("[RIMDOCS] config error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Configuration error: {exc}")


def _doc_chunks_table(ingestion_table: str) -> str:
    schema, sep, table = ingestion_table.rpartition(".")
    suffix = table[len(INGESTION_LOG_PREFIX):] if table.startswith(INGESTION_LOG_PREFIX) else f"_{table}"
    chunks = f"{DOC_CHUNKS_PREFIX}{suffix}"
    return f"{schema}{sep}{chunks}" if sep else chunks


def _fetch_one_available(info: Dict) -> Tuple[str, Optional[int]]:
    chunks = _doc_chunks_table(info["table"])
    try:
        with dbc.db_cursor() as cur:
            cur.execute(
                sql.SQL("SELECT COUNT(DISTINCT doc_id) AS available FROM {}").format(
                    dbc.table_identifier(chunks, dbc.rimdocs_schema())
                )
            )
            return info["table"], int(cur.fetchone()["available"] or 0)
    except (psycopg2.Error, HTTPException, ValueError) as exc:
        logger.warning("[RIMDOCS] available count failed for %s: %s", chunks, str(exc).strip().splitlines()[0] if str(exc).strip() else exc)
        return info["table"], None


@rimdocs_router.get("/tables")
def get_table_list():
    return {"tables": load_tables()}


@rimdocs_router.get("/available-counts")
def get_available_counts():
    tables = load_tables()
    counts = dict(dbc.parallel(tables, _fetch_one_available))
    return JSONResponse(content={"available": counts}, headers=dbc.NO_STORE)


@rimdocs_router.get("/available-counts/stream")
def get_available_counts_stream():
    tables = load_tables()

    def gen():
        for table, count in dbc.parallel(tables, _fetch_one_available):
            yield json.dumps({"table": table, "available": count}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson", headers={**dbc.NO_STORE, "X-Accel-Buffering": "no"})


@rimdocs_router.get("/dashboard")
def get_rimdocs_dashboard():
    return JSONResponse(content=dbc.dashboard(load_tables(), dbc.rimdocs_schema(), "RIMDOCS"), headers=dbc.NO_STORE)


@rimdocs_router.get("/dashboard/stream")
def get_rimdocs_dashboard_stream():
    tables = load_tables()
    return StreamingResponse(
        dbc.dashboard_stream(tables, dbc.rimdocs_schema(), "RIMDOCS"),
        media_type="application/x-ndjson",
        headers={**dbc.NO_STORE, "X-Accel-Buffering": "no"},
    )


@rimdocs_router.get("/diagnose", dependencies=[Depends(require_admin)])
def diagnose_tables():
    try:
        return dbc.diagnose(load_tables(), dbc.rimdocs_schema())
    except psycopg2.OperationalError as exc:
        raise dbc.db_unavailable(exc)
