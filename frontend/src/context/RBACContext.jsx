import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { apiJson, isAbort } from '../utils/apiClient';

const RBACContext = createContext(null);
const REFRESH_MS = 5 * 60 * 1000;

/**
 * The caller's role and effective permissions, resolved server-side
 * (/api/rbac/me). The UI only uses this to decide what to show; every API
 * call is authorised again by the backend.
 */
export const RBACProvider = ({ children }) => {
  const { user } = useAuth();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const controllerRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const data = await apiJson('/api/rbac/me', { signal: controller.signal });
      setMe(data);
      setError(null);
    } catch (err) {
      if (!isAbort(err)) setError(err.message || 'Unable to load your permissions');
    } finally {
      if (controllerRef.current === controller) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return undefined;
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onFocus);
      controllerRef.current?.abort();
    };
  }, [user, refresh]);

  const value = useMemo(() => {
    const permissions = me?.permissions || {};
    const hasPermission = (p) => permissions[p] === true;
    return {
      loading: loading && !me,
      error,
      refresh,
      userRole: me?.role || 'viewer',
      roleName: me?.role_name || 'Viewer',
      roleColor: me?.role_color || '#a39992',
      permissions,
      hasPermission,
      hasAnyPermission: (list = []) => list.some(hasPermission),
      hasAllPermissions: (list = []) => list.every(hasPermission),
      hasRole: (role) => (Array.isArray(role) ? role : [role]).includes(me?.role),
    };
  }, [me, loading, error, refresh]);

  return <RBACContext.Provider value={value}>{children}</RBACContext.Provider>;
};

export const useRBAC = () => {
  const ctx = useContext(RBACContext);
  if (!ctx) throw new Error('useRBAC must be used within an RBACProvider');
  return ctx;
};
