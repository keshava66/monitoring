import { apiFetch } from './apiClient';

export const logAuditEvent = async (action, userEmail, target = '', details = '') => {
  try {
    await apiFetch('/api/audit/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, target, details }),
    });
  } catch {
    // Non-critical
  }
};