import logging
import time
from typing import Dict, Optional

import requests
from fastapi import Header, HTTPException

import rbac

logger = logging.getLogger(__name__)

GRAPH_ME       = "https://graph.microsoft.com/v1.0/me"
GRAPH_MEMBEROF = "https://graph.microsoft.com/v1.0/me/memberOf"

# token -> (expires_at, user_dict). In-memory is fine for a single
# process; if this ever runs multi-worker, move to Redis.
_CACHE: Dict[str, tuple] = {}
_CACHE_TTL_SECS = 60


def _get_access_token(authorization: Optional[str]) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    return authorization[7:]


def _fetch_user_and_groups(token: str) -> Dict:
    me_resp = requests.get(GRAPH_ME, headers={"Authorization": f"Bearer {token}"}, timeout=10)
    if me_resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not me_resp.ok:
        raise HTTPException(status_code=me_resp.status_code, detail="Failed to validate token")
    me = me_resp.json()

    group_names, group_ids = [], []
    try:
        g_resp = requests.get(GRAPH_MEMBEROF, headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if g_resp.ok:
            for g in g_resp.json().get("value", []):
                if g.get("displayName"):
                    group_names.append(g["displayName"])
                if g.get("id"):
                    group_ids.append(g["id"])
    except Exception as e:
        logger.warning(f"[Auth] Could not fetch group membership: {e}")

    email = me.get("mail") or me.get("userPrincipalName") or ""
    role = rbac.resolve_role(email, group_names, group_ids)

    return {
        "id": me.get("id"),
        "email": email,
        "displayName": me.get("displayName"),
        "role": role,
        "groups": group_names,
    }


def get_current_user(authorization: Optional[str] = Header(None)) -> Dict:
    """Validate the bearer token with Graph and resolve the caller's
    real role. Use as a FastAPI dependency on every protected route."""
    token = _get_access_token(authorization)

    cached = _CACHE.get(token)
    if cached and cached[0] > time.time():
        return cached[1]

    user = _fetch_user_and_groups(token)
    _CACHE[token] = (time.time() + _CACHE_TTL_SECS, user)
    return user


def require_permission(permission: str):
    def _dep(authorization: Optional[str] = Header(None)) -> Dict:
        resolved = get_current_user(authorization)
        if not rbac.has_permission(resolved["role"], permission):
            raise HTTPException(status_code=403, detail=f"Missing permission: {permission}")
        return resolved
    return _dep


def require_admin(authorization: Optional[str] = Header(None)) -> Dict:
    user = get_current_user(authorization)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user