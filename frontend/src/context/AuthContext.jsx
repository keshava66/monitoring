import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { InteractionRequiredAuthError, InteractionStatus } from '@azure/msal-browser';
import { useMsal } from '@azure/msal-react';
import { API_SCOPES } from '../msalConfig';
import { logAuditEvent } from '../utils/auditLog';
import { cleanDisplayName, registerTokenGetter, registerUnauthorizedHandler } from '../utils/apiClient';
import { useHeartbeat } from '../hooks/useHeartbeat';

const AuthContext = createContext(null);
const LOGOUT_SIGNAL_KEY = 'rdi-monitoring:logout';
const LOGIN_LOGGED_KEY = 'rdi-monitoring:login-logged';
export const POST_LOGIN_REDIRECT_KEY = 'postLoginRedirect';

let msal = null;
let forceRefresh = false;
const inflight = new Map();

const currentAccount = () => (msal ? msal.getActiveAccount() || msal.getAllAccounts()[0] || null : null);

// Single-flight token acquisition: silent first, then popup, then a full
// redirect when popups are blocked. Lives outside React so the API client can
// attach a bearer token on the very first request any provider makes.
export function acquireToken(scopes = API_SCOPES) {
  const account = currentAccount();
  if (!account) return Promise.reject(new Error('Not signed in'));
  const key = scopes.slice().sort().join(' ');
  if (inflight.has(key)) return inflight.get(key);
  const run = (async () => {
    try {
      const res = await msal.acquireTokenSilent({ scopes, account, forceRefresh });
      forceRefresh = false;
      return res.accessToken;
    } catch (err) {
      if (!(err instanceof InteractionRequiredAuthError)) throw err;
      try {
        const res = await msal.acquireTokenPopup({ scopes, account });
        return res.accessToken;
      } catch {
        try {
          sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, window.location.pathname + window.location.search);
        } catch { /* storage unavailable */ }
        await msal.acquireTokenRedirect({ scopes, account });
        throw err;
      }
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

export function bindMsal(instance) {
  msal = instance;
  registerTokenGetter(() => (currentAccount() ? acquireToken(API_SCOPES) : null));
  registerUnauthorizedHandler(() => { forceRefresh = true; });
}

export const AuthProvider = ({ children }) => {
  const { instance, accounts, inProgress } = useMsal();
  const account = instance.getActiveAccount() || accounts[0] || null;
  const [loggingOut, setLoggingOut] = useState(false);

  // Keyed on primitives: MSAL hands back a fresh account object on every
  // cache event, which would otherwise refetch everything that depends on user.
  const username = account?.username || '';
  const accountName = account?.name || '';
  const accountId = account?.localAccountId || '';
  const tenantId = account?.tenantId || '';
  const user = useMemo(() => {
    if (!username) return null;
    const email = username.toLowerCase();
    return { username, email, name: cleanDisplayName(accountName) || email, id: accountId, tenantId };
  }, [username, accountName, accountId, tenantId]);

  const signedIn = !!user;
  const acquire = useCallback((scopes = API_SCOPES) => {
    if (!signedIn) return Promise.reject(new Error('Not signed in'));
    return acquireToken(scopes);
  }, [signedIn]);

  const getAccessToken = useCallback(() => acquire(API_SCOPES), [acquire]);

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
