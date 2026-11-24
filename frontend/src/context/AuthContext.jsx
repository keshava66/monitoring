import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { InteractionRequiredAuthError, InteractionStatus } from '@azure/msal-browser';
import { useMsal } from '@azure/msal-react';
import { API_SCOPES } from '../msalConfig';
import { logAuditEvent } from '../utils/auditLog';
import { registerTokenGetter, registerUnauthorizedHandler } from '../utils/apiClient';
import { useHeartbeat } from '../hooks/useHeartbeat';

const AuthContext = createContext(null);
const LOGOUT_SIGNAL_KEY = 'rdi-monitoring:logout';
const LOGIN_LOGGED_KEY = 'rdi-monitoring:login-logged';
export const POST_LOGIN_REDIRECT_KEY = 'postLoginRedirect';

export const cleanDisplayName = (name) => (name || '').replace(/\s*\[.*?\]\s*/g, ' ').replace(/\s+/g, ' ').trim();

export const AuthProvider = ({ children }) => {
  const { instance, accounts, inProgress } = useMsal();
  const account = instance.getActiveAccount() || accounts[0] || null;
  const inflight = useRef(new Map());
  const forceRefresh = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const user = useMemo(() => {
    if (!account) return null;
    const email = (account.username || '').toLowerCase();
    return {
      username: account.username,
      email,
      name: cleanDisplayName(account.name) || email,
      id: account.localAccountId,
      tenantId: account.tenantId,
    };
  }, [account]);

  const acquire = useCallback(async (scopes = API_SCOPES) => {
    if (!account) throw new Error('Not signed in');
    const key = scopes.slice().sort().join(' ');
    if (inflight.current.has(key)) return inflight.current.get(key);
    const run = (async () => {
      try {
        const res = await instance.acquireTokenSilent({ scopes, account, forceRefresh: forceRefresh.current });
        forceRefresh.current = false;
        return res.accessToken;
      } catch (err) {
        if (!(err instanceof InteractionRequiredAuthError)) throw err;
        try {
          const res = await instance.acquireTokenPopup({ scopes, account });
          return res.accessToken;
        } catch {
          try {
            sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, window.location.pathname + window.location.search);
          } catch { /* storage unavailable */ }
          await instance.acquireTokenRedirect({ scopes, account });
          throw err;
        }
      } finally {
        inflight.current.delete(key);
      }
    })();
    inflight.current.set(key, run);
    return run;
  }, [account, instance]);

  const getAccessToken = useCallback(() => acquire(API_SCOPES), [acquire]);

  useEffect(() => {
    registerTokenGetter(account ? getAccessToken : null);
    registerUnauthorizedHandler(() => { forceRefresh.current = true; });
    return () => registerTokenGetter(null);
  }, [account, getAccessToken]);

  useHeartbeat(user?.email || null);

  useEffect(() => {
    if (!user || inProgress !== InteractionStatus.None) return;
    try {
      if (sessionStorage.getItem(LOGIN_LOGGED_KEY) === user.email) return;
      sessionStorage.setItem(LOGIN_LOGGED_KEY, user.email);
    } catch { /* storage unavailable: log anyway */ }
    logAuditEvent('user_login', user.email, '', 'User signed in via SSO');
  }, [user, inProgress]);

  const finishLogout = useCallback(async () => {
    try { await instance.clearCache(); } catch { /* already cleared */ }
    try { sessionStorage.clear(); } catch { /* storage unavailable */ }
    window.location.replace(`${window.location.origin}/login`);
  }, [instance]);

  const logout = useCallback(async (reason = 'manual') => {
    if (loggingOut) return;
    setLoggingOut(true);
    await (reason === 'session_expired'
      ? logAuditEvent('session_expired', user?.email, '', 'Session expired due to inactivity')
      : logAuditEvent('user_logout', user?.email, '', 'User signed out'));
    try { localStorage.setItem(LOGOUT_SIGNAL_KEY, String(Date.now())); } catch { /* storage unavailable */ }
    await finishLogout();
  }, [finishLogout, loggingOut, user]);

  // Signing out in one tab signs out every tab.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === LOGOUT_SIGNAL_KEY && e.newValue) finishLogout(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [finishLogout]);

  const value = useMemo(() => ({
    user,
    authenticated: !!user,
    loading: inProgress !== InteractionStatus.None || loggingOut,
    logout,
    getAccessToken,
    acquireToken: acquire,
  }), [user, inProgress, loggingOut, logout, getAccessToken, acquire]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};
