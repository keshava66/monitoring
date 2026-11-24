import { useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../utils/apiClient';

const HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_TIMEOUT_MS   = 60_000;

function debounce(fn, ms) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

export function useHeartbeat(userEmail) {
  const lastActivityRef = useRef(null);
  const intervalRef     = useRef(null);
  const emailRef        = useRef(userEmail);

  useEffect(() => { emailRef.current = userEmail; }, [userEmail]);

  const sendHeartbeat = useCallback(async () => {
    const email = emailRef.current;
    if (!email || !lastActivityRef.current) return;
    if (Date.now() - lastActivityRef.current > ACTIVITY_TIMEOUT_MS) return;
    try {
      await apiFetch('/api/audit/heartbeat', { method: 'POST' });
    } catch { /* non-critical */ }
  }, []);

  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (!userEmail) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    // Discrete events fire once per action — no debounce needed.
    const discreteEvents = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
    discreteEvents.forEach(e => window.addEventListener(e, recordActivity, { passive: true }));

    // mousemove fires hundreds of times per second — debounce to 500 ms.
    const debouncedMouseMove = debounce(recordActivity, 500);
    window.addEventListener('mousemove', debouncedMouseMove, { passive: true });

    intervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    return () => {
      discreteEvents.forEach(e => window.removeEventListener(e, recordActivity));
      window.removeEventListener('mousemove', debouncedMouseMove);
      debouncedMouseMove.cancel();
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [userEmail, sendHeartbeat, recordActivity]);
}