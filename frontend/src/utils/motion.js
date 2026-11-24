import { useEffect, useSyncExternalStore } from 'react';
import { apiJson } from './apiClient';

/*
 * One motion setting for the whole app, chosen in the account menu. When on,
 * <html> carries "reduce-motion"; CSS keys off that class and scripts read
 * reducedMotion() / useReducedMotion(). The OS setting is ignored on purpose:
 * Windows Cloud PCs report "reduce motion" by default and would freeze the
 * app for everyone on one. The browser keeps a copy so pages start in the
 * right mode; the server copy follows the person to other machines.
 */

const KEY = 'rdi-monitoring:reduce-motion';
const listeners = new Set();

const readSaved = () => {
  try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
};

let current = readSaved();

const apply = () => {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('reduce-motion', current);
};
apply();

export const reducedMotion = () => current;

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Change the setting on this device only. */
export function setReducedMotion(on) {
  const next = Boolean(on);
  if (next === current) return;
  current = next;
  try { localStorage.setItem(KEY, String(next)); } catch { /* storage blocked: holds for this visit */ }
  apply();
  listeners.forEach((fn) => fn(next));
}

/** Change the setting and save it to the person's account. */
export async function saveReducedMotion(on) {
  setReducedMotion(on);
  try {
    await apiJson('/api/audit/preferences', { method: 'PUT', body: { reduce_motion: Boolean(on) } });
  } catch { /* offline: this device already has it */ }
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, reducedMotion, () => false);
}

/** Once per signed-in person: adopt the setting saved on their account. */
export function useSyncedMotionPreference(email) {
  useEffect(() => {
    if (!email) return undefined;
    const ctrl = new AbortController();
    apiJson('/api/audit/preferences', { signal: ctrl.signal })
      .then((d) => { if (typeof d?.preferences?.reduce_motion === 'boolean') setReducedMotion(d.preferences.reduce_motion); })
      .catch(() => { /* offline or aborted: keep this device's copy */ });
    return () => ctrl.abort();
  }, [email]);
}

// Other tabs on this device follow along.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) setReducedMotion(e.newValue === 'true');
  });
}
