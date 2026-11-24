import json
import logging
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

RBAC_CONFIG_PATH = Path(__file__).parent / "rbac_config.json"
_config_lock = threading.Lock()

# AD group object-id/display-name -> role, read from env same as before
AD_GROUP_ROLES: Dict[str, str] = {}
if os.environ.get("AD_GROUP_ADMIN"):
    AD_GROUP_ROLES[os.environ["AD_GROUP_ADMIN"]] = "admin"
if os.environ.get("AD_GROUP_OPERATIONAL_SUPPORT"):
    AD_GROUP_ROLES[os.environ["AD_GROUP_OPERATIONAL_SUPPORT"]] = "operational_support"

# Priority order when a user is in more than one mapped group
ROLE_PRIORITY = ["admin", "operational_support"]

ROLE_DEFINITIONS: Dict[str, Dict] = {
    "admin": {
        "name": "Admin",
        "description": "Full access to all features including user management",
        "color": "#eb1700",
        "permissions": {
            "viewDashboard": True, "viewEPODStats": True, "viewEPODStatsEPOD": True,
            "viewEPODStatsRIMDOCS": True, "viewServerMonitor": True,
            "viewEPodDev": True, "viewEPodQA": True, "viewEPodProd": True,
            "viewRimdocsDev": True, "viewRimdocsQA": True, "viewRimdocsProd": True,
            "viewServerManagerDev": True, "viewServerManagerQA": True,
            "viewServerManagerProd": True, "viewServerManagerPOC": True,
            "adminAccessDev": True, "adminAccessQA": True, "adminAccessProd": True,
            "adminAccessPOC": True,
            "stopScriptDev": True, "stopScriptQA": True, "stopScriptProd": True,
            "stopScriptRimdocsDev": True, "stopScriptRimdocsQA": True,
            "stopScriptRimdocsProd": True,
            "viewRimdocsDev1": True, "viewRimdocsDev2": True,
            "viewRimdocsQA2": True, "viewRimdocsProd2": True,
            "stopScriptRimdocsDev1": True, "stopScriptRimdocsDev2": True,
            "stopScriptRimdocsQA2": True, "stopScriptRimdocsProd2": True,
            "viewAudit": True, "viewNasScanner": True, "viewUserManagement": True,
            "manageUsers": True, "manageRoles": True,
        },
    },
    "operational_support": {
        "name": "Operational Support",
        "description": "Access to Dashboard, EPOD Stats, and Server Monitor",
        "color": "#328714",
        "permissions": {
            "viewDashboard": True, "viewEPODStats": True, "viewEPODStatsEPOD": True,
            "viewEPODStatsRIMDOCS": True, "viewServerMonitor": True,
            "viewEPodDev": True, "viewEPodQA": True, "viewEPodProd": True,
            "viewRimdocsDev": True, "viewRimdocsQA": True, "viewRimdocsProd": True,
            "viewServerManagerDev": False, "viewServerManagerQA": False,
            "viewServerManagerProd": False, "viewServerManagerPOC": False,
            "adminAccessDev": False, "adminAccessQA": False, "adminAccessProd": False,
            "adminAccessPOC": False,
            "stopScriptDev": False, "stopScriptQA": False, "stopScriptProd": False,
            "stopScriptRimdocsDev": False, "stopScriptRimdocsQA": False,
            "stopScriptRimdocsProd": False,
            "viewRimdocsDev1": True, "viewRimdocsDev2": True,
            "viewRimdocsQA2": True, "viewRimdocsProd2": True,
            "stopScriptRimdocsDev1": False, "stopScriptRimdocsDev2": False,
            "stopScriptRimdocsQA2": False, "stopScriptRimdocsProd2": False,
            "viewNasScanner": True, "viewAudit": False, "viewUserManagement": False,
            "manageUsers": False, "manageRoles": False,
        },
    },
    "viewer": {
        "name": "Viewer",
        "description": "Read-only access to dashboard",
        "color": "#a39992",
        "permissions": {},  # filled in below from the admin key set
    },
}

# viewer gets everything False except viewDashboard - fill it from the admin
# key set so it always has every permission key present (avoids KeyError).
ROLE_DEFINITIONS["viewer"]["permissions"] = {
    k: False for k in ROLE_DEFINITIONS["admin"]["permissions"]
}
ROLE_DEFINITIONS["viewer"]["permissions"]["viewDashboard"] = True


def load_rbac_config() -> dict:
    if not RBAC_CONFIG_PATH.exists():
        return {"custom_roles": {}, "user_role_overrides": {}}
    try:
        with open(RBAC_CONFIG_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {"custom_roles": {}, "user_role_overrides": {}}


def save_rbac_config(config: dict) -> None:
    with _config_lock:
        with open(RBAC_CONFIG_PATH, "w") as f:
            json.dump(config, f, indent=2)


def get_all_roles() -> Dict[str, Dict]:
    cfg = load_rbac_config()
    return {**ROLE_DEFINITIONS, **cfg.get("custom_roles", {})}


def resolve_role(email: str, group_names: List[str], group_ids: List[str]) -> str:
    """
    Server-side role resolution. Never trust a client-supplied role.
    Priority: manual override > AD group membership > default viewer.
    """
    cfg = load_rbac_config()
    overrides = cfg.get("user_role_overrides", {})
    if email and overrides.get(email.lower()):
        return overrides[email.lower()]

    seen = set(group_names) | set(group_ids)
    for priority in ROLE_PRIORITY:
        ad_group = next((g for g, r in AD_GROUP_ROLES.items() if r == priority), None)
        if ad_group and ad_group in seen:
            return priority

    return "viewer"


def has_permission(role: str, permission: str) -> bool:
    roles = get_all_roles()
    role_def = roles.get(role, ROLE_DEFINITIONS["viewer"])
    return role_def.get("permissions", {}).get(permission) is True