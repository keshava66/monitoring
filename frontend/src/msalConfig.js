import { LogLevel } from '@azure/msal-browser';

const CLIENT_ID = import.meta.env.VITE_MSAL_CLIENT_ID || '574b1b8c-3ee9-44ef-9950-b29cab62a260';
const TENANT_ID = import.meta.env.VITE_MSAL_TENANT_ID || '3ac94b33-9135-4821-9502-eafda6592a35';
const AUTHORITY_HOST = (import.meta.env.VITE_MSAL_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/$/, '');

export const msalConfig = {
  auth: {
    clientId: CLIENT_ID,
    authority: `${AUTHORITY_HOST}/${TENANT_ID}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: `${window.location.origin}/login`,
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: 'localStorage',
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Error,
      piiLoggingEnabled: false,
      loggerCallback: (level, message, containsPii) => {
        if (!containsPii && level === LogLevel.Error) console.error(message);
      },
    },
  },
};

// Graph scopes. The backend validates this same token against Graph and
// resolves the caller's role server-side; the directory scopes are only
// needed by the User Management screens.
export const API_SCOPES = ['User.Read', 'Group.Read.All'];
export const DIRECTORY_SCOPES = ['User.Read.All', 'Group.Read.All', 'GroupMember.Read.All'];

export const loginRequest = {
  scopes: ['openid', 'profile', 'email', 'offline_access', ...new Set([...API_SCOPES, ...DIRECTORY_SCOPES])],
};

export const GRAPH_BASE = (import.meta.env.VITE_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
