import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import {
  Badge, Button, Dot, Drawer, EmptyState, Icon, Panel, ProgressBar, SearchInput, Tabs, Toggle, cx, fmtNum, useDebouncedValue,
} from '../components/ui';

// Log-line patterns emitted by the extraction pipeline.
const RE = {
  processing: /── Processing:\s+(.+?)\s+\(([0-9.]+)\s*MB\)/,
  modified: /Modified doc — deleting existing chunks/,
  step1: /Step 1\/5/,
  step2: /Step 2\/5(?:.*?(\d+) page workers)?/,
  step3: /Step 3\/5/,
  step4: /Step 4\/5/,
  step5: /Step 5\/5/,
  pages: /Pages:\s*(\d+).*?TOC entries:\s*(\d+).*?Has TOC:\s*(True|False)/i,
  ocrPages: /OCR pages:\s*(\d+).*?Table pages:\s*(\d+)/,
  chunks: /Chunks:\s*(\d+).*?Levels:\s*\{([^}]+)\}/,
  embedProg: /Embedded (\d+)\/(\d+) chunks.*?rate=([0-9.]+)\/s/,
  embedFinal: /Embedded:\s*(\d+)\/(\d+)\s+Avg tokens:\s*([0-9.]+)/,
  embedFailed: /(\d+) chunks have zero vectors/,
  success: /✅ SUCCESS\s*—\s*(\d+) chunks\s+(\d+) pages\s+([0-9.]+)s/,
  failed: /❌ FAILED:\s*(.+)/,
  pipelineStart: /(EPOD|RIMDOCS)? ?INGESTION PIPELINE/i,
  startIngestion: /Starting ingestion:\s*([\d,]+)[^,]*,\s*(\d+) parallel/,
  summaryHeader: /PIPELINE RUN SUMMARY/,
  summaryTotal: /Total files processed\s*:\s*(\d+)/,
  summaryElapsed: /Total elapsed\s*:\s*([0-9.]+)s/,
  summaryStatus: /^\s+(SUCCESS|ERROR|SKIPPED|WOULD_PROCESS)\s*:\s*(\d+)/,
  progress: /── Progress:\s*([\d,]+)\/([\d,?]+)\s*([0-9.]+%)?.*?rate=([0-9.]+)\s*doc\/s.*?ETA=([^\s|]+)/,
  done: /── DONE:\s*([\d,]+) docs in ([^\s|]+)/,
  rateLimit: /Rate-limited.*?waiting (\d+\.?\d*)s/,
  queueBuilt: /Queue built.*?(\d[\d,]*) to process.*?(\d[\d,]*) skipped/,
};

const NODES = [
  { id: 'start', step: 'Start', label: 'Pipeline init', desc: 'Scan storage and build the work queue', color: '#6e6259' },
  { id: 'pdf', step: 'Step 1', label: 'PDF structure', desc: 'Layout, reading order and table of contents', color: '#541980' },
  { id: 'ocr', step: 'Step 2a', label: 'Vision OCR', desc: 'OCR for scanned pages', color: '#0f68b2' },
  { id: 'tables', step: 'Step 2b', label: 'Table extraction', desc: 'Table detection and structuring', color: '#004685' },
  { id: 'chunk', step: 'Step 3', label: 'Chunking', desc: 'Hierarchical parent / child chunks', color: '#c4a000' },
  { id: 'embed', step: 'Step 4', label: 'Embeddings', desc: 'Vector embeddings for every chunk', color: '#8c3bbb' },
  { id: 'db', step: 'Step 5', label: 'Database', desc: 'Commit chunks and vectors to Postgres', color: '#328714' },
  { id: 'end', step: 'Finish', label: 'Run summary', desc: 'Totals for the completed run', color: '#eb1700' },
];
const NODE = Object.fromEntries(NODES.map((n) => [n.id, n]));
const META_LABELS = {
  docs: 'Documents', workers: 'Parallel workers', pages: 'Pages', tocEntries: 'TOC entries', hasToc: 'Has TOC',
  ocrPages: 'OCR pages', tablePages: 'Table pages', pageWorkers: 'Page workers', count: 'Chunks', levels: 'Levels',
  done: 'Embedded', total: 'Total', rate: 'Rate (chunks/s)', avgTokens: 'Avg tokens', zeroVectors: 'Zero vectors',
  chunks: 'Chunks', elapsed: 'Elapsed (s)', error: 'Error', success: 'Succeeded', skipped: 'Skipped', would_process: 'Would process',
};

