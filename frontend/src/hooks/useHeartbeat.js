import { useEffect, useRef } from 'react';
import { apiFetch } from '../utils/apiClient';

const HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_WINDOW_MS = 60_000;
const EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'];

/** Tells the backend this user is active (Audit → Active Now) while they interact. */
export function useHeartbeat(userEmail) {
  const lastActivity = useRef(0);

  useEffect(() => {
    if (!userEmail) return undefined;
    lastActivity.current = Date.now();
    const mark = () => { lastActivity.current = Date.now(); };
    EVENTS.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    let lastMove = 0;
    const onMove = () => {
      const now = Date.now();
      if (now - lastMove > 1000) { lastMove = now; mark(); }
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity.current > ACTIVITY_WINDOW_MS) return;
      apiFetch('/api/audit/heartbeat', { method: 'POST', timeoutMs: 10_000 }).catch(() => {});
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => {
      clearInterval(id);
      EVENTS.forEach((e) => window.removeEventListener(e, mark));
      window.removeEventListener('pointermove', onMove);
    };
  }, [userEmail]);
}
