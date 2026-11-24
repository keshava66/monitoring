import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { ApiError, downloadBlob, isAbort, requestJson, streamNdjsonUrl } from '../utils/apiClient';
import { logAuditEvent } from '../utils/auditLog';
import {
  Alert, Badge, Button, Dot, EmptyState, Icon, Menu, MenuItem, Page, PageHeader, ProgressBar, StatusChip, Tabs, Toggle, cx, useFeedback, usePolling,
} from '../components/ui';
import { ServicePulse } from '../components/HeroArt';

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
const BUSY_REFRESH_MS = 3_000;
const LOG_FOLLOW_MS = 5_000;
const LOG_LINES = 500;
const CONSOLE_CAP = 2000;
const STATE = {
  running: { label: 'Running', color: '#328714', tone: 'success' },
  stopped: { label: 'Stopped', color: '#857a73', tone: 'neutral' },
  partial: { label: 'Partially running', color: '#c4a000', tone: 'warning' },
  busy: { label: 'Working…', color: '#0f68b2', tone: 'info' },
  error: { label: 'Unreachable', color: '#eb1700', tone: 'danger' },
  forbidden: { label: 'No access', color: '#eb1700', tone: 'danger' },
  loading: { label: 'Checking…', color: '#cbc4bc', tone: 'neutral' },
};
const BUSY_LABEL = { start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…', 'switch directory': 'Switching…' };
const ERROR_LINE = /^(ERROR|FAILED)\b|Traceback|npm ERR!/;

const describeError = (e) => (e instanceof ApiError && e.status === 403
  ? 'This server only accepts members of its admin AD group.'
  : e?.message || 'Request failed');
const failureState = (e) => (e instanceof ApiError && e.status === 403 ? 'forbidden' : 'error');
const summarize = (overview) => {
  const up = SERVICES.filter((s) => overview.services?.[s.id]?.running).length;
  return up === SERVICES.length ? 'running' : up === 0 ? 'stopped' : 'partial';
};
const stamp = () => new Date().toLocaleString('en-US');
const fileStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const fetchOverview = (url) => requestJson(`${url}/api/overview`, { timeoutMs: 15_000 });

function ServiceCard({ svc, info, state, busy, canAdmin, onAction, dirOptions, onChangeDir }) {
  const st = busy ? { ...STATE.busy, label: BUSY_LABEL[busy.action] || STATE.busy.label } : STATE[state] || STATE.loading;
  const [menuOpen, setMenuOpen] = useState(false);
  const running = state === 'running';
  const reachable = state !== 'error' && state !== 'forbidden' && state !== 'loading';
  return (
    <div className="group relative overflow-hidden surface flex flex-col transition-[box-shadow,transform] duration-500 ease-out hover:-translate-y-0.5 hover:shadow-lift">
      <div className="relative flex items-start gap-4 p-5 sm:p-6">
        <span className="relative w-12 h-12 rounded-2xl grid place-items-center flex-shrink-0 text-white"
          style={{ background: `linear-gradient(140deg, ${st.color}, color-mix(in srgb, ${st.color} 70%, #000))`, boxShadow: `0 14px 28px -14px ${st.color}` }}>
          {(running || busy) && <span className="absolute -inset-1 rounded-[1.1rem] border animate-ring" style={{ borderColor: st.color }} />}
          <Icon name={svc.icon} className="w-5 h-5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-johnson-display font-medium text-xl tracking-[-0.01em] text-jj-gray-08 truncate">{info.name || svc.label}</p>
            <Badge tone={st.tone}><Dot color={st.color} pulse={running || !!busy} className="w-1.5 h-1.5" />{st.label}</Badge>
          </div>
          {canAdmin && dirOptions.length > 0 ? (
            <Menu open={menuOpen} onOpenChange={setMenuOpen} align="left" className="w-[min(22rem,calc(100vw-3rem))] max-h-72 overflow-y-auto scroll-thin" trigger={(
              <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}
                className="mt-1 max-w-full flex items-center gap-1 font-mono text-xs text-jj-gray-06 hover:text-jj-gray-08 rounded focus-ring" title={info.dir}>
                <span className="truncate">{info.dir || 'No directory set'}</span>
                <Icon name="chevronDown" className="w-2.5 h-2.5" />
              </button>
            )}>
              {(running || busy) && <p className="px-3 pt-1.5 pb-2 font-johnson-text text-xs text-jj-gray-06">Stop the service to switch its directory.</p>}
              {dirOptions.map((o) => (
                <MenuItem key={o.path} active={o.path === info.dir} title={o.notes || o.path} disabled={!o.exists || running || !!busy || o.path === info.dir}
                  onClick={() => { setMenuOpen(false); onChangeDir(svc.id, o); }}>
                  <span className="block">{o.label}{!o.exists && ' (missing)'}</span>
                  <span className="block font-mono text-[11px] text-jj-gray-05 truncate">{o.path}</span>
                </MenuItem>
              ))}
            </Menu>
          ) : (
            <p className="mt-1 font-mono text-xs text-jj-gray-06 truncate" title={info.dir}>{info.dir || '—'}</p>
          )}
          {busy?.by && <p className="mt-1 font-johnson-text text-xs text-jj-blue-03 truncate">{busy.action} by {busy.by}</p>}
        </div>
      </div>
      <dl className="relative grid grid-cols-3 gap-px mx-5 sm:mx-6 rounded-2xl overflow-hidden bg-jj-gray-02 border border-jj-gray-02 font-johnson-text">
        {[['Port', info.port], ['PID', info.pid], ['Uptime', info.uptime]].map(([k, v]) => (
          <div key={k} className="min-w-0 bg-[#fbfaf8] px-3.5 py-3"><dt className="text-[12px] font-medium text-jj-gray-06">{k}</dt><dd className="mt-1 font-johnson-display font-light text-xl leading-none text-jj-gray-08 tabular-nums truncate">{v || '—'}</dd></div>
        ))}
      </dl>
      <div className="relative grid grid-cols-2 gap-5 px-5 sm:px-6 mt-5">
        {[['CPU', info.cpu, '#0f68b2'], ['Memory', info.mem, '#8c3bbb']].map(([k, v, c]) => (
          <div key={k}>
            <div className="flex justify-between font-johnson-text text-xs"><span className="text-jj-gray-06">{k}</span><span className="text-jj-gray-08 tabular-nums">{v != null ? `${v}%` : '—'}</span></div>
            <ProgressBar value={v || 0} color={c} className="h-1 mt-1.5" label={`${svc.label} ${k}`} />
          </div>
        ))}
      </div>
      <div className="relative mt-auto flex flex-wrap gap-2 p-5 sm:p-6">
        {canAdmin && (running ? (
          <>
            <Button size="sm" icon="sync" onClick={() => onAction(svc, 'restart')} loading={busy?.action === 'restart'} disabled={!!busy}>Restart</Button>
            <Button size="sm" variant="dangerOutline" onClick={() => onAction(svc, 'stop')} loading={busy?.action === 'stop'} disabled={!!busy}>Stop</Button>
          </>
        ) : (
          <Button size="sm" variant="primary" icon="play" onClick={() => onAction(svc, 'start')} loading={busy?.action === 'start'} disabled={!!busy || !reachable}>Start</Button>
        ))}
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => onAction(svc, 'status')}>Check status</Button>
      </div>
    </div>
  );
}

