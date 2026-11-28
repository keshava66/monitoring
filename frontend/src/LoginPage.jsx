import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InteractionStatus } from '@azure/msal-browser';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { loginRequest } from './msalConfig';
import { POST_LOGIN_REDIRECT_KEY } from './context/AuthContext';
import { Alert, Button, Icon, Spinner } from './components/ui';
import { NAV_ITEMS } from './navigation';
import logo from '/sh_logo.png';
import jjLogo from '/jj-logo.png';

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
    <div className="relative min-h-dvh overflow-hidden paper">
      <div aria-hidden="true" className="absolute inset-0 bg-cover bg-center opacity-70 animate-fade-in [animation-duration:2s]" style={{ backgroundImage: 'url(/background.webp)' }} />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-[#f4f1ed] via-[#f4f1ed]/85 to-[#f4f1ed]/30" />
      <div aria-hidden="true" className="absolute -top-40 -right-40 w-[48rem] aspect-square rounded-full animate-halo"
        style={{ background: 'radial-gradient(circle, rgba(235,23,0,0.12) 0%, rgba(140,59,187,0.08) 40%, transparent 70%)' }} />

      <div className="relative min-h-dvh w-full max-w-[1400px] mx-auto px-5 sm:px-10 py-8 sm:py-10 flex flex-col">
        <header className="flex items-center justify-between animate-rise">
          <img src={jjLogo} alt="Johnson & Johnson" className="h-6 sm:h-7 w-auto" />
          <span className="chip"><span className="w-1.5 h-1.5 rounded-full bg-jj-green-03 shadow-[0_0_8px_#328714]" aria-hidden="true" />Internal · SSO protected</span>
        </header>

        <div className="flex-1 grid items-center gap-10 lg:gap-16 py-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <section className="min-w-0">
            <p className="flex items-baseline gap-2 animate-rise">
              <span className="font-johnson-display font-bold text-2xl text-jj-red">RDI-AI</span>
              <span className="font-johnson-display font-light text-xl uppercase tracking-[0.2em] text-jj-gray-07">Monitoring</span>
            </p>
            <h1 className="mt-6 font-johnson-display font-bold text-[2.6rem] sm:text-[3.6rem] xl:text-[4.4rem] leading-[0.98] tracking-[-0.035em] text-jj-gray-08 text-balance">
              {['Where', 'regulatory', 'data'].map((w, i) => (
                <React.Fragment key={w}><span className="inline-block animate-word-in" style={{ animationDelay: `${0.05 + i * 0.07}s` }}>{w}</span>{' '}</React.Fragment>
              ))}
              <span className="block mt-1 font-light italic text-jj-red">
                {['meets', 'intelligence.'].map((w, i) => (
                  <React.Fragment key={w}><span className="inline-block animate-word-in" style={{ animationDelay: `${0.3 + i * 0.08}s` }}>{w}</span>{' '}</React.Fragment>
                ))}
              </span>
            </h1>
            <p className="mt-6 max-w-xl font-johnson-text font-light text-base sm:text-lg leading-relaxed text-jj-gray-07 text-pretty animate-rise [animation-delay:0.3s]">
              One console for the RDI-AI platform: ingestion progress, extraction pipelines, servers, the EPOD archive and a complete audit trail.
            </p>
            <ul className="mt-8 hidden sm:flex flex-wrap gap-2 stagger">
              {NAV_ITEMS.filter((t) => t.path !== '/dashboard').map((t) => (
                <li key={t.path} className="inline-flex items-center gap-2 h-9 pl-1.5 pr-3.5 rounded-full bg-white/80 border border-jj-gray-02 backdrop-blur shadow-[0_10px_24px_-20px_rgba(49,44,42,0.6)] font-johnson-text text-[13px] text-jj-gray-07">
                  <span className="w-6 h-6 rounded-full grid place-items-center" style={{ background: `${t.color}18`, color: t.color }}><Icon name={t.icon} className="w-3.5 h-3.5" /></span>
                  {t.label}
                </li>
              ))}
            </ul>
          </section>

          <main className="w-full max-w-md lg:justify-self-end animate-rise [animation-delay:0.2s]">
            <div className="relative rounded-[28px] bg-white/90 backdrop-blur-md border border-white shadow-lift px-6 py-8 sm:px-9 sm:py-10">
              <span aria-hidden="true" className="absolute -top-px left-10 right-10 h-px bg-gradient-to-r from-transparent via-jj-red/50 to-transparent" />
              <img src={logo} alt="SmartHub" className="h-12 w-auto" />
              <h2 className="mt-6 font-johnson-display font-medium text-2xl tracking-[-0.02em] text-jj-gray-08">Sign in</h2>
              <p className="mt-1.5 font-johnson-text font-light text-[15px] text-jj-gray-06">Use your Johnson &amp; Johnson account. Your role and tools load automatically.</p>
              <div className="mt-8 flex flex-col gap-4">
                {pending ? (
                  <div className="flex items-center justify-center gap-3 h-12 font-johnson-text text-sm text-jj-gray-07" role="status">
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
              <p className="mt-8 pt-5 border-t border-jj-gray-02 font-johnson-text text-xs text-jj-gray-05">
                Trouble signing in? Contact your IT administrator. Access is granted through AD groups.
              </p>
            </div>
          </main>
        </div>

        <footer className="flex flex-wrap justify-between gap-2 font-johnson-text text-xs text-jj-gray-05">
          <span>Confidential · Internal use only</span>
          <span>© {new Date().getFullYear()} Regulatory Data &amp; Insights · Johnson &amp; Johnson</span>
        </footer>
      </div>
    </div>
  );
}
