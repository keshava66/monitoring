import React, { useRef, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { RBACProvider, useRBAC } from "./context/RBACContext";
import { SessionTimeoutProvider } from "./context/SessionTimeoutContext";
import { ProfilePhotoProvider } from "./context/ProfilePhotoContext";
import { logAuditEvent } from "./utils/auditLog";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginPage from "./LoginPage";
import Sidebar from "./components/Sidebar";
import Header from "./components/Header";
import Dashboard from "./pages/Dashboard";
import EPODStatsPage from "./pages/EPODStatsPage";
import AuditPage from "./pages/AuditPage";
import UserManagement from "./pages/UserManagement";
import ServerMonitor from "./pages/ServerMonitor";
import ServerManagePage from "./pages/ServerManagePage";
import EPODNasScannerPage from "./pages/EPODNasScannerPage";

// Module-level (not component-level) on purpose: React.StrictMode double-runs
// effects with [] deps once in dev to test cleanup behaviour, and resets refs
// /state on that simulated remount — but it doesn't re-import this module, so
// a flag declared here survives that cycle and prevents a duplicate log. An
// actual browser reload re-executes this module from scratch, resetting it.
let refreshLogGuard = false;

const PAGE_LABELS = {
  '/dashboard':        'Dashboard',
  '/ingestion-stats':       'Ingestion Stats',
  '/extraction-pipelines':   'Extraction Pipelines Monitor',
  '/server-manager':   'Server Manager',
  '/nas-scanner':      'NAS Scanner',
  '/audit':            'Audit Log',
  '/audit-edit':       'Audit Log (Edit Mode)',
  '/audit-edit-force': 'Audit Log (Edit Mode)',
  '/user-management':  'User Management',
};

const RootRedirect = () => {
  const targetRef = useRef(null);
  if (targetRef.current === null) {
    let target = '/dashboard';
    try {
      const saved = sessionStorage.getItem('postLoginRedirect');
      if (saved) {
        sessionStorage.removeItem('postLoginRedirect');
        if (saved !== '/') target = saved;
      }
    } catch {
      // non-critical — falls back to /dashboard
    }
    targetRef.current = target;
  }
  return <Navigate to={targetRef.current} replace />;
};
const PermissionRoute = ({ permission, permissions, children }) => {
  const { loading: rbacLoading, hasPermission, hasAnyPermission } = useRBAC();
  const { loading: authLoading } = useAuth();
  if (authLoading || rbacLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-jj-red" />
      </div>
    );
  }

  const allowed = permissions
    ? hasAnyPermission(permissions)
    : hasPermission(permission);

  if (!allowed) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
};

const AppLayoutInner = () => {
  const location = useLocation();
  const { user } = useAuth();
  const isDashboard = location.pathname === "/dashboard" || location.pathname === "/";
  const prevPathRef = useRef(null);

  useEffect(() => {
    const path = location.pathname;
    const prevPath = prevPathRef.current;
    if (prevPath !== null && prevPath !== path) {
      const email = user?.email || user?.username;
      const fromLabel = PAGE_LABELS[prevPath] || prevPath;
      const toLabel = PAGE_LABELS[path] || path;
      logAuditEvent('page_access', email, path, `Switched from ${fromLabel} to ${toLabel}`);
    }
    prevPathRef.current = path;
  }, [location.pathname, user]);

  // Detect an actual browser refresh (F5 / Ctrl+R / reload button) using the
  // Navigation Timing API. This effect runs once per real page load — unlike
  // the one above, it does NOT fire on in-app route changes, since
  // AppLayoutInner only remounts on a true reload, not on navigation.
  useEffect(() => {
    if (refreshLogGuard) return;
    refreshLogGuard = true;
    try {
      const [entry] = performance.getEntriesByType?.('navigation') || [];
      const navType = entry?.type
        || (performance.navigation?.type === 1 ? 'reload' : null);
      if (navType === 'reload') {
        const path = location.pathname;
        const email = user?.email || user?.username;
        const label = PAGE_LABELS[path] || path;
        logAuditEvent('page_refreshed', email, path, `Refreshed ${label} page`);
      }
    } catch {
      // Navigation Timing API unsupported — skip silently, non-critical
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen bg-jj-gray-01">
      <Sidebar />
      <div className="flex flex-col flex-grow overflow-hidden">
        {isDashboard && <Header />}
        <main className="flex-grow overflow-auto">
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route
              path="/ingestion-stats"
              element={
                <PermissionRoute permissions={['viewEPODStatsEPOD', 'viewEPODStatsRIMDOCS']}>
                  <EPODStatsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="/extraction-pipelines"
              element={
                <PermissionRoute permissions={['viewEPodDev', 'viewEPodQA', 'viewEPodProd']}>
                  <ServerMonitor />
                </PermissionRoute>
              }
            />
            <Route
              path="/server-manager"
              element={
                <PermissionRoute permissions={['viewServerManagerDev', 'viewServerManagerQA', 'viewServerManagerProd', 'viewServerManagerPOC']}>
                  <ServerManagePage />
                </PermissionRoute>
              }
            />
            <Route
              path="/audit"
              element={
                <PermissionRoute permission="viewAudit">
                  <AuditPage />
                </PermissionRoute>
              }
            />
            <Route
              path="/audit-edit"
              element={
                <PermissionRoute permission="viewAudit">
                  <AuditPage editable />
                </PermissionRoute>
              }
            />
            <Route
              path="/audit-edit-force"
              element={
                <PermissionRoute permission="viewAudit">
                  <AuditPage editable forceSilent />
                </PermissionRoute>
              }
            />
            <Route
              path="/user-management"
              element={
                <PermissionRoute permission="viewUserManagement">
                  <UserManagement />
                </PermissionRoute>
              }
            />
            <Route
              path="/nas-scanner"
              element={
                <PermissionRoute permission="viewNasScanner">
                  <EPODNasScannerPage />
                </PermissionRoute>
              }
            />
            <Route path="/" element={<RootRedirect />} />
          </Routes>
        </main>
      </div>
    </div>
  );
};

const AppLayout = () => (
  <SessionTimeoutProvider>
    <RBACProvider>
      <ProfilePhotoProvider>
        <AppLayoutInner />
      </ProfilePhotoProvider>
    </RBACProvider>
  </SessionTimeoutProvider>
);

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}