function HostStrip({ host }) {
  const tiles = [
    { k: 'CPU', v: `${host.cpu}%`, bar: host.cpu, color: '#0f68b2', hint: `${host.cores} core${host.cores === 1 ? '' : 's'}` },
    { k: 'Memory', v: `${host.mem}%`, bar: host.mem, color: '#8c3bbb' },
    { k: 'Disk', v: `${host.disk}%`, bar: host.disk, color: host.disk >= 90 ? '#eb1700' : '#328714', hint: host.disk_path },
    { k: 'Load', v: host.load ? host.load[0].toFixed(2) : '—', hint: host.load ? `5m ${host.load[1].toFixed(2)} · 15m ${host.load[2].toFixed(2)}` : null },
    { k: 'Host uptime', v: host.uptime, hint: host.hostname },
  ];
  return (
    <section aria-label="Host vitals" className="surface grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px overflow-hidden bg-jj-gray-02">
      {tiles.map((t) => (
        <div key={t.k} className="min-w-0 bg-white px-4 sm:px-5 py-3.5 last:col-span-2 sm:last:col-span-1">
          <p className="font-johnson-text text-[12px] font-medium text-jj-gray-06">{t.k}</p>
          <p className="mt-1 font-johnson-display font-light text-xl leading-none text-jj-gray-08 tabular-nums truncate">{t.v}</p>
          {t.bar != null && <ProgressBar value={t.bar} color={t.color} className="h-1 mt-2" label={`Host ${t.k}`} />}
          {t.hint && <p className="mt-1.5 font-mono text-[11px] text-jj-gray-05 truncate" title={t.hint}>{t.hint}</p>}
        </div>
      ))}
    </section>
  );
}

