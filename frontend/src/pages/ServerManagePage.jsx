import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import playIcon from '/icons/JJ_Icon_Video_Play_RGB.svg';
import closeIcon        from '/icons/JJ_Icon_Close.svg';
import refreshIcon        from '/icons/JJ_Icon_Refresh_RGB.svg';
import restartIcon        from '/icons/JJ_Icon_Refresh_Sync_RGB.svg';
import gearIcon         from '/icons/JJ_Icon_Alert_RGB.svg';
import terminalIcon           from '/icons/JJ_Icon_Application_On_Computer_RGB.svg';
import backendIcon      from '/icons/JJ_Icon_Application_On_Computer_RGB.svg';
import frontendIcon     from '/icons/JJ_Icon_Globe_RGB.svg';
import chevronDownIcon  from '/icons/JJ_Icon_Chevron_Down.svg';
import Terminal from './Terminal';
import { absoluteApiFetch } from '../utils/apiClient';

const LEGACY_URL = import.meta.env.VITE_MANAGE_API_URL ?? '';

const SERVERS = [
  { id: 'dev',  label: 'DEV',  alias: 'SmartHub DEV',  permission: 'viewServerManagerDev',  terminalPermission: 'adminAccessDev',  url: import.meta.env.VITE_MANAGE_API_DEV_URL  || LEGACY_URL },
  { id: 'qa',   label: 'QA',   alias: 'SmartHub QA',   permission: 'viewServerManagerQA',   terminalPermission: 'adminAccessQA',   url: import.meta.env.VITE_MANAGE_API_QA_URL   || LEGACY_URL },
  { id: 'prod', label: 'PROD', alias: 'SmartHub PROD', permission: 'viewServerManagerProd', terminalPermission: 'adminAccessProd', url: import.meta.env.VITE_MANAGE_API_PROD_URL || LEGACY_URL },
  { id: 'poc',  label: 'POC',  alias: 'SmartHub POC',  permission: 'viewServerManagerPOC',  terminalPermission: 'adminAccessPOC',  url: import.meta.env.VITE_MANAGE_API_POC_URL  || LEGACY_URL },
].filter(s => s.url); // hide tabs whose URL isn't configured

const SERVICES   = ['backend', 'frontend'];
const REFRESH_MS = 30_000;

const cx = (...args) => args.filter(Boolean).join(' ');

const F_WHITE = 'brightness(0) invert(1)';
const F_GRAY  = 'brightness(0) saturate(100%) invert(65%) sepia(6%) saturate(556%) hue-rotate(346deg) brightness(92%) contrast(88%)';
const F_RED   = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';

const lineClass = (line, ok) => {
  const l = line.toLowerCase();
  if (l.includes('error')) return 'text-jj-red';
  if (l.includes('warn'))  return 'text-jj-orange-03';
  return ok ? 'text-jj-green-03' : 'text-jj-red';
};

// Note: 'stopped' now reads as neutral (intentionally off) rather than an
// alarm color — only 'error' (crashed/unreachable) is red. Ring/glow drive
// the circular status indicator on each service card.
const statusColors = {
  running: { card: 'border-l-4 border-l-jj-green-03', badge: 'bg-jj-gray-01 text-jj-green-03 border-jj-green-03', dot: 'bg-jj-green-03 animate-pulse', ring: 'border-jj-green-03', text: 'text-jj-green-03', glow: '#328714' },
  stopped: { card: 'border-l-4 border-l-jj-gray-04',  badge: 'bg-jj-gray-01 text-jj-gray-05 border-jj-gray-04',  dot: 'bg-jj-gray-05',                ring: 'border-jj-gray-04', text: 'text-jj-gray-05', glow: '#a39992' },
  error:   { card: 'border-l-4 border-l-jj-red',      badge: 'bg-jj-gray-01 text-jj-red border-jj-red',           dot: 'bg-jj-red',                    ring: 'border-jj-red',     text: 'text-jj-red',     glow: '#eb1700' },
  loading: { card: 'border-l-4 border-l-jj-gray-04',  badge: 'bg-jj-gray-01 text-jj-gray-05 border-jj-gray-03',   dot: 'bg-jj-gray-04',                ring: 'border-jj-gray-03', text: 'text-jj-gray-05', glow: '#cbc4bc' },
};

const svcMeta = {
  backend:  { label: 'Backend API',  icon: backendIcon  },
  frontend: { label: 'Frontend App', icon: frontendIcon },
};

