import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InteractionStatus } from '@azure/msal-browser';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { loginRequest } from './msalConfig';
import { POST_LOGIN_REDIRECT_KEY } from './context/AuthContext';
import { Alert, Button, Spinner } from './components/ui';
import logo from '/sh_logo.png';

const ERRORS = {
  user_cancelled: 'Sign-in was cancelled. Please try again.',
  interaction_in_progress: 'A sign-in is already in progress in another window.',
  popup_window_error: 'Your browser blocked the sign-in window. Allow pop-ups for this site and retry.',
};

export default function LoginPage() {
  const navigate = useNavigate();
  const { instance, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const redirected = useRef(false);

  useEffect(() => {
    document.title = 'Sign in · RDI-AI Monitoring';
    if (isAuthenticated && inProgress === InteractionStatus.None && !redirected.current) {
      redirected.current = true;
      let target = '/dashboard';
      try {
        const saved = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
        if (saved && saved.startsWith('/') && !saved.startsWith('//')) target = saved;
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
      } catch { /* storage unavailable */ }
      navigate(target, { replace: true });
    }
  }, [isAuthenticated, inProgress, navigate]);

  const signIn = async () => {
    setBusy(true);
    setError('');
    try {
      await instance.loginRedirect(loginRequest);
    } catch (err) {
      setError(ERRORS[err?.errorCode] || 'Unable to sign in. Please try again or contact your IT administrator.');
      setBusy(false);
    }
  };

  const pending = inProgress !== InteractionStatus.None || (isAuthenticated && !error);

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-10 bg-jj-gray-01 bg-cover bg-center"
      style={{ backgroundImage: 'url(/background.webp)' }}>
      <main className="w-full max-w-sm bg-white/95 backdrop-blur rounded-2xl shadow-overlay border border-white px-6 py-8 sm:px-8 sm:py-10">
        <div className="flex flex-col items-center text-center">
          <img src={logo} alt="SmartHub" className="h-14 sm:h-16 w-auto" />
          <h1 className="mt-6 font-johnson-display text-2xl text-jj-gray-08">RDI-AI Monitoring</h1>
          <p className="mt-1.5 font-johnson-text text-sm text-jj-gray-06">Where regulatory data meets intelligence</p>
        </div>

        <div className="mt-8 flex flex-col gap-4">
          {pending ? (
            <div className="flex items-center justify-center gap-3 h-11 font-johnson-text text-sm text-jj-gray-07" role="status">
              <Spinner className="w-5 h-5 text-jj-red" />
              {inProgress === InteractionStatus.Login ? 'Signing you in…' : 'Loading…'}
            </div>
          ) : (
            <Button variant="primary" size="lg" icon="login" onClick={signIn} loading={busy} className="w-full">
              Sign in with Johnson &amp; Johnson SSO
            </Button>
          )}
          {error && <Alert tone="error">{error}</Alert>}
        </div>

        <p className="mt-8 pt-5 border-t border-jj-gray-02 font-johnson-text text-xs text-jj-gray-06 text-center">
          Trouble signing in? Contact your IT administrator.
        </p>
      </main>
    </div>
  );
}