function ServerPanel({ server, tabs, onHealth }) {
  const { hasPermission } = useRBAC();
  const { user } = useAuth();
  const { toast, confirm } = useFeedback();
  const canAdmin = hasPermission(server.admin);
  const [params, setParams] = useSearchParams();
  const api = useCallback((path, opts) => requestJson(`${server.url}${path}`, opts), [server.url]);

  const [overview, setOverview] = useState(null);
  const [failure, setFailure] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [pending, setPending] = useState({});
  const [activity, setActivity] = useState('console');
  const [consoleLines, setConsoleLines] = useState([]);
  const [logs, setLogs] = useState({});
  const [follow, setFollow] = useState(true);
  const [repos, setRepos] = useState([]);
  const [repo, setRepo] = useState('');
  const [repoMenu, setRepoMenu] = useState(false);
  const [dirs, setDirs] = useState({ backend: [], frontend: [] });
  const outRef = useRef(null);
  const stickRef = useRef(true);
  const lineId = useRef(0);
  const abortRef = useRef(null);
  const termOpen = canAdmin && params.get('terminal') === 'true';

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return () => ctrl.abort();
  }, []);

  const append = useCallback((text, tone = 'out') => {
    setConsoleLines((l) => {
      const next = [...l, { text, tone, id: ++lineId.current }];
      return next.length > CONSOLE_CAP ? next.slice(-CONSOLE_CAP) : next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await fetchOverview(server.url);
      setOverview(d);
      setFailure(null);
      onHealth(server.id, summarize(d));
      return d;
    } catch (e) {
      setFailure({ state: failureState(e), message: describeError(e) });
      onHealth(server.id, failureState(e));
      return null;
    } finally {
      setLastSync(new Date());
    }
  }, [server.url, server.id, onHealth]);

  const loadLog = useCallback(async (svc) => {
    try {
      const d = await api(`/api/logs/${svc}?lines=${LOG_LINES}`);
      setLogs((t) => ({ ...t, [svc]: d.missing ? { note: `No log file yet at ${d.missing}` } : { text: d.logs || '' } }));
    } catch (e) {
      setLogs((t) => ({ ...t, [svc]: { note: `Unable to load log: ${describeError(e)}`, error: true } }));
    }
  }, [api]);

  const svcState = (id) => (failure ? failure.state : overview ? (overview.services[id]?.running ? 'running' : 'stopped') : 'loading');
  const busyOf = (id) => (pending[id] ? { action: pending[id] } : overview?.services[id]?.busy || null);
  const gitBusy = !!pending.git || !!overview?.git;
  const anyBusy = gitBusy || SERVICES.some((s) => busyOf(s.id));
  const overall = failure ? failure.state : overview ? summarize(overview) : 'loading';

  usePolling(refresh, anyBusy ? BUSY_REFRESH_MS : REFRESH_MS);
  usePolling(() => loadLog(activity), LOG_FOLLOW_MS, { enabled: activity !== 'console' && follow, immediate: false });
  useEffect(() => { if (activity !== 'console') loadLog(activity); }, [activity, loadLog]);
  useEffect(() => {
    if (!canAdmin) return;
    api('/api/repos').then((d) => setRepos(d.repos || [])).catch(() => {});
    api('/api/service-directories').then((d) => setDirs({ backend: d.backend || [], frontend: d.frontend || [] })).catch(() => {});
  }, [api, canAdmin]);

  // Follow the newest output unless the reader has scrolled up.
  useLayoutEffect(() => { stickRef.current = true; }, [activity]);
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [consoleLines, logs, activity]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  /** Run a streamed job and echo its output into the console. Resolves to the exit code, or null if it never finished. */
  const stream = async (path, body) => {
    let rc = null;
    await streamNdjsonUrl(`${server.url}${path}`, {
      method: 'POST',
      body,
      signal: abortRef.current?.signal,
      onMessage: (m) => {
        if (m.type === 'line') { if (m.text.trim()) append(m.text, ERROR_LINE.test(m.text) ? 'err' : 'out'); } else if (m.type === 'exit') rc = m.returncode;
      },
    });
    return rc;
  };

  const runAction = async (svc, action) => {
    if (action === 'status') {
      const d = await refresh();
      const st = d ? (d.services[svc.id]?.running ? 'running' : 'stopped') : 'error';
      toast.info(`${svc.label}: ${STATE[st].label}`);
      return;
    }
    if (action !== 'start') {
      const ok = await confirm({ title: `${action === 'stop' ? 'Stop' : 'Restart'} ${svc.label}?`,
        message: action === 'stop'
          ? 'The service will be unavailable until it is started again.'
          : `The service is prepared first${svc.id === 'frontend' ? ' (dependencies and a fresh build)' : ''}, then swapped over with only a few seconds of downtime.`,
        confirmLabel: action === 'stop' ? 'Stop service' : 'Restart service', tone: 'danger' });
      if (!ok) return;
    }
    setPending((p) => ({ ...p, [svc.id]: action }));
    setActivity('console');
    append(`$ ${action} ${svc.id}  ·  ${stamp()}`, 'cmd');
    try {
      const rc = await stream(`/api/${action}/${svc.id}`);
      const ok = rc === 0;
      append(ok ? `✓ ${action} ${svc.id} finished` : `✗ ${action} ${svc.id} failed${rc == null ? '' : ` (exit ${rc})`}`, ok ? 'ok' : 'err');
      if (ok) toast.success(`${svc.label} ${action} succeeded`); else toast.error(`${svc.label} ${action} failed`);
      logAuditEvent('server_manager_action', user?.email, `${server.id}:${svc.id}`, `${action} ${svc.id} on ${server.alias} ${ok ? 'succeeded' : 'failed'}`);
    } catch (e) {
      if (isAbort(e)) return;
      append(describeError(e), 'err');
      toast.error(`${svc.label} ${action} failed: ${describeError(e)}`);
    } finally {
      setPending((p) => ({ ...p, [svc.id]: null }));
      refresh();
    }
  };

  const gitPull = async () => {
    const target = repo || 'the default repository';
    const ok = await confirm({ title: 'Pull latest code?', message: `Runs git pull --ff-only in ${target} on ${server.alias}.`, confirmLabel: 'Git pull' });
    if (!ok) return;
    setPending((p) => ({ ...p, git: 'git pull' }));
    setActivity('console');
    append(`$ git pull  ·  ${repo || 'default repo'}  ·  ${stamp()}`, 'cmd');
    try {
      const rc = await stream('/api/gitpull', repo ? { dir: repo } : {});
      const good = rc === 0;
      append(good ? '✓ git pull finished' : `✗ git pull failed${rc == null ? '' : ` (exit ${rc})`}`, good ? 'ok' : 'err');
      if (good) toast.success('Git pull succeeded'); else toast.error('Git pull failed');
      logAuditEvent('server_manager_action', user?.email, server.id, `git pull in ${target} on ${server.alias} ${good ? 'succeeded' : 'failed'}`);
    } catch (e) {
      if (isAbort(e)) return;
      append(describeError(e), 'err');
      toast.error(`Git pull failed: ${describeError(e)}`);
    } finally {
      setPending((p) => ({ ...p, git: null }));
      refresh();
    }
  };

  const changeDir = async (svc, option) => {
    try {
      await api(`/api/service/${svc}/dir`, { body: { dir: option.path, port: option.port || undefined, entry: option.entry || undefined } });
      toast.success(`${svc} now points to ${option.label}`);
      logAuditEvent('server_manager_action', user?.email, `${server.id}:${svc}`, `Switched ${svc} directory to ${option.path} on ${server.alias}`);
      refresh();
      if (activity === svc) loadLog(svc);
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  const download = () => {
    const text = activity === 'console' ? consoleLines.map((l) => l.text).join('\n') : logs[activity]?.text || '';
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${server.id}_${activity}_${fileStamp()}.log`);
  };

  const setTerminal = (open) => setParams((p) => { const n = new URLSearchParams(p); if (open) n.set('terminal', 'true'); else n.delete('terminal'); return n; });
  const log = logs[activity];
  const hasOutput = activity === 'console' ? consoleLines.length > 0 : !!log?.text;

  return (
    <Page>
      <PageHeader title="Server" accent="control."
        description={`Start, stop and deploy the monitoring services on ${server.alias}, then follow every command live.`}
        chips={(
          <>
            {tabs}
            <StatusChip color={STATE[anyBusy ? 'busy' : overall].color} live={!!lastSync && !failure}>
              {failure ? STATE[failure.state].label
                : lastSync ? `${anyBusy ? 'Working · ' : ''}Synced ${lastSync.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Syncing…'}
            </StatusChip>
          </>
        )}
        art={(
          <ServicePulse services={SERVICES.map((svc) => {
            const busy = busyOf(svc.id);
            const st = busy ? STATE.busy : STATE[svcState(svc.id)];
            const x = overview?.services[svc.id] || {};
            return { id: svc.id, label: x.name || svc.label, color: st.color, state: busy ? BUSY_LABEL[busy.action] || st.label : st.label, cpu: x.cpu, mem: x.mem, uptime: x.uptime, live: svcState(svc.id) === 'running' };
          })} />
        )}
        actions={(
          <>
            {canAdmin && <Button icon="server" onClick={() => setTerminal(true)}>Terminal</Button>}
            {canAdmin && (
              <div className="flex">
                <Button variant="primary" icon="sync" onClick={gitPull} loading={!!pending.git} disabled={gitBusy}
                  title={overview?.git && !pending.git ? `git pull running (${overview.git.by})` : undefined} className={repos.length ? 'rounded-r-none' : ''}>
                  Git pull{repo ? ` · ${repo.split('/').pop()}` : ''}
                </Button>
                {repos.length > 0 && (
                  <Menu open={repoMenu} onOpenChange={setRepoMenu} className="max-h-72 overflow-y-auto scroll-thin" trigger={(
                    <Button variant="primary" aria-label="Choose repository" disabled={gitBusy} onClick={() => setRepoMenu((v) => !v)} className="rounded-l-none border-l border-white/30 px-2.5">
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
            <Button icon="refresh" onClick={refresh} aria-label="Refresh status">Refresh</Button>
          </>
        )}
      />

      {failure && <Alert tone="error" title={`Can’t reach ${server.alias}`}>{failure.message}</Alert>}

      {overview?.host && <HostStrip host={overview.host} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 stagger">
        {SERVICES.map((svc) => (
          <ServiceCard key={svc.id} svc={svc} info={overview?.services[svc.id] || {}} state={svcState(svc.id)} busy={busyOf(svc.id)}
            canAdmin={canAdmin} onAction={runAction} dirOptions={dirs[svc.id] || []} onChangeDir={changeDir} />
        ))}
      </div>

      <section className="surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-2 pl-1 pr-3 sm:px-4 border-b border-jj-gray-02">
          <Tabs label="Activity" value={activity} onChange={setActivity} className="border-b-0 min-w-0"
            tabs={[{ id: 'console', label: 'Console' }, ...SERVICES.map((s) => ({ id: s.id, label: `${s.id}.log` }))]} />
          <div className="flex items-center gap-1 shrink-0 py-1.5 ml-auto">
            {activity !== 'console' && (
              <>
                <Toggle checked={follow} onChange={setFollow} label="Follow" className="mr-1.5" />
                {!follow && <Button size="sm" variant="ghost" icon="refresh" onClick={() => loadLog(activity)}>Reload</Button>}
              </>
            )}
            <Button size="sm" variant="ghost" icon="download" onClick={download} disabled={!hasOutput} aria-label="Download output">
              <span className="hidden sm:inline">Download</span>
            </Button>
            {activity === 'console' && <Button size="sm" variant="ghost" onClick={() => setConsoleLines([])} disabled={!consoleLines.length}>Clear</Button>}
          </div>
        </div>
        <div ref={outRef} onScroll={onScroll} tabIndex={0} aria-label="Activity output" aria-live="off"
          className={cx('overflow-auto terminal-scroll bg-terminal px-5 py-4 font-mono text-xs leading-5 focus-ring-inset', activity === 'console' && !consoleLines.length ? 'h-44' : 'h-80 sm:h-96')}>
          {activity === 'console' ? (
            consoleLines.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-center font-johnson-text">
                <span className="flex items-center gap-2 text-[#8b949e] text-[13px]">
                  <span className="w-2 h-4 bg-[#7ee787] animate-blink" aria-hidden="true" />
                  Ready for commands
                </span>
                <span className="text-[#6e7681] text-xs max-w-sm">Output from start, stop, restart and git pull streams in here line by line as it happens.</span>
              </div>
            )
              : consoleLines.map((l) => (
                <div key={l.id} className={cx('whitespace-pre-wrap break-words',
                  { cmd: 'text-[#79c0ff] font-semibold mt-2 first:mt-0', ok: 'text-[#7ee787]', err: 'text-[#ff7b72]', out: 'text-[#c9d1d9]' }[l.tone])}>{l.text}</div>
              ))
          ) : log?.note ? (
            <p className={cx('font-johnson-text text-[13px]', log.error ? 'text-[#ff7b72]' : 'text-[#8b949e]')}>{log.note}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-[#c9d1d9] m-0">{log ? log.text || '(empty)' : 'Loading…'}</pre>
          )}
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
  const active = visible.find((s) => s.id === params.get('server')) || visible[0];
  const [health, setHealth] = useState({});
  const reportHealth = useCallback((id, state) => setHealth((h) => (h[id] === state ? h : { ...h, [id]: state })), []);

  // The open panel reports its own server; only the other tabs are polled here.
  const check = useCallback(() => {
    visible.filter((s) => s.id !== active?.id).forEach((s) => {
      fetchOverview(s.url).then((d) => reportHealth(s.id, summarize(d)), (e) => reportHealth(s.id, failureState(e)));
    });
  }, [visibleKey, active?.id, reportHealth]); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(check, REFRESH_MS, { enabled: visible.length > 1 });

  if (!active) {
    return (
      <Page>
        <EmptyState icon="server" title="No manage servers available"
          description="No server is configured for this deployment, or your role doesn’t include any of them. Contact your administrator." />
      </Page>
    );
  }
  const tabs = visible.length > 1 ? (
    <Tabs variant="pill" label="Server" value={active.id}
      onChange={(id) => setParams((p) => { const n = new URLSearchParams(p); n.set('server', id); n.delete('terminal'); return n; })}
      tabs={visible.map((s) => ({ id: s.id, label: s.label, dot: STATE[health[s.id] || 'loading'].color, title: `${s.alias}: ${STATE[health[s.id] || 'loading'].label}` }))} />
  ) : null;
  return <ServerPanel key={active.id} server={active} tabs={tabs} onHealth={reportHealth} />;
}
