"""RDI-AI Monitoring API."""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Optional, Tuple

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

import httpx  # noqa: E402
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, Response, StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402
from starlette.datastructures import MutableHeaders  # noqa: E402

import psycopg2  # noqa: E402

import auth  # noqa: E402
import core_db  # noqa: E402
import db_common  # noqa: E402
import rbac  # noqa: E402
from audit import audit_router, client_ip, write_audit_event  # noqa: E402
from auth import get_current_user, require_permission, resolve_user  # noqa: E402
from epod import epod_router  # noqa: E402
from nas_scanner import nas_router  # noqa: E402
from rimdocs import rimdocs_router  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("monitoring")

APP_VERSION = "2.0.0"

# ============================================================================
# AGENT REGISTRY
# Each pipeline box runs one agent per product/environment. The browser never
# talks to an agent directly (they're plain HTTP on internal hosts); every
# call goes through here, gets authorised, and is re-signed with that
# agent's shared token.
# ============================================================================

_AGENT_PERMS = {
    "epod-dev": ("viewEPodDev", "stopScriptDev"),
    "epod-qa": ("viewEPodQA", "stopScriptQA"),
    "epod-prod": ("viewEPodProd", "stopScriptProd"),
    "rimdocs-dev": ("viewRimdocsDev", "stopScriptRimdocsDev"),
    "rimdocs-qa": ("viewRimdocsQA", "stopScriptRimdocsQA"),
    "rimdocs-prod": ("viewRimdocsProd", "stopScriptRimdocsProd"),
    "rimdocs-dev1": ("viewRimdocsDev1", "stopScriptRimdocsDev1"),
    "rimdocs-dev2": ("viewRimdocsDev2", "stopScriptRimdocsDev2"),
    "rimdocs-qa2": ("viewRimdocsQA2", "stopScriptRimdocsQA2"),
    "rimdocs-prod2": ("viewRimdocsProd2", "stopScriptRimdocsProd2"),
}


def _agent_env(prefix: str, kind: str) -> str:
    return os.getenv(f"{prefix.upper().replace('-', '_AGENT_', 1)}_{kind}", "").strip()


AGENTS: Dict[str, Dict] = {
    prefix: {"url": _agent_env(prefix, "URL").rstrip("/"), "token": _agent_env(prefix, "TOKEN"), "view": v, "control": c}
    for prefix, (v, c) in _AGENT_PERMS.items()
}

_AGENT_READ_PATHS = {"/status", "/running", "/info", "/logs", "/terminal", "/terminal/stream", "/health"}
_AGENT_QUERY_KEYS = {"n", "from"}
_AGENT_WRITE_PATHS = {"/start", "/stop", "/clear-terminal"}
_AGENT_TLS_VERIFY = os.getenv("AGENT_TLS_VERIFY", "true").strip().lower() not in ("false", "0", "no")

# Reads reuse connections (status polls every few seconds would otherwise pay
# a TCP/TLS handshake each time); a socket a firewall dropped while idle just
# fails the attempt and the GET retry opens a fresh one. Control calls are not
# retried, so they always use a fresh connection and can't hit a dead socket.
_agent_read_client = httpx.AsyncClient(
    verify=_AGENT_TLS_VERIFY,
    timeout=httpx.Timeout(15.0, connect=5.0),
    limits=httpx.Limits(max_keepalive_connections=40, max_connections=100, keepalive_expiry=20.0),
)
_agent_client = httpx.AsyncClient(
    verify=_AGENT_TLS_VERIFY,
    timeout=httpx.Timeout(60.0, connect=5.0),
    limits=httpx.Limits(max_keepalive_connections=0, max_connections=50),
)
_agent_stream_client = httpx.AsyncClient(
    verify=_AGENT_TLS_VERIFY,
    timeout=httpx.Timeout(connect=5.0, read=None, write=10.0, pool=5.0),
    limits=httpx.Limits(max_keepalive_connections=0, max_connections=200),
)


