"""Backend test suite.

Graph is faked at the HTTP transport layer; Postgres tests run against a real
server (TEST_PG_HOST / TEST_PG_PORT / TEST_PG_USER / TEST_PG_PASSWORD,
defaults: localhost:5432 postgres) and are skipped if it isn't reachable.
"""
import csv
import io
import json
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).parent))

_TMP = Path(tempfile.mkdtemp(prefix="monitoring-test-"))
PG = {
    "host": os.getenv("TEST_PG_HOST", "localhost"),
    "port": int(os.getenv("TEST_PG_PORT", "5432")),
    "user": os.getenv("TEST_PG_USER", "postgres"),
    "password": os.getenv("TEST_PG_PASSWORD", ""),
}
TEST_DB = f"monitoring_test_{uuid.uuid4().hex[:8]}"

(_TMP / "config.ini").write_text(
    "[POSTGRES]\n"
    f"host={PG['host']}\nport={PG['port']}\ndbname={TEST_DB}\nuser={PG['user']}\npassword={PG['password']}\n"
    "schema=epod1\nrimdocs_schema=rimdocs1\nsslmode=disable\n\n"
    "[TABLES]\n"
    "t1 = ingestion_log_alpha | Alpha | #112233\n"
    "t2 = ingestion_log_missing | Missing\n\n"
    "[RIMDOCS_TABLES]\n"
    "r1 = ingestion_log_x | X\n"
    "r2 = ingestion_log_y | Y\n\n"
    "[NAS]\nschema=epod1\n"
)
os.environ.update({
    "EPOD_CONFIG_PATH": str(_TMP / "config.ini"),
    "RBAC_CONFIG_PATH": str(_TMP / "rbac_config.json"),
    "AUDIT_DB_PATH": str(_TMP / "audit.db"),
    "ALLOWED_ORIGINS": "http://localhost:5173",
    "AD_GROUP_ADMIN": "GRP-ADMIN",
    "AD_GROUP_OPERATIONAL_SUPPORT": "GRP-OPS",
    "EPOD_AGENT_DEV_URL": "http://agent.test",
    "EPOD_AGENT_DEV_TOKEN": "agent-secret",
    "STALL_THRESHOLD_MINS": "30",
})

import auth  # noqa: E402
import Backend  # noqa: E402
import rbac  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

USERS = {
    "admin-token": {"mail": "admin@corp.com", "groups": [{"id": "g1", "displayName": "GRP-ADMIN"}]},
    "ops-token": {"mail": "ops@corp.com", "groups": [{"id": "g2", "displayName": "GRP-OPS"}]},
    "viewer-token": {"mail": "viewer@corp.com", "groups": []},
    "paged-token": {"mail": "paged@corp.com", "groups": "paged"},
    "nophoto-token": {"mail": "nophoto@corp.com", "groups": []},
}


def _graph_handler(request: httpx.Request) -> httpx.Response:
    token = request.headers.get("authorization", "")[7:]
    user = USERS.get(token)
    if not user:
        return httpx.Response(401, json={"error": {"code": "InvalidAuthenticationToken"}})
    path = request.url.path
    if path.endswith("/me"):
        return httpx.Response(200, json={"id": token, "displayName": user["mail"].split("@")[0].title(),
                                         "mail": user["mail"], "userPrincipalName": user["mail"]})
    if path.endswith("/me/memberOf"):
        if user["groups"] == "paged":
            if "page2" in str(request.url):
                return httpx.Response(200, json={"value": [{"id": "g1", "displayName": "GRP-ADMIN"}]})
            return httpx.Response(200, json={"value": [{"id": f"x{i}", "displayName": f"Other {i}"} for i in range(5)],
                                             "@odata.nextLink": "https://graph.test/v1.0/me/memberOf?page2=1"})
        return httpx.Response(200, json={"value": user["groups"]})
    if "photo" in path:
        if token == "nophoto-token":
            return httpx.Response(404)
        return httpx.Response(200, content=b"\x89PNG fake", headers={"content-type": "image/png"})
    return httpx.Response(404)


auth.graph_client = httpx.Client(transport=httpx.MockTransport(_graph_handler))
auth.GRAPH_BASE = "https://graph.test/v1.0"

AGENT_CALLS = []


