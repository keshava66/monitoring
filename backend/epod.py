"""EPOD ingestion stats (config.ini [TABLES])."""
from __future__ import annotations

import logging
from typing import Dict, List

import psycopg2
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

import db_common as dbc
from auth import require_admin, require_permission

logger = logging.getLogger(__name__)

epod_router = APIRouter(
    prefix="/api/epod", tags=["EPOD"], dependencies=[Depends(require_permission("viewEPODStatsEPOD"))]
)


def load_tables() -> List[Dict]:
    try:
        return dbc.load_table_section("TABLES", dbc.epod_schema())
    except (FileNotFoundError, KeyError, ValueError) as exc:
        logger.error("[EPOD] config error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Configuration error: {exc}")


@epod_router.get("/tables")
def get_table_list():
    return {"tables": load_tables()}


@epod_router.get("/dashboard")
def get_dashboard():
    return JSONResponse(content=dbc.dashboard(load_tables(), dbc.epod_schema(), "EPOD"), headers=dbc.NO_STORE)


@epod_router.get("/dashboard/stream")
def get_dashboard_stream():
    tables = load_tables()
    return StreamingResponse(
        dbc.dashboard_stream(tables, dbc.epod_schema(), "EPOD"),
        media_type="application/x-ndjson",
        headers={**dbc.NO_STORE, "X-Accel-Buffering": "no"},
    )


@epod_router.get("/diagnose", dependencies=[Depends(require_admin)])
def diagnose_tables():
    try:
        return dbc.diagnose(load_tables(), dbc.epod_schema())
    except psycopg2.OperationalError as exc:
        raise dbc.db_unavailable(exc)