# ============================================================================
# APP
# ============================================================================

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Fail fast: without its own database the app can't resolve roles or audit.
    core_db.migrate()
    configured = [p for p, a in AGENTS.items() if a["url"]]
    logger.info("Monitoring API %s starting; agents configured: %s", APP_VERSION, ", ".join(configured) or "none")
    for p in configured:
        if not AGENTS[p]["token"]:
            logger.warning("Agent %s has a URL but no token; calls to it will be rejected by the agent", p)
    yield
    await _agent_read_client.aclose()
    await _agent_client.aclose()
    await _agent_stream_client.aclose()
    auth.graph_client.close()
    db_common.close_pool()
    core_db.close_pool()


TAGS_METADATA = [
    {"name": "Audit", "description": "Audit log — read, filter, export, and track active users."},
    {"name": "EPOD", "description": "EPOD ingestion stats."},
    {"name": "RIMDOCS", "description": "RIMDOCS ingestion stats."},
    {"name": "NAS Scanner", "description": "EPOD NAS archive analysis."},
    {"name": "Graph API", "description": "Microsoft Graph proxy — profile and photo."},
    {"name": "RBAC", "description": "Roles, permissions, and user assignments."},
    {"name": "Agent Proxy", "description": "Authorised proxy to pipeline agents."},
    {"name": "System", "description": "Health checks."},
]

app = FastAPI(
    title="RDI-AI Monitoring API",
    version=APP_VERSION,
    openapi_tags=TAGS_METADATA,
    lifespan=lifespan,
    docs_url=None if os.getenv("DISABLE_DOCS", "").lower() in ("1", "true", "yes") else "/docs",
    redoc_url=None,
)

_SECURITY_HEADERS = {
    b"x-content-type-options": b"nosniff",
    b"x-frame-options": b"DENY",
    b"referrer-policy": b"no-referrer",
    b"strict-transport-security": b"max-age=31536000; includeSubDomains",
}


