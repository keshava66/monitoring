import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { ApiError, requestJson } from '../utils/apiClient';
import { logAuditEvent } from '../utils/auditLog';
import {
  Alert, Badge, Button, Dot, EmptyState, Icon, Menu, MenuItem, Page, PageHeader, ProgressBar, Tabs, cx, useFeedback, usePolling,
} from '../components/ui';

const Terminal = lazy(() => import('./Terminal'));

const LEGACY_URL = import.meta.env.VITE_MANAGE_API_URL || '';
const SERVERS = [
  { id: 'dev', label: 'DEV', alias: 'SmartHub DEV', permission: 'viewServerManagerDev', admin: 'adminAccessDev', url: import.meta.env.VITE_MANAGE_API_DEV_URL || LEGACY_URL },
  { id: 'qa', label: 'QA', alias: 'SmartHub QA', permission: 'viewServerManagerQA', admin: 'adminAccessQA', url: import.meta.env.VITE_MANAGE_API_QA_URL || LEGACY_URL },
  { id: 'prod', label: 'PROD', alias: 'SmartHub PROD', permission: 'viewServerManagerProd', admin: 'adminAccessProd', url: import.meta.env.VITE_MANAGE_API_PROD_URL || LEGACY_URL },
  { id: 'poc', label: 'POC', alias: 'SmartHub POC', permission: 'viewServerManagerPOC', admin: 'adminAccessPOC', url: import.meta.env.VITE_MANAGE_API_POC_URL || LEGACY_URL },
].filter((s) => s.url).map((s) => ({ ...s, url: s.url.replace(/\/$/, '') }));

const SERVICES = [
  { id: 'backend', label: 'Backend API', icon: 'server' },
  { id: 'frontend', label: 'Frontend app', icon: 'globe' },
];
const REFRESH_MS = 30_000;
const STATE = {
  running: { label: 'Running', color: '#328714', tone: 'success' },
  stopped: { label: 'Stopped', color: '#857a73', tone: 'neutral' },
  partial: { label: 'Partially running', color: '#c4a000', tone: 'warning' },
  error: { label: 'Unreachable', color: '#eb1700', tone: 'danger' },
  forbidden: { label: 'No access', color: '#eb1700', tone: 'danger' },
  loading: { label: 'Checking…', color: '#cbc4bc', tone: 'neutral' },
};

const describeError = (e) => (e instanceof ApiError && e.status === 403
  ? 'This server only accepts members of its admin AD group.'
  : e?.message || 'Request failed');

function ServiceCard({ svc, config, status, stats, busy, canAdmin, onAction, dirOptions, onChangeDir }) {
  const st = STATE[status] || STATE.loading;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="bg-white rounded-xl border border-jj-gray-02 shadow-card flex flex-col">
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <span className="w-11 h-11 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-jj-gray-07 flex items-center justify-center flex-shrink-0">
          <Icon name={svc.icon} className="w-5 h-5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-johnson-display text-lg text-jj-gray-08 truncate">{config.name || svc.label}</p>
            <Badge tone={st.tone}><Dot color={st.color} pulse={status === 'running'} className="w-1.5 h-1.5" />{st.label}</Badge>
          </div>
          {canAdmin && dirOptions.length > 0 ? (
            <Menu open={menuOpen} onOpenChange={setMenuOpen} align="left" className="w-[min(22rem,calc(100vw-3rem))] max-h-72 overflow-y-auto scroll-thin" trigger={(
              <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}
                className="mt-1 max-w-full flex items-center gap-1 font-mono text-xs text-jj-gray-06 hover:text-jj-gray-08 rounded focus-ring" title={config.dir}>
                <span className="truncate">{config.dir || 'No directory set'}</span>
                <Icon name="chevronDown" className="w-2.5 h-2.5" />
              </button>
            )}>
              {dirOptions.map((o) => (
                <MenuItem key={o.path} active={o.path === config.dir} title={o.notes || o.path}
                  onClick={() => { setMenuOpen(false); if (o.exists) onChangeDir(svc.id, o); }}>
                  <span className={cx('block', !o.exists && 'opacity-50')}>{o.label}{!o.exists && ' (missing)'}</span>
                  <span className="block font-mono text-[11px] text-jj-gray-05 truncate">{o.path}</span>
                </MenuItem>
              ))}
            </Menu>
          ) : (
            <p className="mt-1 font-mono text-xs text-jj-gray-06 truncate" title={config.dir}>{config.dir || '—'}</p>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-3 px-4 sm:px-5 font-johnson-text">
        {[['Port', config.port], ['PID', stats.pid], ['Uptime', stats.uptime]].map(([k, v]) => (
          <div key={k} className="min-w-0"><dt className="text-xs text-jj-gray-06">{k}</dt><dd className="mt-0.5 text-sm font-semibold text-jj-gray-08 tabular-nums truncate">{v || '—'}</dd></div>
        ))}
      </dl>
      <div className="grid grid-cols-2 gap-4 px-4 sm:px-5 mt-4">
        {[['CPU', stats.cpu, '#0f68b2'], ['Memory', stats.mem, '#8c3bbb']].map(([k, v, c]) => (
          <div key={k}>
            <div className="flex justify-between font-johnson-text text-xs"><span className="text-jj-gray-06">{k}</span><span className="text-jj-gray-08 tabular-nums">{v != null ? `${v}%` : '—'}</span></div>
            <ProgressBar value={v || 0} color={c} className="h-1 mt-1.5" label={`${svc.label} ${k}`} />
          </div>
        ))}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 p-4 sm:p-5">
        {canAdmin && (status === 'running' ? (
          <>
            <Button size="sm" icon="sync" onClick={() => onAction(svc.id, 'restart')} loading={busy === 'restart'} disabled={!!busy}>Restart</Button>
            <Button size="sm" variant="dangerOutline" onClick={() => onAction(svc.id, 'stop')} loading={busy === 'stop'} disabled={!!busy}>Stop</Button>
          </>
        ) : (
          <Button size="sm" variant="primary" icon="play" onClick={() => onAction(svc.id, 'start')} loading={busy === 'start'} disabled={!!busy || status === 'error' || status === 'forbidden'}>Start</Button>
        ))}
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => onAction(svc.id, 'status')} disabled={!!busy}>Check status</Button>
      </div>
    </div>
  );
}

