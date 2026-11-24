"""Bearer-token authentication against Microsoft Graph.

Every protected route validates the caller's Graph access token server-side
and resolves their role from rbac.py. Results are cached briefly per token so
a page that fires a dozen API calls costs one Graph round-trip, not twelve.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

import httpx
from fastapi import Header, HTTPException

import rbac

logger = logging.getLogger(__name__)

GRAPH_BASE = os.getenv("GRAPH_BASE_URL", "https://graph.microsoft.com/v1.0").rstrip("/")
_CACHE_TTL_SECS = int(os.getenv("AUTH_CACHE_TTL_SECS", "60"))
_CACHE_MAX = int(os.getenv("AUTH_CACHE_MAX_ENTRIES", "4096"))
_MAX_GROUP_PAGES = 20

graph_client = httpx.Client(
    timeout=httpx.Timeout(10.0, connect=5.0),
    limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
)


class _TTLCache:
    """Bounded LRU with per-entry expiry, keyed by a hash of the token so raw
    bearer tokens never sit around as dict keys."""

    def __init__(self, ttl: int, max_entries: int):
        self.ttl = ttl
        self.max_entries = max_entries
        self._data: "OrderedDict[str, Tuple[float, Dict]]" = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def key(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def get(self, token: str) -> Optional[Dict]:
        k = self.key(token)
        with self._lock:
            hit = self._data.get(k)
            if not hit:
                return None
            if hit[0] <= time.monotonic():
                del self._data[k]
                return None
            self._data.move_to_end(k)
            return dict(hit[1])

    def put(self, token: str, value: Dict) -> None:
        k = self.key(token)
        with self._lock:
            self._data[k] = (time.monotonic() + self.ttl, dict(value))
            self._data.move_to_end(k)
            while len(self._data) > self.max_entries:
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


_cache = _TTLCache(_CACHE_TTL_SECS, _CACHE_MAX)


def _get_access_token(authorization: Optional[str]) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization[7:].strip()
    if not token or len(token) > 16384:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    return token


def graph_get(path_or_url: str, token: str, params: Optional[Dict] = None) -> httpx.Response:
    url = path_or_url if path_or_url.startswith("http") else f"{GRAPH_BASE}{path_or_url}"
    try:
        return graph_client.get(url, params=params, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as exc:
        logger.warning("[Auth] Graph request failed: %s", exc.__class__.__name__)
        raise HTTPException(status_code=503, detail="Identity provider unavailable") from exc


def _fetch_groups(token: str) -> Tuple[List[str], List[str]]:
    names: List[str] = []
    ids: List[str] = []
    url: Optional[str] = "/me/memberOf"
    params: Optional[Dict] = {"$select": "id,displayName", "$top": "999"}
    for _ in range(_MAX_GROUP_PAGES):
        if not url:
            break
        resp = graph_get(url, token, params)
        if not resp.is_success:
            logger.warning("[Auth] memberOf returned %s; continuing without group roles", resp.status_code)
            break
        body = resp.json()
        for g in body.get("value", []):
            if g.get("displayName"):
                names.append(g["displayName"])
            if g.get("id"):
                ids.append(g["id"])
        url, params = body.get("@odata.nextLink"), None
    return names, ids


def _fetch_user(token: str) -> Dict:
    me = graph_get("/me", token, {"$select": "id,displayName,mail,userPrincipalName"})
    if me.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if not me.is_success:
        logger.warning("[Auth] /me returned %s", me.status_code)
        raise HTTPException(status_code=503, detail="Identity provider unavailable")
    profile = me.json()
    group_names, group_ids = _fetch_groups(token)
    email = (profile.get("mail") or profile.get("userPrincipalName") or "").lower()
    if not email:
        raise HTTPException(status_code=401, detail="Token has no associated user")
    return {
        "id": profile.get("id"),
        "email": email,
        "displayName": profile.get("displayName") or email,
        "groups": group_names,
        "group_ids": group_ids,
    }


def resolve_user(authorization: Optional[str]) -> Dict:
    """Validate a bearer header and return the caller with a freshly resolved
    role. Identity is cached; the role is re-resolved on every call so a role
    change applies on the very next request."""
    token = _get_access_token(authorization)
    identity = _cache.get(token)
    if identity is None:
        identity = _fetch_user(token)
        _cache.put(token, identity)
    identity["role"] = rbac.resolve_role(identity["email"], identity["groups"], identity["group_ids"])
    return identity


def get_current_user(authorization: Optional[str] = Header(None)) -> Dict:
    """FastAPI dependency for every protected route."""
    return resolve_user(authorization)


def require_permission(permission: str):
    if permission not in rbac.ALL_PERMISSIONS:
        raise ValueError(f"Unknown permission {permission!r}")

    def _dep(authorization: Optional[str] = Header(None)) -> Dict:
        user = resolve_user(authorization)
        if not rbac.has_permission(user["role"], permission):
            raise HTTPException(status_code=403, detail=f"Missing permission: {permission}")
        return user

    return _dep


def require_admin(authorization: Optional[str] = Header(None)) -> Dict:
    user = resolve_user(authorization)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user