const idleStages = () => Object.fromEntries(NODES.map((n) => [n.id, { status: 'idle', meta: {}, pct: 0 }]));
const num = (s) => parseInt(String(s || '0').replace(/,/g, ''), 10) || 0;
const nowTs = () => new Date().toLocaleTimeString('en-US', { hour12: false });

const initialState = () => ({
  stages: idleStages(),
  doc: { name: null, sizeMb: null, modified: false },
  queue: { done: 0, total: 0, pct: null, rate: null, eta: null, finished: false, skipped: 0 },
  history: [],
  raw: [],
  rateLimit: null,
  rates: [],
});

const set = (state, id, patch) => ({ ...state, stages: { ...state.stages, [id]: { ...state.stages[id], ...patch } } });

function reducer(state, line) {
  if (line === '__reset__') return initialState();
  let s = { ...state, raw: [...state.raw, { text: line, ts: nowTs() }].slice(-300) };
  let m;
  if (RE.pipelineStart.test(line) && !RE.summaryHeader.test(line)) return set(s, 'start', { status: 'active', meta: {}, pct: 0 });
  if ((m = line.match(RE.startIngestion))) {
    s = set(s, 'start', { status: 'done', meta: { docs: m[1], workers: m[2] }, pct: 100 });
    return { ...s, queue: { ...s.queue, total: num(m[1]) } };
  }
  if ((m = line.match(RE.queueBuilt))) return { ...s, queue: { ...s.queue, total: num(m[1]), skipped: num(m[2]) } };
  if (RE.summaryHeader.test(line)) {
    if (s.stages.db.status === 'active') s = set(s, 'db', { status: 'done' });
    return set(s, 'end', { status: 'active', meta: {}, pct: 0 });
  }
  if ((m = line.match(RE.summaryTotal))) return set(s, 'end', { meta: { ...s.stages.end.meta, total: m[1] } });
  if ((m = line.match(RE.summaryStatus))) return set(s, 'end', { meta: { ...s.stages.end.meta, [m[1].toLowerCase()]: m[2] } });
  if ((m = line.match(RE.summaryElapsed))) return set(s, 'end', { status: 'done', pct: 100, meta: { ...s.stages.end.meta, elapsed: m[1] } });
  if ((m = line.match(RE.processing))) {
    const stages = idleStages();
    stages.start = s.stages.start;
    return { ...s, stages, doc: { name: m[1], sizeMb: parseFloat(m[2]), modified: false }, rateLimit: null };
  }
  if (RE.modified.test(line)) return { ...s, doc: { ...s.doc, modified: true } };
  if (RE.step1.test(line)) return set(s, 'pdf', { status: 'active', meta: {}, pct: 0 });
  if ((m = line.match(RE.step2))) {
    s = set(s, 'pdf', { status: 'done', pct: 100 });
    s = set(s, 'ocr', { status: 'active', meta: m[1] ? { pageWorkers: m[1] } : {}, pct: 0 });
    return set(s, 'tables', { status: 'active', meta: {}, pct: 0 });
  }
  if (RE.step3.test(line)) {
    s = set(s, 'ocr', { status: 'done', pct: 100 });
    s = set(s, 'tables', { status: 'done', pct: 100 });
    return set(s, 'chunk', { status: 'active', meta: {}, pct: 0 });
  }
  if (RE.step4.test(line)) return set(set(s, 'chunk', { status: 'done', pct: 100 }), 'embed', { status: 'active', meta: {}, pct: 0 });
  if (RE.step5.test(line)) return set(set(s, 'embed', { status: 'done', pct: 100 }), 'db', { status: 'active', meta: {}, pct: 0 });
  if ((m = line.match(RE.pages))) return set(s, 'pdf', { meta: { pages: m[1], tocEntries: m[2], hasToc: m[3] }, pct: 100 });
  if ((m = line.match(RE.ocrPages))) {
    s = set(s, 'ocr', { meta: { ...s.stages.ocr.meta, ocrPages: m[1] }, pct: 100 });
    return set(s, 'tables', { meta: { tablePages: m[2] }, pct: num(m[2]) > 0 ? 50 : 100 });
  }
  if ((m = line.match(RE.chunks))) return set(s, 'chunk', { meta: { count: m[1], levels: m[2] }, pct: 100 });
  if ((m = line.match(RE.embedProg))) {
    const total = num(m[2]);
    return set(s, 'embed', { meta: { ...s.stages.embed.meta, done: m[1], total: m[2], rate: m[3] }, pct: total ? Math.round((num(m[1]) / total) * 100) : 0 });
  }
  if ((m = line.match(RE.embedFinal))) return set(s, 'embed', { meta: { done: m[1], total: m[2], avgTokens: m[3] }, pct: 100 });
  if ((m = line.match(RE.embedFailed))) return set(s, 'embed', { meta: { ...s.stages.embed.meta, zeroVectors: m[1] } });
  if ((m = line.match(RE.rateLimit))) return { ...s, rateLimit: `Rate-limited by the model provider — pausing ${m[1]}s` };
  if ((m = line.match(RE.success))) {
    for (const id of ['pdf', 'ocr', 'tables', 'chunk', 'embed']) s = set(s, id, { status: 'done', pct: 100 });
    s = set(s, 'db', { status: 'done', pct: 100, meta: { chunks: m[1], pages: m[2], elapsed: m[3] } });
    const entry = { name: s.doc.name || '(unknown)', status: 'SUCCESS', detail: `${m[1]} chunks · ${m[2]} pages · ${m[3]}s`, ts: nowTs() };
    return { ...s, rateLimit: null, history: [entry, ...s.history].slice(0, 200) };
  }
  if ((m = line.match(RE.failed))) {
    const activeId = ['db', 'embed', 'chunk', 'tables', 'ocr', 'pdf'].find((id) => s.stages[id].status === 'active');
    if (activeId) s = set(s, activeId, { status: 'error', meta: { ...s.stages[activeId].meta, error: m[1] } });
    const entry = { name: s.doc.name || '(unknown)', status: 'ERROR', detail: m[1], ts: nowTs() };
    return { ...s, history: [entry, ...s.history].slice(0, 200) };
  }
  if ((m = line.match(RE.progress))) {
    const rate = parseFloat(m[4]);
    return {
      ...s,
      queue: { ...s.queue, done: num(m[1]), total: m[2].includes('?') ? s.queue.total : num(m[2]), pct: m[3] || null, rate: m[4], eta: m[5], finished: false },
      rates: Number.isFinite(rate) ? [...s.rates, rate].slice(-40) : s.rates,
    };
  }
  if ((m = line.match(RE.done))) return { ...s, queue: { ...s.queue, done: num(m[1]), eta: '0s', finished: true } };
  return s;
}