def _agent_handler(request: httpx.Request) -> httpx.Response:
    AGENT_CALLS.append(request)
    if request.headers.get("authorization") != "Bearer agent-secret":
        return httpx.Response(401, json={"detail": "Invalid token"})
    if request.url.path in ("/status", "/running"):
        return httpx.Response(200, json={"running": True, "pid": 42})
    if request.url.path == "/info":
        return httpx.Response(200, json={"server_name": "EPOD Box"})
    if request.url.path == "/stop":
        return httpx.Response(200, json={"success": True})
    if request.url.path == "/terminal/stream":
        return httpx.Response(200, stream=httpx.ByteStream(b"data: hello\n\ndata: world\n\n"), headers={"content-type": "text/event-stream"})
    return httpx.Response(200, json={"path": request.url.path, "query": dict(request.url.params)})


Backend._agent_client = httpx.AsyncClient(transport=httpx.MockTransport(_agent_handler))
Backend._agent_read_client = httpx.AsyncClient(transport=httpx.MockTransport(_agent_handler))
Backend._agent_stream_client = httpx.AsyncClient(transport=httpx.MockTransport(_agent_handler))

client = TestClient(Backend.app)
client.__enter__()


def H(token):
    return {"Authorization": f"Bearer {token}"}


ADMIN, OPS, VIEWER = H("admin-token"), H("ops-token"), H("viewer-token")


# ============================================================================
# Postgres fixture
# ============================================================================

def _pg_available():
    try:
        psycopg2.connect(dbname="postgres", connect_timeout=3, **PG).close()
        return True
    except psycopg2.Error:
        return False


PG_OK = _pg_available()
needs_pg = pytest.mark.skipif(not PG_OK, reason="Postgres not reachable")


@pytest.fixture(scope="session", autouse=True)
def database():
    if not PG_OK:
        yield
        return
    admin = psycopg2.connect(dbname="postgres", **PG)
    admin.autocommit = True
    admin.cursor().execute(f'CREATE DATABASE "{TEST_DB}"')
    conn = psycopg2.connect(dbname=TEST_DB, **PG)
    conn.autocommit = True
    cur = conn.cursor()
    now = datetime.now(timezone.utc)
    cur.execute("CREATE SCHEMA epod1; CREATE SCHEMA rimdocs1;")
    for table in ("epod1.ingestion_log_alpha", "rimdocs1.ingestion_log_x", "rimdocs1.ingestion_log_y"):
        cur.execute(f"""CREATE TABLE {table} (id serial, status text, file_size bigint,
                        ingested_at timestamptz, updated_at timestamptz)""")
    rows = [("SUCCESS", 1000), ("SUCCESS", 3000), ("ERROR", 500), ("RUNNING", 250)]
    for status, size in rows:
        cur.execute("INSERT INTO epod1.ingestion_log_alpha (status,file_size,ingested_at,updated_at) VALUES (%s,%s,%s,%s)",
                    (status, size, now - timedelta(hours=5), now - timedelta(hours=2)))
    cur.execute("INSERT INTO rimdocs1.ingestion_log_x (status,file_size,ingested_at,updated_at) VALUES ('SUCCESS',2048,%s,%s)",
                (now - timedelta(minutes=10), now - timedelta(minutes=1)))
    cur.execute("INSERT INTO rimdocs1.ingestion_log_y (status,file_size,ingested_at,updated_at) VALUES ('RUNNING',10,%s,%s)",
                (now - timedelta(minutes=5), now - timedelta(minutes=2)))
    cur.execute("CREATE TABLE rimdocs1.doc_chunks_x (doc_id int)")
    cur.execute("INSERT INTO rimdocs1.doc_chunks_x VALUES (1),(1),(2)")
    base = r"\\jnj.com\grausdfsroot\ERIS\EPOD\Archive\eCTD"
    cur.execute("""CREATE TABLE epod1.folder_progress (folder_path text, total_files int, pdf_files int, xml_files int,
                   other_files int, total_size_mb bigint, pdf_size_mb bigint, xml_size_mb bigint, other_size_mb bigint,
                   last_modified timestamp)""")
    for name, size in (("SEG_A", 5000), ("SEG_B", 9000), ("SEG_100%", 10)):
        cur.execute("INSERT INTO epod1.folder_progress VALUES (%s,10,6,3,1,%s,%s,10,5,%s)",
                    (base + "\\" + name, size, size - 20, datetime(2026, 1, 2, 3, 4, 5)))
    cur.execute("INSERT INTO epod1.folder_progress VALUES (%s,1,1,0,0,1,1,0,0,NULL)", (base + "\\SEG_A\\deep",))
    cur.execute("CREATE TABLE epod1.file_data (folder_path text, file_name text, file_size_mb bigint, last_modified timestamp)")
    cur.execute("INSERT INTO epod1.file_data VALUES (%s,'big.pdf',99999,NULL),(%s,'small.PDF',5,NULL),(%s,'x.xml',1e9,NULL)",
                (base + "\\SEG_B\\sub", base + "\\SEG_A", base))
    conn.close()
    yield
    import db_common
    db_common.close_pool()
    cur = admin.cursor()
    cur.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
    admin.close()


