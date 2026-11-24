import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import { apiJson, downloadBlob, streamSse } from '../utils/apiClient';
import {
  Alert, Button, Dot, Page, PageHeader, ProgressBar, SearchInput, Select, StatusChip, Tabs, Toggle, cx, fmtBytes, fmtNum, useFeedback, usePolling,
} from '../components/ui';
import { PipelineFlow } from '../components/HeroArt';
import { AGENT_STATE } from '../navigation';
import EPodPipelineViz from './EPodPipelineViz';

const STATUS_POLL_MS = 5_000;
const SNAPSHOT_POLL_MS = 15_000;
const LIVE_BUFFER = 1000;
const INITIAL_BACKLOG = 400;
const FLUSH_MS = 100;
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
const lineClass = (text) => LINE_COLORS.find(([re]) => re.test(text))?.[1] || 'text-[#c9d1d9]';
const gaugeColor = (pct) => (pct >= 85 ? '#eb1700' : pct >= 60 ? '#c4a000' : '#328714');
const clock = () => new Date().toLocaleTimeString('en-US', { hour12: false });
const toRows = (lines, first) => lines.map((text, i) => ({ n: first + i, text }));
const EMPTY_SNAPSHOT = { lines: [], total: 0, path: '' };
// Marks a new or truncated terminal log inside a batch of streamed lines.
const RESET = null;

