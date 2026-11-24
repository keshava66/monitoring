import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import { apiFetch, apiJson, downloadBlob, isAbort, streamSse } from '../utils/apiClient';
import {
  Alert, Button, Dot, ProgressBar, Select, Tabs, Toggle, cx, fmtBytes, fmtNum, useFeedback, usePolling,
} from '../components/ui';
import EPodPipelineViz from './EPodPipelineViz';

const STATUS_POLL_MS = 5_000;
const LIVE_BUFFER = 1000;
const VIEWS = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'terminal', label: 'Terminal output' },
  { id: 'log', label: 'Log file' },
];

const LINE_COLORS = [
  [/error|fail|exception|traceback|❌/i, 'text-[#ff7b72]'],
  [/warn/i, 'text-[#e3b341]'],
  [/success|complete|done|finished|✅/i, 'text-[#7ee787]'],
  [/info|start|running|step \d/i, 'text-[#79c0ff]'],
];
const lineClass = (line) => (LINE_COLORS.find(([re]) => re.test(line))?.[1] || 'text-[#c9d1d9]');

const gaugeColor = (pct, warn = 60, danger = 85) => (pct >= danger ? '#eb1700' : pct >= warn ? '#c4a000' : '#328714');

function LogBox({ lines, firstLineNo, path, total, showTs, stampedAt }) {
  const ref = useRef(null);
  const [pinned, setPinned] = useState(true);
  const colors = useMemo(() => lines.map(lineClass), [lines]);

  useEffect(() => {
    if (pinned && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, pinned]);

  const onScroll = () => {
    const el = ref.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
  };

  return (
    <div className="relative flex flex-col h-[70dvh] min-h-[22rem] bg-terminal">
      <div ref={ref} onScroll={onScroll} tabIndex={0} aria-label="Log output"
        className="flex-1 min-h-0 overflow-auto terminal-scroll px-3 sm:px-4 py-3 font-mono text-xs leading-6 focus-ring-inset">
        {lines.length === 0 ? (
          <p className="flex items-center gap-2 text-[#8b949e]"><Dot color="#8b949e" pulse className="w-1.5 h-1.5" />Waiting for output…</p>
        ) : lines.map((line, i) => (
          <div key={i} className={cx('flex gap-3 px-1 -mx-1 rounded hover:bg-white/5', colors[i])}>
            <span className="hidden sm:inline w-12 flex-shrink-0 text-right select-none text-[#6e7681] tabular-nums">{firstLineNo + i}</span>
            {showTs && <span className="flex-shrink-0 select-none text-[#6e7681] tabular-nums">{stampedAt?.[i] || ''}</span>}
            <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">{line}</span>
          </div>
        ))}
      </div>
      {!pinned && (
        <button type="button" onClick={() => { setPinned(true); ref.current.scrollTop = ref.current.scrollHeight; }}
          className="absolute bottom-12 left-1/2 -translate-x-1/2 px-3 h-8 rounded-full bg-jj-red text-white font-johnson-text text-xs font-semibold shadow-overlay focus-ring">
          Jump to latest
        </button>
      )}
      {path && (
        <div className="flex items-center justify-between gap-4 px-3 sm:px-4 py-1.5 border-t border-white/10 font-mono text-[11px] text-[#8b949e]">
          <span className="truncate" title={path}>{path}</span>
          <span className="flex-shrink-0 tabular-nums">{fmtNum(total)} lines</span>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub, gauge, color }) {
  return (
    <div className="px-4 py-3 sm:px-5 sm:py-4 bg-white min-w-0">
      <p className="font-johnson-text text-xs text-jj-gray-06">{label}</p>
      <p className="mt-1 font-johnson-display text-lg sm:text-xl text-jj-gray-08 tabular-nums truncate" style={color ? { color } : undefined}>{value}</p>
      {gauge != null && <ProgressBar value={gauge} color={gaugeColor(gauge)} className="h-1 mt-2" label={label} />}
      {sub && <p className="mt-1 font-johnson-text text-xs text-jj-gray-05 truncate">{sub}</p>}
    </div>
  );
}

export default function EPodAgentPage({ agentId, title, canControl }) {
  const { user } = useAuth();
  const email = user?.email;
  const { toast, confirm } = useFeedback();
  const base = `/${agentId}`;
  const [params, setParams] = useSearchParams();
  const view = VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'pipeline';

  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [info, setInfo] = useState(null);
  const [logs, setLogs] = useState({ lines: [], total: 0, path: '' });
  const [terminal, setTerminal] = useState({ lines: [], total: 0, path: '' });
  const [lineCount, setLineCount] = useState(100);
  const [liveMode, setLiveMode] = useState(true);
  const [showTs, setShowTs] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [busy, setBusy] = useState(null);
  const [stream, setStream] = useState('connecting');
  const [live, setLive] = useState({ lines: [], stamps: [], seen: 0 });
  const [lastRefresh, setLastRefresh] = useState(null);
  const pipelineHandler = useRef(null);
  const liveModeRef = useRef(liveMode);
  useEffect(() => { liveModeRef.current = liveMode; }, [liveMode]);

  const audit = useCallback((details) => logAuditEvent('in-page-extraction-pipelines', email, agentId, `${details} on ${title}`), [email, agentId, title]);

  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await apiJson(`${base}/status`, { timeoutMs: 10_000 }));
      setStatusError(null);
    } catch (e) {
      if (!isAbort(e)) setStatusError(e.message);
    }
  }, [base]);

  const fetchLogs = useCallback(async () => {
    try { setLogs(await apiJson(`${base}/logs?n=${lineCount}`)); } catch { /* surfaced through status */ }
  }, [base, lineCount]);

  const fetchTerminal = useCallback(async () => {
    try { setTerminal(await apiJson(`${base}/terminal?n=${lineCount}`)); } catch { /* surfaced through status */ }
  }, [base, lineCount]);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchStatus(), fetchLogs(), fetchTerminal()]);
    setLastRefresh(new Date());
  }, [fetchStatus, fetchLogs, fetchTerminal]);

  useEffect(() => {
    apiJson(`${base}/info`).then(setInfo).catch(() => {});
  }, [base]);
  useEffect(() => { refreshAll(); }, [refreshAll]);
  usePolling(fetchStatus, STATUS_POLL_MS, { immediate: false });
  usePolling(refreshAll, 15_000, { enabled: autoRefresh && !(liveMode && view === 'terminal'), immediate: false });

  // One SSE connection per agent feeds both the terminal view and the pipeline visualiser.
  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let timer = null;
    const connect = async () => {
      setStream('connecting');
      try {
        await streamSse(`${base}/terminal/stream`, {
          signal: controller.signal,
          onOpen: () => { attempt = 0; setStream('live'); },
          onEvent: (line) => {
            pipelineHandler.current?.(line);
            if (!liveModeRef.current) return;
            const stamp = new Date().toLocaleTimeString('en-US', { hour12: false });
            setLive((prev) => {
              const lines = [...prev.lines, line];
              const stamps = [...prev.stamps, stamp];
              const drop = Math.max(0, lines.length - LIVE_BUFFER);
              return { lines: lines.slice(drop), stamps: stamps.slice(drop), seen: prev.seen + 1 };
            });
          },
        });
      } catch (e) {
        if (isAbort(e) || controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      setStream('reconnecting');
      attempt += 1;
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    };
    connect();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base]);

  const setView = (id) => {
    if (id === view) return;
    audit(`Switched from ${VIEWS.find((v) => v.id === view).label} to ${VIEWS.find((v) => v.id === id).label}`);
    setParams((prev) => { const n = new URLSearchParams(prev); n.set('view', id); return n; }, { replace: true });
  };

  const act = async (action) => {
    const labels = { start: 'Start', stop: 'Stop', 'clear-terminal': 'Clear' };
    if (action !== 'start') {
      const ok = await confirm(action === 'stop'
        ? { title: `Stop ${title}?`, message: 'The pipeline process and its workers will be terminated. Files in progress will be retried on the next run.', confirmLabel: 'Stop pipeline', tone: 'danger' }
        : { title: 'Clear terminal output?', message: 'This truncates the captured terminal log on the agent.', confirmLabel: 'Clear', tone: 'danger' });
      if (!ok) return;
    }
    setBusy(action);
    try {
      await apiJson(`${base}/${action}`, { method: 'POST', timeoutMs: 60_000 });
      toast.success(action === 'start' ? 'Pipeline started' : action === 'stop' ? 'Pipeline stopped' : 'Terminal cleared');
      if (action === 'clear-terminal') setLive({ lines: [], stamps: [], seen: 0 });
      setTimeout(refreshAll, 800);
    } catch (e) {
      toast.error(`${labels[action]} failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    const which = view === 'log' ? 'logs' : 'terminal';
    try {
      const res = await apiFetch(`${base}/${which}?n=10000`);
      if (!res.ok) throw new Error();
      const d = await res.json();
      downloadBlob(new Blob([d.lines.join('\n')], { type: 'text/plain' }), `${agentId}_${which}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`);
      audit(`Downloaded ${which}`);
    } catch {
      toast.error('Download failed');
    }
  };

  const running = !!status?.running;
  const state = busy === 'start' ? 'Starting…' : busy === 'stop' ? 'Stopping…' : status == null ? 'Checking…' : running ? 'Running' : 'Stopped';
  const stateColor = busy === 'start' || busy === 'stop' ? '#c4a000' : status == null ? '#857a73' : running ? '#328714' : '#eb1700';
  const cores = info?.cpu_count || 1;
  const memPct = status?.memory_bytes && info?.total_memory ? (status.memory_bytes / info.total_memory) * 100 : null;
  const cpuPct = status?.cpu_percent != null ? Math.min(100, status.cpu_percent / cores) : null;

  const termLines = liveMode ? live.lines : terminal.lines;
  const termFirst = liveMode ? Math.max(1, live.seen - live.lines.length + 1) : Math.max(1, terminal.total - terminal.lines.length + 1);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="bg-white border-b border-jj-gray-02">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between px-4 sm:px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <Dot color={stateColor} pulse={running} className="w-3 h-3" />
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-johnson-display text-xl sm:text-2xl text-jj-gray-08">
                <span className="truncate">{info?.server_name || title}</span>
                <span className="px-2 py-0.5 rounded-full text-xs font-johnson-text font-semibold border" style={{ color: stateColor, borderColor: `${stateColor}66`, background: `${stateColor}12` }}>{state}</span>
              </h1>
              {info && <p className="mt-0.5 font-mono text-xs text-jj-gray-06 truncate" title={`${info.script_path} ${info.script_args}`}>{info.script_name} {info.script_args !== '—' ? info.script_args : ''}</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="refresh" onClick={() => { audit('Refresh clicked'); refreshAll(); }}>Refresh</Button>
            {canControl && (running ? (
              <Button size="sm" variant="dangerOutline" onClick={() => act('stop')} loading={busy === 'stop'} disabled={!!busy}>Stop pipeline</Button>
            ) : (
              <Button size="sm" variant="primary" icon="play" onClick={() => act('start')} loading={busy === 'start'} disabled={!!busy || status == null}>Start pipeline</Button>
            ))}
          </div>
        </div>
        {statusError && <div className="px-4 sm:px-6 pb-4"><Alert tone="error" title="Agent unreachable">{statusError}</Alert></div>}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-px bg-jj-gray-02 border-t border-jj-gray-02">
          <Metric label="Process ID" value={status?.pid ?? '—'} sub={status?.processes > 1 ? `${status.processes} processes` : null} />
          <Metric label="Uptime" value={status?.uptime ?? '—'} sub={status?.started_at ? `since ${new Date(status.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : null} />
          <Metric label="Memory" value={status?.memory_bytes != null ? fmtBytes(status.memory_bytes) : '—'} gauge={memPct}
            sub={memPct != null ? `${memPct.toFixed(0)}% of ${fmtBytes(info.total_memory)}` : null} />
          <Metric label="CPU" value={cpuPct != null ? `${cpuPct.toFixed(1)}%` : '—'} gauge={cpuPct} sub={info ? `${cores} cores` : null} />
          <Metric label="Live stream" value={stream === 'live' ? 'Connected' : stream === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
            color={stream === 'live' ? '#328714' : '#c4a000'} sub={lastRefresh ? `refreshed ${lastRefresh.toLocaleTimeString('en-US')}` : null} />
        </div>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 px-2 sm:px-4">
          <Tabs label="View" tabs={VIEWS} value={view} onChange={setView} className="border-b-0" />
          {view !== 'pipeline' && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-2 pb-3 md:pb-0">
              {view === 'terminal' && <Toggle checked={liveMode} onChange={(v) => { setLiveMode(v); audit(`Live stream ${v ? 'enabled' : 'disabled'}`); if (v) setLive({ lines: [], stamps: [], seen: 0 }); else fetchTerminal(); }} label="Live" />}
              {(view === 'log' || !liveMode) && <Toggle checked={autoRefresh} onChange={(v) => { setAutoRefresh(v); audit(`Auto-refresh ${v ? 'enabled' : 'disabled'}`); }} label="Auto-refresh" />}
              {view === 'terminal' && liveMode && <Toggle checked={showTs} onChange={setShowTs} label="Timestamps" />}
              {(view === 'log' || !liveMode) && (
                <Select size="sm" label="Lines" value={lineCount} onChange={(v) => setLineCount(Number(v))}>
                  {[50, 100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}
                </Select>
              )}
              {view === 'terminal' && canControl && <Button size="sm" variant="ghost" onClick={() => act('clear-terminal')} disabled={!!busy}>Clear</Button>}
              <Button size="sm" variant="ghost" icon="download" onClick={download}>Download</Button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className={view === 'pipeline' ? 'flex-1' : 'hidden'}>
          <EPodPipelineViz title={info?.server_name || title} agentId={agentId} handlerRef={pipelineHandler} streamState={stream} />
        </div>
        {view === 'terminal' && (
          <LogBox lines={termLines} firstLineNo={termFirst} total={liveMode ? live.seen : terminal.total}
            path={liveMode ? null : terminal.path} showTs={showTs && liveMode} stampedAt={live.stamps} />
        )}
        {view === 'log' && (
          <LogBox lines={logs.lines} firstLineNo={Math.max(1, logs.total - logs.lines.length + 1)} total={logs.total} path={logs.path} />
        )}
      </div>
    </div>
  );
}
