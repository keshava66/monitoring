import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, POST_LOGIN_REDIRECT_KEY } from '../context/AuthContext';
import { LoadingBlock } from './ui';

export default function ProtectedRoute({ children }) {
  const { authenticated, loading } = useAuth();
  const location = useLocation();

  if (loading && !authenticated) {
    return <div className="min-h-dvh flex items-center justify-center bg-jj-gray-01"><LoadingBlock label="Verifying your session…" /></div>;
  }
  if (!authenticated) {
    try {
      if (location.pathname !== '/') sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, location.pathname + location.search);
    } catch { /* storage unavailable: login falls back to the dashboard */ }
    return <Navigate to="/login" replace />;
  }
  return children;
}
