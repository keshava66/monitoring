import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

# Minimal config so module-level config loading in epod/rimdocs doesn't
# blow up at import time — these routes never get far enough to touch it,
# but load_tables() is called lazily per-request so this just needs to exist.
_TEST_CFG_DIR = Path(__file__).parent / "_fixtures"
_TEST_CFG_DIR.mkdir(exist_ok=True)
_TEST_CFG = _TEST_CFG_DIR / "config.ini"
_TEST_CFG.write_text(
    "[POSTGRES]\nhost=localhost\nport=5432\ndbname=x\nuser=x\npassword=x\n\n"
    "[TABLES]\nt1 = some_table | Some Table\n\n"
    "[RIMDOCS_TABLES]\nr1 = ingestion_log_x | X\n"
)
os.environ.setdefault("EPOD_CONFIG_PATH", str(_TEST_CFG))
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost:5173")

import Backend  # noqa: E402

client = TestClient(Backend.app)

# Every one of these used to be reachable with zero authentication, or with
# just a spoofable X-User-Email / X-User-Role header. All of them must now
# come back 401 with no Authorization header at all.
UNAUTHENTICATED_MUST_401 = [
    ("GET",    "/api/epod/dashboard"),
    ("GET",    "/api/epod/tables"),
    ("GET",    "/api/epod/diagnose"),
    ("GET",    "/api/rimdocs/dashboard"),
    ("GET",    "/api/rimdocs/tables"),
    ("GET",    "/api/rimdocs/diagnose"),
    ("GET",    "/api/nas/overview"),
    ("GET",    "/api/nas/debug"),
    ("GET",    "/api/audit/logs"),
    ("GET",    "/api/audit/stats"),
    ("GET",    "/api/audit/active-users"),
    ("POST",   "/api/audit/log"),
    ("POST",   "/api/audit/heartbeat"),
    ("DELETE", "/api/audit/logs/some-id"),
    ("GET",    "/api/rbac/config"),
    ("POST",   "/api/rbac/roles"),
    ("POST",   "/api/rbac/user-assignments"),
]


@pytest.mark.parametrize("method,path", UNAUTHENTICATED_MUST_401)
def test_requires_authentication(method, path):
    resp = client.request(method, path, json={} if method == "POST" else None)
    assert resp.status_code == 401, f"{method} {path} returned {resp.status_code}, expected 401"


def test_spoofed_admin_header_no_longer_works():
    """The original bug: X-User-Role: admin used to be trusted outright."""
    resp = client.delete(
        "/api/audit/logs/some-id",
        headers={"X-User-Role": "admin", "X-User-Email": "attacker@evil.com"},
    )
    assert resp.status_code == 401


def test_health_still_open():
    """Health check is intentionally the one route with no auth."""
    resp = client.get("/health")
    assert resp.status_code == 200


def test_agent_proxy_requires_auth_before_leaking_config_state():
    """Must 401 even for an environment with no agent URL configured —
    auth is checked before that 503 branch, so an unauthenticated caller
    can't use the status code to map out which environments exist."""
    resp = client.get("/epod-dev/status")
    assert resp.status_code == 401