class RequestContextMiddleware:
    """Request id, security headers and one access-log line per request.
    Pure ASGI so streaming responses are never buffered. Logs the path only,
    never the query string."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode("latin-1")
        rid = incoming if incoming and len(incoming) <= 64 and incoming.isalnum() else uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = rid
        started = time.perf_counter()
        status = {"code": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = rid
                for k, v in _SECURITY_HEADERS.items():
                    if k.decode() not in headers:
                        headers[k.decode()] = v.decode()
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            if path not in ("/health", "/health/ready"):
                logger.info(
                    "%s %s %s %.1fms rid=%s",
                    scope.get("method"), path, status["code"], (time.perf_counter() - started) * 1000, rid,
                )


_allowed_origins = [o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if not _allowed_origins:
    # Fail closed: no browser origin may call the API until one is configured.
    logger.error("[CORS] ALLOWED_ORIGINS is not set: every browser request from another origin will be refused.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID", "Content-Disposition"],
    max_age=600,
)
app.add_middleware(RequestContextMiddleware)


@app.exception_handler(core_db.DatabaseUnavailable)
@app.exception_handler(psycopg2.OperationalError)
async def _database_down(request: Request, exc: Exception):
    rid = request.scope.get("state", {}).get("request_id", "")
    logger.error("Database unavailable rid=%s on %s %s: %s", rid, request.method, request.url.path,
                 str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__)
    return JSONResponse(status_code=503, content={"detail": "Database unavailable, please retry", "request_id": rid})


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    rid = request.scope.get("state", {}).get("request_id", "")
    logger.exception("Unhandled error rid=%s on %s %s", rid, request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error", "request_id": rid})


app.include_router(audit_router)
app.include_router(epod_router)
app.include_router(nas_router)
app.include_router(rimdocs_router)


# ============================================================================
# SYSTEM
# ============================================================================

@app.get("/health", tags=["System"])
def health_check():
    return {"status": "healthy", "version": APP_VERSION}


@app.get("/health/ready", tags=["System"])
def readiness_check():
    checks = {"core_db": core_db.healthy()}
    try:
        db_common.load_config()
        checks["postgres"] = db_common.db_healthy()
    except (FileNotFoundError, KeyError):
        checks["postgres"] = False
    ok = all(checks.values())
    return JSONResponse(status_code=200 if ok else 503, content={"status": "ready" if ok else "degraded", "checks": checks})


# ============================================================================
# GRAPH API
# ============================================================================

@app.get("/auth/user", tags=["Graph API"])
def get_user(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "displayName": user["displayName"],
        "mail": user["email"],
        "userPrincipalName": user["email"],
        "role": user["role"],
    }


@app.get("/auth/user/photo", tags=["Graph API"])
def get_user_photo(authorization: Optional[str] = Header(None)):
    token = auth._get_access_token(authorization)
    resp = auth.graph_get("/me/photos/96x96/$value", token)
    if resp.status_code == 404:
        resp = auth.graph_get("/me/photo/$value", token)
    if resp.status_code == 404:
        # No photo is a normal state, not an error: answer 204 so browsers stay quiet.
        return Response(status_code=204, headers={"Cache-Control": "private, max-age=3600"})
    if resp.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not resp.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch photo")
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/auth/user/details", tags=["Graph API"])
def get_user_details(authorization: Optional[str] = Header(None)):
    token = auth._get_access_token(authorization)
    fields = ",".join([
        "id", "displayName", "mail", "userPrincipalName", "jobTitle", "department", "officeLocation", "city",
        "country", "companyName", "mobilePhone", "businessPhones", "employeeId", "employeeType", "userType",
        "accountEnabled", "createdDateTime",
    ])
    resp = auth.graph_get("/me", token, {"$select": fields})
    if resp.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not resp.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch user details")
    return resp.json()


# ============================================================================
# AGENT PROXY
# ============================================================================

async def _proxy_agent(request: Request, prefix: str, path: str):
    agent = AGENTS[prefix]
    user = await run_in_threadpool(resolve_user, request.headers.get("authorization"))
    sub = "/" + path.strip("/")
    method = request.method

    if method == "GET" and sub in _AGENT_READ_PATHS:
        needed = agent["view"]
    elif method == "POST" and sub in _AGENT_WRITE_PATHS:
        needed = agent["control"]
    else:
        raise HTTPException(status_code=404, detail="Not found")
    if not rbac.has_permission(user["role"], needed):
        raise HTTPException(status_code=403, detail=f"Missing permission: {needed}")
    if not agent["url"]:
        raise HTTPException(status_code=503, detail="Agent not configured for this environment")

    target = agent["url"] + sub
    params = {k: v for k, v in request.query_params.items() if k in _AGENT_QUERY_KEYS}
    headers = {"Accept": request.headers.get("accept", "application/json")}
    if agent["token"]:
        headers["Authorization"] = f"Bearer {agent['token']}"

    if sub == "/terminal/stream":
        return await _proxy_stream(target, params, headers, prefix)

    attempts = 3 if method == "GET" else 1
    last_exc: Optional[Exception] = None
    resp = None
    for attempt in range(attempts):
        try:
            resp = await (_agent_read_client if method == "GET" else _agent_client).request(method, target, params=params, headers=headers)
            break
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt + 1 < attempts:
                await asyncio.sleep((0.3, 0.8)[attempt])
    if resp is None:
        logger.warning("[AgentProxy] %s %s unreachable: %s", prefix, sub, last_exc.__class__.__name__)
        raise HTTPException(status_code=502, detail="Agent did not respond")

    if method == "POST":
        outcome = "succeeded" if resp.is_success else f"failed ({resp.status_code})"
        await run_in_threadpool(
            write_audit_event, "pipeline_action", user["email"], prefix,
            f"{sub.lstrip('/').replace('-', ' ').capitalize()} on {prefix.upper()} {outcome}", client_ip(request),
        )

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
        headers={"Cache-Control": "no-store"},
    )


async def _proxy_stream(target: str, params: Dict, headers: Dict, prefix: str):
    headers = {**headers, "Accept": "text/event-stream"}
    try:
        upstream = await _agent_stream_client.send(
            _agent_stream_client.build_request("GET", target, params=params, headers=headers), stream=True
        )
    except httpx.TransportError as exc:
        logger.warning("[AgentProxy] %s stream unreachable: %s", prefix, exc.__class__.__name__)
        raise HTTPException(status_code=502, detail="Agent did not respond")
    if upstream.status_code != 200:
        body = await upstream.aread()
        await upstream.aclose()
        return Response(content=body, status_code=upstream.status_code,
                        media_type=upstream.headers.get("content-type", "application/json"))

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError:
            return
        finally:
            await upstream.aclose()

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


def _register_agent_proxy(prefix: str) -> None:
    async def _handler(request: Request, path: str):
        return await _proxy_agent(request, prefix, path)

    _handler.__name__ = f"proxy_{prefix.replace('-', '_')}"
    app.add_api_route(f"/{prefix}/{{path:path}}", _handler, methods=["GET", "POST"], tags=["Agent Proxy"])


for _prefix in AGENTS:
    _register_agent_proxy(_prefix)


_agent_names: Dict[str, Tuple[str, float]] = {}
_AGENT_NAME_TTL = 600.0


async def _agent_get(prefix: str, sub: str, timeout: float) -> Optional[httpx.Response]:
    agent = AGENTS[prefix]
    headers = {"Authorization": f"Bearer {agent['token']}"} if agent["token"] else {}
    try:
        return await _agent_read_client.get(agent["url"] + sub, headers=headers, timeout=timeout)
    except httpx.TransportError:
        return None


async def _agent_state(prefix: str) -> Dict:
    """Running / stopped / unreachable plus display name, for one agent."""
    resp = await _agent_get(prefix, "/running", 4.0)
    if resp is not None and resp.status_code == 404:  # agent older than /running
        resp = await _agent_get(prefix, "/status", 6.0)
    try:
        state = ("running" if resp.json().get("running") else "stopped") if resp is not None and resp.is_success else "unreachable"
    except ValueError:
        state = "unreachable"
    name, fetched = _agent_names.get(prefix, (None, 0.0))
    if state != "unreachable" and (name is None or time.monotonic() - fetched > _AGENT_NAME_TTL):
        info = await _agent_get(prefix, "/info", 4.0)
        try:
            if info is not None and info.is_success:
                name = info.json().get("server_name") or None
                _agent_names[prefix] = (name, time.monotonic())
        except ValueError:
            pass
    return {"id": prefix, "state": state, "name": name}


@app.get("/api/agents/status", tags=["Agent Proxy"])
async def agents_status(request: Request):
    """State of every configured agent the caller may view, probed in parallel."""
    user = await run_in_threadpool(resolve_user, request.headers.get("authorization"))
    perms = rbac.permissions_for(user["role"])
    visible = [p for p, a in AGENTS.items() if a["url"] and perms.get(a["view"], False)]
    return {"agents": list(await asyncio.gather(*(_agent_state(p) for p in visible)))}


@app.get("/api/agents", tags=["Agent Proxy"])
def list_agents(user: dict = Depends(get_current_user)):
    perms = rbac.permissions_for(user["role"])
    return {
        "agents": [
            {"id": p, "configured": bool(a["url"]), "can_view": perms.get(a["view"], False),
             "can_control": perms.get(a["control"], False)}
            for p, a in AGENTS.items() if perms.get(a["view"], False)
        ]
    }


# ============================================================================
# RBAC
# ============================================================================

class RoleDefinition(BaseModel):
    name: str = Field(..., max_length=64)
    description: Optional[str] = Field("", max_length=256)
    color: Optional[str] = Field("#0f68b2", max_length=7)
    permissions: Dict[str, bool] = Field(default_factory=dict)


class UserAssignment(BaseModel):
    user_email: str = Field(..., max_length=254)
    role_name: str = Field(..., max_length=48)


def _bad_request(exc: rbac.RBACValidationError):
    return HTTPException(status_code=422, detail=str(exc))


def _role_diff(before: Optional[Dict], after: Dict, verb: str) -> str:
    if not before:
        return f"{verb} role '{after['name']}'"
    changes = []
    if before.get("name") != after.get("name"):
        changes.append(f'name "{before.get("name")}" → "{after.get("name")}"')
    if (before.get("description") or "") != (after.get("description") or ""):
        changes.append("description changed")
    if (before.get("color") or "").lower() != (after.get("color") or "").lower():
        changes.append(f"color {before.get('color')} → {after.get('color')}")
    labels = rbac.PERMISSION_LABELS
    perm_changes = [
        f"{labels[k]} {'enabled' if after['permissions'].get(k) else 'disabled'}"
        for k in rbac.ALL_PERMISSIONS
        if bool(before.get("permissions", {}).get(k)) != bool(after["permissions"].get(k))
    ]
    if perm_changes:
        changes.append("permissions: " + ", ".join(perm_changes))
    return f"{verb} role '{after['name']}'" + (f" — {'; '.join(changes)}" if changes else " (no changes)")


@app.get("/api/rbac/me", tags=["RBAC"])
def rbac_me(user: dict = Depends(get_current_user)):
    roles = rbac.get_all_roles()
    role_def = roles.get(user["role"], rbac.ROLE_DEFINITIONS["viewer"])
    return {
        "email": user["email"],
        "displayName": user["displayName"],
        "role": user["role"],
        "role_name": role_def["name"],
        "role_color": role_def["color"],
        "permissions": role_def["permissions"],
    }


@app.get("/api/rbac/config", tags=["RBAC"])
def get_rbac_config(user: dict = Depends(require_permission("viewUserManagement"))):
    config = rbac.store.load()
    return {
        "success": True,
        "config": {
            "roles": rbac.get_all_roles(config),
            "builtin_roles": rbac.ROLE_DEFINITIONS,
            "builtin_role_ids": list(rbac.BUILTIN_ROLE_IDS),
            "custom_roles": config["custom_roles"],
            "user_role_overrides": config["user_role_overrides"],
            "ad_group_roles": rbac.AD_GROUP_ROLES,
            "permission_catalog": rbac.PERMISSION_CATALOG,
            "admin_locked_permissions": list(rbac.ADMIN_LOCKED_PERMISSIONS),
        },
    }


@app.post("/api/rbac/roles", tags=["RBAC"])
def create_role(
    request: Request,
    role_id: str = Body(..., max_length=48),
    role_definition: RoleDefinition = Body(...),
    user: dict = Depends(require_permission("manageRoles")),
):
    if role_id in rbac.BUILTIN_ROLE_IDS:
        raise HTTPException(status_code=409, detail=f"Role '{role_id}' already exists")
    try:
        rbac.validate_role_id(role_id)
        role = rbac.validate_role_definition(role_id, role_definition.model_dump())
    except rbac.RBACValidationError as exc:
        raise _bad_request(exc)

    def apply(config):
        if role_id in config["custom_roles"] or role_id in rbac.BUILTIN_ROLE_IDS:
            raise HTTPException(status_code=409, detail=f"Role '{role_id}' already exists")
        config["custom_roles"][role_id] = role

    rbac.store.mutate(apply)
    write_audit_event("role_created", user["email"], target=role_id,
                      details=f"Created custom role '{role['name']}'", ip_address=client_ip(request))
    return {"success": True, "role_id": role_id, "role": role}


@app.put("/api/rbac/roles/{role_id}", tags=["RBAC"])
def update_role(
    role_id: str,
    request: Request,
    role_definition: RoleDefinition = Body(..., embed=True),
    user: dict = Depends(require_permission("manageRoles")),
):
    try:
        role = rbac.validate_role_definition(role_id, role_definition.model_dump())
    except rbac.RBACValidationError as exc:
        raise _bad_request(exc)

    def apply(config):
        if role_id not in config["custom_roles"] and role_id not in rbac.BUILTIN_ROLE_IDS:
            raise HTTPException(status_code=404, detail=f"Role '{role_id}' not found")
        before = rbac.get_all_roles(config).get(role_id)
        config["custom_roles"][role_id] = role
        return before

    before = rbac.store.mutate(apply)
    write_audit_event("role_updated", user["email"], target=role_id,
                      details=_role_diff(before, role, "Updated"), ip_address=client_ip(request))
    return {"success": True, "role_id": role_id, "role": role}


@app.delete("/api/rbac/roles/{role_id}", tags=["RBAC"])
def delete_role(
    role_id: str,
    request: Request,
    reset: bool = Query(False),
    user: dict = Depends(require_permission("manageRoles")),
):
    is_builtin = role_id in rbac.BUILTIN_ROLE_IDS

    def apply(config):
        if role_id not in config["custom_roles"]:
            raise HTTPException(status_code=404, detail=f"No custom definition for role '{role_id}'")
        before = config["custom_roles"].pop(role_id)
        removed = []
        if not is_builtin:
            removed = [e for e, r in config["user_role_overrides"].items() if r == role_id]
            for e in removed:
                del config["user_role_overrides"][e]
        return before, removed

    before, removed = rbac.store.mutate(apply)
    if is_builtin:
        write_audit_event("role_reset", user["email"], target=role_id,
                          details=_role_diff(before, rbac.ROLE_DEFINITIONS[role_id], "Reset"),
                          ip_address=client_ip(request))
    else:
        detail = f"Deleted custom role '{before['name']}'"
        if removed:
            detail += f"; removed from {len(removed)} user(s)"
        write_audit_event("role_deleted", user["email"], target=role_id, details=detail, ip_address=client_ip(request))
    return {"success": True, "reset": is_builtin or reset, "removed_assignments": removed}


@app.post("/api/rbac/user-assignments", tags=["RBAC"])
def assign_role(assignment: UserAssignment, request: Request, user: dict = Depends(require_permission("manageUsers"))):
    try:
        email = rbac.validate_email(assignment.user_email)
    except rbac.RBACValidationError as exc:
        raise _bad_request(exc)
    role_id = assignment.role_name

    def apply(config):
        if role_id not in rbac.get_all_roles(config):
            raise HTTPException(status_code=422, detail=f"Unknown role '{role_id}'")
        previous = config["user_role_overrides"].get(email)
        config["user_role_overrides"][email] = role_id
        return previous

    previous = rbac.store.mutate(apply)
    detail = f"Assigned role '{role_id}'" + (f" (was '{previous}')" if previous and previous != role_id else "")
    write_audit_event("role_assigned", user["email"], target=email, details=detail, ip_address=client_ip(request))
    return {"success": True, "user_email": email, "role_name": role_id}


@app.delete("/api/rbac/user-assignments/{user_email}", tags=["RBAC"])
def remove_role_assignment(user_email: str, request: Request, user: dict = Depends(require_permission("manageUsers"))):
    email = user_email.strip().lower()

    def apply(config):
        if email not in config["user_role_overrides"]:
            raise HTTPException(status_code=404, detail="No role override found for this user")
        return config["user_role_overrides"].pop(email)

    previous = rbac.store.mutate(apply)
    write_audit_event("role_removed", user["email"], target=email,
                      details=f"Removed manual role override '{previous}'", ip_address=client_ip(request))
    return {"success": True}
