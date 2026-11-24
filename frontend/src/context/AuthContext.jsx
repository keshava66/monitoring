import React, { createContext, useContext, useEffect, useState } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { useHeartbeat } from '../hooks/useHeartbeat';
import { logAuditEvent } from '../utils/auditLog';
import { registerTokenGetter } from '../utils/apiClient';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useHeartbeat(user?.email || user?.username || null);

  const fetchUserGroups = async (accessToken) => {
    try {
      const response = await fetch('https://graph.microsoft.com/v1.0/me/memberOf', {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.value || [];
    } catch {
      return [];
    }
  };

  useEffect(() => {
    const checkAuth = async () => {
      try {
        if (inProgress !== 'none') return;

        if (isAuthenticated && accounts.length > 0) {
          const account = accounts[0];

          let groups = [];
          try {
            const tokenResponse = await instance.acquireTokenSilent({
              scopes: ['User.Read', 'Group.Read.All'],
              account,
            });
            if (tokenResponse?.accessToken) {
              groups = await fetchUserGroups(tokenResponse.accessToken);
            }
          } catch {
            // Continue without groups — user gets default viewer role
          }

          const userData = {
            username:      account.username,
            name:          account.name || account.username,
            email:         account.username,
            id:            account.localAccountId,
            tenantId:      account.tenantId,
            idTokenClaims: account.idTokenClaims,
            groups,
          };

          setUser(userData);
          setLoading(false);
          try {
            if (!sessionStorage.getItem('auditLoginLogged')) {
              sessionStorage.setItem('auditLoginLogged', '1');
              logAuditEvent('user_login', userData.email, '', 'User signed in via SSO');
            }
          } catch {
            logAuditEvent('user_login', userData.email, '', 'User signed in via SSO');
          }
        } else {
          setUser(null);
          setLoading(false);
        }
      } catch (error) {
        console.error('Auth check error:', error);
        setUser(null);
        setLoading(false);
      }
    };

    checkAuth();
  }, [accounts, inProgress, isAuthenticated, instance]);

  const logout = async (reason = 'manual') => {
    try {
      setLoading(true);
      try { sessionStorage.clear(); } catch { /* non-critical */ }
      if (reason === 'session_expired') {
        await logAuditEvent('session_expired', user?.email || user?.username, '', 'Session expired due to inactivity, user logged out');
      } else {
        await logAuditEvent('user_logout', user?.email || user?.username, '', 'User signed out');
      }
      await instance.clearCache();
      setUser(null);
      window.location.href = window.location.origin + '/login';
    } catch {
      setUser(null);
      window.location.href = window.location.origin + '/login';
    } finally {
      setLoading(false);
    }
  };

  const getAccessToken = async () => {
    if (accounts.length === 0) throw new Error('No authenticated account found');
    try {
      const response = await instance.acquireTokenSilent({
        scopes: ['User.Read', 'Group.Read.All'],
        account: accounts[0],
      });
      return response.accessToken;
    } catch (error) {
      if (error.name === 'InteractionRequiredAuthError') {
        const response = await instance.acquireTokenPopup({
          scopes: ['User.Read', 'Group.Read.All'],
        });
        return response.accessToken;
      }
      throw error;
    }
  };

  // Every backend call needs this token now (backend validates it
  // server-side against Graph — see backend/auth.py). Register it once
  // MSAL has an account to acquire tokens for.
  useEffect(() => {
    if (accounts.length > 0) {
      registerTokenGetter(getAccessToken);
    } else {
      registerTokenGetter(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length, instance]);

  return (
    <AuthContext.Provider value={{
      user,
      authenticated: isAuthenticated && !!user && accounts.length > 0,
      loading: loading || inProgress !== 'none',
      logout,
      getAccessToken,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};