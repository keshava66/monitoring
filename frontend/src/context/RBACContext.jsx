import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from '../utils/apiClient';

// AD Group to Role Mapping — group names loaded from .env (VITE_AD_GROUP_*)
const AD_GROUP_ROLES = {
  ...(import.meta.env.VITE_AD_GROUP_ADMIN              && { [import.meta.env.VITE_AD_GROUP_ADMIN]:              'admin'               }),
  ...(import.meta.env.VITE_AD_GROUP_OPERATIONAL_SUPPORT && { [import.meta.env.VITE_AD_GROUP_OPERATIONAL_SUPPORT]: 'operational_support' }),
};

// ─── Role Definitions ──────────────────────────────────────────────────────────
const ROLE_DEFINITIONS = {
  admin: {
    name: 'Admin',
    description: 'Full access to all features including user management',
    color: '#eb1700',
    permissions: {
      viewDashboard:          true,
      viewEPODStats:          true,
      viewEPODStatsEPOD:      true,
      viewEPODStatsRIMDOCS:   true,
      viewServerMonitor:      true,
      viewEPodDev:            true,
      viewEPodQA:             true,
      viewEPodProd:           true,
      viewRimdocsDev:         true,
      viewRimdocsQA:          true,
      viewRimdocsProd:        true,
      viewServerManagerDev:   true,
      viewServerManagerQA:    true,
      viewServerManagerProd:  true,
      viewServerManagerPOC:   true,
      adminAccessDev:         true,
      adminAccessQA:          true,
      adminAccessProd:        true,
      adminAccessPOC:         true,
      stopScriptDev:          true,
      stopScriptQA:           true,
      stopScriptProd:         true,
      stopScriptRimdocsDev:   true,
      stopScriptRimdocsQA:    true,
      stopScriptRimdocsProd:  true,
      viewRimdocsDev1:        true,
      viewRimdocsDev2:        true,
      viewRimdocsQA2:         true,
      viewRimdocsProd2:       true,
      stopScriptRimdocsDev1:  true,
      stopScriptRimdocsDev2:  true,
      stopScriptRimdocsQA2:   true,
      stopScriptRimdocsProd2: true,
      viewAudit:              true,
      viewNasScanner:         true,
      viewUserManagement:     true,
      manageUsers:            true,
      manageRoles:            true,
    },
  },

  operational_support: {
    name: 'Operational Support',
    description: 'Access to Dashboard, EPOD Stats, and Server Monitor',
    color: '#328714',
    permissions: {
      viewDashboard:          true,
      viewEPODStats:          true,
      viewEPODStatsEPOD:      true,
      viewEPODStatsRIMDOCS:   true,
      viewServerMonitor:      true,
      viewEPodDev:            true,
      viewEPodQA:             true,
      viewEPodProd:           true,
      viewRimdocsDev:         true,
      viewRimdocsQA:          true,
      viewRimdocsProd:        true,
      viewServerManagerDev:   false,
      viewServerManagerQA:    false,
      viewServerManagerProd:  false,
      viewServerManagerPOC:   false,
      adminAccessDev:         false,
      adminAccessQA:          false,
      adminAccessProd:        false,
      adminAccessPOC:         false,
      stopScriptDev:          false,
      stopScriptQA:           false,
      stopScriptProd:         false,
      stopScriptRimdocsDev:   false,
      stopScriptRimdocsQA:    false,
      stopScriptRimdocsProd:  false,
      viewRimdocsDev1:        true,
      viewRimdocsDev2:        true,
      viewRimdocsQA2:         true,
      viewRimdocsProd2:       true,
      stopScriptRimdocsDev1:  false,
      stopScriptRimdocsDev2:  false,
      stopScriptRimdocsQA2:   false,
      stopScriptRimdocsProd2: false,
      viewNasScanner:         true,
      viewAudit:              false,
      viewUserManagement:     false,
      manageUsers:            false,
      manageRoles:            false,
    },
  },

  viewer: {
    name: 'Viewer',
    description: 'Read-only access to dashboard',
    color: '#a39992',
    permissions: {
      viewDashboard:          true,
      viewEPODStats:          false,
      viewEPODStatsEPOD:      false,
      viewEPODStatsRIMDOCS:   false,
      viewServerMonitor:      false,
      viewEPodDev:            false,
      viewEPodQA:             false,
      viewEPodProd:           false,
      viewRimdocsDev:         false,
      viewRimdocsQA:          false,
      viewRimdocsProd:        false,
      viewServerManagerDev:   false,
      viewServerManagerQA:    false,
      viewServerManagerProd:  false,
      viewServerManagerPOC:   false,
      adminAccessDev:         false,
      adminAccessQA:          false,
      adminAccessProd:        false,
      adminAccessPOC:         false,
      stopScriptDev:          false,
      stopScriptQA:           false,
      stopScriptProd:         false,
      stopScriptRimdocsDev:   false,
      stopScriptRimdocsQA:    false,
      stopScriptRimdocsProd:  false,
      viewRimdocsDev1:        false,
      viewRimdocsDev2:        false,
      viewRimdocsQA2:         false,
      viewRimdocsProd2:       false,
      stopScriptRimdocsDev1:  false,
      stopScriptRimdocsDev2:  false,
      stopScriptRimdocsQA2:   false,
      stopScriptRimdocsProd2: false,
      viewNasScanner:         false,
      viewAudit:              false,
      viewUserManagement:     false,
      manageUsers:            false,
      manageRoles:            false,
    },
  },
};