const STATUS_STYLE = {
  idle: { label: 'Idle', text: 'text-jj-gray-05' },
  active: { label: 'Running', text: 'text-jj-blue-03' },
  done: { label: 'Done', text: 'text-jj-green-03' },
  error: { label: 'Failed', text: 'text-jj-red' },
  halted: { label: 'Halted', text: 'text-jj-gray-06' },
};

function StageCard({ node, stage, onOpen }) {
  const st = STATUS_STYLE[stage.status];
  const active = stage.status === 'active';
  return (
    <button type="button" onClick={() => onOpen(node.id)}
      className={cx('group relative w-full h-full overflow-hidden text-left rounded-2xl border bg-white p-4 transition-[transform,box-shadow,border-color] duration-300 ease-out focus-ring hover:-translate-y-0.5 hover:shadow-lift',
        stage.status === 'error' ? 'border-jj-red/30 bg-[#fff6f4]' : active ? 'border-transparent shadow-lift' : 'border-jj-gray-02 shadow-card')}
      style={active ? { boxShadow: `0 0 0 2px ${node.color}, 0 24px 44px -26px ${node.color}` } : undefined}>
      <div className="relative flex items-center justify-between gap-2">
        <p className="min-w-0 font-johnson-display font-medium text-[15px] text-jj-gray-08 truncate">{node.label}</p>
        <span className={cx('shrink-0 inline-flex items-center gap-1.5 font-johnson-text text-[12px] font-medium', st.text)}>
          {stage.status !== 'idle' && <Dot color={stage.status === 'error' ? '#eb1700' : stage.status === 'done' ? '#328714' : stage.status === 'halted' ? '#857a73' : node.color} pulse={active} className="w-1.5 h-1.5" />}
          {st.label}
        </span>
      </div>
      <p className="relative mt-0.5 font-johnson-text font-light text-xs text-jj-gray-06 leading-snug line-clamp-2 min-h-[2rem]">{node.desc}</p>
      <ProgressBar value={stage.status === 'idle' ? 0 : stage.pct || (stage.status === 'done' ? 100 : 8)} color={stage.status === 'error' ? '#eb1700' : stage.status === 'halted' ? '#857a73' : node.color} className="relative h-1 mt-3" label={`${node.label} progress`} />
    </button>
  );
}

