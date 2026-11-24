"""EPOD NAS archive scanner views over folder_progress / file_data.

Configurable through an optional [NAS] section in config.ini:
    base_prefix   = \\\\jnj.com\\grausdfsroot\\ERIS\\EPOD\\Archive\\eCTD
    schema        = epod1
    folder_table  = folder_progress
    file_table    = file_data
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

import psycopg2
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from psycopg2 import sql

import db_common as dbc
from auth import require_admin, require_permission

logger = logging.getLogger(__name__)

nas_router = APIRouter(prefix="/api/nas", tags=["NAS Scanner"], dependencies=[Depends(require_permission("viewNasScanner"))])

DEFAULT_BASE_PREFIX = r"\\jnj.com\grausdfsroot\ERIS\EPOD\Archive\eCTD"
_ESC = "!"


def _like_escape(text: str) -> str:
    return text.replace(_ESC, _ESC * 2).replace("%", _ESC + "%").replace("_", _ESC + "_")


def _settings() -> Dict:
    cfg = dbc.load_config()
    nas = cfg["NAS"] if cfg.has_section("NAS") else {}
    schema = (nas.get("schema") or "epod1").strip()
    return {
        "base_prefix": (nas.get("base_prefix") or DEFAULT_BASE_PREFIX).strip().rstrip("\\"),
        "folders": dbc.table_identifier((nas.get("folder_table") or "folder_progress").strip(), schema),
        "files": dbc.table_identifier((nas.get("file_table") or "file_data").strip(), schema),
    }


def _patterns(base: str) -> Dict[str, str]:
    escaped = _like_escape(base)
    # Direct children of base only: "<base>\X" but not "<base>\X\Y".
    return {"top": escaped + "\\%", "deep": escaped + "\\%\\%"}


def _segment_where(base: str, search: Optional[str]):
    pats = _patterns(base)
    clause = sql.SQL("folder_path LIKE %s ESCAPE '!' AND folder_path NOT LIKE %s ESCAPE '!'")
    params: List = [pats["top"], pats["deep"]]
    if search:
        clause = clause + sql.SQL(" AND folder_path ILIKE %s ESCAPE '!'")
        params.append(_like_escape(base) + "\\%" + _like_escape(search) + "%")
    return clause, params


def _ts(value) -> Optional[str]:
    if value is None:
        return None
    return dbc.fmt_ts(value) if hasattr(value, "hour") else str(value)


def _short_label(path: str) -> str:
    return path.split("\\")[-1] if "\\" in path else path


def _run(fn):
    try:
        return fn()
    except psycopg2.OperationalError as exc:
        raise dbc.db_unavailable(exc)
    except psycopg2.errors.UndefinedTable:
        raise HTTPException(status_code=404, detail="NAS scanner tables not found")
    except psycopg2.Error as exc:
        logger.exception("[NAS] query failed")
        raise HTTPException(status_code=500, detail="NAS query failed") from exc


@nas_router.get("/overview")
def get_nas_overview(search: Optional[str] = Query(None, max_length=200), top_n: int = Query(50, ge=1, le=500)):
    s = _settings()
    where, params = _segment_where(s["base_prefix"], search.strip() if search else None)

    def q():
        with dbc.db_cursor() as cur:
            cur.execute(sql.SQL("""
                SELECT folder_path,
                       COALESCE(total_files, 0)            AS total_files,
                       COALESCE(pdf_files, 0)              AS pdf_files,
                       COALESCE(xml_files, 0)              AS xml_files,
                       COALESCE(other_files, 0)            AS other_files,
                       COALESCE(total_size_mb, 0)::float8  AS total_bytes,
                       COALESCE(pdf_size_mb, 0)::float8    AS pdf_bytes,
                       COALESCE(xml_size_mb, 0)::float8    AS xml_bytes,
                       COALESCE(other_size_mb, 0)::float8  AS other_bytes,
                       last_modified
                FROM {t} WHERE {w}
                ORDER BY total_size_mb DESC NULLS LAST
                LIMIT %s
            """).format(t=s["folders"], w=where), params + [top_n])
            rows = cur.fetchall()
            cur.execute(sql.SQL("""
                SELECT COUNT(*)                                AS segments,
                       COALESCE(SUM(total_files), 0)           AS total_files,
                       COALESCE(SUM(pdf_files), 0)             AS pdf_files,
                       COALESCE(SUM(xml_files), 0)             AS xml_files,
                       COALESCE(SUM(other_files), 0)           AS other_files,
                       COALESCE(SUM(total_size_mb), 0)::float8 AS total_bytes,
                       COALESCE(SUM(pdf_size_mb), 0)::float8   AS pdf_bytes,
                       COALESCE(SUM(xml_size_mb), 0)::float8   AS xml_bytes,
                       COALESCE(SUM(other_size_mb), 0)::float8 AS other_bytes
                FROM {t} WHERE {w}
            """).format(t=s["folders"], w=where), params)
            return rows, cur.fetchone()

    rows, agg = _run(q)
    segments = [{
        "segment": _short_label(r["folder_path"]),
        "folder_path": r["folder_path"],
        **{k: int(r[k]) for k in ("total_files", "pdf_files", "xml_files", "other_files")},
        **{k: float(r[k]) for k in ("total_bytes", "pdf_bytes", "xml_bytes", "other_bytes")},
        "total_size": dbc.fmt_size(r["total_bytes"]),
        "pdf_size": dbc.fmt_size(r["pdf_bytes"]),
        "xml_size": dbc.fmt_size(r["xml_bytes"]),
        "other_size": dbc.fmt_size(r["other_bytes"]),
        "last_modified": _ts(r["last_modified"]),
    } for r in rows]
    kpis = {
        "segments": int(agg["segments"]),
        **{k: int(agg[k]) for k in ("total_files", "pdf_files", "xml_files", "other_files")},
        **{k: float(agg[k]) for k in ("total_bytes", "pdf_bytes", "xml_bytes", "other_bytes")},
        "total_size": dbc.fmt_size(agg["total_bytes"]),
        "pdf_size": dbc.fmt_size(agg["pdf_bytes"]),
        "xml_size": dbc.fmt_size(agg["xml_bytes"]),
        "other_size": dbc.fmt_size(agg["other_bytes"]),
    }
    return JSONResponse(content={"kpis": kpis, "segments": segments, "base_prefix": s["base_prefix"]}, headers=dbc.NO_STORE)


@nas_router.get("/largest-pdfs")
def get_largest_pdfs(top_n: int = Query(20, ge=1, le=100)):
    s = _settings()

    def q():
        with dbc.db_cursor() as cur:
            cur.execute(sql.SQL("""
                SELECT folder_path, file_name, COALESCE(file_size_mb, 0)::float8 AS size_bytes, last_modified
                FROM {t}
                WHERE file_name ILIKE %s
                ORDER BY file_size_mb DESC NULLS LAST
                LIMIT %s
            """).format(t=s["files"]), ["%.pdf", top_n])
            return cur.fetchall()

    rows = _run(q)
    prefix = s["base_prefix"]
    files = []
    for r in rows:
        fp = (r["folder_path"] or "").replace("/", "\\")
        rest = fp[len(prefix):].lstrip("\\") if fp.lower().startswith(prefix.lower()) else fp
        size = float(r["size_bytes"])
        files.append({
            "file_name": r["file_name"],
            "folder_path": r["folder_path"],
            "segment": rest.split("\\")[0] if rest else fp,
            "size_bytes": size,
            "size_fmt": dbc.fmt_size(size),
            "last_modified": _ts(r["last_modified"]),
        })
    return JSONResponse(content={"files": files}, headers=dbc.NO_STORE)


@nas_router.get("/trends")
def get_trends():
    s = _settings()
    where, params = _segment_where(s["base_prefix"], None)

    def q():
        with dbc.db_cursor() as cur:
            cur.execute(sql.SQL("""
                SELECT last_modified::date             AS day,
                       COUNT(*)                        AS folders_completed,
                       COALESCE(SUM(pdf_files), 0)     AS pdf,
                       COALESCE(SUM(xml_files), 0)     AS xml,
                       COALESCE(SUM(other_files), 0)   AS other
                FROM {t}
                WHERE last_modified IS NOT NULL AND {w}
                GROUP BY last_modified::date
                ORDER BY day
            """).format(t=s["folders"], w=where), params)
            return cur.fetchall()

    daily, cumulative = [], 0
    for r in _run(q):
        cumulative += int(r["folders_completed"])
        daily.append({
            "day": str(r["day"]),
            "folders_completed": int(r["folders_completed"]),
            "pdf": int(r["pdf"]), "xml": int(r["xml"]), "other": int(r["other"]),
            "cumulative": cumulative,
        })
    return JSONResponse(content={"daily": daily}, headers=dbc.NO_STORE)


@nas_router.get("/debug", dependencies=[Depends(require_admin)])
def debug_patterns():
    s = _settings()
    pats = _patterns(s["base_prefix"])

    def q():
        with dbc.db_cursor() as cur:
            cur.execute(sql.SQL("SELECT COUNT(*) AS n FROM {t}").format(t=s["folders"]))
            total = cur.fetchone()["n"]
            cur.execute(sql.SQL("SELECT COUNT(*) AS n FROM {t} WHERE folder_path LIKE %s ESCAPE '!'").format(t=s["folders"]), [pats["top"]])
            top = cur.fetchone()["n"]
            where, params = _segment_where(s["base_prefix"], None)
            cur.execute(sql.SQL("SELECT COUNT(*) AS n FROM {t} WHERE {w}").format(t=s["folders"], w=where), params)
            segs = cur.fetchone()["n"]
            cur.execute(sql.SQL("SELECT folder_path FROM {t} LIMIT 3").format(t=s["folders"]))
            return total, top, segs, [r["folder_path"] for r in cur.fetchall()]

    total, top, segs, samples = _run(q)
    return {
        "base_prefix": s["base_prefix"], "like_top": pats["top"], "like_not_deep": pats["deep"],
        "total_rows": total, "rows_under_prefix": top, "top_level_segments": segs, "sample_paths": samples,
    }
