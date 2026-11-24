"""Role-based access control: permission catalog, built-in roles, and the
persisted custom-role / per-user override store.

This module is the single source of truth. The frontend reads the catalog
and role definitions from /api/rbac/config and the caller's effective
permissions from /api/rbac/me, so nothing here is duplicated client-side.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

RBAC_CONFIG_PATH = Path(os.getenv("RBAC_CONFIG_PATH", str(Path(__file__).parent / "rbac_config.json")))

ROLE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}$")

# ── Permission catalog ───────────────────────────────────────────────────────
# Tree shape drives the role editor UI. Every key that appears anywhere here
# is a valid permission; nothing else is accepted when saving a role.

def _env(key: str, stop_key: str, product: str, env_label: str) -> Dict:
    return {
        "key": key,
        "label": f"{product} {env_label}",
        "description": f"View the {product} {env_label} extraction pipeline",
        "children": [{
            "key": stop_key,
            "label": "Start / stop pipeline",
            "description": f"Start, stop and clear the {product} {env_label} pipeline",
            "children": [],
        }],
    }


def _server(env_label: str, suffix: str) -> Dict:
    return {
        "key": f"viewServerManager{suffix}",
        "label": f"{env_label} server",
        "description": f"View service status on the {env_label} manage server",
        "children": [{
            "key": f"adminAccess{suffix}",
            "label": "Admin access",
            "description": f"Stop / restart services, git pull and terminal on {env_label}",
            "children": [],
        }],
    }


PERMISSION_CATALOG: List[Dict] = [
    {"key": "viewDashboard", "label": "Dashboard", "description": "Main dashboard", "children": []},
    {
        "key": "viewEPODStats", "label": "Ingestion Stats", "description": "Ingestion statistics page",
        "children": [
            {"key": "viewEPODStatsEPOD", "label": "EPOD", "description": "EPOD ingestion stats tab", "children": []},
            {"key": "viewEPODStatsRIMDOCS", "label": "RIMDOCS", "description": "RIMDOCS ingestion stats tab", "children": []},
        ],
    },
    {
        "key": "viewServerMonitor", "label": "Extraction Pipelines", "description": "Extraction pipeline monitor",
        "children": [
            _env("viewRimdocsDev", "stopScriptRimdocsDev", "RIMDOCS", "DEV"),
            _env("viewRimdocsQA", "stopScriptRimdocsQA", "RIMDOCS", "QA"),
            _env("viewRimdocsProd", "stopScriptRimdocsProd", "RIMDOCS", "PROD"),
            _env("viewRimdocsDev1", "stopScriptRimdocsDev1", "RIMDOCS", "DEV1"),
            _env("viewRimdocsDev2", "stopScriptRimdocsDev2", "RIMDOCS", "DEV2"),
            _env("viewRimdocsQA2", "stopScriptRimdocsQA2", "RIMDOCS", "QA2"),
            _env("viewRimdocsProd2", "stopScriptRimdocsProd2", "RIMDOCS", "PROD2"),
            _env("viewEPodDev", "stopScriptDev", "EPOD", "DEV"),
            _env("viewEPodQA", "stopScriptQA", "EPOD", "QA"),
            _env("viewEPodProd", "stopScriptProd", "EPOD", "PROD"),
        ],
    },
    {
        "key": "viewServerManager", "label": "Server Manager", "description": "Backend / frontend service control",
        "children": [_server("DEV", "Dev"), _server("QA", "QA"), _server("PROD", "Prod"), _server("POC", "POC")],
    },
    {"key": "viewNasScanner", "label": "NAS Scanner", "description": "EPOD NAS archive analysis", "children": []},
    {"key": "viewAudit", "label": "Audit Log", "description": "Read and export the audit log", "children": []},
    {
        "key": "viewUserManagement", "label": "User Management", "description": "Users, groups and roles",
        "children": [
            {"key": "manageUsers", "label": "Manage users", "description": "Assign and remove user roles", "children": []},
            {"key": "manageRoles", "label": "Manage roles", "description": "Create, edit and delete roles", "children": []},
        ],
    },
]


def _walk(nodes: Iterable[Dict], parent: Optional[str] = None):
    for node in nodes:
        yield node["key"], parent
        yield from _walk(node.get("children", []), node["key"])


PERMISSION_PARENTS: Dict[str, Optional[str]] = dict(_walk(PERMISSION_CATALOG))


def _labels(nodes: Iterable[Dict], prefix: str = "") -> Dict[str, str]:
    out: Dict[str, str] = {}
    for node in nodes:
        label = f"{prefix} › {node['label']}" if prefix else node["label"]
        out[node["key"]] = label
        out.update(_labels(node.get("children", []), label))
    return out


PERMISSION_LABELS: Dict[str, str] = _labels(PERMISSION_CATALOG)
ALL_PERMISSIONS: Tuple[str, ...] = tuple(PERMISSION_PARENTS)

# Admin must always be able to get back into user management, otherwise one
# bad edit to the admin role locks everybody out permanently.
ADMIN_LOCKED_PERMISSIONS = ("viewDashboard", "viewUserManagement", "manageUsers", "manageRoles")


def _perms(granted: Iterable[str]) -> Dict[str, bool]:
    granted = set(granted)
    return {k: k in granted for k in ALL_PERMISSIONS}


_OPS_GRANTED = {
    "viewDashboard", "viewEPODStats", "viewEPODStatsEPOD", "viewEPODStatsRIMDOCS", "viewServerMonitor",
    "viewEPodDev", "viewEPodQA", "viewEPodProd",
    "viewRimdocsDev", "viewRimdocsQA", "viewRimdocsProd",
    "viewRimdocsDev1", "viewRimdocsDev2", "viewRimdocsQA2", "viewRimdocsProd2",
    "viewNasScanner",
}

ROLE_DEFINITIONS: Dict[str, Dict] = {
    "admin": {
        "name": "Admin",
        "description": "Full access to all features including user management",
        "color": "#eb1700",
        "permissions": _perms(ALL_PERMISSIONS),
    },
    "operational_support": {
        "name": "Operational Support",
        "description": "Dashboard, ingestion stats, pipeline monitor and NAS scanner",
        "color": "#328714",
        "permissions": _perms(_OPS_GRANTED),
    },
    "viewer": {
        "name": "Viewer",
        "description": "Read-only access to the dashboard",
        "color": "#a39992",
        "permissions": _perms({"viewDashboard"}),
    },
}
BUILTIN_ROLE_IDS = tuple(ROLE_DEFINITIONS)


def _load_ad_group_roles() -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    for env_key, role in (("AD_GROUP_ADMIN", "admin"), ("AD_GROUP_OPERATIONAL_SUPPORT", "operational_support")):
        for group in (os.environ.get(env_key) or "").split(","):
            if group.strip():
                mapping[group.strip()] = role
    return mapping


AD_GROUP_ROLES: Dict[str, str] = _load_ad_group_roles()
ROLE_PRIORITY = ("admin", "operational_support")


# ── Persistence ──────────────────────────────────────────────────────────────

class RBACStore:
    """JSON-file store with an mtime-validated cache and atomic writes.

    Reads are served from memory and only hit the disk when the file has
    changed, so per-request permission checks are cheap. Every mutation runs
    under one lock as a read-modify-write, so two concurrent edits can never
    silently drop one another.
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._cache: Optional[Dict] = None
        self._mtime: Optional[float] = None

    @staticmethod
    def _empty() -> Dict:
        return {"custom_roles": {}, "user_role_overrides": {}}

    def _read_disk(self) -> Dict:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return self._empty()
        except (OSError, json.JSONDecodeError):
            logger.exception("[RBAC] %s is unreadable; refusing to treat it as empty", self.path)
            raise
        if not isinstance(data, dict):
            raise ValueError(f"{self.path} must contain a JSON object")
        data.setdefault("custom_roles", {})
        data.setdefault("user_role_overrides", {})
        data["custom_roles"] = {rid: _normalize_role(r) for rid, r in data["custom_roles"].items()}
        data["user_role_overrides"] = {e.lower(): r for e, r in data["user_role_overrides"].items()}
        return data

    def load(self) -> Dict:
        with self._lock:
            try:
                mtime = self.path.stat().st_mtime
            except FileNotFoundError:
                mtime = None
            if self._cache is None or mtime != self._mtime:
                self._cache = self._read_disk()
                self._mtime = mtime
            return copy.deepcopy(self._cache)

    def _write(self, config: Dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".rbac_", suffix=".json", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self._cache = copy.deepcopy(config)
        self._mtime = self.path.stat().st_mtime

    def mutate(self, fn):
        """Run fn(config) under the store lock and persist the result."""
        with self._lock:
            config = self.load()
            result = fn(config)
            self._write(config)
            return result


store = RBACStore(RBAC_CONFIG_PATH)


# ── Validation / normalisation ───────────────────────────────────────────────

def _normalize_permissions(perms: Dict) -> Dict[str, bool]:
    out = {k: perms.get(k) is True for k in ALL_PERMISSIONS}
    # Roles saved before a parent key existed (e.g. viewServerManager) still
    # carry granted children; switch the parent on so the editor tree shows
    # them as reachable instead of locked.
    for key, parent in PERMISSION_PARENTS.items():
        if out[key] and parent and parent not in perms:
            node = parent
            while node:
                out[node] = True
                node = PERMISSION_PARENTS[node]
    return out


def _normalize_role(role: Dict) -> Dict:
    return {
        "name": str(role.get("name") or "Unnamed role")[:64],
        "description": str(role.get("description") or "")[:256],
        "color": role.get("color") if COLOR_RE.match(str(role.get("color") or "")) else "#0f68b2",
        "permissions": _normalize_permissions(role.get("permissions") or {}),
    }


class RBACValidationError(ValueError):
    pass


def validate_role_id(role_id: str) -> str:
    if not ROLE_ID_RE.match(role_id or ""):
        raise RBACValidationError("Role ID must be 2-48 chars: lowercase letters, digits and underscores, starting with a letter")
    return role_id


def validate_role_definition(role_id: str, role: Dict) -> Dict:
    name = (role.get("name") or "").strip()
    if not 1 <= len(name) <= 64:
        raise RBACValidationError("Role name must be 1-64 characters")
    description = (role.get("description") or "").strip()
    if len(description) > 256:
        raise RBACValidationError("Description must be 256 characters or fewer")
    color = role.get("color") or "#0f68b2"
    if not COLOR_RE.match(color):
        raise RBACValidationError("Color must be a hex value like #0f68b2")
    perms = role.get("permissions") or {}
    if not isinstance(perms, dict):
        raise RBACValidationError("permissions must be an object")
    unknown = sorted(set(perms) - set(ALL_PERMISSIONS))
    if unknown:
        raise RBACValidationError(f"Unknown permission(s): {', '.join(unknown)}")
    if any(not isinstance(v, bool) for v in perms.values()):
        raise RBACValidationError("Permission values must be true or false")
    normalized = {k: perms.get(k, False) for k in ALL_PERMISSIONS}
    # A child can't be on while its parent is off.
    for key, parent in PERMISSION_PARENTS.items():
        node = parent
        while normalized[key] and node:
            if not normalized[node]:
                normalized[key] = False
            node = PERMISSION_PARENTS[node]
    if role_id == "admin":
        missing = [p for p in ADMIN_LOCKED_PERMISSIONS if not normalized[p]]
        if missing:
            raise RBACValidationError(f"The Admin role must keep: {', '.join(missing)}")
    return {"name": name, "description": description, "color": color.lower(), "permissions": normalized}


def validate_email(email: str) -> str:
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise RBACValidationError("A valid email address is required")
    return email


# ── Queries ──────────────────────────────────────────────────────────────────

def get_all_roles(config: Optional[Dict] = None) -> Dict[str, Dict]:
    config = config if config is not None else store.load()
    return {**copy.deepcopy(ROLE_DEFINITIONS), **config.get("custom_roles", {})}


def resolve_role(email: str, group_names: List[str], group_ids: List[str]) -> str:
    """Server-side role resolution. Never trust a client-supplied role.
    Priority: manual override > AD group membership > viewer."""
    config = store.load()
    override = config["user_role_overrides"].get((email or "").lower())
    if override and override in get_all_roles(config):
        return override
    seen = set(group_names) | set(group_ids)
    for role in ROLE_PRIORITY:
        if any(r == role and g in seen for g, r in AD_GROUP_ROLES.items()):
            return role
    return "viewer"


def permissions_for(role: str) -> Dict[str, bool]:
    roles = get_all_roles()
    return dict(roles.get(role, ROLE_DEFINITIONS["viewer"])["permissions"])


def has_permission(role: str, permission: str) -> bool:
    return permissions_for(role).get(permission) is True