const RBACContext = createContext();

export const RBACProvider = ({ children }) => {
  const { user, loading: authLoading } = useAuth();
  const [customRoles, setCustomRoles]             = useState({});
  const [userRoleOverrides, setUserRoleOverrides] = useState({});
  const [overridesLoaded, setOverridesLoaded]     = useState(false);

  // Fetch RBAC config from backend on mount
  useEffect(() => {
    const fetchRBACConfig = async () => {
      try {
        const response = await apiFetch('/api/rbac/config');
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.config) {
            setCustomRoles(data.config.custom_roles || {});
            setUserRoleOverrides(data.config.user_role_overrides || {});
          }
        }
      } catch (error) {
        console.error('Error fetching RBAC config:', error);
      } finally {
        setOverridesLoaded(true);
      }
    };
    fetchRBACConfig();
  }, []);

const userRole = useMemo(() => {
    if (!user) return 'viewer';

    const userEmail = user.email || user.username;

    // 1. Manual override takes highest priority
    if (userRoleOverrides[userEmail?.toLowerCase()]) {
      return userRoleOverrides[userEmail.toLowerCase()];
    }

    // 2. AD group membership
    if (user.groups && user.groups.length > 0) {
      const rolesPriority = ['admin', 'operational_support'];
      for (const priority of rolesPriority) {
        const adGroup = Object.keys(AD_GROUP_ROLES).find(
          group => AD_GROUP_ROLES[group] === priority
        );
        if (adGroup && user.groups.some(g =>
          g.displayName === adGroup || g.id === adGroup
        )) {
          return priority;
        }
      }
    }

    // 3. Default
    return 'viewer';
  }, [user, userRoleOverrides]);

  // Loading until both auth and RBAC config are resolved
  const loading = authLoading || !overridesLoaded;

  const getAllRoles = () => ({ ...ROLE_DEFINITIONS, ...customRoles });

  const getRoleDefinition = (roleName = null) => {
    const role = roleName || userRole;
    return getAllRoles()[role] || ROLE_DEFINITIONS.viewer;
  };

  // Returns the built-in default for a role, ignoring any custom override —
  // used to diff "before reset" vs "after reset".
  const getDefaultRoleDefinition = (roleId) => ROLE_DEFINITIONS[roleId] || null;

  const hasPermission = (permission) =>
    getRoleDefinition().permissions[permission] === true;

  const hasAnyPermission = (permissions = []) =>
    permissions.some(p => hasPermission(p));

  const hasAllPermissions = (permissions = []) =>
    permissions.every(p => hasPermission(p));

  const hasRole = (role) =>
    Array.isArray(role) ? role.includes(userRole) : userRole === role;

  // ── Custom role CRUD (admin only) ──────────────────────────────────────────

  const createCustomRole = async (roleId, roleDefinition) => {
    if (!hasPermission('manageRoles')) throw new Error('Insufficient permissions to create roles');
    const response = await apiFetch('/api/rbac/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: roleId, role_definition: roleDefinition }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Failed to create role');
    setCustomRoles(prev => ({ ...prev, [roleId]: roleDefinition }));
    return data;
  };

  const updateCustomRole = async (roleId, updates, changesSummary = '') => {
    if (!hasPermission('manageRoles')) throw new Error('Insufficient permissions to update roles');
    const response = await apiFetch(`/api/rbac/roles/${roleId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_definition: updates, changes_summary: changesSummary }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Failed to update role');
    setCustomRoles(prev => ({ ...prev, [roleId]: updates }));
    return data;
  };

  const deleteCustomRole = async (roleId, isReset = false, changesSummary = '') => {
    if (!hasPermission('manageRoles')) throw new Error('Insufficient permissions to delete roles');
    const params = new URLSearchParams();
    if (isReset) params.set('reset', 'true');
    if (changesSummary) params.set('changes_summary', changesSummary);
    const qs = params.toString();
    const response = await apiFetch(`/api/rbac/roles/${roleId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Failed to delete role');
    setCustomRoles(prev => { const u = { ...prev }; delete u[roleId]; return u; });
    setUserRoleOverrides(prev => {
      const u = {};
      Object.keys(prev).forEach(email => { if (prev[email] !== roleId) u[email] = prev[email]; });
      return u;
    });
    return data;
  };

  // ── User role assignment (admin only) ──────────────────────────────────────

  const assignRoleToUser = async (userEmail, roleName) => {
    if (!hasPermission('manageUsers')) throw new Error('Insufficient permissions to assign roles');
    const response = await apiFetch('/api/rbac/user-assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_email: userEmail, role_name: roleName }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Failed to assign role');
    setUserRoleOverrides(prev => ({ ...prev, [userEmail.toLowerCase()]: roleName }));
    return data;
  };

  const removeUserRoleOverride = async (userEmail) => {
    if (!hasPermission('manageUsers')) throw new Error('Insufficient permissions to remove role assignments');
    const response = await apiFetch(`/api/rbac/user-assignments/${encodeURIComponent(userEmail)}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Failed to remove role assignment');
    setUserRoleOverrides(prev => { const u = { ...prev }; delete u[userEmail.toLowerCase()]; return u; });
    return data;
  };

  const getUserAssignedRole  = (userEmail) => userRoleOverrides[userEmail.toLowerCase()] || null;
  const getAllUserOverrides   = () => userRoleOverrides;

  const value = {
    userRole,
    roleDefinition: getRoleDefinition(),
    loading,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    getAllRoles,
    getRoleDefinition,
    getDefaultRoleDefinition,
    createCustomRole,
    updateCustomRole,
    deleteCustomRole,
    assignRoleToUser,
    removeUserRoleOverride,
    getUserAssignedRole,
    getAllUserOverrides,
    AD_GROUP_ROLES,
    customRoles,
  };

  return (
    <RBACContext.Provider value={value}>
      {children}
    </RBACContext.Provider>
  );
};

export const useRBAC = () => {
  const context = useContext(RBACContext);
  if (!context) throw new Error('useRBAC must be used within an RBACProvider');
  return context;
};

// ─── Permission Gate Component ─────────────────────────────────────────────────
export const PermissionGate = ({ permission, permissions, requireAll = false, fallback = null, children }) => {
  const { hasPermission, hasAnyPermission, hasAllPermissions } = useRBAC();
  let hasAccess = false;
  if (permission) {
    hasAccess = hasPermission(permission);
  } else if (permissions) {
    hasAccess = requireAll ? hasAllPermissions(permissions) : hasAnyPermission(permissions);
  }
  return hasAccess ? <>{children}</> : fallback;
};

// ─── Role Gate Component ───────────────────────────────────────────────────────
export const RoleGate = ({ role, roles, fallback = null, children }) => {
  const { hasRole } = useRBAC();
  const allowedRoles = roles || (role ? [role] : []);
  return hasRole(allowedRoles) ? <>{children}</> : fallback;
};