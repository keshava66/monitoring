from __future__ import annotations

import logging
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

import db_common as dbc
from auth import get_current_user, require_admin

logger = logging.getLogger(__name__)

nas_router = APIRouter(prefix="/api/nas", tags=["NAS Scanner"], dependencies=[Depends(get_current_user)])

BASE_PREFIX = r'\\jnj.com\grausdfsroot\ERIS\EPOD\Archive\eCTD'
_LIKE_TOP      = BASE_PREFIX + r'\%'
_LIKE_NOT_DEEP = BASE_PREFIX + r'\%\%'


def _short_label(path: str) -> str:
    return path.split("\\")[-1] if "\\" in path else path


@nas_router.get("/overview")
def get_nas_overview(
    search: Optional[str] = Query(None),
    top_n:  int           = Query(50, ge=1, le=500),
):
    try:
        with dbc.db_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:

                search_clause = ""
                search_params: list = []
                if search:
                    search_clause = "AND folder_path ILIKE %s ESCAPE ''"
                    search_params = [BASE_PREFIX + "\\" + "%" + search + "%"]

                cur.execute(f"""
                    SELECT
                        folder_path,
                        COALESCE(total_files,   0)          AS total_files,
                        COALESCE(pdf_files,     0)          AS pdf_files,
                        COALESCE(xml_files,     0)          AS xml_files,
                        COALESCE(other_files,   0)          AS other_files,
                        COALESCE(total_size_mb, 0)::float8  AS total_bytes,
                        COALESCE(pdf_size_mb,   0)::float8  AS pdf_bytes,
                        COALESCE(xml_size_mb,   0)::float8  AS xml_bytes,
                        COALESCE(other_size_mb, 0)::float8  AS other_bytes,
                        last_modified
                    FROM epod1.folder_progress
                    WHERE folder_path LIKE %s ESCAPE ''
                      AND folder_path NOT LIKE %s ESCAPE ''
                      {search_clause}
                    ORDER BY total_size_mb DESC NULLS LAST
                    LIMIT {int(top_n)}
                """, [_LIKE_TOP, _LIKE_NOT_DEEP] + search_params)
                rows = cur.fetchall()

                cur.execute(f"""
                    SELECT
                        COUNT(*)                                AS segments,
                        COALESCE(SUM(total_files),   0)         AS total_files,
                        COALESCE(SUM(pdf_files),     0)         AS pdf_files,
                        COALESCE(SUM(xml_files),     0)         AS xml_files,
                        COALESCE(SUM(other_files),   0)         AS other_files,
                        COALESCE(SUM(total_size_mb), 0)::float8 AS total_bytes,
                        COALESCE(SUM(pdf_size_mb),   0)::float8 AS pdf_bytes,
                        COALESCE(SUM(xml_size_mb),   0)::float8 AS xml_bytes,
                        COALESCE(SUM(other_size_mb), 0)::float8 AS other_bytes
                    FROM epod1.folder_progress
                    WHERE folder_path LIKE %s ESCAPE ''
                      AND folder_path NOT LIKE %s ESCAPE ''
                      {search_clause}
                """, [_LIKE_TOP, _LIKE_NOT_DEEP] + search_params)
                agg = cur.fetchone()

    except psycopg2.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {e}")
    except Exception as e:
        logger.exception("NAS overview error")
        raise HTTPException(status_code=500, detail=str(e))

    segments = [
        {
            "segment":       _short_label(r["folder_path"]),
            "folder_path":   r["folder_path"],
            "total_files":   int(r["total_files"]),
            "pdf_files":     int(r["pdf_files"]),
            "xml_files":     int(r["xml_files"]),
            "other_files":   int(r["other_files"]),
            "total_bytes":   float(r["total_bytes"]),
            "pdf_bytes":     float(r["pdf_bytes"]),
            "xml_bytes":     float(r["xml_bytes"]),
            "other_bytes":   float(r["other_bytes"]),
            "total_size":    dbc.fmt_size(r["total_bytes"]),
            "pdf_size":      dbc.fmt_size(r["pdf_bytes"]),
            "xml_size":      dbc.fmt_size(r["xml_bytes"]),
            "other_size":    dbc.fmt_size(r["other_bytes"]),
            "last_modified": str(r["last_modified"]) if r["last_modified"] else None,
        }
        for r in rows
    ]

    kpis = {
        "segments":    int(agg["segments"]),
        "total_files": int(agg["total_files"]),
        "pdf_files":   int(agg["pdf_files"]),
        "xml_files":   int(agg["xml_files"]),
        "other_files": int(agg["other_files"]),
        "total_bytes": float(agg["total_bytes"]),
        "pdf_bytes":   float(agg["pdf_bytes"]),
        "xml_bytes":   float(agg["xml_bytes"]),
        "other_bytes": float(agg["other_bytes"]),
        "total_size":  dbc.fmt_size(agg["total_bytes"]),
        "pdf_size":    dbc.fmt_size(agg["pdf_bytes"]),
        "xml_size":    dbc.fmt_size(agg["xml_bytes"]),
        "other_size":  dbc.fmt_size(agg["other_bytes"]),
    }

    return JSONResponse(
        content={"kpis": kpis, "segments": segments, "base_prefix": BASE_PREFIX},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


@nas_router.get("/largest-pdfs")
def get_largest_pdfs(top_n: int = Query(20, ge=1, le=100)):
    try:
        with dbc.db_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT
                        folder_path,
                        file_name,
                        COALESCE(file_size_mb, 0)::float8 AS size_bytes,
                        last_modified
                    FROM epod1.file_data
                    WHERE file_name ILIKE '%.pdf'
                    ORDER BY file_size_mb DESC NULLS LAST
                    LIMIT {int(top_n)}
                """)
                rows = cur.fetchall()

    except psycopg2.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {e}")
    except Exception as e:
        logger.exception("NAS largest-pdfs error")
        raise HTTPException(status_code=500, detail=str(e))

    prefix = BASE_PREFIX
    files = []
    for r in rows:
        fp      = (r["folder_path"] or "").replace("/", "\\")
        rest    = fp[len(prefix):].lstrip("\\") if fp.lower().startswith(prefix.lower()) else fp
        segment = rest.split("\\")[0] if rest else fp
        sz      = float(r["size_bytes"])
        files.append({
            "file_name":     r["file_name"],
            "folder_path":   r["folder_path"],
            "segment":       segment,
            "size_bytes":    sz,
            "size_fmt":      dbc.fmt_size(sz),
            "last_modified": str(r["last_modified"]) if r["last_modified"] else None,
        })

    return JSONResponse(
        content={"files": files},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


@nas_router.get("/trends")
def get_trends():
    try:
        with dbc.db_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT
                        last_modified::date              AS day,
                        COUNT(*)                         AS folders_completed,
                        COALESCE(SUM(pdf_files),   0)    AS pdf,
                        COALESCE(SUM(xml_files),   0)    AS xml,
                        COALESCE(SUM(other_files), 0)    AS other
                    FROM epod1.folder_progress
                    WHERE last_modified IS NOT NULL
                      AND folder_path LIKE %s ESCAPE ''
                      AND folder_path NOT LIKE %s ESCAPE ''
                    GROUP BY last_modified::date
                    ORDER BY day
                """, [_LIKE_TOP, _LIKE_NOT_DEEP])
                rows = cur.fetchall()

    except psycopg2.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {e}")
    except Exception as e:
        logger.exception("NAS trends error")
        raise HTTPException(status_code=500, detail=str(e))

    daily = []
    cumulative = 0
    for r in rows:
        cumulative += int(r["folders_completed"])
        daily.append({
            "day":               str(r["day"]),
            "folders_completed": int(r["folders_completed"]),
            "pdf":               int(r["pdf"]),
            "xml":               int(r["xml"]),
            "other":             int(r["other"]),
            "cumulative":        cumulative,
        })

    return JSONResponse(
        content={"daily": daily},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


@nas_router.get("/debug", dependencies=[Depends(require_admin)])
def debug_patterns():
    """Verify LIKE patterns and row counts. Admin-only: exposes sample DB rows."""
    try:
        with dbc.db_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT COUNT(*) AS total FROM epod1.folder_progress")
                total = cur.fetchone()["total"]

                cur.execute(
                    "SELECT COUNT(*) AS cnt FROM epod1.folder_progress WHERE folder_path LIKE %s ESCAPE ''",
                    [_LIKE_TOP]
                )
                top_count = cur.fetchone()["cnt"]

                cur.execute(
                    """SELECT COUNT(*) AS cnt FROM epod1.folder_progress
                       WHERE folder_path LIKE %s ESCAPE ''
                         AND folder_path NOT LIKE %s ESCAPE ''""",
                    [_LIKE_TOP, _LIKE_NOT_DEEP]
                )
                segment_count = cur.fetchone()["cnt"]

                cur.execute("SELECT folder_path FROM epod1.folder_progress LIMIT 3")
                samples = [r["folder_path"] for r in cur.fetchall()]

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "base_prefix":        BASE_PREFIX,
        "like_top":           _LIKE_TOP,
        "like_not_deep":      _LIKE_NOT_DEEP,
        "total_rows":         total,
        "rows_under_prefix":  top_count,
        "top_level_segments": segment_count,
        "sample_paths":       samples,
    }