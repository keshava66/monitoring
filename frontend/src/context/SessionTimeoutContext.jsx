import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { Button, Modal } from '../components/ui';

const SessionTimeoutContext = createContext(null);

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const WARNING_MS = 2 * 60 * 1000;
const ACTIVITY_KEY = 'rdi-monitoring:last-activity';
const EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'];

const readShared = () => {
  try { return Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch { return 0; }
};

/**
 * Signs the user out after 15 minutes without interaction. Activity is
 * shared across tabs through localStorage, so working in one tab keeps the
 * others alive and nobody gets signed out from a tab they forgot about.
 */
export function SessionTimeoutProvider({ children }) {
  const { logout, authenticated } = useAuth();
  const [remaining, setRemaining] = useState(null);
  const local = useRef(0);
  const lastWrite = useRef(0);
  const warning = remaining != null && remaining <= WARNING_MS;
  const warningRef = useRef(false);
  const logoutRef = useRef(logout);
  const expired = useRef(false);
  useEffect(() => { warningRef.current = warning; }, [warning]);
  useEffect(() => { logoutRef.current = logout; }, [logout]);

  const touch = useCallback((force = false) => {
    if (warningRef.current && !force) return;
    const now = Date.now();
    local.current = now;
    if (force || now - lastWrite.current > 5000) {
      lastWrite.current = now;
      try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch { /* storage unavailable */ }
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return undefined;
    touch(true);
    const onActivity = () => touch(false);
    let lastMove = 0;
    const onMove = () => { const n = Date.now(); if (n - lastMove > 1000) { lastMove = n; onActivity(); } };
    EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    window.addEventListener('pointermove', onMove, { passive: true });
    const tick = () => {
      if (expired.current) return;
      const last = Math.max(local.current, readShared());
      const left = INACTIVITY_TIMEOUT_MS - (Date.now() - last);
      if (left <= 0) {
        expired.current = true;
        setRemaining(0);
        logoutRef.current('session_expired');
        return;
      }
      setRemaining(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.removeEventListener('pointermove', onMove);
    };
  }, [authenticated, touch]);

  const stay = () => { touch(true); setRemaining(INACTIVITY_TIMEOUT_MS); };
  const seconds = remaining != null ? Math.max(0, Math.ceil(remaining / 1000)) : 0;
  const circumference = 2 * Math.PI * 44;

  return (
    <SessionTimeoutContext.Provider value={{ resetTimers: stay }}>
      {children}
      <Modal open={authenticated && warning} onClose={stay} title="Are you still there?" size="sm" dismissable={false}
        footer={(
          <>
            <Button onClick={() => logout('manual')}>Sign out now</Button>
            <Button variant="primary" onClick={stay} data-autofocus>Stay signed in</Button>
          </>
        )}>
        <div className="flex flex-col items-center text-center gap-4">
          <div className="relative w-28 h-28" aria-hidden="true">
            <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
              <circle cx="50" cy="50" r="44" fill="none" stroke="#e8e6e3" strokeWidth="6" />
              <circle cx="50" cy="50" r="44" fill="none" stroke="#eb1700" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={circumference} strokeDashoffset={circumference * (1 - seconds / (WARNING_MS / 1000))}
                style={{ transition: 'stroke-dashoffset 1s linear' }} />
            </svg>
            <span className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-johnson-display text-3xl text-jj-red tabular-nums leading-none">{seconds}</span>
              <span className="font-johnson-text text-xs text-jj-gray-06">seconds</span>
            </span>
          </div>
          <p className="font-johnson-text text-sm text-jj-gray-07" aria-live="polite">
            For security you’ll be signed out in <strong className="text-jj-gray-08 tabular-nums">{seconds}s</strong> because there’s been no activity.
          </p>
        </div>
      </Modal>
    </SessionTimeoutContext.Provider>
  );
}

export function useSessionTimeout() {
  const ctx = useContext(SessionTimeoutContext);
  if (!ctx) throw new Error('useSessionTimeout must be used within a SessionTimeoutProvider');
  return ctx;
}