function ServerPanel({ server, tabs }) {
  const { hasPermission } = useRBAC();
  const { user } = useAuth();
  const { toast, confirm } = useFeedback();
  const canAdmin = hasPermission(server.admin);
  const [params, setParams] = useSearchParams();
  const api = useCallback((path, opts) => requestJson(`${server.url}${path}`, opts), [server.url]);

  const [config, setConfig] = useState({});
  const [statuses, setStatuses] = useState({ backend: 'loading', frontend: 'loading' });
  const [stats, setStats] = useState({ backend: {}, frontend: {} });
  const [busy, setBusy] = useState({});
  const [panelError, setPanelError] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [activity, setActivity] = useState('console');
  const [consoleLines, setConsoleLines] = useState([]);
  const [logText, setLogText] = useState({});
  const [repos, setRepos] = useState([]);
  const [repo, setRepo] = useState('');
  const [repoMenu, setRepoMenu] = useState(false);
  const [dirs, setDirs] = useState({ backend: [], frontend: [] });
  const [pulling, setPulling] = useState(false);
  const outRef = useRef(null);
  const termOpen = canAdmin && params.get('terminal') === 'true';

  const append = useCallback((text, tone = 'out') => setConsoleLines((l) => [...l, { text, tone, id: l.length + Math.random() }].slice(-1000)), []);

  const refreshService = useCallback(async (svc) => {
    try {
      const d = await api(`/api/status/${svc}`, { timeoutMs: 15_000 });
      const next = d.running ? 'running' : 'stopped';
      setStatuses((s) => ({ ...s, [svc]: next }));
      setStats((s) => ({ ...s, [svc]: { pid: d.pid, cpu: d.cpu, mem: d.mem, uptime: d.uptime } }));
      setPanelError(null);
      return next;
    } catch (e) {
      const next = e instanceof ApiError && e.status === 403 ? 'forbidden' : 'error';
      setStatuses((s) => ({ ...s, [svc]: next }));
      setPanelError(describeError(e));
      return next;
    }
  }, [api]);

  const refreshAll = useCallback(async () => {
    api('/api/services').then(setConfig).catch(() => {});
    await Promise.all(SERVICES.map((s) => refreshService(s.id)));
    setLastSync(new Date());
  }, [api, refreshService]);

  const loadLog = useCallback(async (svc) => {
    setLogText((t) => ({ ...t, [svc]: t[svc] ?? 'Loading…' }));
    try {
      const d = await api(`/api/logs/${svc}?lines=500`);
      setLogText((t) => ({ ...t, [svc]: d.logs || '(empty)' }));
    } catch (e) {
      setLogText((t) => ({ ...t, [svc]: `Unable to load log: ${describeError(e)}` }));
    }
  }, [api]);

  usePolling(refreshAll, REFRESH_MS);
  useEffect(() => {
    if (!canAdmin) return;
    api('/api/repos').then((d) => setRepos(d.repos || [])).catch(() => {});
    api('/api/service-directories').then((d) => setDirs({ backend: d.backend || [], frontend: d.frontend || [] })).catch(() => {});
  }, [api, canAdmin]);
  useEffect(() => { if (activity !== 'console') loadLog(activity); }, [activity, loadLog]);
  useEffect(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; }, [consoleLines, logText, activity]);

  const runAction = async (svc, action) => {
    const label = SERVICES.find((s) => s.id === svc).label;
    if (action === 'status') { const now = await refreshService(svc); toast.info(`${label}: ${STATE[now].label}`); return; }
    if (action !== 'start') {
      const ok = await confirm({ title: `${action === 'stop' ? 'Stop' : 'Restart'} ${label}?`,
        message: action === 'stop' ? 'The service will be unavailable until it is started again.' : 'The service restarts and is briefly unavailable. The frontend is rebuilt on restart.',
        confirmLabel: action === 'stop' ? 'Stop service' : 'Restart service', tone: 'danger' });
      if (!ok) return;
    }
    setBusy((b) => ({ ...b, [svc]: action }));
    setActivity('console');
    append(`$ ${action} ${svc}  ·  ${new Date().toLocaleString('en-US')}`, 'cmd');
    try {
      const d = await api(`/api/${action}/${svc}`, { method: 'POST', timeoutMs: 15 * 60_000 });
      const ok = (d.returncode ?? 0) === 0;
      (d.output || '').split('\n').filter((l) => l.trim()).forEach((l) => append(l, ok ? 'out' : 'err'));
      append(ok ? `✓ ${action} ${svc} finished` : `✗ ${action} ${svc} failed (exit ${d.returncode})`, ok ? 'ok' : 'err');
      ok ? toast.success(`${label} ${action} succeeded`) : toast.error(`${label} ${action} failed`);
      logAuditEvent('server_manager_action', user?.email, `${server.id}:${svc}`, `${action} ${svc} on ${server.alias} ${ok ? 'succeeded' : 'failed'}`);
    } catch (e) {
      append(describeError(e), 'err');
      toast.error(`${label} ${action} failed: ${describeError(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [svc]: null }));
      refreshService(svc);
    }
  };

  const gitPull = async () => {
    const target = repo || 'the default repository';
    const ok = await confirm({ title: 'Pull latest code?', message: `Runs git pull --ff-only in ${target} on ${server.alias}.`, confirmLabel: 'Git pull' });
    if (!ok) return;
    setPulling(true);
    setActivity('console');
    append(`$ git pull  ·  ${repo || 'default repo'}`, 'cmd');
    try {
      const d = await api('/api/gitpull', { body: repo ? { dir: repo } : {}, timeoutMs: 300_000 });
      const good = (d.returncode ?? 0) === 0;
      (d.output || '').split('\n').filter((l) => l.trim()).forEach((l) => append(l, good ? 'out' : 'err'));
      good ? toast.success('Git pull succeeded') : toast.error('Git pull failed');
      logAuditEvent('server_manager_action', user?.email, server.id, `git pull in ${target} on ${server.alias} ${good ? 'succeeded' : 'failed'}`);
    } catch (e) {
      append(describeError(e), 'err');
      toast.error(`Git pull failed: ${describeError(e)}`);
    } finally {
      setPulling(false);
    }
  };

  const changeDir = async (svc, option) => {
    try {
      await api(`/api/service/${svc}/dir`, { body: { dir: option.path, port: option.port || undefined, entry: option.entry || undefined } });
      toast.success(`${svc} now points to ${option.label}`);
      logAuditEvent('server_manager_action', user?.email, `${server.id}:${svc}`, `Switched ${svc} directory to ${option.path} on ${server.alias}`);
      refreshAll();
      if (activity === svc) loadLog(svc);
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  const setTerminal = (open) => setParams((p) => { const n = new URLSearchParams(p); if (open) n.set('terminal', 'true'); else n.delete('terminal'); return n; });

  return (
    <Page>
      <PageHeader icon="server" title="Server control" description={server.alias}
        meta={lastSync ? `synced ${lastSync.toLocaleTimeString('en-US')}` : 'syncing…'}
        actions={(
          <>
            {tabs}
            {canAdmin && <Button icon="server" onClick={() => setTerminal(true)}>Terminal</Button>}
            {canAdmin && (
              <div className="flex">
                <Button variant="primary" icon="sync" onClick={gitPull} loading={pulling} className={repos.length ? 'rounded-r-none' : ''}>
                  Git pull{repo ? ` · ${repo.split('/').pop()}` : ''}
                </Button>
                {repos.length > 0 && (
                  <Menu open={repoMenu} onOpenChange={setRepoMenu} className="max-h-72 overflow-y-auto scroll-thin" trigger={(
                    <Button variant="primary" aria-label="Choose repository" onClick={() => setRepoMenu((v) => !v)} className="rounded-l-none border-l border-white/30 px-2.5">
                      <Icon name="chevronDown" className="w-3 h-3" />
                    </Button>
                  )}>
                    <MenuItem active={!repo} onClick={() => { setRepo(''); setRepoMenu(false); }}>Default repository</MenuItem>
                    {repos.map((r) => (
                      <MenuItem key={r} active={repo === r} title={r} onClick={() => { setRepo(r); setRepoMenu(false); }}>
                        <span className="block">{r.split('/').pop()}</span>
                        <span className="block font-mono text-[11px] text-jj-gray-05 truncate">{r}</span>
                      </MenuItem>
                    ))}
                  </Menu>
                )}
              </div>
            )}
            <Button icon="refresh" onClick={refreshAll} aria-label="Refresh status">Refresh</Button>
          </>
        )}
      />

      {panelError && <Alert tone="error" title={`Can’t reach ${server.alias} fully`}>{panelError}</Alert>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {SERVICES.map((svc) => (
          <ServiceCard key={svc.id} svc={svc} config={config[svc.id] || {}} status={statuses[svc.id]} stats={stats[svc.id] || {}}
            busy={busy[svc.id]} canAdmin={canAdmin} onAction={runAction} dirOptions={dirs[svc.id] || []} onChangeDir={changeDir} />
        ))}
      </div>

      <section className="bg-white rounded-xl border border-jj-gray-02 shadow-card overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-2 sm:px-3 border-b border-jj-gray-02">
          <Tabs label="Activity" value={activity} onChange={setActivity} className="border-b-0"
            tabs={[{ id: 'console', label: 'Console' }, ...SERVICES.map((s) => ({ id: s.id, label: `${s.id}.log` }))]} />
          <div className="px-2 pb-2 sm:pb-0">
            {activity === 'console'
              ? <Button size="sm" variant="ghost" onClick={() => setConsoleLines([])} disabled={!consoleLines.length}>Clear</Button>
              : <Button size="sm" variant="ghost" icon="refresh" onClick={() => loadLog(activity)}>Reload</Button>}
          </div>
        </div>
        <div ref={outRef} tabIndex={0} aria-label="Activity output" className="h-80 sm:h-96 overflow-auto terminal-scroll bg-terminal px-4 py-3 font-mono text-xs leading-5 focus-ring-inset">
          {activity === 'console' ? (
            consoleLines.length === 0 ? <p className="text-[#8b949e]">Output from start, stop, restart and git pull appears here.</p>
              : consoleLines.map((l) => (
                <div key={l.id} className={cx('whitespace-pre-wrap break-words',
                  { cmd: 'text-[#79c0ff] font-semibold mt-2 first:mt-0', ok: 'text-[#7ee787]', err: 'text-[#ff7b72]', out: 'text-[#c9d1d9]' }[l.tone])}>{l.text}</div>
              ))
          ) : <pre className="whitespace-pre-wrap break-words text-[#c9d1d9] m-0">{logText[activity]}</pre>}
        </div>
      </section>

      {termOpen && (
        <Suspense fallback={null}>
          <Terminal manageUrl={server.url} title={server.alias} onClose={() => setTerminal(false)} />
        </Suspense>
      )}
    </Page>
  );
}

export default function ServerManagePage() {
  const { hasPermission } = useRBAC();
  const [params, setParams] = useSearchParams();
  const visible = SERVERS.filter((s) => hasPermission(s.permission));
  const visibleKey = visible.map((s) => s.id).join();
  const [health, setHealth] = useState({});

  const check = useCallback(() => {
    visible.forEach(async (s) => {
      try {
        const results = await Promise.all(SERVICES.map((svc) => requestJson(`${s.url}/api/status/${svc.id}`, { timeoutMs: 10_000 })));
        const up = results.filter((r) => r.running).length;
        setHealth((h) => ({ ...h, [s.id]: up === results.length ? 'running' : up === 0 ? 'stopped' : 'partial' }));
      } catch {
        setHealth((h) => ({ ...h, [s.id]: 'error' }));
      }
    });
  }, [visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(check, REFRESH_MS, { enabled: visible.length > 1 });

  if (!visible.length) {
    return (
      <Page>
        <EmptyState icon="server" title="No manage servers available"
          description="No server is configured for this deployment, or your role doesn’t include any of them. Contact your administrator." />
      </Page>
    );
  }
  const active = visible.find((s) => s.id === params.get('server')) || visible[0];
  const tabs = visible.length > 1 ? (
    <Tabs variant="pill" label="Server" value={active.id}
      onChange={(id) => setParams((p) => { const n = new URLSearchParams(p); n.set('server', id); n.delete('terminal'); return n; })}
      tabs={visible.map((s) => ({ id: s.id, label: s.label, dot: STATE[health[s.id] || 'loading'].color, title: `${s.alias}: ${STATE[health[s.id] || 'loading'].label}` }))} />
  ) : null;
  return <ServerPanel key={active.id} server={active} tabs={tabs} />;
}
