import { apiFetch } from './apiClient';

/**
 * Fire-and-forget audit event. The server stamps the user from the token,
 * so the email argument is accepted only for call-site readability.
 */
export const logAuditEvent = async (action, _userEmail, target = '', details = '') => {
  try {
    await apiFetch('/api/audit/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, target: String(target || '').slice(0, 512), details: String(details || '').slice(0, 4000) }),
      keepalive: true,
      timeoutMs: 10_000,
    });
  } catch {
    // Audit writes must never break the UI.
  }
};
