import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { apiJson, requestJson } from '../utils/apiClient';
import { EmptyState, Icon, Page, Section, Skeleton, StatusChip, cx, fmtCompact, fmtNum } from '../components/ui';
import { ToolOrbit } from '../components/HeroArt';
import { MANAGE_SERVERS, NAV_ITEMS } from '../navigation';

const GOOD = '#328714';
const WARN = '#e8a317';
const BAD = '#eb1700';

const greeting = (d) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');
const settle = (p) => p.then((v) => v, () => null);

/** One live figure per tool, fetched in parallel; anything unavailable shows a dash. */
function useToolPulse(paths, servers) {
  const [pulse, setPulse] = useState({});
  const key = `${paths.join('|')}#${servers.map((x) => x.id).join('|')}`;
  useEffect(() => {
    const has = (p) => paths.includes(p);
    const ctrl = new AbortController();
    const opts = { signal: ctrl.signal, timeoutMs: 20_000 };
    const put = (path, value) => { if (!ctrl.signal.aborted) setPulse((s) => ({ ...s, [path]: value })); };

    if (has('/ingestion-stats')) {
      Promise.all([settle(apiJson('/api/rimdocs/dashboard', opts)), settle(apiJson('/api/epod/dashboard', opts))]).then(([r, e]) => {
        const all = [r, e].filter(Boolean);
        if (!all.length) return put('/ingestion-stats', { value: '—', label: 'ingested' });
        const total = all.reduce((a, d) => a + (d.kpis?.total_docs || 0), 0);
        const success = all.reduce((a, d) => a + (d.kpis?.success || 0), 0);
        const stalls = all.reduce((a, d) => a + (d.stalls?.length || 0), 0);
        put('/ingestion-stats', {
          value: total ? `${((success / total) * 100).toFixed(1)}%` : '0%',
          label: `of ${fmtCompact(total)} documents ingested`,
          note: stalls ? `${stalls} stalled` : 'no stalls',
          color: stalls ? WARN : GOOD,
        });
      });
    }
    if (has('/extraction-pipelines')) {
      settle(apiJson('/api/agents/status', opts)).then((d) => {
        const agents = d?.agents || [];
        if (!d) return put('/extraction-pipelines', { value: '—', label: 'pipelines running' });
        if (!agents.length) return put('/extraction-pipelines', { value: '0', label: 'agents configured' });
        const running = agents.filter((a) => a.state === 'running').length;
        const down = agents.filter((a) => a.state === 'unreachable').length;
        put('/extraction-pipelines', {
          value: `${running}/${agents.length}`,
          label: 'pipelines running',
          note: down ? `${down} unreachable` : 'all agents reachable',
          color: down ? BAD : running ? GOOD : WARN,
        });
      });
    }
    if (has('/server-manager')) {
      if (!servers.length) put('/server-manager', { value: '0', label: 'servers configured' });
      else {
        Promise.all(servers.map((x) => settle(requestJson(`${x.url}/health`, opts)))).then((res) => {
          const up = res.filter(Boolean).length;
          put('/server-manager', {
            value: `${up}/${servers.length}`,
            label: 'servers reachable',
            note: up === servers.length ? 'all managers online' : `${servers.length - up} unreachable`,
            color: up === servers.length ? GOOD : up ? WARN : BAD,
          });
        });
      }
    }
    if (has('/nas-scanner')) {
      settle(apiJson('/api/nas/overview', opts)).then((d) => put('/nas-scanner', d?.kpis
        ? { value: d.kpis.total_size || '—', label: `across ${fmtNum(d.kpis.segments)} segments` }
        : { value: '—', label: 'archive size' }));
    }
    if (has('/audit')) {
      settle(apiJson('/api/audit/stats', opts)).then((d) => put('/audit', { value: d ? fmtNum(d.today) : '—', label: 'events today', note: d ? `${fmtNum(d.unique_users)} people` : null }));
    }
    if (has('/user-management')) {
      settle(apiJson('/api/rbac/config', opts)).then((d) => {
        const cfg = d?.config;
        put('/user-management', cfg
          ? { value: String(Object.keys(cfg.roles || {}).length), label: 'roles', note: `${Object.keys(cfg.user_role_overrides || {}).length} manual assignments` }
          : { value: '—', label: 'roles' });
      });
    }
    return () => ctrl.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return pulse;
}

function ToolCard({ tool, pulse, index }) {
  const attention = pulse?.color && pulse.color !== GOOD;
  return (
    <li className="animate-rise" style={{ animationDelay: `${0.1 + index * 0.06}s` }}>
      <Link to={tool.path} style={{ '--c': tool.color, ...(attention ? { borderColor: `${pulse.color}80`, boxShadow: `0 0 0 1px ${pulse.color}55, 0 24px 50px -34px rgba(49,44,42,0.55)` } : null) }}
        className="group relative flex flex-col h-full overflow-hidden rounded-3xl bg-white border border-jj-gray-02 p-6 shadow-soft transition-[transform,box-shadow,border-color] duration-500 ease-out hover:-translate-y-1 hover:shadow-lift focus-ring">
        <div className="flex items-start justify-between gap-4">
          <span className="relative w-12 h-12 rounded-2xl grid place-items-center text-white shadow-[0_14px_28px_-14px_var(--c)] transition-transform duration-500 ease-out group-hover:scale-105 group-hover:-rotate-3"
            style={{ background: `linear-gradient(140deg, ${tool.color}, color-mix(in srgb, ${tool.color} 70%, #000))` }}>
            <Icon name={tool.icon} className="w-[22px] h-[22px]" />
          </span>
        </div>
        <h3 className="mt-5 font-johnson-display font-medium text-xl text-jj-gray-08 tracking-[-0.01em]">{tool.label}</h3>
        <p className="mt-3 font-johnson-text font-light text-sm leading-relaxed text-jj-gray-07 text-pretty">{tool.description}</p>
        <div className="mt-auto pt-6 flex items-end justify-between gap-3">
          <div className="min-w-0">
            {pulse ? (
              <>
                <p className="font-johnson-display text-[2.25rem] leading-none tracking-[-0.03em] text-jj-gray-08 tabular-nums truncate">{pulse.value}</p>
                <p className="mt-1.5 font-johnson-text text-sm text-jj-gray-06 truncate">{pulse.label}</p>
                {pulse.note && (
                  <p className="mt-2 flex items-center gap-2 font-johnson-text font-medium text-[15px] truncate" style={{ color: pulse.color || '#6e6259' }}>
                    {pulse.color && <span className={cx('w-2 h-2 rounded-full shrink-0', attention && 'animate-breathe')} style={{ background: pulse.color }} />}
                    {pulse.note}
                  </p>
                )}
              </>
            ) : (
              <>
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-3 w-28 mt-2" />
              </>
            )}
          </div>
          <span className="flex items-center gap-2 font-johnson-text text-sm text-jj-gray-07 group-hover:text-[color:var(--c)] transition-colors duration-300">
            Open
            <span className="w-8 h-8 rounded-full border border-jj-gray-02 grid place-items-center transition-[background-color,border-color,color,transform] duration-300 ease-out group-hover:translate-x-1 group-hover:text-white group-hover:border-transparent group-hover:bg-[color:var(--c)]">
              <Icon name="chevronRight" className="w-3 h-3" />
            </span>
          </span>
        </div>
      </Link>
    </li>
  );
}

function ToolSearch({ tools }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const input = useRef(null);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? tools.filter((t) => `${t.label} ${t.description} ${t.group}`.toLowerCase().includes(s)) : tools;
  }, [q, tools]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || ''))) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative max-w-lg">
      <div className="relative flex items-center gap-3 h-12 pl-4 pr-2 rounded-2xl bg-white/90 border border-jj-gray-07/15 backdrop-blur shadow-[0_24px_50px_-30px_rgba(49,44,42,0.55)] transition-[border-color,box-shadow] duration-300 focus-within:border-jj-red/45 focus-within:shadow-[0_26px_60px_-28px_rgba(235,23,0,0.35),0_0_0_4px_rgba(235,23,0,0.07)]">
        <Icon name="search" className="w-4 h-4 text-jj-red" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) navigate(matches[0].path); if (e.key === 'Escape') { setQ(''); e.currentTarget.blur(); } }}
          placeholder="Jump to a tool…" aria-label="Jump to a tool"
          className="flex-1 min-w-0 bg-transparent font-johnson-text text-[15px] text-jj-gray-08 placeholder:text-jj-gray-05 focus:outline-none" />
        <span className="kbd hidden sm:inline-flex">Ctrl K</span>
      </div>
      {focused && (
        <ul className="absolute z-30 left-0 right-0 mt-2 p-1.5 rounded-2xl bg-white border border-jj-gray-02 shadow-overlay animate-pop-in">
          {matches.length === 0 && <li className="px-3 py-2.5 font-johnson-text text-sm text-jj-gray-06">No tool matches “{q}”.</li>}
          {matches.map((t, i) => (
            <li key={t.path}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); navigate(t.path); }}
                className={cx('w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors hover:bg-jj-gray-01', i === 0 && q && 'bg-jj-gray-01')}>
                <span className="w-8 h-8 rounded-lg grid place-items-center" style={{ background: `${t.color}14`, color: t.color }}><Icon name={t.icon} className="w-4 h-4" /></span>
                <span className="flex-1 min-w-0">
                  <span className="block font-johnson-display text-[15px] text-jj-gray-08">{t.label}</span>
                  <span className="block font-johnson-text text-xs text-jj-gray-05 truncate">{t.description}</span>
                </span>
                {i === 0 && q && <span className="kbd">Enter</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { hasPermission, hasAnyPermission, roleName, roleColor } = useRBAC();
  const navigate = useNavigate();
  const [now] = useState(() => new Date());

  const tools = useMemo(() => NAV_ITEMS.filter((t) => t.path !== '/dashboard')
    .filter((t) => (t.anyPermissions ? hasAnyPermission(t.anyPermissions) : hasPermission(t.permission))), [hasPermission, hasAnyPermission]);
  const servers = useMemo(() => MANAGE_SERVERS.filter((x) => hasPermission(x.permission)), [hasPermission]);
  const pulse = useToolPulse(tools.map((t) => t.path), servers);
  const firstName = (user?.name || '').split(/[\s,]+/).filter(Boolean)[0] || 'there';
  const readings = Object.values(pulse);
  const checking = readings.length < tools.length;
  const unavailable = readings.filter((p) => p.value === '—').length;
  const attention = readings.filter((p) => p.color && p.color !== GOOD).length + unavailable;

  return (
    <Page>
      <header className="relative isolate grid items-center gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div aria-hidden="true" className="pointer-events-none absolute -z-10 -inset-x-10 -top-10 -bottom-4 hero-grid" />
        <div aria-hidden="true" className="pointer-events-none absolute -z-10 -top-32 right-[-6rem] w-[46rem] max-w-[120%] aspect-square rounded-full animate-halo"
          style={{ background: 'radial-gradient(circle, rgba(235,23,0,0.12) 0%, rgba(140,59,187,0.09) 40%, rgba(255,255,255,0) 70%)' }} />
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2 mb-4 animate-rise">
            <StatusChip color={roleColor} live>{roleName}</StatusChip>
            {tools.length > 0 && (
              <StatusChip color={checking ? '#cbc4bc' : attention ? WARN : GOOD} live={!checking && !!attention}>
                {checking ? 'Checking tools…' : attention ? `${attention} ${attention === 1 ? 'tool needs' : 'tools need'} a look` : 'All systems reporting'}
              </StatusChip>
            )}
          </div>
          <h1 className="font-johnson-display font-bold text-[2.1rem] sm:text-[2.75rem] 2xl:text-[3.25rem] leading-[1] tracking-[-0.035em] text-jj-gray-08 text-balance">
            <span className="inline-block animate-word-in">{greeting(now)},</span>{' '}
            <span className="inline-block animate-word-in [animation-delay:0.08s] bg-clip-text text-transparent animate-sweep"
              style={{ backgroundImage: 'linear-gradient(100deg,#312c2a 0%,#312c2a 40%,#eb1700 50%,#312c2a 60%,#312c2a 100%)', backgroundSize: '300% 100%' }}>
              {firstName}.
            </span>
            <span className="block mt-1 font-light italic text-jj-red">
              {['What', 'are', 'we', 'watching?'].map((w, i) => (
                <React.Fragment key={w}><span className="inline-block animate-word-in" style={{ animationDelay: `${0.3 + i * 0.07}s` }}>{w}</span>{' '}</React.Fragment>
              ))}
            </span>
          </h1>
          <p className="mt-3 max-w-lg font-johnson-text font-light text-[15px] sm:text-base leading-relaxed text-jj-gray-07 text-pretty animate-rise [animation-delay:0.25s]">
            Ingestion runs, extraction pipelines, servers and the archive, live from the platform. Pick a tool, or jump straight to one.
          </p>
          <div className="mt-5 animate-rise [animation-delay:0.35s]">
            <ToolSearch tools={tools} />
          </div>
        </div>
        {tools.length > 0 && (
          <div className="hidden md:block animate-fade-in [animation-duration:1.4s]">
            <ToolOrbit tools={tools} status={pulse} onLaunch={(t) => navigate(t.path)} />
          </div>
        )}
      </header>

      <Section title="Your" accent="toolkit." description={tools.length ? `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} for the ${roleName} role, with a live reading from each.` : `Nothing is assigned to the ${roleName} role yet.`}>
        {tools.length === 0 ? (
          <div className="surface">
            <EmptyState icon="lock" title="No tools assigned yet"
              description="Your role only includes the dashboard. Ask an administrator to assign you a role with access to the tools you need." />
          </div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4 sm:gap-5">
            {tools.map((tool, i) => <ToolCard key={tool.path} tool={tool} pulse={pulse[tool.path]} index={i} />)}
          </ul>
        )}
      </Section>

      <footer className="pt-4 flex flex-wrap items-center justify-between gap-2 font-johnson-text text-xs text-jj-gray-05">
        <span>Confidential · Internal use only</span>
        <span>© {now.getFullYear()} Regulatory Data &amp; Insights · Johnson &amp; Johnson</span>
      </footer>
    </Page>
  );
}