# ============================================================================
# Authentication & authorisation
# ============================================================================

PROTECTED = [
    ("GET", "/api/epod/dashboard"), ("GET", "/api/epod/tables"), ("GET", "/api/epod/diagnose"),
    ("GET", "/api/rimdocs/dashboard"), ("GET", "/api/rimdocs/dashboard/stream"), ("GET", "/api/rimdocs/diagnose"),
    ("GET", "/api/nas/overview"), ("GET", "/api/nas/debug"),
    ("GET", "/api/audit/logs"), ("GET", "/api/audit/stats"), ("GET", "/api/audit/export"),
    ("GET", "/api/audit/active-users"), ("POST", "/api/audit/log"), ("POST", "/api/audit/heartbeat"),
    ("DELETE", "/api/audit/logs/some-id"),
    ("GET", "/api/rbac/config"), ("GET", "/api/rbac/me"), ("POST", "/api/rbac/roles"),
    ("POST", "/api/rbac/user-assignments"), ("GET", "/epod-dev/status"), ("GET", "/epod-qa/status"),
    ("GET", "/api/agents"), ("GET", "/auth/user"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
def test_requires_authentication(method, path):
    assert client.request(method, path, json={} if method == "POST" else None).status_code == 401


@pytest.mark.parametrize("method,path", PROTECTED)
def test_rejects_invalid_token(method, path):
    resp = client.request(method, path, headers=H("bogus"), json={} if method == "POST" else None)
    assert resp.status_code == 401


VIEWER_FORBIDDEN = [
    "/api/epod/dashboard", "/api/rimdocs/dashboard", "/api/nas/overview", "/api/audit/logs",
    "/api/audit/stats", "/api/audit/export", "/api/audit/active-users", "/api/audit/unique-users",
    "/api/rbac/config", "/epod-dev/status",
]


@pytest.mark.parametrize("path", VIEWER_FORBIDDEN)
def test_viewer_is_forbidden(path):
    assert client.get(path, headers=VIEWER).status_code == 403


def test_spoofed_admin_header_ignored():
    resp = client.delete("/api/audit/logs/x", headers={**VIEWER, "X-User-Role": "admin"})
    assert resp.status_code == 403


def test_health_and_security_headers():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["x-request-id"]


def test_rbac_me_roles():
    assert client.get("/api/rbac/me", headers=ADMIN).json()["role"] == "admin"
    assert client.get("/api/rbac/me", headers=OPS).json()["role"] == "operational_support"
    me = client.get("/api/rbac/me", headers=VIEWER).json()
    assert me["role"] == "viewer" and me["permissions"]["viewDashboard"] and not me["permissions"]["viewAudit"]


def test_group_membership_pagination():
    assert client.get("/api/rbac/me", headers=H("paged-token")).json()["role"] == "admin"


def test_graph_outage_returns_503(monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("down")
    auth._cache.clear()
    monkeypatch.setattr(auth.graph_client, "get", boom)
    assert client.get("/api/rbac/me", headers=ADMIN).status_code == 503
    monkeypatch.undo()
    auth._cache.clear()


def test_photo_proxy():
    resp = client.get("/auth/user/photo", headers=VIEWER)
    assert resp.status_code == 200 and resp.headers["content-type"] == "image/png"


def test_photo_missing_is_no_content():
    resp = client.get("/auth/user/photo", headers={"Authorization": "Bearer nophoto-token"})
    assert resp.status_code == 204 and not resp.content


# ============================================================================
# RBAC management
# ============================================================================

def _role(name="Analyst", **perms):
    return {"name": name, "description": "d", "color": "#123456", "permissions": perms}


def test_rbac_config_shape():
    cfg = client.get("/api/rbac/config", headers=ADMIN).json()["config"]
    assert set(cfg["builtin_role_ids"]) == {"admin", "operational_support", "viewer"}
    assert cfg["ad_group_roles"] == {"GRP-ADMIN": "admin", "GRP-OPS": "operational_support"}
    assert cfg["permission_catalog"][0]["key"] == "viewDashboard"


def test_role_lifecycle_and_assignment():
    body = {"role_id": "analyst", "role_definition": _role(viewDashboard=True, viewAudit=True)}
    assert client.post("/api/rbac/roles", headers=OPS, json=body).status_code == 403
    assert client.post("/api/rbac/roles", headers=ADMIN, json=body).status_code == 200
    assert client.post("/api/rbac/roles", headers=ADMIN, json=body).status_code == 409

    r = client.post("/api/rbac/user-assignments", headers=ADMIN, json={"user_email": "Viewer@Corp.com", "role_name": "analyst"})
    assert r.status_code == 200
    auth._cache.clear()
    me = client.get("/api/rbac/me", headers=VIEWER).json()
    assert me["role"] == "analyst" and me["permissions"]["viewAudit"]
    assert client.get("/api/audit/logs", headers=VIEWER).status_code == 200

    upd = client.put("/api/rbac/roles/analyst", headers=ADMIN, json={"role_definition": _role("Analyst 2", viewDashboard=True)})
    assert upd.status_code == 200
    assert client.get("/api/audit/logs", headers=VIEWER).status_code == 403

    assert client.delete("/api/rbac/roles/analyst", headers=ADMIN).json()["removed_assignments"] == ["viewer@corp.com"]
    assert client.get("/api/rbac/me", headers=VIEWER).json()["role"] == "viewer"

    logs = client.get("/api/audit/logs", headers=ADMIN, params={"search": "analyst"}).json()["logs"]
    actions = {l["action"] for l in logs}
    assert {"role_created", "role_assigned", "role_updated", "role_deleted"} <= actions
    updated = next(l for l in logs if l["action"] == "role_updated")
    assert "Audit Log disabled" in updated["details"]


@pytest.mark.parametrize("role_id,definition,status", [
    ("Bad ID", _role(), 422),
    ("ok_id", _role(name=""), 422),
    ("ok_id", {**_role(), "color": "red"}, 422),
    ("ok_id", _role(notAPermission=True), 422),
    ("admin", _role(), 409),
])
def test_role_validation(role_id, definition, status):
    resp = client.post("/api/rbac/roles", headers=ADMIN, json={"role_id": role_id, "role_definition": definition})
    assert resp.status_code == status


def test_admin_role_cannot_lock_itself_out():
    resp = client.put("/api/rbac/roles/admin", headers=ADMIN, json={"role_definition": _role("Admin", viewDashboard=True)})
    assert resp.status_code == 422


def test_builtin_override_and_reset():
    perms = dict(rbac.ROLE_DEFINITIONS["viewer"]["permissions"], viewNasScanner=True)
    assert client.put("/api/rbac/roles/viewer", headers=ADMIN, json={"role_definition": _role("Viewer", **perms)}).status_code == 200
    assert client.get("/api/rbac/me", headers=VIEWER).json()["permissions"]["viewNasScanner"]
    resp = client.delete("/api/rbac/roles/viewer", headers=ADMIN)
    assert resp.status_code == 200 and resp.json()["reset"]
    assert not client.get("/api/rbac/me", headers=VIEWER).json()["permissions"]["viewNasScanner"]


def test_child_permission_requires_parent():
    resp = client.post("/api/rbac/roles", headers=ADMIN, json={"role_id": "orphan", "role_definition": _role(manageUsers=True)})
    assert resp.status_code == 200 and resp.json()["role"]["permissions"]["manageUsers"] is False
    client.delete("/api/rbac/roles/orphan", headers=ADMIN)


def test_assignment_validation():
    assert client.post("/api/rbac/user-assignments", headers=ADMIN, json={"user_email": "nope", "role_name": "viewer"}).status_code == 422
    assert client.post("/api/rbac/user-assignments", headers=ADMIN, json={"user_email": "a@b.c", "role_name": "ghost"}).status_code == 422
    assert client.delete("/api/rbac/user-assignments/none@corp.com", headers=ADMIN).status_code == 404


def test_legacy_config_normalised(tmp_path):
    path = tmp_path / "rbac.json"
    path.write_text(json.dumps({"custom_roles": {"legacy": {"name": "Legacy", "permissions": {"viewServerManagerDev": True}}},
                                "user_role_overrides": {"MiXeD@corp.com": "legacy"}}))
    store = rbac.RBACStore(path)
    cfg = store.load()
    assert cfg["custom_roles"]["legacy"]["permissions"]["viewServerManager"] is True
    assert "mixed@corp.com" in cfg["user_role_overrides"]


# ============================================================================
# Audit
# ============================================================================

def test_audit_write_filter_export():
    assert client.post("/api/audit/log", headers=VIEWER, json={"action": "page_access", "target": "/x", "details": "=cmd()"}).status_code == 200
    assert client.post("/api/audit/log", headers=VIEWER, json={"action": "role_assigned"}).status_code == 403
    assert client.post("/api/audit/log", headers=VIEWER, json={"action": "Bad Action!"}).status_code == 422

    today = datetime.now(Backend.audit.DISPLAY_TZ).date().isoformat()
    page = client.get("/api/audit/logs", headers=ADMIN, params={"performed_by": "viewer@", "date_from": today, "date_to": today}).json()
    assert page["total"] >= 1 and page["logs"][0]["performed_by"] == "viewer@corp.com"
    assert client.get("/api/audit/logs", headers=ADMIN, params={"search": "%"}).json()["total"] == 0
    assert client.get("/api/audit/logs", headers=ADMIN, params={"date_from": "bad"}).status_code == 422

    export = client.get("/api/audit/export", headers=ADMIN, params={"action": "page_access"})
    assert export.status_code == 200 and "attachment" in export.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(export.text)))
    assert rows[0][0] == "id" and any(r[5] == "'=cmd()" for r in rows[1:])

    actions = {a["action"] for a in client.get("/api/audit/actions", headers=ADMIN).json()["actions"]}
    assert {"page_access", "audit_exported"} <= actions
    stats = client.get("/api/audit/stats", headers=ADMIN).json()
    assert stats["today"] >= 1 and stats["total"] >= stats["today"]


def test_audit_delete_admin_only():
    client.post("/api/audit/log", headers=OPS, json={"action": "page_access", "target": "delete-me"})
    log_id = client.get("/api/audit/logs", headers=ADMIN, params={"search": "delete-me"}).json()["logs"][0]["id"]
    assert client.delete(f"/api/audit/logs/{log_id}", headers=OPS).status_code == 403
    assert client.delete(f"/api/audit/logs/{log_id}", headers=ADMIN).status_code == 200
    assert client.delete(f"/api/audit/logs/{log_id}", headers=ADMIN).status_code == 404
    ids = client.get("/api/audit/logs/ids", headers=ADMIN, params={"action": "page_access"}).json()["ids"]
    resp = client.request("DELETE", "/api/audit/logs", headers=ADMIN, params={"silent": "true"}, json={"ids": ids})
    assert resp.json()["deleted"] == len(ids)


def test_heartbeat_and_active_users():
    client.post("/api/audit/heartbeat", headers=OPS)
    users = client.get("/api/audit/active-users", headers=ADMIN).json()
    assert any(u["email"] == "ops@corp.com" for u in users["users"])


def test_preferences_are_per_user_and_merge():
    assert client.get("/api/audit/preferences").status_code == 401
    assert client.get("/api/audit/preferences", headers=VIEWER).json() == {"preferences": {}}
    resp = client.put("/api/audit/preferences", headers=VIEWER, json={"reduce_motion": True})
    assert resp.status_code == 200 and resp.json()["preferences"]["reduce_motion"] is True
    # Omitted fields leave saved values alone; other people are unaffected.
    client.put("/api/audit/preferences", headers=VIEWER, json={})
    assert client.get("/api/audit/preferences", headers=VIEWER).json()["preferences"] == {"reduce_motion": True}
    assert client.get("/api/audit/preferences", headers=OPS).json()["preferences"] == {}
    assert client.put("/api/audit/preferences", headers=VIEWER, json={"reduce_motion": "sometimes"}).status_code == 422
    client.put("/api/audit/preferences", headers=VIEWER, json={"reduce_motion": False})
    assert client.get("/api/audit/preferences", headers=VIEWER).json()["preferences"]["reduce_motion"] is False


# ============================================================================
# Agent proxy
# ============================================================================

def test_agent_proxy_read_and_token_injection():
    AGENT_CALLS.clear()
    resp = client.get("/epod-dev/status", headers=OPS)
    assert resp.status_code == 200 and resp.json()["running"] is True
    assert AGENT_CALLS[-1].headers["authorization"] == "Bearer agent-secret"
    assert "cookie" not in AGENT_CALLS[-1].headers


def test_agent_proxy_query_filtered():
    resp = client.get("/epod-dev/logs?n=25&evil=1&from=10", headers=ADMIN).json()
    assert resp["query"] == {"n": "25", "from": "10"}


def test_agent_proxy_control_requires_permission():
    assert client.post("/epod-dev/stop", headers=OPS).status_code == 403
    assert client.post("/epod-dev/stop", headers=ADMIN).status_code == 200
    logs = client.get("/api/audit/logs", headers=ADMIN, params={"action": "pipeline_action"}).json()["logs"]
    assert logs and logs[0]["target"] == "epod-dev"


def test_agent_proxy_unknown_path_and_unconfigured():
    assert client.get("/epod-dev/admin/shell", headers=ADMIN).status_code == 404
    assert client.post("/epod-dev/status", headers=ADMIN).status_code == 404
    assert client.get("/epod-qa/status", headers=ADMIN).status_code == 503


def test_agent_proxy_stream():
    with client.stream("GET", "/epod-dev/terminal/stream", headers=ADMIN) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes())
    assert b"data: hello" in body


