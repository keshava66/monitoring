/**
 * EPodAgentPage.jsx — Cockpit / gauge row design
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import { apiFetch, API_BASE_URL } from '../utils/apiClient';
import EPodPipelineViz from './EPodPipelineViz';

const VIEW_LABELS = { pipeline: 'Pipeline', terminal: 'Terminal output', log: 'Log file' };

const POLL_MS  = 5_000;
const cx = (...a) => a.filter(Boolean).join(' ');

// Pipeline VM spec — used to turn the agent's raw readings into "% of this
// machine", not arbitrary numbers. Update if the boxes ever get resized.
const TOTAL_MEMORY_MB = 7.5 * 1024; // 7.5 GiB
const CPU_CORES       = 4;          // vCPUs

const COLOR_RULES = [
  [/error|fail|exception|traceback/i, '#ef2929'],
  [/warn|warning/i,                   '#fce94f'],
  [/success|complete|done|finished/i, '#8ae234'],
  [/info|start|running/i,             '#729fcf'],
];
function lineColor(line) {
  for (const [re, col] of COLOR_RULES) if (re.test(line)) return col;
  return '#cccccc';
}

// Gauge color reflects the VALUE, not which metric it is — a 5% memory bar
// and a 95% CPU bar were previously hardcoded red/green regardless of
// actual usage, which is backwards (low memory looked alarming, maxed-out
// CPU looked fine). Same green/amber/red palette already used elsewhere
// on this page (stateColor, lineColor).
function gaugeColor(pct, { warn = 60, danger = 85 } = {}) {
  if (pct >= danger) return '#eb1700';
  if (pct >= warn)   return '#c4a000';
  return '#328714';
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ value, onChange, label, disabled = false }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      className={cx('flex items-center gap-2 select-none group', disabled && 'opacity-40 cursor-not-allowed')}
      role="switch" aria-checked={value}
    >
      <div
        className="relative flex items-center w-8 h-4 rounded-full transition-colors duration-200 flex-shrink-0"
        style={{ background: value ? '#eb1700' : '#cbc4bc' }}
      >
        <span
          className="absolute w-3 h-3 rounded-full bg-white shadow transition-all duration-200"
          style={{ left: value ? '17px' : '2px' }}
        />
      </div>
      {label && (
        <span className="text-xs font-johnson-text text-jj-gray-05 group-hover:text-jj-gray-07 transition-colors whitespace-nowrap">
          {label}
        </span>
      )}
    </button>
  );
}

// ── Gauge bar ─────────────────────────────────────────────────────────────────
function GaugeBar({ pct, color }) {
  return (
    <div className="mt-1.5 h-1 w-full rounded-full bg-jj-gray-02">
      <div
        className="h-1 rounded-full transition-all duration-700"
        style={{ width: `${Math.min(100, pct)}%`, background: color }}
      />
    </div>
  );
}

// ── Log box ───────────────────────────────────────────────────────────────────
function LogBox({ lines, total, path, showTs, className = '' }) {
  const ref    = useRef(null);
  const [pinned, setPinned] = useState(true);
  const colors = useMemo(() => lines.map(lineColor), [lines]);
  const now    = new Date();
  const ts     = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  useEffect(() => {
    if (pinned && ref.current)
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, pinned]);

  const onScroll = () => {
    if (!ref.current) return;
    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    setPinned(scrollHeight - scrollTop - clientHeight < 32);
  };

  return (
    <div className={cx('flex flex-col min-h-0 relative', className)}>
      <div
        ref={ref}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto p-4 font-mono text-xs leading-6"
        style={{ background: '#0d1117', scrollbarWidth: 'thin', scrollbarColor: '#312c2a #0d1117' }}
      >
        {lines.length === 0 ? (
          <div className="flex items-center gap-2 mt-2" style={{ color: '#555' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-jj-gray-06 animate-pulse" />
            Waiting for output...
          </div>
        ) : lines.map((line, i) => (
          <div key={i} className="flex gap-3 hover:bg-white/5 px-1 -mx-1 rounded" style={{ color: colors[i] }}>
            <span className="flex-shrink-0 w-7 text-right select-none leading-6" style={{ color: '#444' }}>
              {total - lines.length + i + 1}
            </span>
            {showTs && (
              <span className="flex-shrink-0 select-none leading-6" style={{ color: '#444' }}>{ts}</span>
            )}
            <span className="break-all flex-1">{line}</span>
          </div>
        ))}
        {!pinned && (
          <button
            onClick={() => { setPinned(true); ref.current.scrollTop = ref.current.scrollHeight; }}
            className="sticky bottom-2 mx-auto flex items-center gap-1.5 px-3 py-1 text-xs font-johnson-text text-white rounded-full"
            style={{ background: '#eb1700', display: 'flex' }}
          >
            ↓ Jump to bottom
          </button>
        )}
      </div>
      {path && (
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-jj-gray-07 flex-shrink-0"
          style={{ background: '#0d1117' }}>
          <span className="text-xs font-mono truncate" style={{ color: '#555' }}>{path}</span>
          <span className="text-xs font-mono ml-4 flex-shrink-0" style={{ color: '#555' }}>
            {total.toLocaleString()} lines
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function EPodAgentPage({ proxyBase, title, adminPermission }) {
  const { hasPermission } = useRBAC();
  const { user, getAccessToken } = useAuth();
  const email = user?.email || user?.username || 'unknown';
  const canStop = adminPermission ? hasPermission(adminPermission) : false;
  const base = proxyBase; // apiFetch prepends the backend origin

  const [searchParams, setSearchParams] = useSearchParams();
  const VIEWS = ['pipeline', 'terminal', 'log'];

  const [status,        setStatus]        = useState(null);
  const [info,          setInfo]          = useState(null);
  const [logs,          setLogs]          = useState({ lines: [], total: 0, path: '' });
  const [terminal,      setTerminal]      = useState({ lines: [], total: 0, path: '' });
  const [activeTab, setActiveTabState] = useState(() => {
    const v = searchParams.get('view');
    return VIEWS.includes(v) ? v : 'pipeline';
  });
  const setActiveTab = useCallback((id) => {
    setActiveTabState(id);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('view', id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const handleViewChange = (id) => {
    if (id === activeTab) return;
    const fromLabel = VIEW_LABELS[activeTab] ?? activeTab;
    const toLabel   = VIEW_LABELS[id] ?? id;
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Switched from ${fromLabel} to ${toLabel} on ${title || proxyBase}`);
    setActiveTab(id);
  };
  useEffect(() => {
    const v = searchParams.get('view');
    const resolved = VIEWS.includes(v) ? v : 'pipeline';
    if (resolved !== activeTab) setActiveTabState(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [logLines,      setLogLines]      = useState(50);
  const [termLines,     setTermLines]     = useState(50);
  const [liveMode,      setLiveMode]      = useState(true);
  const [sseStatus,     setSseStatus]     = useState('off');
  const [autoRefresh,   setAutoRefresh]   = useState(false);
  const [autoInterval,  setAutoInterval]  = useState(15);
  const [showTs,        setShowTs]        = useState(false);
  const [scriptState,   setScriptState]   = useState('idle');
  const [confirmStop,   setConfirmStop]   = useState(false);
  const [busy,          setBusy]          = useState(false);
  const [toast,         setToast]         = useState(null);
  const [lastRefresh,   setLastRefresh]   = useState(null);

  const evtSourceRef        = useRef(null);
  const reconnectTimer      = useRef(null);
  const liveBufferRef       = useRef([]);
  const liveModeRef         = useRef(true);   // mirrors liveMode without closure staleness
  const pipelineCallbackRef = useRef(null);   // EPodPipelineViz registers here
  const [liveLines,    setLiveLines]      = useState([]);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const r = await apiFetch(`${base}/status`);
      if (r.ok) {
        const d = await r.json();
        setStatus(d);
        setScriptState(d.running ? 'running' : 'idle');
      }
    } catch {}
  }, [base]);

  const fetchLogs = useCallback(async () => {
    try { const r = await apiFetch(`${base}/logs?n=${logLines}`); if (r.ok) setLogs(await r.json()); } catch {}
  }, [base, logLines]);

  const fetchTerminal = useCallback(async () => {
    try { const r = await apiFetch(`${base}/terminal?n=${termLines}`); if (r.ok) setTerminal(await r.json()); } catch {}
  }, [base, termLines]);

  const fetchAll = useCallback(async () => {
    await Promise.all([fetchStatus(), fetchLogs(), fetchTerminal()]);
    setLastRefresh(new Date());
  }, [fetchStatus, fetchLogs, fetchTerminal]);

  useEffect(() => {
    fetchAll();
    apiFetch(`${base}/info`).then(r => r.ok ? r.json() : null).then(d => { if (d) setInfo(d); });
  }, [base]);

  useEffect(() => { fetchLogs(); }, [logLines]);
  useEffect(() => { fetchTerminal(); }, [termLines]);
  useEffect(() => { const id = setInterval(fetchStatus, POLL_MS); return () => clearInterval(id); }, [fetchStatus]);

  useEffect(() => {
    if (!autoRefresh || liveMode) return;
    const id = setInterval(fetchAll, autoInterval * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, autoInterval, fetchAll, liveMode]);

  // Keep ref in sync so the SSE closure always reads the current value
  useEffect(() => { liveModeRef.current = liveMode; }, [liveMode]);

  // Clear terminal buffer when user switches live mode back on
  useEffect(() => {
    if (liveMode) { liveBufferRef.current = []; setLiveLines([]); }
  }, [liveMode]);

  const connectSSE = useCallback(async () => {
    if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null; }
    setSseStatus('connecting');
    // EventSource can't set an Authorization header — the proxy accepts the
    // token as a query param for this route instead (see Backend.py).
    let token = '';
    try { token = await getAccessToken(); } catch { /* server will reject, that's fine */ }
    const es = new EventSource(`${API_BASE_URL}${base}/terminal/stream?access_token=${encodeURIComponent(token)}`);
    evtSourceRef.current = es;
    es.onopen = () => setSseStatus('connected');
    es.onmessage = (e) => {
      if (!e.data) return;
      // Always forward to pipeline visualiser — it needs the stream regardless of terminal liveMode
      pipelineCallbackRef.current?.(e.data);
      // Only accumulate in the terminal buffer when live display is active
      if (liveModeRef.current) {
        liveBufferRef.current = [...liveBufferRef.current, e.data].slice(-200);
        setLiveLines([...liveBufferRef.current]);
      }
    };
    es.onerror = () => {
      es.close(); evtSourceRef.current = null; setSseStatus('error');
      reconnectTimer.current = setTimeout(() => { if (!evtSourceRef.current) connectSSE(); }, 3000);
    };
  }, [base, getAccessToken]);
  // liveMode only controls whether the *terminal tab* displays the live stream.
  useEffect(() => {
    const t = setTimeout(() => connectSSE(), 300);
    return () => {
      clearTimeout(t);
      clearTimeout(reconnectTimer.current);
      evtSourceRef.current?.close(); evtSourceRef.current = null;
      setSseStatus('off');
    };
  }, [connectSSE]);

  const doAction = async (endpoint, successMsg) => {
    setBusy(true);
    if (endpoint === 'start') setScriptState('starting');
    if (endpoint === 'stop')  setScriptState('stopping');
    try {
      const r = await apiFetch(`${base}/${endpoint}`, { method: 'POST' });
      if (r.ok) {
        showToast(successMsg);
        if (endpoint === 'start') logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Started pipeline on ${title || proxyBase}`);
        if (endpoint === 'stop')  logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Stopped pipeline on ${title || proxyBase}`);
        setTimeout(fetchAll, 1500);
      }
      else { const d = await r.json().catch(() => ({})); showToast(d.detail || 'Action failed.', 'error'); setScriptState(status?.running ? 'running' : 'idle'); }
    } catch { showToast('Network error.', 'error'); setScriptState(status?.running ? 'running' : 'idle'); }
    finally { setBusy(false); }
  };

  const clearTerminal = async () => {
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Clear button clicked on ${title || proxyBase}`);
    await doAction('clear-terminal', 'Terminal cleared.');
    liveBufferRef.current = []; setLiveLines([]);
  };

  const handleRefresh = () => {
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Refresh clicked on ${title || proxyBase} (${activeTab} view)`);
    fetchAll();
  };

  const handleLiveModeToggle = (v) => {
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Live stream ${v ? 'enabled' : 'disabled'} on ${title || proxyBase}`);
    setLiveMode(v);
    if (v) setAutoRefresh(false);
  };

  const handleAutoRefreshToggle = (v) => {
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Auto-refresh ${v ? 'enabled' : 'disabled'} on ${title || proxyBase}`);
    setAutoRefresh(v);
  };

  const handleShowTsToggle = (v) => {
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Timestamps ${v ? 'enabled' : 'disabled'} on ${title || proxyBase}`);
    setShowTs(v);
  };

  const downloadLog = async () => {
    const endpoint = activeTab === 'terminal' ? `/terminal?n=10000` : `/logs?n=10000`;
    try {
      const r = await apiFetch(`${base}${endpoint}`);
      if (!r.ok) return;
      const d = await r.json();
      const blob = new Blob([d.lines.join('\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(title || 'epod').replace(/\s+/g,'_')}_${activeTab}_${new Date().toISOString().slice(0,10)}.log`;
      a.click(); URL.revokeObjectURL(a.href);
      logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Downloaded ${activeTab} log on ${title || proxyBase}`);
    } catch { showToast('Download failed.', 'error'); }
  };

  const running     = status?.running ?? false;
  const displayLines = liveMode ? liveLines : terminal.lines;

  // Parse memory percentage from string like "142.0 MB"
  const memPct = useMemo(() => {
    if (!status?.memory) return 0;
    const mb = parseFloat(status.memory);
    return isNaN(mb) ? 0 : Math.min(100, (mb / TOTAL_MEMORY_MB) * 100);
  }, [status?.memory]);

  // psutil's process.cpu_percent() is relative to ONE core — a single
  // fully-busy thread reads ~100% even with 3 other cores sitting idle on
  // this 4-vCPU box. Dividing by CPU_CORES turns it into "% of this
  // machine's total capacity", which is what the gauge color/label
  // (Low/Moderate/High load) are meant to represent.
  const cpuPct = useMemo(() => {
    if (!status?.cpu) return 0;
    const raw = parseFloat(status.cpu) || 0;
    return Math.min(100, raw / CPU_CORES);
  }, [status?.cpu]);

  const sseIndicator = {
    connecting: { color: '#c4a000', label: 'Connecting...' },
    connected:  { color: '#639922', label: 'Live' },
    error:      { color: '#ff6017', label: 'Reconnecting...' },
  }[sseStatus];

  const stateColor = {
    idle:     '#eb1700',
    starting: '#c4a000',
    running:  '#639922',
    stopping: '#c4a000',
  }[scriptState] ?? '#a39992';

  const stateLabel = {
    idle: 'Offline', starting: 'Starting…', running: 'Online', stopping: 'Stopping…',
  }[scriptState] ?? '···';

  const formatRefresh = () => {
    if (!lastRefresh) return '—';
    const s = Math.floor((Date.now() - lastRefresh) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s/60)}m ago`;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-jj-gray-01">

      {/* Toast */}
      {toast && (
        <div className={cx(
          'fixed top-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 animate-slide-in font-johnson-text text-sm font-semibold border-l-4',
          toast.type === 'error' ? 'bg-white text-jj-red border-l-jj-red' : 'bg-white text-jj-green-03 border-l-jj-green-03'
        )} style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.14)' }}>
          <span className={cx('w-2 h-2 rounded-full', toast.type === 'error' ? 'bg-jj-red' : 'bg-jj-green-03')} />
          {toast.msg}
        </div>
      )}

      {/* ── Controls block — shared by both header modes ────────────────────
           compact (Pipeline tab): inline pill strip
           full    (Terminal/Log): original header + cockpit cards           ── */}

      {activeTab === 'pipeline' ? (

        /* ── COMPACT MODE (Pipeline tab only) ────────────────────────────── */
        <div className="flex-shrink-0 bg-white" style={{ borderBottom: '3px solid #eb1700' }}>
          <div className="flex items-center gap-0 px-4 py-1.5" style={{ borderBottom: '1px solid #e8e6e3' }}>

            {/* Pulse + title */}
            <div className="flex items-center gap-2 min-w-0 mr-4">
              <div className="relative flex-shrink-0 w-2.5 h-2.5">
                {running && <div className="absolute inset-0 rounded-full border-2 animate-ping opacity-40" style={{ borderColor: stateColor }} />}
                <div className="absolute inset-0.5 rounded-full" style={{ background: stateColor }} />
              </div>
              <span className="font-johnson-display text-jj-gray-08 font-normal truncate" style={{ fontSize: '1rem', lineHeight: 1.2 }}>
                {info?.server_name || title || 'Extraction Monitor'}
              </span>
              <span className="font-johnson-text font-bold px-2 py-0.5 border flex-shrink-0" style={{
                color: stateColor, borderColor: stateColor, fontSize: '0.65rem',
                background: scriptState === 'running' ? '#EAF3DE' : scriptState === 'idle' ? '#FCEBEB' : '#FAEEDA',
              }}>
                {status === null ? '···' : stateLabel}
              </span>
              {info && <span className="font-mono text-jj-gray-04 truncate hidden sm:inline" style={{ fontSize: '0.65rem' }}>{info.script_name}</span>}
            </div>

            {/* Stat pills */}
            <div className="flex items-center gap-0 divide-x divide-jj-gray-02 mr-4">
              {[
                { label: 'PID',    value: status?.pid    ?? '—' },
                { label: 'Uptime', value: status?.uptime ?? '—' },
                { label: 'Mem',    value: status?.memory ?? '—', pct: memPct, pctColor: gaugeColor(memPct) },
                { label: 'CPU',    value: status?.cpu ? `${cpuPct.toFixed(1)}%` : '—', pct: cpuPct, pctColor: gaugeColor(cpuPct, { warn: 20, danger: 60 }) },
              ].map(({ label, value, pct, pctColor }) => (
                <div key={label} className="flex items-center gap-1.5 px-3">
                  <span className="font-johnson-text text-jj-gray-04 uppercase" style={{ fontSize: '0.6rem', letterSpacing: '0.06em' }}>{label}</span>
                  <span className="font-johnson-display text-jj-gray-08 font-semibold" style={{ fontSize: '0.8rem' }}>{value}</span>
                  {pct > 0 && (
                    <div className="w-10 h-1 bg-jj-gray-02 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100,pct)}%`, background: pctColor }} />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Controls */}
            <div className="ml-auto flex items-center gap-2 flex-shrink-0">
              <button onClick={handleRefresh} disabled={busy}
                className="flex items-center gap-1 px-2.5 py-1 border border-jj-gray-02 text-jj-gray-06 font-johnson-text hover:border-jj-gray-04 hover:text-jj-gray-08 transition-colors disabled:opacity-40"
                style={{ fontSize: '0.7rem' }}>
                ↻ Refresh
              </button>
              {scriptState === 'idle' ? (
                <button onClick={() => doAction('start', 'Script started.')} disabled={busy}
                  className="flex items-center gap-1 px-3 py-1 font-johnson-text font-bold text-white transition-colors disabled:opacity-40"
                  style={{ background: '#eb1700', fontSize: '0.75rem' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#9e0000'}
                  onMouseLeave={e => e.currentTarget.style.background = '#eb1700'}>
                  ▶ Start
                </button>
              ) : scriptState === 'starting' || scriptState === 'stopping' ? (
                <div className="flex items-center gap-1.5 px-3 py-1 font-johnson-text font-bold border"
                  style={{ color: '#c4a000', borderColor: '#c4a000', background: '#FAEEDA', fontSize: '0.75rem' }}>
                  <span className="w-2.5 h-2.5 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: '#c4a000', borderTopColor: 'transparent' }} />
                  {scriptState === 'starting' ? 'Starting…' : 'Stopping…'}
                </div>
              ) : confirmStop ? (
                <div className="flex items-center gap-1.5">
                  <span className="font-johnson-text text-jj-gray-06" style={{ fontSize: '0.7rem' }}>Stop?</span>
                  <button onClick={() => { setConfirmStop(false); doAction('stop', 'Script stopped.'); }} disabled={busy}
                    className="px-2.5 py-1 font-johnson-text font-bold text-white disabled:opacity-40"
                    style={{ background: '#eb1700', fontSize: '0.75rem' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#9e0000'}
                    onMouseLeave={e => e.currentTarget.style.background = '#eb1700'}>Yes</button>
                  <button onClick={() => setConfirmStop(false)}
                    className="px-2.5 py-1 border border-jj-gray-03 text-jj-gray-06 font-johnson-text hover:bg-jj-gray-01 transition-colors"
                    style={{ fontSize: '0.75rem' }}>Cancel</button>
                </div>
              ) : canStop ? (
                <button onClick={() => setConfirmStop(true)} disabled={busy}
                  className="flex items-center gap-1 px-3 py-1 border font-johnson-text font-bold transition-colors disabled:opacity-40"
                  style={{ borderColor: '#eb1700', color: '#eb1700', fontSize: '0.75rem' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#FCEBEB'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
                  ■ Stop
                </button>
              ) : null}
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex items-center px-2">
            {[['pipeline', 'Pipeline'], ['terminal', 'Terminal output'], ['log', 'Log file']].map(([id, label]) => (
              <button key={id} onClick={() => handleViewChange(id)}
                className={cx('relative px-5 py-3 font-johnson-text text-sm transition-colors',
                  activeTab === id ? 'text-jj-gray-08 font-semibold' : 'text-jj-gray-05 hover:text-jj-gray-07')}>
                {label}
                {activeTab === id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-jj-red" />}
              </button>
            ))}
          </div>
        </div>

      ) : (

        /* ── FULL MODE (Terminal / Log tabs) ──────────────────────────────── */
        <>
          {/* Header bar */}
          <div className="flex-shrink-0 bg-white px-6 py-3 flex items-center justify-between gap-4" style={{ borderBottom: '3px solid #eb1700' }}>
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative flex-shrink-0 w-3 h-3">
                {running && <div className="absolute inset-0 rounded-full border-2 animate-ping opacity-40" style={{ borderColor: stateColor }} />}
                <div className="absolute inset-0.5 rounded-full" style={{ background: stateColor }} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="font-johnson-display text-jj-gray-08 font-normal truncate" style={{ fontSize: '1.35rem', lineHeight: 1.2 }}>
                    {info?.server_name || title || 'Extraction Monitor'}
                  </h1>
                  <span className="text-xs font-johnson-text font-bold px-2.5 py-0.5 border flex-shrink-0" style={{
                    color: stateColor, borderColor: stateColor,
                    background: scriptState === 'running' ? '#EAF3DE' : scriptState === 'idle' ? '#FCEBEB' : '#FAEEDA',
                  }}>
                    {status === null ? '···' : stateLabel}
                  </span>
                </div>
                {info && <p className="font-mono text-xs text-jj-gray-05 mt-0.5 truncate">{info.script_name}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={handleRefresh} disabled={busy}
                className="flex items-center gap-1.5 px-3 py-2 border border-jj-gray-02 text-jj-gray-06 font-johnson-text text-xs hover:border-jj-gray-04 hover:text-jj-gray-08 transition-colors disabled:opacity-40">
                ↻ Refresh
              </button>
              {scriptState === 'idle' ? (
                <button onClick={() => doAction('start', 'Script started.')} disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 font-johnson-text text-sm font-bold text-white transition-colors disabled:opacity-40"
                  style={{ background: '#eb1700' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#9e0000'}
                  onMouseLeave={e => e.currentTarget.style.background = '#eb1700'}>
                  ▶ Start script
                </button>
              ) : scriptState === 'starting' || scriptState === 'stopping' ? (
                <div className="flex items-center gap-2 px-4 py-2 font-johnson-text text-sm font-bold border"
                  style={{ color: '#c4a000', borderColor: '#c4a000', background: '#FAEEDA' }}>
                  <span className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: '#c4a000', borderTopColor: 'transparent' }} />
                  {scriptState === 'starting' ? 'Starting…' : 'Stopping…'}
                </div>
              ) : confirmStop ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-johnson-text text-jj-gray-06">Stop the script?</span>
                  <button onClick={() => { setConfirmStop(false); doAction('stop', 'Script stopped.'); }} disabled={busy}
                    className="px-3 py-2 font-johnson-text text-xs font-bold text-white disabled:opacity-40"
                    style={{ background: '#eb1700' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#9e0000'}
                    onMouseLeave={e => e.currentTarget.style.background = '#eb1700'}>Yes, stop</button>
                  <button onClick={() => setConfirmStop(false)}
                    className="px-3 py-2 border border-jj-gray-03 text-jj-gray-06 font-johnson-text text-xs hover:bg-jj-gray-01 transition-colors">
                    Cancel
                  </button>
                </div>
              ) : canStop ? (
                <button onClick={() => setConfirmStop(true)} disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 border font-johnson-text text-sm font-bold transition-colors disabled:opacity-40"
                  style={{ borderColor: '#eb1700', color: '#eb1700' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#FCEBEB'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
                  ■ Stop script
                </button>
              ) : null}
            </div>
          </div>

          {/* Cockpit gauge row */}
          <div className="flex-shrink-0 bg-white grid grid-cols-5" style={{ borderBottom: '1px solid #e8e6e3' }}>
            <div className="px-5 py-4 border-r border-jj-gray-02">
              <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-widest mb-1.5">Status</p>
              <p className="font-johnson-display text-xl font-semibold" style={{ color: stateColor }}>{stateLabel}</p>
              <p className="text-xs font-johnson-text text-jj-gray-05 mt-1">
                {running && info ? `Since ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : 'Not running'}
              </p>
            </div>
            <div className="px-5 py-4 border-r border-jj-gray-02">
              <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-widest mb-1.5">Process ID</p>
              <p className="font-johnson-display text-xl font-semibold text-jj-gray-08">{status?.pid ?? '—'}</p>
              <p className="text-xs font-johnson-text text-jj-gray-05 mt-1">python3 process</p>
            </div>
            <div className="px-5 py-4 border-r border-jj-gray-02">
              <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-widest mb-1.5">Uptime</p>
              <p className="font-johnson-display text-xl font-semibold text-jj-gray-08">{status?.uptime ?? '—'}</p>
              <p className="text-xs font-johnson-text text-jj-gray-05 mt-1">active session</p>
            </div>
            <div className="px-5 py-4 border-r border-jj-gray-02">
              <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-widest mb-1.5">Memory</p>
              <p className="font-johnson-display text-xl font-semibold text-jj-gray-08">{status?.memory ?? '—'}</p>
              <GaugeBar pct={memPct} color={gaugeColor(memPct)} />
              <p className="text-xs font-johnson-text text-jj-gray-05 mt-1">{memPct > 0 ? `${memPct.toFixed(0)}% of 7.5 GiB` : '—'}</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-widest mb-1.5">CPU</p>
              <p className="font-johnson-display text-xl font-semibold text-jj-gray-08">{status?.cpu ? `${cpuPct.toFixed(1)}%` : '—'}</p>
              <GaugeBar pct={cpuPct} color={gaugeColor(cpuPct, { warn: 20, danger: 60 })} />
              <p className="text-xs font-johnson-text text-jj-gray-05 mt-1">{cpuPct > 0 ? (cpuPct < 20 ? 'Low utilisation' : cpuPct < 60 ? 'Moderate' : 'High load') : '—'}</p>
            </div>
          </div>

          {/* Tab + toolbar row */}
          <div className="flex-shrink-0 bg-white flex items-center border-b border-jj-gray-02 px-2">
            {[['pipeline', 'Pipeline'], ['terminal', 'Terminal output'], ['log', 'Log file']].map(([id, label]) => (
              <button key={id} onClick={() => handleViewChange(id)}
                className={cx('relative px-5 py-3 font-johnson-text text-sm transition-colors',
                  activeTab === id ? 'text-jj-gray-08 font-semibold' : 'text-jj-gray-05 hover:text-jj-gray-07')}>
                {label}
                {activeTab === id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-jj-red" />}
              </button>
            ))}

            {/* Toolbar */}
            <div className="ml-auto flex items-center gap-3 pr-3">
              <Toggle value={showTs} onChange={handleShowTsToggle} label="Timestamps" />
              <div className="h-4 w-px bg-jj-gray-02" />
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-johnson-text text-jj-gray-05">Lines</span>
                <div className="relative">
                  <select
                    value={activeTab === 'terminal' ? termLines : logLines}
                    onChange={e => activeTab === 'terminal' ? setTermLines(Number(e.target.value)) : setLogLines(Number(e.target.value))}
                    className="appearance-none border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07 pl-2 pr-6 py-1.5 bg-white focus:outline-none focus:border-jj-red transition-colors"
                  >
                    {[20, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-jj-gray-05 pointer-events-none text-xs">▾</span>
                </div>
              </div>
              <div className="h-4 w-px bg-jj-gray-02" />
              {activeTab === 'terminal' && (
                <>
                  {liveMode && sseIndicator && (
                    <span className="flex items-center gap-1.5 text-xs font-johnson-text font-bold" style={{ color: sseIndicator.color }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: sseIndicator.color, animation: sseStatus === 'connected' ? 'pulse 2s infinite' : 'none' }} />
                      {sseIndicator.label}
                    </span>
                  )}
                  <Toggle value={liveMode} onChange={handleLiveModeToggle} label="Live stream" />
                  <div className="h-4 w-px bg-jj-gray-02" />
                  <button onClick={clearTerminal} disabled={busy}
                    className="text-xs font-johnson-text text-jj-gray-04 hover:text-jj-red transition-colors disabled:opacity-40">
                    Clear
                  </button>
                  <div className="h-4 w-px bg-jj-gray-02" />
                </>
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-johnson-text text-jj-gray-05">Auto</span>
                {liveMode ? (
                  <span className="text-xs font-johnson-text text-jj-gray-04 italic">off while live</span>
                ) : (
                  <>
                    <Toggle value={autoRefresh} onChange={handleAutoRefreshToggle} />
                    {autoRefresh && (
                      <div className="relative">
                        <select value={autoInterval} onChange={e => setAutoInterval(Number(e.target.value))}
                          className="appearance-none border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07 pl-2 pr-6 py-1.5 bg-white focus:outline-none focus:border-jj-red">
                          {[5, 10, 15, 30].map(s => <option key={s} value={s}>{s}s</option>)}
                        </select>
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-jj-gray-05 pointer-events-none text-xs">▾</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="h-4 w-px bg-jj-gray-02" />
              <button onClick={downloadLog} disabled={busy}
                className="flex items-center gap-1 text-xs font-johnson-text text-jj-gray-05 hover:text-jj-red transition-colors disabled:opacity-40">
                ↓ Download
              </button>
            </div>
          </div>{/* end tab+toolbar row */}
        </>
      )}
      {/* ── Log content ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-auto">
        {activeTab === 'pipeline' && (
          <EPodPipelineViz proxyBase={proxyBase} title={title} lineRef={pipelineCallbackRef} sseStatus={sseStatus} />
        )}
        {activeTab === 'log' && (
          <LogBox lines={logs.lines} total={logs.total} path={logs.path} showTs={showTs} className="h-full" />
        )}
        {activeTab === 'terminal' && (
          <LogBox
            lines={displayLines}
            total={liveMode ? displayLines.length : terminal.total}
            path={liveMode ? null : terminal.path}
            showTs={showTs}
            className="h-full"
          />
        )}
      </div>

      {/* ── Status footer ──────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 py-2 bg-white border-t border-jj-gray-02">
        <span className="text-xs font-johnson-text text-jj-gray-04">
          Last refreshed <span className="text-jj-gray-06">{formatRefresh()}</span>
        </span>
        {info && (
          <div className="flex items-center gap-3 min-w-0 ml-4">
            <span className="font-mono text-xs text-jj-gray-04 truncate">{info.script_path}</span>
            {info.script_args && info.script_args !== '—' && (
              <>
                <span className="text-jj-gray-03 flex-shrink-0">·</span>
                <span className="text-xs font-johnson-text text-jj-gray-04 flex-shrink-0">args</span>
                <span className="font-mono text-xs text-jj-gray-06 truncate">{info.script_args}</span>
              </>
            )}
          </div>
        )}
      </div>

    </div>
  );
}