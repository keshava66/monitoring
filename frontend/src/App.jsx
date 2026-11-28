import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth, POST_LOGIN_REDIRECT_KEY } from './context/AuthContext';
import { RBACProvider, useRBAC } from './context/RBACContext';
import { SessionTimeoutProvider } from './context/SessionTimeoutContext';
import { ProfilePhotoProvider } from './context/ProfilePhotoContext';
import { FeedbackProvider, Alert, Button, LoadingBlock, EmptyState } from './components/ui';
import ProtectedRoute from './components/ProtectedRoute';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import LoginPage from './LoginPage';
import { logAuditEvent } from './utils/auditLog';
import { useSyncedMotionPreference } from './utils/motion';
import { PAGE_TITLES, PIPELINE_VIEW_PERMISSIONS, SERVER_MANAGER_PERMISSIONS, STATS_PERMISSIONS } from './navigation';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const IngestionStats = lazy(() => import('./pages/EPODStatsPage'));
const ServerMonitor = lazy(() => import('./pages/ServerMonitor'));
const ServerManagePage = lazy(() => import('./pages/ServerManagePage'));
const NasScanner = lazy(() => import('./pages/EPODNasScannerPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const UserManagement = lazy(() => import('./pages/UserManagement'));

// Module scope so StrictMode's double effect run doesn't log a reload twice.
let refreshLogged = false;

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('UI error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunkFailed = /dynamically imported module|Loading chunk|Failed to fetch/i.test(String(this.state.error?.message));
    return (
      <EmptyState
        icon="error"
        title={chunkFailed ? 'A new version is available' : 'Something went wrong on this page'}
        description={chunkFailed ? 'Reload to get the latest version of the app.' : 'The error has been logged. Reload the page or go back to the dashboard.'}
        action={(
          <div className="flex flex-wrap gap-2 justify-center">
            <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload</Button>
            {!chunkFailed && <Button onClick={() => { window.location.href = '/dashboard'; }}>Dashboard</Button>}
          </div>
        )}
      />
    );
  }
}

function RootRedirect() {
  const [target] = useState(() => {
    let saved = null;
    try {
      saved = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    } catch { /* storage unavailable */ }
    return saved && saved.startsWith('/') && !saved.startsWith('//') && saved !== '/' ? saved : '/dashboard';
  });
  return <Navigate to={target} replace />;
}

function PermissionRoute({ permission, permissions, children }) {
  const { loading, hasPermission, hasAnyPermission } = useRBAC();
  if (loading) return <LoadingBlock label="Checking access…" />;
  const allowed = permissions ? hasAnyPermission(permissions) : hasPermission(permission);
  return allowed ? children : <Navigate to="/dashboard" replace />;
}

function useNavigationAudit() {
  const location = useLocation();
  const { user } = useAuth();
  const prev = useRef(null);

  useEffect(() => {
    const path = location.pathname;
    // Only real moves between pages: redirects out of "/" or unknown paths are not visits.
    if (prev.current !== path && PAGE_TITLES[prev.current] && PAGE_TITLES[path]) {
      logAuditEvent('page_access', user?.email, path, `Switched from ${PAGE_TITLES[prev.current]} to ${PAGE_TITLES[path]}`);
    }
    prev.current = path;
  }, [location.pathname, user]);

  useEffect(() => {
    if (refreshLogged) return;
    refreshLogged = true;
    const [entry] = performance.getEntriesByType?.('navigation') || [];
    if (entry?.type === 'reload') {
      const path = window.location.pathname;
      logAuditEvent('page_refreshed', user?.email, path, `Refreshed ${PAGE_TITLES[path] || path} page`);
    }
  }, [user]);
}

function AppShell() {
  const location = useLocation();
  const { error: rbacError, refresh: refreshRbac, loading: rbacLoading } = useRBAC();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const { user } = useAuth();
  useNavigationAudit();
  useSyncedMotionPreference(user?.email || null);

  useEffect(() => {
    const title = PAGE_TITLES[location.pathname];
    document.title = title ? `${title} · RDI-AI Monitoring` : 'RDI-AI Monitoring';
  }, [location.pathname]);

  return (
    <div className="flex h-dvh paper overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[90] focus:px-4 focus:py-2 focus:bg-white focus:rounded-lg focus:shadow-overlay font-johnson-text text-sm">Skip to content</a>
      <Sidebar mobileOpen={navOpen} onMobileClose={closeNav} />
      <div className="flex flex-col flex-1 min-w-0">
        <Header onMenuClick={() => setNavOpen(true)} />
        <main id="main" className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scroll-thin">
          {rbacError && !rbacLoading && (
            <div className="px-4 sm:px-6 lg:px-8 pt-4">
              <Alert tone="error" title="Couldn’t load your permissions" action={<Button size="sm" onClick={refreshRbac}>Retry</Button>}>{rbacError}</Alert>
            </div>
          )}
          <ErrorBoundary key={location.pathname}>
            <Suspense fallback={<LoadingBlock />}>
              <Routes>
                <Route path="/dashboard" element={<PermissionRoute permission="viewDashboard"><Dashboard /></PermissionRoute>} />
                <Route path="/ingestion-stats" element={<PermissionRoute permissions={STATS_PERMISSIONS}><IngestionStats /></PermissionRoute>} />
                <Route path="/extraction-pipelines" element={<PermissionRoute permissions={PIPELINE_VIEW_PERMISSIONS}><ServerMonitor /></PermissionRoute>} />
                <Route path="/server-manager" element={<PermissionRoute permissions={SERVER_MANAGER_PERMISSIONS}><ServerManagePage /></PermissionRoute>} />
                <Route path="/nas-scanner" element={<PermissionRoute permission="viewNasScanner"><NasScanner /></PermissionRoute>} />
                <Route path="/audit" element={<PermissionRoute permission="viewAudit"><AuditPage /></PermissionRoute>} />
                <Route path="/audit-edit" element={<PermissionRoute permission="viewAudit"><AuditPage editable /></PermissionRoute>} />
                <Route path="/audit-edit-force" element={<PermissionRoute permission="viewAudit"><AuditPage editable forceSilent /></PermissionRoute>} />
                <Route path="/user-management" element={<PermissionRoute permission="viewUserManagement"><UserManagement /></PermissionRoute>} />
                <Route path="/" element={<RootRedirect />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <FeedbackProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/*"
              element={(
                <ProtectedRoute>
                  <SessionTimeoutProvider>
                    <RBACProvider>
                      <ProfilePhotoProvider>
                        <AppShell />
                      </ProfilePhotoProvider>
                    </RBACProvider>
                  </SessionTimeoutProvider>
                </ProtectedRoute>
              )}
            />
          </Routes>
        </FeedbackProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
