import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { Icon, cx } from './ui';
import { NAV_GROUPS, NAV_ITEMS } from '../navigation';
import jjLogo from '/jj-logo.png';
import jjLogoSmall from '/jj-logo-small.png';

const COLLAPSE_KEY = 'rdi-monitoring:sidebar-collapsed';

function NavList({ collapsed, onNavigate }) {
  const { hasPermission, hasAnyPermission } = useRBAC();
  const items = NAV_ITEMS.filter((i) => (i.anyPermissions ? hasAnyPermission(i.anyPermissions) : hasPermission(i.permission)));
  const groups = NAV_GROUPS.map((g) => ({ name: g, items: items.filter((i) => i.group === g) })).filter((g) => g.items.length);
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto scroll-none px-3 py-5">
      {groups.map((group, gi) => (
        <div key={group.name} className={cx(gi > 0 && 'mt-6')}>
          {collapsed ? (
            gi > 0 && <span className="block mx-auto mb-3 w-6 h-px bg-jj-gray-03" aria-hidden="true" />
          ) : (
            <p className="px-3 mb-2 font-johnson-text text-[10.5px] uppercase tracking-[0.2em] text-jj-gray-05">{group.name}</p>
          )}
          <ul className="flex flex-col gap-1">
            {group.items.map((item) => (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) => cx(
                    'group relative flex items-center gap-3 h-11 rounded-xl font-johnson-text text-[14.5px] transition-[background-color,color,box-shadow] duration-300 ease-out focus-ring',
                    collapsed ? 'justify-center px-0 w-12 mx-auto' : 'px-3',
                    isActive ? 'bg-jj-red text-white shadow-glow' : 'text-jj-gray-07 hover:bg-white hover:text-jj-gray-08 hover:shadow-[0_10px_24px_-18px_rgba(49,44,42,0.6)]',
                  )}
                >
                  {({ isActive }) => (
                    <>
                      <Icon name={item.icon} className={cx('w-[18px] h-[18px] transition-transform duration-300 ease-out group-hover:scale-110', !isActive && 'text-jj-gray-06 group-hover:text-jj-red')} />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
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
      <aside className={cx('relative hidden lg:flex flex-col flex-shrink-0 bg-[#fbfaf8] border-r border-jj-gray-02 transition-[width] duration-300 ease-out', collapsed ? 'w-[5rem]' : 'w-[16.5rem]')}>
        <div className={cx('h-16 flex items-center border-b border-jj-gray-02', collapsed ? 'justify-center' : 'px-6')}>
          {collapsed
            ? <img src={jjLogoSmall} alt="Johnson & Johnson" className="w-9 h-9 object-contain" />
            : <img src={jjLogo} alt="Johnson & Johnson" className="h-7 object-contain" />}
        </div>
        <button type="button" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute -right-3.5 top-[4.5rem] z-10 w-7 h-7 rounded-full bg-white border border-jj-gray-02 shadow-soft flex items-center justify-center text-jj-red hover:scale-110 transition-transform duration-200 focus-ring">
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} className="w-3 h-3" />
        </button>
        <NavList collapsed={collapsed} />
        <div className={cx('border-t border-jj-gray-02 py-4 font-johnson-text text-[11px] text-jj-gray-05', collapsed ? 'text-center px-2' : 'px-6')}>
          {collapsed ? 'RDI' : 'Regulatory Data & Insights · Internal use'}
        </div>
      </aside>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-[#1f1b18]/40 backdrop-blur-[2px] animate-fade-in" onClick={onMobileClose} aria-hidden="true" />
          <aside className="relative h-full w-72 max-w-[85vw] bg-[#fbfaf8] flex flex-col shadow-overlay rounded-r-[28px] animate-slide-in-left pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            <div className="h-16 flex items-center justify-between px-5 border-b border-jj-gray-02">
              <img src={jjLogo} alt="Johnson & Johnson" className="h-7 object-contain" />
              <button type="button" onClick={onMobileClose} aria-label="Close navigation"
                className="w-10 h-10 flex items-center justify-center rounded-xl text-jj-gray-07 hover:bg-white focus-ring">
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