def test_agents_status_fans_out_and_respects_permissions():
    agents = client.get("/api/agents/status", headers=OPS).json()["agents"]
    assert agents == [{"id": "epod-dev", "state": "running", "name": "EPOD Box"}]
    assert client.get("/api/agents/status").status_code == 401
    assert client.get("/api/agents/status", headers=VIEWER).json()["agents"] == []


def test_agents_status_marks_unreachable(monkeypatch):
    async def down(*_a, **_k):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(Backend._agent_read_client, "get", down)
    assert client.get("/api/agents/status", headers=OPS).json()["agents"][0]["state"] == "unreachable"


def test_agent_copies_are_identical():
    root = Path(__file__).resolve().parent.parent
    master = (root / "windows_manage" / "epod_agent.py").read_bytes()
    for copy in ("rimdocs_agent/linux/RIMDocs_agent.py", "rimdocs_agent/windows/RIMDocs_agent.py"):
        assert (root / copy).read_bytes() == master, f"{copy} drifted from windows_manage/epod_agent.py"


def _load_agent(tmp_path):
    import importlib.util
    script = tmp_path / "main.py"
    script.write_text("print('hi')\n")
    cfg = tmp_path / "config.ini"
    cfg.write_text(
        "[app]\n"
        f"SCRIPT_PATH = {script}\nPYTHON_EXE = {sys.executable}\n"
        f"LOG_PATH = {tmp_path / 'run.log'}\nTERMINAL_LOG = {tmp_path / 'terminal.log'}\n"
        "AGENT_TOKEN = agent-token-0123456789abcdefghij\n"
    )
    os.environ["AGENT_CONFIG"] = str(cfg)
    path = Path(__file__).resolve().parent.parent / "windows_manage" / "epod_agent.py"
    spec = importlib.util.spec_from_file_location(f"agent_{uuid.uuid4().hex}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_agent_auth_probe_and_backlog(tmp_path):
    agent = _load_agent(tmp_path)
    ac = TestClient(agent.app)
    tok = {"Authorization": "Bearer agent-token-0123456789abcdefghij"}
    assert ac.get("/health").status_code == 200
    assert ac.get("/running").status_code == 401
    assert ac.get("/running", headers=tok).json() == {"running": False, "pid": None}
    assert ac.get("/status", headers=tok).json()["running"] is False
    log = tmp_path / "terminal.log"
    log.write_bytes(b"one\ntwo\nthree\npart")
    lines, end = agent._backlog(str(log), 2, log.stat().st_size)
    # The trailing partial line is held back so it is never streamed in two pieces.
    assert lines == ["two", "three"] and end == len(b"one\ntwo\nthree\n")
    assert agent._backlog(str(log), 0, log.stat().st_size) == ([], end)
    assert agent._sse("x", "7:5") == "id: 7:5\ndata: x\n\n"
    assert agent._parse_resume("7:5") == (7, 5) and agent._parse_resume("junk") is None and agent._parse_resume(None) is None
    assert agent._sse("", event="reset") == "event: reset\ndata: \n\n"


def test_agent_list():
    agents = client.get("/api/agents", headers=OPS).json()["agents"]
    dev = next(a for a in agents if a["id"] == "epod-dev")
    assert dev["configured"] and dev["can_view"] and not dev["can_control"]


# ============================================================================
# Ingestion stats / NAS (real Postgres)
# ============================================================================

@needs_pg
def test_epod_dashboard():
    data = client.get("/api/epod/dashboard", headers=OPS).json()
    alpha, missing = data["tables"]
    assert alpha["counts"] == {"total": 4, "success": 2, "error": 1, "running": 1}
    assert alpha["sizes"]["total_size_bytes"] == 4750 and alpha["sizes"]["pct_ingested"] == round(4000 / 4750, 4)
    assert alpha["timeline"]["duration_secs"] == pytest.approx(3 * 3600, abs=2)
    assert alpha["stall"] and alpha["stall"]["running"] == 1
    assert missing["status"] == "not_started"
    assert data["kpis"]["total_docs"] == 4 and data["chart_donut"] == {"success": 2, "error": 1, "running": 1}


@needs_pg
def test_rimdocs_stream_and_available():
    with client.stream("GET", "/api/rimdocs/dashboard/stream", headers=OPS) as resp:
        lines = [json.loads(l) for l in resp.iter_lines() if l]
    assert lines[0] == {"type": "meta", "data": {"table_count": 2}}
    tables = [l["data"] for l in lines if l["type"] == "table"]
    assert {t["label"] for t in tables} == {"X", "Y"}
    assert all(t["stall"] is None for t in tables)
    summary = lines[-1]
    assert summary["type"] == "summary" and summary["data"]["kpis"]["total_docs"] == 2

    avail = client.get("/api/rimdocs/available-counts", headers=OPS).json()["available"]
    assert avail == {"rimdocs1.ingestion_log_x": 2, "rimdocs1.ingestion_log_y": None}


@needs_pg
def test_diagnose():
    assert client.get("/api/epod/diagnose", headers=OPS).status_code == 403
    data = client.get("/api/epod/diagnose", headers=ADMIN).json()
    flags = {t["config_name"]: t["exists"] for t in data["configured_tables"]}
    assert flags == {"epod1.ingestion_log_alpha": True, "epod1.ingestion_log_missing": False}


@needs_pg
def test_nas_endpoints():
    ov = client.get("/api/nas/overview", headers=OPS).json()
    assert ov["kpis"]["segments"] == 3
    assert [s["segment"] for s in ov["segments"]] == ["SEG_B", "SEG_A", "SEG_100%"]
    assert ov["segments"][0]["last_modified"].startswith("2026-01-")
    only = client.get("/api/nas/overview", headers=OPS, params={"search": "100%"}).json()
    assert [s["segment"] for s in only["segments"]] == ["SEG_100%"]
    assert client.get("/api/nas/overview", headers=OPS, params={"search": "_"}).json()["kpis"]["segments"] == 3
    pdfs = client.get("/api/nas/largest-pdfs", headers=OPS).json()["files"]
    assert [f["file_name"] for f in pdfs] == ["big.pdf", "small.PDF"] and pdfs[0]["segment"] == "SEG_B"
    trends = client.get("/api/nas/trends", headers=OPS).json()["daily"]
    assert trends[-1]["cumulative"] == 3
    assert client.get("/api/nas/debug", headers=ADMIN).json()["top_level_segments"] == 3


@needs_pg
def test_readiness():
    assert client.get("/health/ready").json() == {"status": "ready", "checks": {"audit_db": True, "postgres": True}}


def test_config_injection_rejected(tmp_path, monkeypatch):
    import db_common
    with pytest.raises(ValueError):
        db_common.table_identifier("public.t; DROP TABLE x", "public")
    with pytest.raises(ValueError):
        db_common.table_identifier('a"b', "public")
