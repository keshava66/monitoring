export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

let _tokenGetter = null;

export function registerTokenGetter(fn) {
  _tokenGetter = fn;
}

export async function apiFetch(path, options = {}) {
  const token = _tokenGetter ? await _tokenGetter() : null;
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${API_BASE_URL}${path}`, { ...options, headers });
}

// Same token, different host — used for the manage.py panel, which is a
// separate service (not proxied through the main backend) but validates
// the exact same Graph token/scopes.
export async function absoluteApiFetch(url, options = {}) {
  const token = _tokenGetter ? await _tokenGetter() : null;
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(url, { ...options, headers });
}