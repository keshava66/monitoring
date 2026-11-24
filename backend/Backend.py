import os
import asyncio
from fastapi import FastAPI, HTTPException, Header, Body, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import requests
import json
import logging
from io import BytesIO
from pathlib import Path
from typing import Optional
from pydantic import BaseModel
from dotenv import load_dotenv

# Load .env from the same directory as this file
load_dotenv(Path(__file__).parent / ".env")

import rbac
from auth import get_current_user, require_permission, require_admin, _get_access_token
from audit import audit_router, write_audit_event
from epod  import epod_router
from nas_scanner import nas_router
from rimdocs import rimdocs_router

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ── Tag order controls section order in /docs ──────────────────────────────────
TAGS_METADATA = [
    {
        "name": "Audit",
        "description": "Audit log — read, filter, export, and track active users.",
    },
    {
        "name": "EPOD",
        "description": "EPOD NAS ingestion stats — dashboard, per-table metrics, and diagnostics.",
    },
    {
        "name": "Graph API",
        "description": "Microsoft Graph proxy — user profile, photo, and extended details.",
    },
    {
        "name": "RBAC",
        "description": "Role-based access control — roles, permissions, and user assignments.",
    },
    {
        "name": "System",
        "description": "Health check and server status.",
    },
]

app = FastAPI(
    title="RDI-AI Backened",
    version="0.1.0",
    openapi_tags=TAGS_METADATA,
)

_allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if not _allowed_origins:
    logger.warning("[CORS] ALLOWED_ORIGINS not set — defaulting to http://localhost:5173 for local dev only.")
    _allowed_origins = ["http://localhost:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audit_router)
app.include_router(epod_router)
app.include_router(nas_router)
app.include_router(rimdocs_router)

# ============================================================================
# HELPERS
# ============================================================================

def get_access_token(authorization: Optional[str]) -> str:
    return _get_access_token(authorization)


# ============================================================================
# SYSTEM
# ============================================================================

@app.get("/health", tags=["System"])
def health_check():
    return {"status": "healthy"}


# ============================================================================
# GRAPH API
# ============================================================================

@app.get("/auth/user", tags=["Graph API"])
def get_user(authorization: Optional[str] = Header(None)):
    """Return basic user profile from Microsoft Graph."""
    token = get_access_token(authorization)
    response = requests.get(
        "https://graph.microsoft.com/v1.0/me",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not response.ok:
        raise HTTPException(status_code=response.status_code, detail="Failed to validate token")
    user_data = response.json()
    return {
        "id":                user_data.get("id"),
        "displayName":       user_data.get("displayName"),
        "mail":              user_data.get("mail"),
        "userPrincipalName": user_data.get("userPrincipalName"),
        "jobTitle":          user_data.get("jobTitle"),
        "department":        user_data.get("department"),
    }


@app.get("/auth/user/photo", tags=["Graph API"])
def get_user_photo(authorization: Optional[str] = Header(None)):
    """Proxy the user's profile photo from Microsoft Graph."""
    token = get_access_token(authorization)
    try:
        photo_response = requests.get(
            "https://graph.microsoft.com/v1.0/me/photo/$value",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        if photo_response.status_code == 200:
            logger.info("Profile photo fetched successfully")
            return StreamingResponse(BytesIO(photo_response.content), media_type="image/jpeg")
        elif photo_response.status_code == 404:
            raise HTTPException(status_code=404, detail="No profile photo found")
        elif photo_response.status_code == 401:
            raise HTTPException(status_code=401, detail="Unauthorized")
        else:
            raise HTTPException(status_code=photo_response.status_code, detail="Failed to fetch photo")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Photo fetch error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch photo")


@app.get("/auth/user/details", tags=["Graph API"])
def get_user_details(authorization: Optional[str] = Header(None)):
    """Return extended user profile fields from Microsoft Graph."""
    token = get_access_token(authorization)
    fields = ",".join([
        "id", "displayName", "mail", "userPrincipalName", "jobTitle",
        "department", "officeLocation", "city", "country", "companyName",
        "mobilePhone", "businessPhones", "employeeId", "employeeType",
        "userType", "accountEnabled", "createdDateTime",
    ])
    response = requests.get(
        f"https://graph.microsoft.com/v1.0/me?$select={fields}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not response.ok:
        raise HTTPException(status_code=response.status_code, detail="Failed to fetch user details")
    return response.json()


# ============================================================================
# AGENT PROXY — forwards API calls from HTTPS frontend to HTTP agents
# Prevents mixed-content errors when UI is on HTTPS but agents are on HTTP.
#
# Covers both EPOD and RIMDOCS agents. Each environment is a separate
# epod_agent.py process (same agent code, own config.ini/port), even when
# co-located with its EPOD counterpart on the same physical box — one agent
# process can only ever run one script, so EPOD and RIMDOCS each need their
# own instance per environment.
#
# Set in environment:
#   EPOD_AGENT_DEV_URL,    EPOD_AGENT_QA_URL,    EPOD_AGENT_PROD_URL
#   RIMDOCS_AGENT_DEV_URL, RIMDOCS_AGENT_QA_URL, RIMDOCS_AGENT_PROD_URL
#   RIMDOCS_AGENT_DEV1_URL, RIMDOCS_AGENT_DEV2_URL,
#   RIMDOCS_AGENT_QA2_URL,  RIMDOCS_AGENT_PROD2_URL   (Linux pipeline boxes)
# ============================================================================

import os
from fastapi import Request
from fastapi.responses import Response as FastAPIResponse, StreamingResponse as FastAPIStreamingResponse
import httpx

_AGENT_TLS_VERIFY = os.getenv("AGENT_TLS_VERIFY", "true").strip().lower() not in ("false", "0", "no")

_agent_client = httpx.AsyncClient(
    verify=_AGENT_TLS_VERIFY,
    follow_redirects=True,
    timeout=10,
    limits=httpx.Limits(max_keepalive_connections=0),
)

# Actions that stop/restart a running extraction pipeline — gated behind a
# permission, not just "any authenticated user". Mapped from the proxy
# prefix (e.g. "epod-prod") to the permission key in rbac.py.
_STOP_PERMISSIONS = {
    "epod-dev": "stopScriptDev", "epod-qa": "stopScriptQA", "epod-prod": "stopScriptProd",
    "rimdocs-dev": "stopScriptRimdocsDev", "rimdocs-qa": "stopScriptRimdocsQA",
    "rimdocs-prod": "stopScriptRimdocsProd",
    "rimdocs-dev1": "stopScriptRimdocsDev1", "rimdocs-dev2": "stopScriptRimdocsDev2",
    "rimdocs-qa2": "stopScriptRimdocsQA2", "rimdocs-prod2": "stopScriptRimdocsProd2",
}
_MUTATING_AGENT_PATHS = ("/start", "/stop", "/clear-terminal")
_AGENT_TOKENS = {
    "epod-dev":      os.getenv("EPOD_AGENT_DEV_TOKEN",      ""),
    "epod-qa":       os.getenv("EPOD_AGENT_QA_TOKEN",       ""),
    "epod-prod":     os.getenv("EPOD_AGENT_PROD_TOKEN",     ""),
    "rimdocs-dev":   os.getenv("RIMDOCS_AGENT_DEV_TOKEN",   ""),
    "rimdocs-qa":    os.getenv("RIMDOCS_AGENT_QA_TOKEN",    ""),
    "rimdocs-prod":  os.getenv("RIMDOCS_AGENT_PROD_TOKEN",  ""),
    "rimdocs-dev1":  os.getenv("RIMDOCS_AGENT_DEV1_TOKEN",  ""),
    "rimdocs-dev2":  os.getenv("RIMDOCS_AGENT_DEV2_TOKEN",  ""),
    "rimdocs-qa2":   os.getenv("RIMDOCS_AGENT_QA2_TOKEN",   ""),
    "rimdocs-prod2": os.getenv("RIMDOCS_AGENT_PROD2_TOKEN", ""),
}


def _authenticate_proxy_request(request: Request, prefix: str) -> dict:
    authorization = request.headers.get("authorization")
    if not authorization:
        qs_token = request.query_params.get("access_token")
        if qs_token:
            authorization = f"Bearer {qs_token}"
    user = get_current_user(authorization=authorization)

    sub_path = "/" + "/".join(request.url.path.lstrip("/").split("/")[1:])
    if request.method == "POST" and any(sub_path.startswith(p) for p in _MUTATING_AGENT_PATHS):
        perm = _STOP_PERMISSIONS.get(prefix)
        if perm and not rbac.has_permission(user["role"], perm):
            raise HTTPException(status_code=403, detail=f"Missing permission: {perm}")
    return user

@app.on_event("shutdown")
async def _close_agent_client():
    await _agent_client.aclose()

# route prefix → backing agent URL (env var resolved at import time)
_AGENT_PROXIES = {
    "epod-dev":      os.getenv("EPOD_AGENT_DEV_URL",      ""),
    "epod-qa":       os.getenv("EPOD_AGENT_QA_URL",       ""),
    "epod-prod":     os.getenv("EPOD_AGENT_PROD_URL",     ""),
    "rimdocs-dev":   os.getenv("RIMDOCS_AGENT_DEV_URL",   ""),
    "rimdocs-qa":    os.getenv("RIMDOCS_AGENT_QA_URL",    ""),
    "rimdocs-prod":  os.getenv("RIMDOCS_AGENT_PROD_URL",  ""),
    "rimdocs-dev1":  os.getenv("RIMDOCS_AGENT_DEV1_URL",  ""),
    "rimdocs-dev2":  os.getenv("RIMDOCS_AGENT_DEV2_URL",  ""),
    "rimdocs-qa2":   os.getenv("RIMDOCS_AGENT_QA2_URL",   ""),
    "rimdocs-prod2": os.getenv("RIMDOCS_AGENT_PROD2_URL", ""),
}

_HOP_BY_HOP = {"host", "connection", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive"}


async def _proxy_request_with_retry(method: str, target: str, headers: dict, body: bytes):
    """
    GET requests to agents get up to 3 attempts with short backoff between
    them (0.3s, 0.8s) instead of one instant retry. An instant retry doesn't
    help when the underlying blip is a network-level burst rather than a
    single stale connection — measured in practice: failures here weren't
    independent random events, they were clustering together, so a retry
    fired milliseconds later just failed again for the same reason.
    POST (/start, /stop) never retries — can't tell whether the agent
    already received and acted on the request before the connection failed.
    """
    delays = (0, 0.3, 0.8)
    last_exc = None
    for attempt, delay in enumerate(delays):
        if delay:
            await asyncio.sleep(delay)
        try:
            resp = await _agent_client.request(method=method, url=target, headers=headers, content=body)
            if attempt > 0:
                logger.info(f"[AgentProxy] {target} recovered on attempt {attempt + 1}")
            return resp
        except httpx.TransportError as e:
            last_exc = e
            if method != "GET":
                logger.warning(f"[AgentProxy] {target} {e.__class__.__name__} on {method}, not retrying")
                raise HTTPException(status_code=502, detail=f"Agent did not respond: {e.__class__.__name__}")
            logger.info(f"[AgentProxy] {target} {e.__class__.__name__} on GET, attempt {attempt + 1}/{len(delays)}")

    logger.warning(f"[AgentProxy] {target} unreachable after {len(delays)} attempts: {last_exc}")
    raise HTTPException(status_code=502, detail=f"Agent did not respond: {last_exc.__class__.__name__}")


async def _proxy_agent(request: Request, base_url: str, prefix: str) -> FastAPIResponse:
    # Authenticate before anything else — including before revealing
    # whether this environment even has an agent configured.
    _authenticate_proxy_request(request, prefix)

    if not base_url:
        raise HTTPException(status_code=503, detail="Agent URL not configured")

    # Strip the /epod-qa, /rimdocs-prod, etc. prefix to get the actual agent path
    path    = "/" + "/".join(request.url.path.lstrip("/").split("/")[1:])
    target  = base_url.rstrip("/") + path
    if request.url.query:
        target += "?" + request.url.query

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    headers["host"] = httpx.URL(base_url).host
    agent_token = _AGENT_TOKENS.get(prefix)
    if agent_token:
        headers["authorization"] = f"Bearer {agent_token}"
    else:
        headers.pop("authorization", None)
        logger.warning(f"[AgentProxy] No shared token configured for '{prefix}' — "
                        f"agent must be configured to allow unauthenticated calls, which is not recommended.")

    # SSE streaming — use a streaming response
    if "text/event-stream" in request.headers.get("accept", ""):
        async def sse_generator():
            async with httpx.AsyncClient(verify=_AGENT_TLS_VERIFY, timeout=None) as client:
                async with client.stream("GET", target, headers=headers) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        return FastAPIStreamingResponse(sse_generator(), media_type="text/event-stream")

    # Regular request
    body = await request.body()
    resp = await _proxy_request_with_retry(request.method, target, headers, body)

    resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in _HOP_BY_HOP}
    return FastAPIResponse(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp_headers,
        media_type=resp.headers.get("content-type"),
    )


def _register_agent_proxy(prefix: str, base_url: str) -> None:
    """Registers one /{prefix}/{path:path} route forwarding to base_url."""
    async def _handler(request: Request, path: str):
        return await _proxy_agent(request, base_url, prefix)
    _handler.__name__ = f"proxy_{prefix.replace('-', '_')}"
    app.add_api_route(
        f"/{prefix}/{{path:path}}",
        _handler,
        methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
        tags=["Agent Proxy"],
    )


for _prefix, _url in _AGENT_PROXIES.items():
    _register_agent_proxy(_prefix, _url)


class RoleDefinition(BaseModel):
    name: str
    description: Optional[str] = ""
    color: Optional[str] = "#0f68b2"
    permissions: dict


class UserAssignment(BaseModel):
    user_email: str
    role_name: str


@app.get("/api/rbac/config", tags=["RBAC"], dependencies=[Depends(get_current_user)])
def get_rbac_config():
    """Return current RBAC config — custom roles and per-user overrides."""
    config = rbac.load_rbac_config()
    return {"success": True, "config": config}


@app.post("/api/rbac/roles", tags=["RBAC"])
def create_role(
    role_id: str = Body(...),
    role_definition: RoleDefinition = Body(...),
    user: dict = Depends(require_permission("manageRoles")),
):
    """Create a new custom role. Requires manageRoles permission."""
    config = rbac.load_rbac_config()
    if role_id in config.get("custom_roles", {}):
        raise HTTPException(status_code=400, detail=f"Role '{role_id}' already exists")
    config.setdefault("custom_roles", {})[role_id] = role_definition.dict()
    rbac.save_rbac_config(config)
    write_audit_event("role_created", user["email"], target=role_id,
                      details=f"Created custom role '{role_definition.name}'")
    return {"success": True, "role_id": role_id}


@app.put("/api/rbac/roles/{role_id}", tags=["RBAC"])
def update_role(
    role_id: str,
    role_definition: RoleDefinition = Body(...),
    changes_summary: Optional[str] = Body(None),
    user: dict = Depends(require_permission("manageRoles")),
):
    """Update an existing custom role. Requires manageRoles permission."""
    config = rbac.load_rbac_config()
    config.setdefault("custom_roles", {})[role_id] = role_definition.dict()
    rbac.save_rbac_config(config)
    details = changes_summary or f"Updated role '{role_definition.name}'"
    write_audit_event("role_updated", user["email"], target=role_id, details=details)
    return {"success": True, "role_id": role_id}


@app.delete("/api/rbac/roles/{role_id}", tags=["RBAC"])
def delete_role(
    role_id: str,
    reset: bool = Query(False),
    changes_summary: Optional[str] = Query(None),
    user: dict = Depends(require_permission("manageRoles")),
):
    """Delete a custom role and remove any user overrides pointing to it.

    When `reset=true`, this is a "reset to default" action (removing the
    custom override so the role reverts to its built-in definition), so it
    is audit-logged as `role_reset` instead of `role_deleted`.
    """
    config = rbac.load_rbac_config()
    custom_roles = config.get("custom_roles", {})
    if role_id not in custom_roles:
        raise HTTPException(status_code=404, detail=f"Custom role '{role_id}' not found")
    del custom_roles[role_id]
    overrides = config.get("user_role_overrides", {})
    config["user_role_overrides"] = {k: v for k, v in overrides.items() if v != role_id}
    rbac.save_rbac_config(config)
    if reset:
        details = changes_summary or f"Reset role '{role_id}' to default settings"
        write_audit_event("role_reset", user["email"], target=role_id, details=details)
    else:
        write_audit_event("role_deleted", user["email"], target=role_id,
                          details=f"Deleted custom role '{role_id}'")
    return {"success": True}


@app.post("/api/rbac/user-assignments", tags=["RBAC"])
def assign_role(
    assignment: UserAssignment,
    user: dict = Depends(require_permission("manageUsers")),
):
    """Assign a role override to a specific user. Requires manageUsers permission."""
    config = rbac.load_rbac_config()
    config.setdefault("user_role_overrides", {})[assignment.user_email.lower()] = assignment.role_name
    rbac.save_rbac_config(config)
    write_audit_event("role_assigned", user["email"],
                      target=assignment.user_email,
                      details=f"Assigned role '{assignment.role_name}'")
    return {"success": True}


@app.delete("/api/rbac/user-assignments/{user_email}", tags=["RBAC"])
def remove_role_assignment(
    user_email: str,
    user: dict = Depends(require_permission("manageUsers")),
):
    """Remove a manual role override from a user. Requires manageUsers permission."""
    config = rbac.load_rbac_config()
    overrides = config.get("user_role_overrides", {})
    if user_email.lower() not in overrides:
        raise HTTPException(status_code=404, detail="No role override found for this user")
    del overrides[user_email.lower()]
    rbac.save_rbac_config(config)
    write_audit_event("role_removed", user["email"],
                      target=user_email,
                      details="Removed manual role override")
    return {"success": True}