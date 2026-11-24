import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ProtectedRoute = ({ children }) => {
  const { authenticated, loading } = useAuth();
  const location = useLocation();

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-jj-gray-01">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-jj-red mx-auto"></div>
          <p className="mt-4 text-jj-gray-07 font-johnson-text">Verifying authentication...</p>
        </div>
      </div>
    );
  }

  // Redirect to Log in if not authenticated
  if (!authenticated) {
    try {
      if (location.pathname !== '/') {
        sessionStorage.setItem('postLoginRedirect', location.pathname + location.search);
      }
    } catch {
      // non-critical — worst case, login just falls back to /dashboard
    }
    return <Navigate to="/login" replace />;
  }

  // User is authenticated, render the protected content
  return children;
};

export default ProtectedRoute;