const extractPid = (out = '') => { const m = out.match(/\(PID\s+(\d+)\)/i); return m ? m[1] : '—'; };


// ─────────────────────────────────────────────────────────────────────────────
// TAB WRAPPER — default export
// ─────────────────────────────────────────────────────────────────────────────
export default function ServerManagerTabs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { hasPermission } = useRBAC();

  // Only show tabs the user has permission for AND whose URL is configured
  const visibleServers = SERVERS.filter(s => hasPermission(s.permission));
  const serverKey = visibleServers.map(s => `${s.id}:${s.url}`).join('|');

  const validIds = visibleServers.map(s => s.id);
  const activeId = validIds.includes(searchParams.get('server'))
    ? searchParams.get('server')
    : visibleServers[0]?.id ?? '';

  const handleTabChange = (id) => {
    if (id === activeId) return;
    setSearchParams(p => { const n = new URLSearchParams(p); n.set('server', id); return n; });
  };

  // Background health check across ALL configured environments (not just the
  // active one) so the tab pills can show a live status dot. Best-effort —
  // an unreachable environment just reads as its 'error' color.
  const [envHealth, setEnvHealth] = useState({});
  useEffect(() => {
    if (!serverKey) return;
    let cancelled = false;
    const checkAll = async () => {
      const entries = await Promise.all(visibleServers.map(async s => {
        try {
          const results = await Promise.all(
            SERVICES.map(svc => absoluteApiFetch(`${s.url}/api/status/${svc}`).then(r => r.json()))
          );
          const runningCount = results.filter(d => d.running).length;
          return [s.id, runningCount === results.length ? 'running' : runningCount === 0 ? 'stopped' : 'partial'];
        } catch {
          return [s.id, 'error'];
        }
      }));
      if (!cancelled) setEnvHealth(Object.fromEntries(entries));
    };
    checkAll();
    const t = setInterval(checkAll, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [serverKey]); // eslint-disable-line

  if (visibleServers.length === 0) return (
    <div className="flex items-center justify-center h-full text-jj-gray-05 font-johnson-text">
      No manage servers configured or you don't have access. Contact your administrator.
    </div>
  );

  const activeServer = visibleServers.find(s => s.id === activeId) ?? visibleServers[0];

  const tabs = visibleServers.map(s => ({
    id: s.id,
    label: s.label,
    active: s.id === activeId,
    dotCls: envHealth[s.id] === 'running' ? 'bg-jj-green-03' : envHealth[s.id] === 'error' ? 'bg-jj-red' : 'bg-jj-gray-05',
    onClick: () => handleTabChange(s.id),
  }));

  return (
    <div className="h-full overflow-hidden">
      {/* key forces full remount when server changes so state resets */}
      <ServerManagePanel
        key={activeServer.id}
        manageUrl={activeServer.url}
        serverId={activeServer.id}
        terminalPermission={activeServer.terminalPermission}
        alias={activeServer.alias}
        tabs={tabs}
      />
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// MAIN PANEL (previously ServerManagePage)
// ─────────────────────────────────────────────────────────────────────────────
function ServerManagePanel({ manageUrl, serverId, terminalPermission, alias, tabs }) {
  const MANAGE_API = manageUrl;
  const { hasPermission } = useRBAC();
  const canUseTerminal = hasPermission(terminalPermission);

  // Must be declared before the useEffect that reads it
  const [searchParams, setSearchParams] = useSearchParams();

  // Clear stale ?terminal=true from URL if user lacks permission
  useEffect(() => {
    if (!canUseTerminal && searchParams.get('terminal') === 'true') {
      setSearchParams(p => { const n = new URLSearchParams(p); n.delete('terminal'); return n; });
    }
  }, [canUseTerminal, searchParams, setSearchParams]);
  const [config,      setConfig]      = useState({});
  const [statuses,    setStatuses]    = useState({ backend: 'loading', frontend: 'loading' });
  const [stats,       setStats]       = useState({ backend: { pid: '—', cpu: null, mem: null, uptime: '—' }, frontend: { pid: '—', cpu: null, mem: null, uptime: '—' } });
  const [busy,        setBusy]        = useState({ backend: false, frontend: false });
  const [lastSync,    setLastSync]    = useState('—');
  const [refreshing,  setRefreshing]  = useState(false);
  const [barWidth,    setBarWidth]    = useState(0);
  const [consoleLogs, setConsoleLogs] = useState([{ cls: 'font-johnson-text text-jj-gray-05 italic', text: '  Waiting for command output…' }]);
  const [activityTab, setActivityTab] = useState('console'); // 'console' | 'backend' | 'frontend'
  const [logContents, setLogContents] = useState({ backend: 'Fetching logs…', frontend: 'Fetching logs…' }); // per-service, so a background refresh for one svc can't clobber the other tab's view
  const [toast,       setToast]       = useState(null);
  const [repos,       setRepos]       = useState([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [showRepoMenu, setShowRepoMenu] = useState(false);
  const [dirMenuOpen, setDirMenuOpen] = useState(null); // svc key whose directory picker is open, or null
  const [serviceDirs, setServiceDirs] = useState({ backend: [], frontend: [] }); // from service_directories.json

  const termOpen  = searchParams.get('terminal') === 'true';
  const openTerm  = () => setSearchParams(p => { const n = new URLSearchParams(p); n.set('terminal', 'true'); return n; });
  const closeTerm = () => setSearchParams(p => { const n = new URLSearchParams(p); n.delete('terminal');      return n; });
  const consoleRef          = useRef(null);
  const logRef              = useRef(null);
  const toastTimer          = useRef(null);
  const barTimer            = useRef(null);
  // true while the user has manually scrolled away from the bottom
  const consoleUserScrolled = useRef(false);
  const logUserScrolled     = useRef(false);
  const statusReqId         = useRef({}); // per-service counter, drops stale/out-of-order responses

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const appendConsole = useCallback((textCls, text) => {
    setConsoleLogs(prev => [...prev, { cls: textCls, text }]);
    // Scrolling is handled by the useEffect below
  }, []);

  const loadConfig = useCallback(async () => {
    try { const r = await absoluteApiFetch(`${MANAGE_API}/api/services`); setConfig(await r.json()); } catch { /* non-critical */ }
  }, [MANAGE_API]);

  const fetchStatus = useCallback(async (svc) => {
    const myId = (statusReqId.current[svc] || 0) + 1;
    statusReqId.current[svc] = myId;
    try {
      const d = await (await absoluteApiFetch(`${MANAGE_API}/api/status/${svc}`)).json();
      // a newer request already started (or finished) for this service — this
      // response is stale/out-of-order, drop it instead of overwriting fresher state
      if (statusReqId.current[svc] !== myId) return;
      setStatuses(prev => ({ ...prev, [svc]: d.running ? 'running' : 'stopped' }));
      setStats(prev => ({
        ...prev,
        [svc]: {
          pid:    d.pid ?? extractPid(d.output),
          cpu:    d.cpu    ?? null,
          mem:    d.mem    ?? null,
          uptime: d.uptime ?? '—',
        },
      }));
    } catch {
      if (statusReqId.current[svc] !== myId) return;
      setStatuses(prev => ({ ...prev, [svc]: 'error' }));
    }
  }, []);

  const fetchLog = useCallback(async (svc, { quiet = false } = {}) => {
    // quiet=true is used for background refreshes (e.g. after a directory
    // change) that shouldn't disturb scroll position or flash "Loading…"
    // for a tab the user isn't even looking at.
    if (!quiet) {
      logUserScrolled.current = false; // new log selected — reset to auto-scroll
      setLogContents(prev => ({ ...prev, [svc]: 'Loading…' }));
    }
    try {
      const d = await (await absoluteApiFetch(`${MANAGE_API}/api/logs/${svc}`)).json();
      setLogContents(prev => ({ ...prev, [svc]: d.logs || '(empty)' }));
      // Scrolling is handled by the useEffect below
    } catch (e) { setLogContents(prev => ({ ...prev, [svc]: 'Error: ' + e.message })); }
  }, [MANAGE_API]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await loadConfig();
    await Promise.all(SERVICES.map(fetchStatus));
    setLastSync(new Date().toLocaleTimeString());
    setRefreshing(false);
    // Fix 5: setTimeout(50) gives React a guaranteed paint cycle before the
    // CSS transition starts, replacing the unreliable requestAnimationFrame.
    setBarWidth(0);
    setTimeout(() => setBarWidth(100), 50);
  }, [loadConfig, fetchStatus]);

  const loadRepos = useCallback(async () => {
    try {
      const d = await (await absoluteApiFetch(`${MANAGE_API}/api/repos`)).json();
      setRepos(d.repos || []);
    } catch { /* non-critical */ }
  }, [MANAGE_API]);

  const loadServiceDirectories = useCallback(async () => {
    try {
      const d = await (await absoluteApiFetch(`${MANAGE_API}/api/service-directories`)).json();
      setServiceDirs({ backend: d.backend || [], frontend: d.frontend || [] });
    } catch { /* non-critical */ }
  }, [MANAGE_API]);

  const changeServiceDir = useCallback(async (svc, dir, port, entry) => {
    setDirMenuOpen(null);
    try {
      const res = await absoluteApiFetch(`${MANAGE_API}/api/service/${svc}/dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, port, entry }),
      });
      const d = await res.json();
      if (!res.ok) { showToast(d.detail || 'Failed to update directory', 'err'); return; }
      await loadConfig();
      await fetchStatus(svc);
      fetchLog(svc, { quiet: true }); // background refresh — doesn't touch scroll or whichever tab is currently shown
      showToast(`${svc} directory updated`, 'ok');
    } catch { showToast('Failed to update directory', 'err'); }
  }, [MANAGE_API, loadConfig, fetchStatus, fetchLog, showToast]);

  useEffect(() => {
    refreshAll();
    fetchLog('backend');
    loadRepos();
    loadServiceDirectories();
    barTimer.current = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(barTimer.current);
  }, []); // eslint-disable-line

  const doAction = useCallback(async (svc, action) => {
    if (action === 'stop' && !window.confirm(`Stop ${svcMeta[svc]?.label || svc}?\n\nThis will terminate the running process.`)) return;
    setBusy(prev => ({ ...prev, [svc]: true }));
    appendConsole('font-johnson-text text-jj-blue-03 font-semibold', `\n❯ ${action.toUpperCase()} ${svc}`);
    appendConsole('font-johnson-text text-jj-gray-05', `  ${new Date().toISOString()}`);
    try {
      const d   = await (await absoluteApiFetch(`${MANAGE_API}/api/${action}/${svc}`, { method: action === 'status' ? 'GET' : 'POST' })).json();
      const out = d.output || d.logs || '';
      const ok  = (d.returncode ?? 0) === 0;
      out.split('\n').forEach(line => {
        if (!line.trim()) return;
        appendConsole(`font-johnson-text ${lineClass(line, ok)}`, '  ' + line);
      });
      showToast(`${svc} ${action} ${ok ? 'succeeded' : 'failed'}`, ok ? 'ok' : 'err');
      if (action !== 'status') { await new Promise(res => setTimeout(res, 700)); await fetchStatus(svc); }
      else {
        setStatuses(prev => ({ ...prev, [svc]: d.running ? 'running' : 'stopped' }));
        setStats(prev => ({ ...prev, [svc]: { pid: d.pid ?? extractPid(d.output), cpu: d.cpu ?? null, mem: d.mem ?? null, uptime: d.uptime ?? '—' } }));
      }
    } catch (e) { appendConsole('font-johnson-text text-jj-red', '  ' + e.message); showToast('Request failed', 'err'); }
    setBusy(prev => ({ ...prev, [svc]: false }));
  }, [appendConsole, fetchStatus, showToast]);

  const runGitPull = useCallback(async () => {
    appendConsole('font-johnson-text text-jj-blue-03 font-semibold', '\n❯ GIT PULL');
    appendConsole('font-johnson-text text-jj-gray-05', `  ${new Date().toISOString()}`);
    try {
      const res = await absoluteApiFetch(`${MANAGE_API}/api/gitpull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedRepo ? { dir: selectedRepo } : {}),
      });
      const d = await res.json();

      if (!res.ok) {
        appendConsole('font-johnson-text text-jj-red', '  ' + (d.detail || `HTTP ${res.status}`));
        showToast('Git pull failed', 'err');
        return;
      }

      const ok = (d.returncode ?? 0) === 0;
      (d.output || '').split('\n').forEach(line => {
        if (!line.trim()) return;
        appendConsole(`font-johnson-text ${lineClass(line, ok)}`, '  ' + line);
      });
      showToast(ok ? 'Git pull succeeded' : 'Git pull failed', ok ? 'ok' : 'err');
    } catch (e) { appendConsole('font-johnson-text text-jj-red', '  ' + e.message); showToast('Git pull failed', 'err'); }
  }, [appendConsole, showToast, selectedRepo]);

  // ── Auto-scroll: scroll to bottom when content changes, unless the user
  // has manually scrolled up to read history. Once they scroll back to the
  // bottom (within 40px) auto-scroll resumes automatically.
  useEffect(() => {
    if (!consoleUserScrolled.current && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [consoleLogs]);

  useEffect(() => {
    if (!logUserScrolled.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logContents, activityTab]);

  const handleConsoleScroll = useCallback(() => {
    const el = consoleRef.current;
    if (!el) return;
    consoleUserScrolled.current = el.scrollHeight - el.scrollTop - el.clientHeight > 40;
  }, []);

  const handleLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    logUserScrolled.current = el.scrollHeight - el.scrollTop - el.clientHeight > 40;
  }, []);

  return (
    // Outer shell: fills the slot given by AppLayoutInner, never scrolls itself
    <div className="h-full flex flex-col overflow-hidden bg-jj-gray-01">

      {/* ── Header — full-bleed white bar, matches 3a ───────────────────────────── */}
      <div className="flex-shrink-0 grid grid-cols-3 items-center gap-4 bg-jj-white border-b border-jj-gray-02 px-4 py-3">
          <div className="flex items-center gap-3 justify-self-start">
            <span className="font-johnson-display font-bold text-jj-red" style={{ fontSize: '18px', letterSpacing: '-.02em' }}>&gt;_</span>
            <div>
              <h2 className="font-johnson-display text-jj-gray-08 font-bold" style={{ fontSize: '1.2rem' }}>
                Server Control
              </h2>
              <p className="font-johnson-text text-jj-gray-05 text-xs mt-0.5">
                {alias || '—'} · synced <strong className="text-jj-gray-07">{lastSync}</strong>
              </p>
            </div>
          </div>

          <div className="justify-self-center">
            {tabs && tabs.length > 1 && (
              <div className="inline-flex items-center gap-0.5 bg-jj-gray-02 rounded-full p-1">
                {tabs.map(t => (
                  <button
                    key={t.id}
                    onClick={t.onClick}
                    className={cx('flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-johnson-text text-sm font-semibold transition-all',
                      t.active ? 'bg-white text-jj-gray-08 shadow-sm' : 'text-jj-gray-06 hover:text-jj-gray-08')}
                  >
                    <span className={cx('w-1.5 h-1.5 rounded-full flex-shrink-0', t.dotCls)} />
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 justify-self-end">
            {canUseTerminal && (
              <button
                onClick={() => openTerm()}
                className="flex items-center gap-2 px-3 py-1.5 rounded border border-jj-gray-03 bg-jj-white text-jj-gray-07 font-johnson-text font-semibold hover:border-jj-gray-05 hover:bg-jj-gray-01 transition-all shadow-sm text-xs"
              >
                <img src={terminalIcon} alt="" className="w-3.5 h-3.5" style={{ filter: F_GRAY }} />
                Terminal
              </button>
            )}

            {canUseTerminal && (
              <div className="relative">
                <div className="flex items-center rounded-full overflow-hidden shadow-sm">
                  <button
                    onClick={runGitPull}
                    className="flex items-center gap-2 pl-4 pr-3 py-2 bg-jj-red text-jj-white font-johnson-text font-semibold hover:bg-jj-maroon-05 transition-colors text-xs"
                  >
                    <GitIcon /> Git Pull
                  </button>
                  {repos.length > 0 && (
                    <button
                      onClick={() => setShowRepoMenu(v => !v)}
                      title="Choose repo"
                      className="flex items-center px-2.5 py-2 bg-jj-maroon-05 hover:bg-jj-red transition-colors border-l border-white/30"
                    >
                      <img src={chevronDownIcon} alt="" className={cx('w-3 h-3 transition-transform', showRepoMenu && 'rotate-180')} style={{ filter: F_WHITE }} />
                    </button>
                  )}
                </div>

                {showRepoMenu && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setShowRepoMenu(false)} />
                    <div className="absolute right-0 mt-1.5 w-48 bg-jj-white rounded-lg shadow-lg border border-jj-gray-03 py-1 z-30">
                      <button
                        onClick={() => { setSelectedRepo(''); setShowRepoMenu(false); }}
                        className={cx('w-full text-left px-3 py-1.5 text-xs font-johnson-text hover:bg-jj-gray-01 transition-colors', !selectedRepo ? 'text-jj-red font-semibold' : 'text-jj-gray-07')}
                      >
                        Default repo
                      </button>
                      {repos.map(r => (
                        <button
                          key={r}
                          onClick={() => { setSelectedRepo(r); setShowRepoMenu(false); }}
                          className={cx('w-full text-left px-3 py-1.5 text-xs font-johnson-text hover:bg-jj-gray-01 transition-colors truncate', selectedRepo === r ? 'text-jj-red font-semibold' : 'text-jj-gray-07')}
                          title={r}
                        >
                          {r.split('/').pop()}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            <button
              onClick={refreshAll}
              disabled={refreshing}
              className="w-9 h-9 flex items-center justify-center rounded border border-jj-gray-03 bg-jj-white hover:bg-jj-gray-01 text-jj-gray-06 hover:text-jj-gray-08 transition-colors shadow-sm disabled:opacity-40"
              title="Refresh all"
            >
              <img src={refreshIcon} alt="" className={cx('w-4 h-4', refreshing && 'animate-spin')} style={{ filter: F_GRAY }} />
            </button>
          </div>
        </div>

        {/* ── Service cards ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden gap-3 px-4 py-4 min-h-0">

        <div className="flex-shrink-0">
          <SectionLabel>Services</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {SERVICES.map(svc => (
              <ServiceCard
                key={svc} svc={svc} config={config[svc] || {}}
                status={statuses[svc]} stats={stats[svc]}
                isBusy={busy[svc]} onAction={doAction}
                canUseTerminal={canUseTerminal}
                dirOptions={serviceDirs[svc] || []} dirMenuOpen={dirMenuOpen} setDirMenuOpen={setDirMenuOpen} onChangeDir={changeServiceDir}
              />
            ))}
          </div>
        </div>

        {/*
          ── Console + Logs: share the remaining vertical space ──────────────
          flex-1 + min-h-0 lets this section shrink/grow to fill what's left
          after the header and service cards are painted.
        */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <SectionLabel>Activity</SectionLabel>
          <div className="flex-1 flex flex-col bg-jj-white rounded-xl border border-jj-gray-02 shadow-sm overflow-hidden min-h-0">
            <div className="flex-shrink-0 flex items-center justify-between px-4 h-11 border-b border-jj-gray-02 bg-jj-gray-01">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setActivityTab('console')}
                  className={cx('font-johnson-text text-xs font-semibold px-3 py-1 rounded-full border transition-all',
                    activityTab === 'console'
                      ? 'bg-jj-red border-jj-red text-jj-white shadow-sm'
                      : 'bg-jj-white border-jj-gray-03 text-jj-gray-06 hover:text-jj-gray-08 hover:border-jj-gray-04')}
                >
                  Console
                </button>
                {SERVICES.map(svc => (
                  <button key={svc} onClick={() => { setActivityTab(svc); fetchLog(svc); }}
                    className={cx('font-johnson-text text-xs font-semibold px-3 py-1 rounded-full border transition-all',
                      activityTab === svc
                        ? 'bg-jj-red border-jj-red text-jj-white shadow-sm'
                        : 'bg-jj-white border-jj-gray-03 text-jj-gray-06 hover:text-jj-gray-08 hover:border-jj-gray-04')}>
                    {svc}.log
                  </button>
                ))}
              </div>
              {activityTab === 'console' ? (
                <button
                  onClick={() => setConsoleLogs([{ cls: 'font-johnson-text text-jj-gray-05 italic', text: '  Console cleared.' }])}
                  className="font-johnson-text text-xs text-jj-gray-05 hover:text-jj-gray-08 px-3 py-1 rounded-full border border-jj-gray-03 bg-jj-white hover:border-jj-gray-04 transition-colors"
                >
                  Clear
                </button>
              ) : (
                <button
                  onClick={() => fetchLog(activityTab)}
                  className="font-johnson-text text-xs text-jj-gray-05 hover:text-jj-gray-08 px-3 py-1 rounded-full border border-jj-gray-03 bg-jj-white hover:border-jj-gray-04 transition-colors"
                >
                  ↻ Reload
                </button>
              )}
            </div>

            {activityTab === 'console' ? (
              <div
                ref={consoleRef}
                onScroll={handleConsoleScroll}
                className="flex-1 font-johnson-text text-xs leading-relaxed p-4 overflow-y-auto bg-jj-gray-08"
                style={{ scrollbarWidth: 'thin' }}
              >
                {consoleLogs.map((line, i) => (
                  <span key={i} className={cx('block', line.cls)}>{line.text}</span>
                ))}
              </div>
            ) : (
              <div
                ref={logRef}
                onScroll={handleLogScroll}
                className="flex-1 font-johnson-text text-xs leading-relaxed p-4 overflow-y-auto text-jj-gray-01 bg-jj-gray-08"
                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', scrollbarWidth: 'thin' }}
              >
                {logContents[activityTab]}
              </div>
            )}
          </div>
        </div>{/* end activity panel */}

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 flex items-center justify-center py-1 border-t border-jj-gray-02">
          <p className="font-johnson-text text-xs text-jj-gray-04">
            © {new Date().getFullYear()} RDI · Johnson &amp; Johnson
          </p>
        </div>

      </div>{/* end inner flex-1 */}

      {/* Progress bar — animates from 0→100% over REFRESH_MS on each refresh */}
      <div className="fixed bottom-0 left-0 right-0 h-0.5 bg-jj-gray-02 z-30">
        <div
          className="h-full bg-jj-red"
          style={{
            width: `${barWidth}%`,
            transition: barWidth === 100 ? `width ${REFRESH_MS}ms linear` : 'none',
          }}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div className={cx(
          'fixed bottom-6 right-6 flex items-center gap-3 px-4 py-3 rounded-xl bg-jj-white border shadow-lg font-johnson-text text-sm text-jj-gray-08 z-40 animate-slide-in',
          toast.type === 'ok' ? 'border-jj-green-03' : 'border-jj-red'
        )}>
          <span className={cx('w-2 h-2 rounded-full flex-shrink-0',
            toast.type === 'ok' ? 'bg-jj-green-03' : 'bg-jj-red')} />
          {toast.msg}
        </div>
      )}

      {/* Terminal — only shown if user has terminal permission for this server */}
      {canUseTerminal && <Terminal isOpen={termOpen} onClose={closeTerm} manageUrl={MANAGE_API} />}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CARD
// ─────────────────────────────────────────────────────────────────────────────
function ServiceCard({ svc, config, status, stats, isBusy, onAction, canUseTerminal, dirOptions, dirMenuOpen, setDirMenuOpen, onChangeDir }) {
  const meta   = svcMeta[svc];
  const colors = statusColors[status] || statusColors.loading;

  const Btn = ({ action, label, icon, hoverCls }) => (
    <button
      onClick={() => onAction(svc, action)}
      disabled={isBusy}
      className={cx(
        'flex items-center justify-center gap-1.5 py-2 px-1 rounded border border-jj-gray-03 bg-jj-white text-jj-gray-06 font-johnson-text font-semibold shadow-sm transition-all text-xs',
        'hover:-translate-y-px hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none',
        hoverCls
      )}
    >
      {icon}{label}
    </button>
  );

  return (
    <div className={cx('bg-jj-white rounded-xl border border-jj-gray-02 shadow-sm overflow-hidden transition-shadow hover:shadow-md', colors.card)}>
      <div className="flex items-center gap-3 p-5 pb-0">
        <div
          className={cx('w-[50px] h-[50px] rounded-full border-2 flex items-center justify-center flex-shrink-0 bg-jj-gray-01', colors.ring)}
          style={{ boxShadow: `0 0 14px ${colors.glow}` }}
        >
          <img src={meta.icon} alt="" className="w-[19px] h-[19px]" style={{ filter: F_GRAY }} />
        </div>
        <div className="min-w-0">
          <p className="font-johnson-display text-jj-gray-08 font-semibold leading-tight" style={{ fontSize: '1.05rem' }}>
            {config.name || meta.label}
          </p>
          <div className="relative inline-block mt-0.5">
            <button
              onClick={() => setDirMenuOpen(open => open === svc ? null : svc)}
              className="flex items-center gap-1 text-jj-gray-05 hover:text-jj-gray-07 transition-colors"
              title={config.dir || ''}
            >
              <span className="font-johnson-text text-xs truncate max-w-48">{config.dir || '—'}</span>
              {dirOptions.length > 0 && (
                <img src={chevronDownIcon} alt="" className={cx('w-2.5 h-2.5 flex-shrink-0 transition-transform', dirMenuOpen === svc && 'rotate-180')} style={{ filter: F_GRAY }} />
              )}
            </button>

            {dirMenuOpen === svc && dirOptions.length > 0 && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setDirMenuOpen(null)} />
                <div className="absolute left-0 top-full mt-1 w-72 bg-jj-white rounded-lg shadow-lg border border-jj-gray-03 py-1 z-30 max-h-64 overflow-y-auto">
                  {dirOptions.map(o => (
                    <button
                      key={o.path}
                      onClick={() => o.exists !== false && onChangeDir(svc, o.path, o.port, o.entry)}
                      title={o.notes || o.path}
                      disabled={o.exists === false}
                      className={cx('w-full text-left px-3 py-1.5 font-johnson-text transition-colors',
                        o.exists === false ? 'opacity-40 cursor-not-allowed' : 'hover:bg-jj-gray-01',
                        o.path === config.dir ? 'text-jj-red' : 'text-jj-gray-07')}
                    >
                      <div className={cx('text-xs', o.path === config.dir && 'font-semibold')}>{o.label}</div>
                      <div className="text-[10px] text-jj-gray-05 truncate">{o.path}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <p className={cx('font-johnson-text font-bold uppercase tracking-wide mt-1', colors.text)} style={{ fontSize: '11px' }}>
            {status === 'running' ? 'Running' : status === 'loading' ? '…' : status === 'error' ? 'Error' : 'Stopped'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mx-5 mt-4">
        {[{ label: 'Port', value: config.port || '—' }, { label: 'PID', value: stats?.pid || '—' }, { label: 'Uptime', value: stats?.uptime || '—' }].map((m, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <span className="font-johnson-text font-bold uppercase tracking-widest text-jj-gray-05" style={{ fontSize: '9px' }}>
              {m.label}
            </span>
            <span className="font-johnson-text text-jj-gray-08 font-semibold text-sm">{m.value}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 mx-5 mt-3">
        {[{ label: 'CPU', value: stats?.cpu, barCls: 'bg-jj-blue-03' }, { label: 'MEM', value: stats?.mem, barCls: 'bg-jj-violet-03' }].map((m, i) => (
          <div key={i}>
            <div className="flex items-center justify-between">
              <span className="font-johnson-text font-bold uppercase tracking-widest text-jj-gray-05" style={{ fontSize: '9px' }}>{m.label}</span>
              <span className="font-johnson-text text-jj-gray-06" style={{ fontSize: '10px' }}>{m.value != null ? `${m.value}%` : '—'}</span>
            </div>
            <div className="h-1 rounded-full bg-jj-gray-02 mt-1.5 overflow-hidden">
              <div className={cx('h-full rounded-full', m.barCls)} style={{ width: `${m.value ?? 0}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className={`grid ${canUseTerminal ? 'grid-cols-4' : 'grid-cols-2'} gap-2 p-4 pt-3`}>
        <Btn action="start"   label="Start"   icon={<StartIcon />}   hoverCls="hover:bg-jj-gray-01 hover:border-jj-green-03 hover:text-jj-green-03" />
        {canUseTerminal && <Btn action="stop"    label="Stop"    icon={<StopIcon />}    hoverCls="hover:bg-jj-gray-01 hover:border-jj-red hover:text-jj-red" />}
        {canUseTerminal && <Btn action="restart" label="Restart" icon={<RestartIcon />} hoverCls="hover:bg-jj-gray-01 hover:border-jj-orange-03 hover:text-jj-orange-03" />}
        <Btn action="status"  label="Status"  icon={<StatusIcon />}  hoverCls="hover:bg-jj-gray-01 hover:border-jj-blue-03 hover:text-jj-blue-03" />
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// SHARED ATOMS
// ─────────────────────────────────────────────────────────────────────────────
const SectionLabel = ({ children }) => (
  <div className="flex items-center gap-3 mb-4">
    <span className="font-johnson-text font-bold text-xs uppercase tracking-widest text-jj-gray-05 whitespace-nowrap">
      {children}
    </span>
    <div className="flex-1 h-px bg-jj-gray-02" />
  </div>
);

const StartIcon   = () => <img src={playIcon} alt="" className="w-3 h-3"    style={{ filter: F_GRAY }} />;
const StopIcon    = () => <img src={closeIcon}        alt="" className="w-3 h-3"    style={{ filter: F_GRAY }} />;
const RestartIcon = () => <img src={restartIcon}        alt="" className="w-3 h-3"    style={{ filter: F_GRAY }} />;
const StatusIcon  = () => <img src={gearIcon}         alt="" className="w-3 h-3"    style={{ filter: F_GRAY }} />;
const GitIcon     = () => <img src={restartIcon}   alt="" className="w-3.5 h-3.5" style={{ filter: F_WHITE }} />;