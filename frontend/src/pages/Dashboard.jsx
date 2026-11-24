import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { useProfilePhoto } from '../context/ProfilePhotoContext';
import { Avatar } from '../components/Header';
import { Badge, EmptyState, Icon, Page } from '../components/ui';
import { NAV_ITEMS } from '../navigation';

const greeting = (d) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');

export default function Dashboard() {
  const { user } = useAuth();
  const { hasPermission, hasAnyPermission, roleName, roleColor } = useRBAC();
  const { profilePhoto } = useProfilePhoto();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const tools = NAV_ITEMS.filter((t) => t.path !== '/dashboard')
    .filter((t) => (t.anyPermissions ? hasAnyPermission(t.anyPermissions) : hasPermission(t.permission)));
  const firstName = (user?.name || '').split(/[\s,]+/).filter(Boolean)[0] || 'there';

  return (
    <Page>
      <section className="bg-white rounded-2xl border border-jj-gray-02 shadow-card overflow-hidden">
        <div className="h-1 bg-jj-red" aria-hidden="true" />
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between px-5 py-5 sm:px-8 sm:py-7">
          <div className="flex items-center gap-4 sm:gap-5 min-w-0">
            <Avatar src={profilePhoto} name={user?.name} className="w-14 h-14 sm:w-16 sm:h-16 text-base" />
            <div className="min-w-0">
              <h1 className="font-johnson-display text-2xl sm:text-3xl text-jj-gray-08 leading-tight text-balance">
                {greeting(now)}, {firstName}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="font-johnson-text text-sm text-jj-gray-06 truncate max-w-full">{user?.email}</span>
                <Badge color={roleColor}>{roleName}</Badge>
              </div>
            </div>
          </div>
          <div className="flex sm:flex-col sm:items-end gap-x-3 font-johnson-text text-jj-gray-06 sm:text-right border-t border-jj-gray-02 pt-4 sm:border-t-0 sm:pt-0 sm:pl-8 sm:border-l">
            <time dateTime={now.toISOString()} className="font-johnson-display text-lg sm:text-2xl text-jj-gray-08 tabular-nums">
              {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </time>
            <span className="text-sm self-center sm:self-auto">
              {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        </div>
      </section>

      <section aria-labelledby="tools-heading" className="flex flex-col gap-3">
        <h2 id="tools-heading" className="font-johnson-display text-xl text-jj-gray-08">Your tools</h2>
        {tools.length === 0 ? (
          <div className="bg-white rounded-2xl border border-jj-gray-02">
            <EmptyState icon="lock" title="No tools assigned yet"
              description="Your role only includes the dashboard. Ask an administrator to assign you a role with access to the tools you need." />
          </div>
        ) : (
          <ul className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-jj-gray-02 rounded-2xl border border-jj-gray-02 overflow-hidden shadow-card">
            {tools.map((tool) => (
              <li key={tool.path} className="bg-white">
                <Link to={tool.path}
                  className="group flex items-center gap-4 h-full px-5 py-4 sm:px-6 sm:py-5 transition-colors hover:bg-jj-gray-01 focus-ring-inset">
                  <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 text-white shadow-sm" style={{ background: tool.color }}>
                    <Icon name={tool.icon} className="w-5 h-5" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-johnson-display text-base sm:text-lg text-jj-gray-08">{tool.label}</span>
                    <span className="block mt-0.5 font-johnson-text text-sm text-jj-gray-06 leading-snug">{tool.description}</span>
                  </span>
                  <Icon name="chevronRight" className="w-4 h-4 text-jj-gray-04 transition-transform group-hover:translate-x-0.5 group-hover:text-jj-red" />
                </Link>
              </li>
            ))}
            {tools.length % 2 === 1 && <li className="hidden lg:block bg-white" aria-hidden="true" />}
          </ul>
        )}
      </section>

      <footer className="pt-2 text-center font-johnson-text text-xs text-jj-gray-05">
        © {now.getFullYear()} RDI · Johnson &amp; Johnson
      </footer>
    </Page>
  );
}