function ProgressRing({ pct, done, total }) {
  const R = 44;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative w-28 h-28 flex-shrink-0">
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={R} fill="none" stroke="#f1efed" strokeWidth="7" />
        <circle cx="50" cy="50" r={R} fill="none" stroke="#312c2a" strokeWidth="7" strokeLinecap="round" strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.min(100, pct) / 100)} className="transition-[stroke-dashoffset] duration-1000 ease-out" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-johnson-display font-light text-2xl leading-none tabular-nums text-jj-gray-08">{total ? `${Math.round(pct)}%` : '—'}</span>
        <span className="mt-1 font-johnson-text font-medium text-[11px] text-jj-gray-06">{fmtNum(done)} done</span>
      </div>
    </div>
  );
}

export default function EPodPipelineViz({ title, agentId, handlerRef, streamState, running, onStages }) {
  const { user } = useAuth();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [showConsole, setShowConsole] = useState(false);
  const [tail, setTail] = useState(true);
  const consoleRef = useRef(null);
  const debouncedQuery = useDebouncedValue(query, 400);
  const audit = (details) => logAuditEvent('in-page-extraction-pipelines', user?.email, agentId, `${details} on ${title}`);

  useEffect(() => {
    handlerRef.current = dispatch;
    return () => { handlerRef.current = null; };
  }, [handlerRef]);

  useEffect(() => {
    if (tail && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [state.raw, tail, showConsole]);

  const firstQuery = useRef(true);
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return; }
    logAuditEvent('in-page-extraction-pipelines', user?.email, agentId, debouncedQuery ? `Filtered processed documents by "${debouncedQuery}" on ${title}` : `Cleared document filter on ${title}`);
  }, [debouncedQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const history = useMemo(() => state.history.filter((h) => (filter === 'ALL' || h.status === filter)
    && h.name.toLowerCase().includes(debouncedQuery.toLowerCase())), [state.history, filter, debouncedQuery]);
  const counts = useMemo(() => ({
    ALL: state.history.length,
    SUCCESS: state.history.filter((h) => h.status === 'SUCCESS').length,
    ERROR: state.history.filter((h) => h.status === 'ERROR').length,
  }), [state.history]);

  const { queue, doc } = state;
  // A stopped pipeline cannot have running stages: whatever was mid-flight is shown as halted.
  const stages = useMemo(() => (running === false
    ? Object.fromEntries(Object.entries(state.stages).map(([k, v]) => [k, v.status === 'active' ? { ...v, status: 'halted' } : v]))
    : state.stages), [state.stages, running]);
  useEffect(() => { onStages?.({ nodes: NODES, stages }); }, [stages, onStages]);
  const halted = running === false && !queue.finished;
  const queuePct = queue.total ? (queue.done / queue.total) * 100 : 0;
  const sel = selected ? { node: NODE[selected], stage: stages[selected] } : null;

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-4 sm:gap-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 font-johnson-text text-sm text-jj-gray-06">
          <Dot color={running === false ? '#857a73' : streamState === 'live' ? '#328714' : '#c4a000'} pulse={running !== false && streamState === 'live'} className="w-2 h-2" />
          {running === false ? 'Pipeline stopped · showing the last run' : streamState === 'live' ? 'Following the live terminal stream' : 'Connecting to the live stream…'}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={showConsole ? 'dark' : 'secondary'} onClick={() => { setShowConsole(!showConsole); audit(`${showConsole ? 'Hid' : 'Opened'} stream console`); }}>
            {showConsole ? 'Hide stream' : 'Show stream'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { dispatch('__reset__'); audit('Reset pipeline view'); }}>Reset view</Button>
        </div>
      </div>

      {state.rateLimit && <div role="status" className="rounded-2xl border border-amber-300/50 bg-[#fffaf0] px-4 py-3 font-johnson-text text-sm text-amber-900">{state.rateLimit}</div>}

      {showConsole && (
        <div className="rounded-2xl overflow-hidden border border-jj-gray-08 bg-terminal shadow-lift">
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
            <span className="font-mono text-xs text-[#8b949e]">terminal stream · last {state.raw.length} lines</span>
            <Toggle checked={tail} onChange={setTail} label={<span className="text-[#c9d1d9] text-xs">Follow</span>} />
          </div>
          <div ref={consoleRef} className="h-56 overflow-y-auto terminal-scroll px-4 py-2 font-mono text-xs leading-5">
            {state.raw.length === 0 ? <p className="text-[#8b949e]">Waiting for output…</p> : state.raw.map((l, i) => (
              <div key={i} className="flex gap-3">
                <span className="text-[#6e7681] select-none tabular-nums flex-shrink-0">{l.ts}</span>
                <span className={cx('whitespace-pre-wrap break-words min-w-0', /FAILED|❌|error/i.test(l.text) ? 'text-[#ff7b72]' : /SUCCESS|✅/.test(l.text) ? 'text-[#7ee787]' : /Step \d/.test(l.text) ? 'text-[#79c0ff]' : 'text-[#c9d1d9]')}>{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Current document" bodyClassName="pt-3">
          {doc.name ? (
            <div className="flex items-start justify-between gap-3">
              <p className="font-johnson-text text-sm text-jj-gray-08 break-all">{doc.name}</p>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                {doc.sizeMb != null && <Badge tone="info">{doc.sizeMb} MB</Badge>}
                {doc.modified && <Badge tone="warning">Re-ingesting</Badge>}
              </div>
            </div>
          ) : <p className="font-johnson-text text-sm text-jj-gray-06">No document in progress yet.</p>}
        </Panel>
        <Panel title="Run progress" bodyClassName="pt-3">
          <div className="flex items-center gap-5">
            <ProgressRing pct={queue.finished ? 100 : queuePct} done={queue.done} total={queue.total} />
            <div className="min-w-0 font-johnson-text">
              <p className="text-sm text-jj-gray-06"><span className="font-johnson-display font-light text-3xl text-jj-gray-08 tabular-nums">{fmtNum(queue.done)}</span> of {fmtNum(queue.total)} documents</p>
              <p className="mt-1.5 text-xs text-jj-gray-06">
                {queue.finished ? 'Run complete' : halted ? 'Stopped before the run finished' : queue.rate ? <>{queue.rate} docs/s · ETA {queue.eta}</> : 'Waiting for progress'}
              </p>
              {queue.skipped > 0 && <p className="mt-1 text-xs text-jj-gray-05">{fmtNum(queue.skipped)} already ingested and skipped</p>}
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Stages" bodyClassName="pt-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {NODES.map((node) => <StageCard key={node.id} node={node} stage={stages[node.id]} onOpen={setSelected} />)}
        </div>
      </Panel>

      <Panel title="Processed this session" bodyClassName="p-0 pt-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 sm:px-5 pb-3">
          <SearchInput value={query} onChange={setQuery} placeholder="Filter by document name" className="sm:w-72" />
          <Tabs variant="pill" label="Result filter" value={filter}
            onChange={(f) => { setFilter(f); audit(`Filtered processed documents by ${f}`); }}
            tabs={[{ id: 'ALL', label: `All ${counts.ALL}` }, { id: 'SUCCESS', label: `Succeeded ${counts.SUCCESS}` }, { id: 'ERROR', label: `Failed ${counts.ERROR}` }]} />
        </div>
        {history.length === 0 ? (
          <EmptyState icon="records" title={state.history.length ? 'No matching documents' : 'Nothing processed yet'}
            description={state.history.length ? 'Try a different filter.' : 'Documents appear here as the live stream reports them.'} className="py-10" />
        ) : (
          <ul className="max-h-80 overflow-y-auto scroll-thin divide-y divide-jj-gray-02 border-t border-jj-gray-02">
            {history.map((h, i) => (
              <li key={`${h.ts}-${i}`} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 px-4 sm:px-5 py-2.5 font-johnson-text text-sm">
                <span className="flex items-center gap-2 min-w-0 flex-1">
                  <Dot color={h.status === 'SUCCESS' ? '#328714' : '#eb1700'} className="w-2 h-2" />
                  <span className="truncate text-jj-gray-08" title={h.name}>{h.name}</span>
                </span>
                <span className={cx('text-xs sm:text-sm break-words', h.status === 'ERROR' ? 'text-jj-red' : 'text-jj-gray-06')}>{h.detail}</span>
                <span className="text-xs text-jj-gray-05 tabular-nums">{h.ts}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Drawer open={!!sel} onClose={() => setSelected(null)} title={sel?.node.label} description={sel ? `${sel.node.step} · ${STATUS_STYLE[sel.stage.status].label}` : ''}>
        {sel && (
          <div className="p-5 flex flex-col gap-5">
            <p className="font-johnson-text text-sm text-jj-gray-07">{sel.node.desc}</p>
            <ProgressBar value={sel.stage.pct} color={sel.node.color} className="h-2" label="Stage progress" />
            {Object.keys(sel.stage.meta).length === 0 ? (
              <p className="font-johnson-text text-sm text-jj-gray-06">No details reported for this stage yet.</p>
            ) : (
              <dl className="divide-y divide-jj-gray-02 border-y border-jj-gray-02">
                {Object.entries(sel.stage.meta).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 py-2.5 font-johnson-text text-sm">
                    <dt className="text-jj-gray-06">{META_LABELS[k] || k}</dt>
                    <dd className={cx('text-right break-words min-w-0', k === 'error' ? 'text-jj-red' : 'text-jj-gray-08 tabular-nums')}>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
