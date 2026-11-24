import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { Icon, cx } from './ui';
import { NAV_ITEMS } from '../navigation';
import jjLogo from '/jj-logo.png';
import jjLogoSmall from '/jj-logo-small.png';

const COLLAPSE_KEY = 'rdi-monitoring:sidebar-collapsed';

function NavList({ collapsed, onNavigate }) {
  const { hasPermission, hasAnyPermission } = useRBAC();
  const items = NAV_ITEMS.filter((i) => (i.anyPermissions ? hasAnyPermission(i.anyPermissions) : hasPermission(i.permission)));
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto scroll-none px-3 py-4">
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.path}>
            <NavLink
              to={item.path}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) => cx(
                'group flex items-center gap-3 h-10 rounded-lg font-johnson-text text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
                collapsed ? 'justify-center px-0' : 'px-3',
                isActive ? 'bg-jj-red text-white shadow-sm' : 'text-jj-gray-03 hover:bg-white/10 hover:text-white',
              )}
            >
              <Icon name={item.icon} className="w-5 h-5" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Desktop rail (collapsible) + mobile off-canvas drawer. */
export default function Sidebar({ mobileOpen, onMobileClose }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [collapsed]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { onMobileClose(); }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onMobileClose(); };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [mobileOpen, onMobileClose]);

  return (
    <>
      <aside className={cx('hidden lg:flex flex-col flex-shrink-0 bg-jj-gray-08 transition-[width] duration-200 ease-out', collapsed ? 'w-[4.5rem]' : 'w-64')}>
        <div className={cx('h-16 flex items-center border-b border-white/10', collapsed ? 'justify-center' : 'px-4')}>
          {collapsed ? (
            <span className="w-10 h-10 rounded-full bg-white flex items-center justify-center">
              <img src={jjLogoSmall} alt="Johnson & Johnson" className="w-8 h-8 object-contain" />
            </span>
          ) : (
            <span className="bg-white rounded-lg px-2 py-1">
              <img src={jjLogo} alt="Johnson & Johnson" className="h-8 object-contain" />
            </span>
          )}
        </div>
        <NavList collapsed={collapsed} />
        <div className="p-3 border-t border-white/10">
          <button type="button" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cx('w-full h-10 flex items-center gap-3 rounded-lg text-jj-gray-04 hover:bg-white/10 hover:text-white font-johnson-text text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70', collapsed ? 'justify-center' : 'px-3')}>
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} className="w-4 h-4" />
            {!collapsed && 'Collapse'}
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-jj-gray-08/50 animate-fade-in" onClick={onMobileClose} aria-hidden="true" />
          <aside className="relative h-full w-72 max-w-[85vw] bg-jj-gray-08 flex flex-col shadow-overlay animate-slide-in-left pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            <div className="h-16 flex items-center justify-between px-4 border-b border-white/10">
              <span className="bg-white rounded-lg px-2 py-1">
                <img src={jjLogo} alt="Johnson & Johnson" className="h-8 object-contain" />
              </span>
              <button type="button" onClick={onMobileClose} aria-label="Close navigation"
                className="w-10 h-10 flex items-center justify-center rounded-lg text-jj-gray-03 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
                <Icon name="close" className="w-4 h-4" />
              </button>
            </div>
            <NavList collapsed={false} onNavigate={onMobileClose} />
          </aside>
        </div>
      )}
    </>
  );
}
