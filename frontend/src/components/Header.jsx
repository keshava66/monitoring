import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { useProfilePhoto } from '../context/ProfilePhotoContext';
import { Icon, Menu, MenuItem, MenuToggle, Badge } from './ui';
import { saveReducedMotion, useReducedMotion } from '../utils/motion';
import { PAGE_TITLES } from '../navigation';

export function Avatar({ src, name, className = 'w-8 h-8' }) {
  const [failed, setFailed] = useState(null);
  const initials = (name || '?').split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return src && failed !== src ? (
    <img src={src} alt="" onError={() => setFailed(src)} className={`${className} rounded-full object-cover ring-2 ring-white shadow-[0_0_0_1px_rgba(235,23,0,0.35)] flex-shrink-0`} />
  ) : (
    <span aria-hidden="true" className={`${className} rounded-full bg-[#fff3f1] text-jj-red font-johnson-display text-xs flex items-center justify-center ring-1 ring-jj-red/40 flex-shrink-0`}>
      {initials}
    </span>
  );
}

/** Date and a ticking clock; isolated so only this chip re-renders each second. */
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="chip hidden xl:inline-flex" aria-label={now.toLocaleString('en-US')}>
      {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      <span className="w-px h-3 bg-jj-gray-04" aria-hidden="true" />
      <b className="font-johnson-display font-medium text-[12px] tracking-[0.04em] normal-case text-jj-gray-08 tabular-nums">
        {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
      </b>
    </span>
  );
}

/** Sticky app bar: navigation toggle (mobile), page title, user menu. */
export default function Header({ onMenuClick }) {
  const reduceMotion = useReducedMotion();
  const { user, logout } = useAuth();
  const { roleName, roleColor } = useRBAC();
  const { profilePhoto } = useProfilePhoto();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const title = PAGE_TITLES[location.pathname] || 'RDI-AI Monitoring';

  return (
    <header className="sticky top-0 z-40 flex items-center gap-2 sm:gap-4 h-16 px-3 sm:px-6 lg:px-8 bg-white/80 backdrop-blur-md border-b border-jj-gray-02 pt-[env(safe-area-inset-top)] box-content">
      <button type="button" onClick={onMenuClick} aria-label="Open navigation"
        className="lg:hidden w-10 h-10 -ml-1 flex items-center justify-center rounded-xl text-jj-gray-07 hover:bg-jj-gray-01 focus-ring">
        <svg viewBox="0 0 20 20" className="w-5 h-5" aria-hidden="true">
          <path d="M3 5.5h14M3 10h9M3 14.5h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
      <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="font-johnson-display font-bold text-[1.35rem] sm:text-2xl tracking-[-0.02em] text-jj-red">RDI-AI</span>
          <span className="hidden sm:inline font-johnson-display font-light text-lg sm:text-xl tracking-[0.18em] uppercase text-jj-gray-07">Monitoring</span>
        </p>
        <span className="hidden md:block w-px h-7 bg-jj-gray-03" aria-hidden="true" />
        <p className="hidden md:block font-johnson-text text-[11px] uppercase tracking-[0.22em] text-jj-gray-07 truncate">{title}</p>
      </div>
      <LiveClock />
      <Menu open={open} onOpenChange={setOpen} trigger={(
        <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
          className="flex items-center gap-2.5 rounded-2xl pl-1 pr-1 sm:pr-3 py-1 sm:border sm:border-jj-gray-02 bg-white/70 hover:bg-white hover:shadow-[0_10px_24px_-18px_rgba(49,44,42,0.6)] transition-[background-color,box-shadow] duration-200 focus-ring">
          <Avatar src={profilePhoto} name={user?.name} className="w-9 h-9" />
          <span className="hidden md:flex flex-col items-start min-w-0 max-w-[14rem]">
            <span className="font-johnson-text text-sm text-jj-gray-08 leading-tight truncate max-w-full">{user?.name}</span>
            <span className="font-johnson-text text-xs text-jj-gray-05 leading-tight truncate max-w-full">{roleName}</span>
          </span>
          <Icon name="chevronDown" className={`hidden sm:block w-3 h-3 text-jj-gray-05 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}>
        <div className="px-3 pt-3 pb-4 mb-1 border-b border-jj-gray-02 flex items-center gap-3">
          <Avatar src={profilePhoto} name={user?.name} className="w-12 h-12" />
          <div className="min-w-0">
            <p className="font-johnson-text text-sm text-jj-gray-08 truncate">{user?.name}</p>
            <p className="font-johnson-text text-xs text-jj-gray-05 truncate">{user?.email}</p>
            <Badge color={roleColor} className="mt-1.5">{roleName}</Badge>
          </div>
        </div>
        <div role="group" aria-label="Preferences" className="pb-1 mb-1 border-b border-jj-gray-02">
          <p className="px-3 pt-1 pb-1 font-johnson-text text-xs text-jj-gray-06">Preferences</p>
          <MenuToggle label="Reduce motion" hint="Calmer pages, fewer animations" checked={reduceMotion} onChange={saveReducedMotion} />
        </div>
        <MenuItem tone="danger" onClick={() => { setOpen(false); logout(); }}>
          <span className="flex items-center gap-2"><Icon name="logout" className="w-4 h-4" />Sign out</span>
        </MenuItem>
      </Menu>
    </header>
  );
}
