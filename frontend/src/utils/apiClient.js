import { GRAPH_BASE } from '../msalConfig';

// Environment (Vite):
//   VITE_API_BASE_URL            monitoring backend origin, e.g. https://host:8501
//   VITE_MANAGE_API_{DEV,QA,PROD,POC}_URL   manage.py panels (VITE_MANAGE_API_URL = fallback)
//   VITE_MSAL_CLIENT_ID / VITE_MSAL_TENANT_ID   Entra app registration
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

const DEFAULT_TIMEOUT_MS = 30_000;

let tokenGetter = null;
let unauthorizedHandler = null;

export function registerTokenGetter(fn) {
  tokenGetter = fn;
}

export function registerUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function authHeaders(extra) {
  const headers = { ...(extra || {}) };
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** fetch() against an absolute URL with the user's bearer token attached. */
export async function absoluteApiFetch(url, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers, ...options } = {}) {
  const { signal: merged, cleanup } = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { ...options, headers: await authHeaders(headers), signal: merged });
    if (res.status === 401 && unauthorizedHandler) unauthorizedHandler();
    return res;
  } finally {
    cleanup();
  }
}

/** fetch() against the monitoring backend. Returns the raw Response. */
export function apiFetch(path, options) {
  return absoluteApiFetch(`${API_BASE_URL}${path}`, options);
}

export async function errorMessage(res) {
  const body = await res.json().catch(() => null);
  const detail = body?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  if (res.status === 403) return 'You do not have permission to do that.';
  if (res.status === 401) return 'Your session has expired. Please sign in again.';
  if (res.status >= 500) return `Server error (${res.status}). Please retry.`;
  return `Request failed (${res.status})`;
}

/** JSON request helper: throws ApiError with the server's message on failure. */
export async function requestJson(url, { body, method = body !== undefined ? 'POST' : 'GET', ...options } = {}) {
  const res = await absoluteApiFetch(url, {
    method,
    ...options,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  if (res.status === 204) return null;
  return res.json();
}

export function apiJson(path, options) {
  return requestJson(`${API_BASE_URL}${path}`, options);
}

export function isAbort(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

async function* readLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Stream newline-delimited JSON from the backend. */
export async function streamNdjson(path, { signal, onMessage }) {
  const res = await apiFetch(path, { signal, timeoutMs: 0, cache: 'no-store' });
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  for await (const line of readLines(res)) {
    if (line.trim()) onMessage(JSON.parse(line));
  }
}

/**
 * Server-sent events over fetch (so the bearer token travels in a header,
 * never in a URL). Resolves when the stream ends; rejects on HTTP errors.
 */
/**
 * Server-sent events over fetch (so the bearer token stays in a header).
 * onEvent(data, { event, id, hasData }) fires per event block; blocks that
 * only carry an `id:` still fire so callers can track the resume point.
 */
export async function streamSse(path, { signal, onOpen, onEvent }) {
  const res = await apiFetch(path, { signal, timeoutMs: 0, headers: { Accept: 'text/event-stream' }, cache: 'no-store' });
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  onOpen?.();
  let data = [];
  let event = 'message';
  let id = null;
  const flush = () => {
    if (data.length || id !== null || event !== 'message') onEvent(data.join('\n'), { event, id, hasData: data.length > 0 });
    data = [];
    event = 'message';
    id = null;
  };
  for await (const line of readLines(res)) {
    if (line === '') flush();
    else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
  }
  flush();
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Microsoft Graph (directory lookups for names / photos / groups) ──────────

const graphCache = new Map();

export async function graphJson(path, token, { signal } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error?.message || `Directory request failed (${res.status})`, res.status);
  }
  return res.json();
}

/** Cached profile photo object URL for a user id or UPN; null when none. */
export async function graphPhoto(idOrUpn, token) {
  const key = `photo:${idOrUpn.toLowerCase()}`;
  if (graphCache.has(key)) return graphCache.get(key);
  const pending = fetch(`${GRAPH_BASE}/users/${encodeURIComponent(idOrUpn)}/photos/64x64/$value`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
    .catch(() => null);
  graphCache.set(key, pending);
  return pending;
}

/** Directory names carry suffixes like "[JNJ]"; strip them for display. */
export const cleanDisplayName = (name) => (name || '').replace(/\s*\[.*?\]\s*/g, ' ').replace(/\s+/g, ' ').trim();

/** Cached displayName lookup by email/UPN; null when not found. */
export async function graphDisplayName(upn, token) {
  const key = `name:${upn.toLowerCase()}`;
  if (graphCache.has(key)) return graphCache.get(key);
  const pending = graphJson(`/users/${encodeURIComponent(upn)}?$select=displayName`, token)
    .then((d) => cleanDisplayName(d.displayName) || null)
    .catch(() => null);
  graphCache.set(key, pending);
  return pending;
}

/** OData string literal escaping for $filter expressions. */
export const odata = (s) => String(s).replace(/'/g, "''");

/** Runs async tasks with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
