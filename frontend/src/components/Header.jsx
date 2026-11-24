import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { useProfilePhoto } from '../context/ProfilePhotoContext';
import { Icon, Menu, MenuItem, Badge } from './ui';
import { PAGE_TITLES } from '../navigation';

export function Avatar({ src, name, className = 'w-8 h-8' }) {
  const initials = (name || '?').split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return src ? (
    <img src={src} alt="" className={`${className} rounded-full object-cover ring-1 ring-jj-gray-03 flex-shrink-0`} />
  ) : (
    <span aria-hidden="true" className={`${className} rounded-full bg-jj-gray-02 text-jj-gray-07 font-johnson-display text-xs flex items-center justify-center ring-1 ring-jj-gray-03 flex-shrink-0`}>
      {initials}
    </span>
  );
}

/** Sticky app bar: navigation toggle (mobile), page title, user menu. */
export default function Header({ onMenuClick }) {
  const { user, logout } = useAuth();
  const { roleName, roleColor } = useRBAC();
  const { profilePhoto } = useProfilePhoto();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const title = PAGE_TITLES[location.pathname] || 'RDI-AI Monitoring';

  return (
    <header className="sticky top-0 z-40 flex items-center gap-2 sm:gap-3 h-14 sm:h-16 px-3 sm:px-6 bg-white/95 backdrop-blur border-b border-jj-gray-02 pt-[env(safe-area-inset-top)] box-content">
      <button type="button" onClick={onMenuClick} aria-label="Open navigation"
        className="lg:hidden w-10 h-10 -ml-1 flex items-center justify-center rounded-lg text-jj-gray-07 hover:bg-jj-gray-01 focus-ring">
        <svg viewBox="0 0 20 20" className="w-5 h-5" aria-hidden="true">
          <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="hidden lg:inline-block w-1 h-6 rounded-full bg-jj-red" aria-hidden="true" />
        <p className="font-johnson-display text-base sm:text-lg text-jj-gray-08 truncate">{title}</p>
        <span className="hidden md:inline font-johnson-text text-xs text-jj-gray-05 truncate">RDI-AI Monitoring</span>
      </div>
      <Menu open={open} onOpenChange={setOpen} trigger={(
        <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
          className="flex items-center gap-2.5 rounded-full sm:rounded-lg pl-1 pr-1 sm:pr-2 py-1 hover:bg-jj-gray-01 transition-colors focus-ring">
          <Avatar src={profilePhoto} name={user?.name} />
          <span className="hidden md:flex flex-col items-start min-w-0 max-w-[14rem]">
            <span className="font-johnson-text text-sm text-jj-gray-08 leading-tight truncate max-w-full">{user?.name}</span>
            <span className="font-johnson-text text-xs text-jj-gray-05 leading-tight truncate max-w-full">{roleName}</span>
          </span>
          <Icon name="chevronDown" className={`hidden sm:block w-3 h-3 text-jj-gray-05 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}>
        <div className="px-4 py-3 border-b border-jj-gray-02 flex items-center gap-3">
          <Avatar src={profilePhoto} name={user?.name} className="w-10 h-10" />
          <div className="min-w-0">
            <p className="font-johnson-text text-sm text-jj-gray-08 truncate">{user?.name}</p>
            <p className="font-johnson-text text-xs text-jj-gray-05 truncate">{user?.email}</p>
            <Badge color={roleColor} className="mt-1.5">{roleName}</Badge>
          </div>
        </div>
        <MenuItem tone="danger" onClick={() => { setOpen(false); logout(); }}>
          <span className="flex items-center gap-2"><Icon name="logout" className="w-4 h-4" />Sign out</span>
        </MenuItem>
      </Menu>
    </header>
  );
}