function LogBox({ rows, path, total, showTs, filter }) {
  const ref = useRef(null);
  const [pinned, setPinned] = useState(true);
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => (needle ? rows.filter((r) => r.text.toLowerCase().includes(needle)) : rows), [rows, needle]);

  useEffect(() => {
    if (pinned && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [visible, pinned]);

  const onScroll = () => {
    const el = ref.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
  };

  return (
    <div className="relative flex flex-col h-[70dvh] min-h-[22rem] bg-terminal rounded-3xl overflow-hidden shadow-lift">
      <div ref={ref} onScroll={onScroll} tabIndex={0} aria-label="Log output"
        className="flex-1 min-h-0 overflow-auto terminal-scroll px-3 sm:px-4 py-3 font-mono text-xs leading-6 focus-ring-inset">
        {visible.length === 0 ? (
          <p className="flex items-center gap-2 text-[#8b949e]">
            {needle ? `No lines match “${filter.trim()}”.` : <><Dot color="#8b949e" pulse className="w-1.5 h-1.5" />Waiting for output…</>}
          </p>
        ) : visible.map((r) => (
          <div key={r.n} className={cx('flex gap-3 px-1 -mx-1 rounded hover:bg-white/5', lineClass(r.text))}>
            <span className="hidden sm:inline w-12 flex-shrink-0 text-right select-none text-[#6e7681] tabular-nums">{r.n}</span>
            {showTs && <span className="flex-shrink-0 select-none text-[#6e7681] tabular-nums">{r.ts || ''}</span>}
            <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">{r.text}</span>
          </div>
        ))}
      </div>
      {!pinned && (
        <button type="button" onClick={() => { setPinned(true); ref.current.scrollTop = ref.current.scrollHeight; }}
          className="absolute bottom-12 left-1/2 -translate-x-1/2 px-3 h-8 rounded-full bg-jj-red text-white font-johnson-text text-xs font-semibold shadow-overlay focus-ring">
          Jump to latest
        </button>
      )}
      <div className="flex items-center justify-between gap-4 px-3 sm:px-4 py-1.5 border-t border-white/10 font-mono text-[11px] text-[#8b949e]">
        <span className="truncate" title={path || undefined}>{path || 'live stream'}</span>
        <span className="flex-shrink-0 tabular-nums">
          {needle ? `${fmtNum(visible.length)} of ${fmtNum(rows.length)} shown · ` : ''}{fmtNum(total)} lines
        </span>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, gauge, color }) {
  return (
    <div className="flex-1 basis-40 min-w-0 rounded-2xl bg-white border border-jj-gray-02 shadow-card px-5 py-4">
      <p className="font-johnson-text text-xs text-jj-gray-06">{label}</p>
      <p className="mt-1.5 font-johnson-display font-light text-2xl leading-none tracking-[-0.02em] text-jj-gray-08 tabular-nums truncate" style={color ? { color } : undefined}>{value}</p>
      {gauge != null && <ProgressBar value={gauge} color={gaugeColor(gauge)} className="h-1 mt-3" label={label} />}
      {sub && <p className="mt-2 font-johnson-text text-xs text-jj-gray-05 truncate">{sub}</p>}
    </div>
  );
}

export default function EPodAgentPage({ agentId, title, canControl, chips, onState }) {
  const { user } = useAuth();
  const email = user?.email;
  const { toast, confirm } = useFeedback();
  const base = `/${agentId}`;
  const [params, setParams] = useSearchParams();
  const view = VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'pipeline';

  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [unreachable, setUnreachable] = useState(false);
  const [statusAt, setStatusAt] = useState(null);
  const [info, setInfo] = useState(null);
  const [logs, setLogs] = useState(EMPTY_SNAPSHOT);
  const [terminal, setTerminal] = useState(EMPTY_SNAPSHOT);
  const [lineCount, setLineCount] = useState(100);
  const [liveMode, setLiveMode] = useState(true);
  const [showTs, setShowTs] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);
  const [flow, setFlow] = useState(null);
  const [stream, setStream] = useState('connecting');
  const [live, setLive] = useState({ rows: [], seen: 0 });
  const vizDispatch = useRef(null);
  const liveModeRef = useRef(liveMode);
  const failures = useRef(0);
  const reached = useRef(false);
  const expectStop = useRef(false);
  const prevRunning = useRef(null);
  useEffect(() => { liveModeRef.current = liveMode; }, [liveMode]);

  const name = info?.server_name || title;
  const audit = useCallback((details) => logAuditEvent('in-page-extraction-pipelines', email, agentId, `${details} on ${title}`), [email, agentId, title]);

  const fetchInfo = useCallback(() => apiJson(`${base}/info`, { timeoutMs: 8_000 }).then(setInfo).catch(() => {}), [base]);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await apiJson(`${base}/status`, { timeoutMs: 10_000 });
      failures.current = 0;
      reached.current = true;
      setStatus(s);
      setStatusError(null);
      setUnreachable(false);
      setStatusAt(new Date());
    } catch (e) {
      if (e?.name === 'AbortError') return;
      failures.current += 1;
      setStatusError(e.message);
      // One missed poll on a healthy agent is noise; two in a row (or never reached) is an outage.
      if (!reached.current || failures.current >= 2) setUnreachable(true);
    }
  }, [base]);

  const fetchLogs = useCallback(async () => {
    try { setLogs(await apiJson(`${base}/logs?n=${lineCount}`)); } catch { /* status shows reachability */ }
  }, [base, lineCount]);
  const fetchTerminal = useCallback(async () => {
    try { setTerminal(await apiJson(`${base}/terminal?n=${lineCount}`)); } catch { /* status shows reachability */ }
  }, [base, lineCount]);

  // Only the open view's snapshot is fetched; the pipeline view runs off the stream.
  const snapshot = view === 'log' ? fetchLogs : view === 'terminal' && !liveMode ? fetchTerminal : null;
  const refresh = useCallback(() => Promise.all([fetchStatus(), snapshot?.()]), [fetchStatus, snapshot]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => { snapshot?.(); }, [snapshot]);
  useEffect(() => { if (status && !info) fetchInfo(); }, [status, info, fetchInfo]);
  usePolling(fetchStatus, STATUS_POLL_MS, { immediate: false });
  usePolling(() => snapshot?.(), SNAPSHOT_POLL_MS, { enabled: autoRefresh && !!snapshot, immediate: false });

  const running = !!status?.running && !unreachable;
  const state = unreachable ? 'unreachable' : status == null ? 'checking' : running ? 'running' : 'stopped';

  useEffect(() => { onState?.(agentId, state); }, [onState, agentId, state]);
  useEffect(() => () => onState?.(agentId, null), [onState, agentId]);

  // Tell the viewer when a run ends without them stopping it (finished or crashed).
  useEffect(() => {
    if (state !== 'running' && state !== 'stopped') return;
    if (prevRunning.current === true && state === 'stopped' && !expectStop.current) toast.info(`${name} has stopped`);
    if (state === 'stopped') expectStop.current = false;
    prevRunning.current = state === 'running';
  }, [state, name, toast]);

  // One SSE connection per agent feeds the terminal view and the pipeline view.
  // Lines are batched and flushed every 100 ms, and a reconnect resumes from the
  // last byte offset the agent sent, so nothing is replayed or lost.
  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let retry = null;
    let flushTimer = null;
    let lastId = null;
    let pending = [];

    const flush = () => {
      flushTimer = null;
      const items = pending;
      pending = [];
      if (!items.length) return;
      vizDispatch.current?.(items);
      if (!liveModeRef.current && !items.includes(RESET)) return;
      const ts = clock();
      setLive((prev) => {
        let { rows, seen } = prev;
        let added = [];
        for (const item of items) {
          if (item === RESET) { rows = []; added = []; seen = 0; continue; }
          if (!liveModeRef.current) continue;
          seen += 1;
          added.push({ n: seen, text: item, ts });
        }
        const next = added.length ? rows.concat(added) : rows;
        return { rows: next.length > LIVE_BUFFER ? next.slice(next.length - LIVE_BUFFER) : next, seen };
      });
    };

    const connect = async () => {
      setStream(attempt ? 'reconnecting' : 'connecting');
      const query = lastId != null ? `n=0&from=${encodeURIComponent(lastId)}` : `n=${INITIAL_BACKLOG}`;
      try {
        await streamSse(`${base}/terminal/stream?${query}`, {
          signal: controller.signal,
          onOpen: () => { attempt = 0; setStream('live'); },
          onEvent: (data, { event, id, hasData }) => {
            if (id != null) lastId = id;
            if (event === 'reset') pending.push(RESET);
            else if (hasData) pending.push(data);
            else return;
            if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
          },
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        // Permission or configuration problems won't fix themselves by retrying.
        if (e?.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          setStream('denied');
          return;
        }
      }
      if (controller.signal.aborted) return;
      attempt += 1;
      setStream('reconnecting');
      retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    };
    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearTimeout(flushTimer);
    };
  }, [base]);

  const setView = (id) => {
    if (id === view) return;
    audit(`Switched from ${VIEWS.find((v) => v.id === view).label} to ${VIEWS.find((v) => v.id === id).label}`);
    setFilter('');
    setParams((prev) => { const n = new URLSearchParams(prev); n.set('view', id); return n; }, { replace: true });
  };

  const act = async (action) => {
    const labels = { start: 'Start', stop: 'Stop', 'clear-terminal': 'Clear' };
    if (action !== 'start') {
      const ok = await confirm(action === 'stop'
        ? { title: `Stop ${name}?`, message: 'The pipeline process and its workers will be terminated. Files in progress will be retried on the next run.', confirmLabel: 'Stop pipeline', tone: 'danger' }
        : { title: 'Clear terminal output?', message: 'This truncates the captured terminal log on the agent.', confirmLabel: 'Clear', tone: 'danger' });
      if (!ok) return;
    }
    setBusy(action);
    if (action === 'stop') expectStop.current = true;
    try {
      await apiJson(`${base}/${action}`, { method: 'POST', timeoutMs: 60_000 });
      toast.success(action === 'start' ? 'Pipeline started' : action === 'stop' ? 'Pipeline stopped' : 'Terminal cleared');
      await refresh();
    } catch (e) {
      if (action === 'stop') expectStop.current = false;
      toast.error(`${labels[action]} failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    const which = view === 'log' ? 'logs' : 'terminal';
    try {
      const d = await apiJson(`${base}/${which}?n=10000`, { timeoutMs: 60_000 });
      downloadBlob(new Blob([d.lines.join('\n')], { type: 'text/plain' }), `${agentId}_${which}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`);
      audit(`Downloaded ${which}`);
    } catch (e) {
      toast.error(`Download failed: ${e.message}`);
    }
  };

  const toggleLive = (on) => {
    setLiveMode(on);
    audit(`Live stream ${on ? 'enabled' : 'disabled'}`);
    if (on) setLive({ rows: [], seen: 0 });
  };

  const stateInfo = AGENT_STATE[state];
  const chipLabel = busy === 'start' ? 'Starting…' : busy === 'stop' ? 'Stopping…' : stateInfo.label;
  const chipColor = busy === 'start' || busy === 'stop' ? '#c4a000' : stateInfo.color;
  const accent = busy === 'start' ? 'is starting…' : busy === 'stop' ? 'is stopping…'
    : { unreachable: 'is unreachable.', checking: 'checking in…', running: 'is running.', stopped: 'is stopped.' }[state];
  const cores = info?.cpu_count || 1;
  const memPct = status?.memory_bytes && info?.total_memory ? (status.memory_bytes / info.total_memory) * 100 : null;
  const cpuPct = status?.cpu_percent != null ? Math.min(100, status.cpu_percent / cores) : null;
  const streamLabel = { live: 'Connected', connecting: 'Connecting…', reconnecting: 'Retrying…', denied: 'Unavailable' }[stream];

  const logRows = useMemo(() => toRows(logs.lines, Math.max(1, logs.total - logs.lines.length + 1)), [logs]);
  const terminalRows = useMemo(() => toRows(terminal.lines, Math.max(1, terminal.total - terminal.lines.length + 1)), [terminal]);
  const showsSnapshot = view === 'log' || !liveMode;

  return (
    <Page>
      <PageHeader title={name} accent={accent}
        description={info
          ? <span className="font-mono text-[13px]" title={`${info.script_path} ${info.script_args}`}>{info.script_name} {info.script_args !== '—' ? info.script_args : ''}</span>
          : unreachable ? null : 'Connecting to the pipeline agent…'}
        chips={(
          <>
            {chips}
            <StatusChip color={chipColor} live={running}>{chipLabel}</StatusChip>
          </>
        )}
        art={flow && !unreachable && <div className="h-full"><PipelineFlow nodes={flow.nodes} stages={flow.stages} running={running} /></div>}
        actions={(
          <>
            {canControl && (running ? (
              <Button variant="dangerOutline" onClick={() => act('stop')} loading={busy === 'stop'} disabled={!!busy}>Stop pipeline</Button>
            ) : (
              <Button variant="primary" icon="play" onClick={() => act('start')} loading={busy === 'start'} disabled={!!busy || state !== 'stopped'}>Start pipeline</Button>
            ))}
            <Button icon="refresh" onClick={() => { audit('Refresh clicked'); refresh(); }}>Refresh</Button>
          </>
        )} />
      {unreachable && (
        <Alert tone="error" title="Agent unreachable" action={<Button size="sm" onClick={fetchStatus}>Retry now</Button>}>
          {statusError}. Check that the agent is running and reachable from the monitoring backend; retrying every {STATUS_POLL_MS / 1000}s.
        </Alert>
      )}
      <div className="flex flex-wrap gap-3 sm:gap-4">
        {running ? (
          <>
            <Metric label="Process ID" value={status.pid} sub={status.processes > 1 ? `${status.processes} processes` : null} />
            <Metric label="Uptime" value={status.uptime} sub={status.started_at ? `since ${new Date(status.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : null} />
            <Metric label="Memory" value={fmtBytes(status.memory_bytes)} gauge={memPct}
              sub={memPct != null ? `${memPct.toFixed(0)}% of ${fmtBytes(info.total_memory)}` : null} />
            <Metric label="CPU" value={`${(cpuPct ?? 0).toFixed(1)}%`} gauge={cpuPct} sub={info ? `${cores} cores` : null} />
          </>
        ) : (
          <Metric label="Process" value={state === 'stopped' ? 'Not running' : '—'}
            sub={info ? `${cores} cores · ${fmtBytes(info.total_memory)} memory on this host` : null} />
        )}
        <Metric label="Live stream" value={streamLabel} color={stream === 'live' ? '#328714' : stream === 'denied' ? '#eb1700' : '#c4a000'}
          sub={statusAt ? `status ${statusAt.toLocaleTimeString('en-US')}` : null} />
      </div>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <Tabs variant="pill" label="View" tabs={VIEWS} value={view} onChange={setView} className="self-start" />
          {view !== 'pipeline' && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <SearchInput value={filter} onChange={setFilter} placeholder="Filter lines" className="w-full sm:w-56" />
              {view === 'terminal' && <Toggle checked={liveMode} onChange={toggleLive} label="Live" />}
              {view === 'terminal' && liveMode && <Toggle checked={showTs} onChange={setShowTs} label="Timestamps" />}
              {showsSnapshot && <Toggle checked={autoRefresh} onChange={(v) => { setAutoRefresh(v); audit(`Auto-refresh ${v ? 'enabled' : 'disabled'}`); }} label="Auto-refresh" />}
              {showsSnapshot && (
                <Select size="sm" label="Lines" value={lineCount} onChange={(v) => setLineCount(Number(v))}>
                  {[50, 100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}
                </Select>
              )}
              {view === 'terminal' && canControl && <Button size="sm" variant="ghost" onClick={() => act('clear-terminal')} disabled={!!busy}>Clear</Button>}
              <Button size="sm" variant="ghost" icon="download" onClick={download}>Download</Button>
            </div>
          )}
        </div>

        <div className={view === 'pipeline' ? 'block -mx-4 sm:-mx-6' : 'hidden'}>
          <EPodPipelineViz title={name} agentId={agentId} dispatchRef={vizDispatch} streamState={stream}
            running={state === 'checking' || state === 'unreachable' ? undefined : running} onStages={setFlow} />
        </div>
        {view === 'terminal' && (
          <LogBox rows={liveMode ? live.rows : terminalRows} total={liveMode ? live.seen : terminal.total}
            path={liveMode ? null : terminal.path} showTs={showTs && liveMode} filter={filter} />
        )}
        {view === 'log' && <LogBox rows={logRows} total={logs.total} path={logs.path} filter={filter} />}
      </section>
    </Page>
  );
}
