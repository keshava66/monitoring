"""One-time copy of the old local files into the app database (core_db).

    cd backend
    python migrate_to_postgres.py --dry-run     # read, convert, count, roll back
    python migrate_to_postgres.py               # do it

Reads, whichever exist:
    audit_log.db       audit log and per-user preferences (SQLite)
    rbac_config.json   custom roles and per-user role assignments

Everything lands in one transaction or not at all. Rows whose key is already
in the database are left alone, so running it twice copies nothing twice.
Old audit timestamps were ISO strings with their offset; a string without
one is read as DISPLAY_TIMEZONE. Stop the old backend first: anything it
writes while this runs is not copied.
"""
from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import psycopg2.extras
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

import core_db  # noqa: E402
import rbac  # noqa: E402
from audit import DISPLAY_TZ  # noqa: E402

log = logging.getLogger("migrate")


def _timestamp(raw: str) -> datetime:
    ts = datetime.fromisoformat(raw)
    return ts if ts.tzinfo else ts.replace(tzinfo=DISPLAY_TZ)


def copy_sqlite(cur, path: Path) -> dict:
    counts = {"audit_log": 0, "user_preferences": 0, "unreadable audit rows": 0}
    src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    try:
        tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "audit_log" in tables:
            rows = []
            for r in src.execute("SELECT id, timestamp, action, performed_by, target, details, ip_address FROM audit_log"):
                try:
                    rows.append((r["id"], _timestamp(r["timestamp"]), r["action"], r["performed_by"] or "unknown",
                                 r["target"] or "", r["details"] or "", r["ip_address"] or ""))
                except (TypeError, ValueError):
                    counts["unreadable audit rows"] += 1
                    log.warning("Skipping audit row %s: unreadable timestamp %r", r["id"], r["timestamp"])
            for i in range(0, len(rows), 1000):
                psycopg2.extras.execute_values(
                    cur,
                    'INSERT INTO audit_log (id, "timestamp", action, performed_by, target, details, ip_address) '
                    "VALUES %s ON CONFLICT (id) DO NOTHING",
                    rows[i:i + 1000],
                    page_size=1000,  # one statement per batch, so rowcount covers all of it
                )
                counts["audit_log"] += cur.rowcount
        if "user_preferences" in tables:
            for r in src.execute("SELECT email, preferences FROM user_preferences"):
                try:
                    prefs = json.loads(r["preferences"] or "{}")
                except ValueError:
                    prefs = {}
                cur.execute(
                    "INSERT INTO user_preferences (email, preferences) VALUES (%s, %s) ON CONFLICT (email) DO NOTHING",
                    (r["email"].lower(), psycopg2.extras.Json(prefs if isinstance(prefs, dict) else {})),
                )
                counts["user_preferences"] += cur.rowcount
    finally:
        src.close()
    return counts


def copy_rbac(cur, path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path} must contain a JSON object")
    counts = {"rbac_roles": 0, "rbac_user_roles": 0}
    for role_id, role in (data.get("custom_roles") or {}).items():
        cur.execute(
            "INSERT INTO rbac_roles (role_id, definition) VALUES (%s, %s) ON CONFLICT (role_id) DO NOTHING",
            (role_id, psycopg2.extras.Json(rbac._normalize_role(role))),
        )
        counts["rbac_roles"] += cur.rowcount
    for email, role_id in (data.get("user_role_overrides") or {}).items():
        cur.execute(
            "INSERT INTO rbac_user_roles (email, role_id) VALUES (%s, %s) ON CONFLICT (email) DO NOTHING",
            (email.strip().lower(), role_id),
        )
        counts["rbac_user_roles"] += cur.rowcount
    return counts


class _DryRun(Exception):
    pass


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--audit-db", type=Path, default=HERE / "audit_log.db")
    parser.add_argument("--rbac-json", type=Path, default=HERE / "rbac_config.json")
    parser.add_argument("--dry-run", action="store_true", help="convert and count, then roll back")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    sources = [p for p in (args.audit_db, args.rbac_json) if p.is_file()]
    if not sources:
        log.info("Nothing to copy: neither %s nor %s exists.", args.audit_db, args.rbac_json)
        return 0
    counts = {}
    try:
        with core_db.transaction() as cur:
            if args.audit_db.is_file():
                counts.update(copy_sqlite(cur, args.audit_db))
            if args.rbac_json.is_file():
                counts.update(copy_rbac(cur, args.rbac_json))
            if args.dry_run:
                raise _DryRun
    except _DryRun:
        pass
    verb = "Would copy" if args.dry_run else "Copied"
    for name, n in counts.items():
        log.info("%s %s: %d", "Skipped" if name.startswith("unreadable") else verb, name, n)
    if not args.dry_run:
        log.info("Done. Keep the old files until the app has been checked, then remove them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
