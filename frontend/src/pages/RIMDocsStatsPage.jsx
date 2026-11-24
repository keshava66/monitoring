import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from '../utils/apiClient';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';

const REFRESH_MS   = 5 * 60 * 1000; // 5 minutes

const STATUS_COLOR = { success: '#16a34a', error: '#dc2626', running: '#2563eb' };
const STATUS_LABEL = { success: 'Success', error: 'Error', running: 'Running' };

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtPct = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);

// Compact form for big counts — 3,107,736 -> "3.11 M". Exact count is kept
// as a hover tooltip so nothing is lost.
const fmtCompact = (n) => {
  if (n == null) return '—';
  const num = Number(n);
  const abs = Math.abs(num);
  if (abs >= 1e9) return (num / 1e9).toFixed(2) + ' B';
  if (abs >= 1e6) return (num / 1e6).toFixed(2) + ' M';
  if (abs >= 1e3) return (num / 1e3).toFixed(2) + ' K';
  return String(num);
};

// Ingestion rate = Total Files ÷ Duration, scaled to whichever unit the
// user picks. Multiplier converts a per-second rate to the chosen unit.
const RATE_MULTIPLIER = { second: 1, minute: 60, hour: 3600, day: 86400 };
const RATE_SUFFIX     = { second: '/sec', minute: '/min', hour: '/hr', day: '/day' };

const Pulse = ({ w = 'w-24', h = 'h-4' }) => (
  <div className={`${w} ${h} bg-jj-gray-02 rounded animate-pulse`} />
);

const SectionHeader = ({ title, subtitle }) => (
  <div className="flex items-start gap-3 mb-4">
    <div className="w-1 self-stretch rounded-full bg-jj-red flex-shrink-0 min-h-[2rem]" />
    <div>
      <h2 className="font-johnson-display text-jj-gray-08 text-xl">{title}</h2>
      {subtitle && <p className="text-jj-gray-05 font-johnson-text text-xs mt-0.5">{subtitle}</p>}
    </div>
  </div>
);

const Dot = ({ color, size = 10 }) => (
  <span
    className="inline-block rounded-full flex-shrink-0"
    style={{ width: size, height: size, background: color, boxShadow: `0 0 0 3px ${color}22` }}
  />
);

function useSortedRows(rows, defaultKey) {
  const [sort, setSort] = useState({ key: defaultKey, asc: true });
  const toggle = (key) => setSort(s => ({ key, asc: s.key === key ? !s.asc : true }));
  const sorted = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => {
      const va = a[sort.key] ?? '';
      const vb = b[sort.key] ?? '';
      const na = parseFloat(String(va).replace(/[^0-9.]/g, ''));
      const nb = parseFloat(String(vb).replace(/[^0-9.]/g, ''));
      if (!isNaN(na) && !isNaN(nb)) return sort.asc ? na - nb : nb - na;
      return sort.asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }, [rows, sort]);
  return { sorted, sort, toggle };
}

const Th = ({ label, sortKey, sort, onSort, right }) => {
  const active = sort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`px-5 py-3.5 text-xs font-semibold text-jj-gray-04 uppercase tracking-wider cursor-pointer select-none whitespace-nowrap hover:text-white transition-colors ${right ? 'text-right' : 'text-left'}`}
    >
      {label}
      <span className="ml-1 opacity-60">{active ? (sort.asc ? '▲' : '▼') : '⬍'}</span>
    </th>
  );
};

const THead = ({ children }) => (
  <thead>
    <tr style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)' }}>
      {children}
    </tr>
  </thead>
);

const tableWrap = 'rounded-xl overflow-hidden shadow border border-jj-gray-02';

// ── KPI Cards ─────────────────────────────────────────────────────────────────
// 5 cards, not the old 6 — there's no "Pending" bucket in the 3-state
// SUCCESS/ERROR/RUNNING model these tables use. "Failed" is the error bucket.
//
// Colors/labels are static and known immediately; values aren't known until
// kpis loads. Keeping them separate means the card backgrounds are right
// from the very first paint instead of falling back to flat gray until the
// first successful fetch resolves.
const KPI_CARD_DEFS = [
  { label: 'Total Docs',   accent: '#312c2a' },
  { label: '✅ Completed', accent: '#16a34a' },
  { label: '❌ Failed',    accent: '#dc2626' },
  { label: '🔄 Running',   accent: '#2563eb' },
  { label: '💾 Total Storage',   accent: '#8c3bbb' },
];

const KpiCards = ({ kpis, loading }) => {
  const values = kpis
    ? [
        { value: fmtCompact(kpis.total_docs), exact: fmtNum(kpis.total_docs), sub: 'discovered so far',                                  subColor: '#a39992' },
        { value: fmtCompact(kpis.success),    exact: fmtNum(kpis.success),    sub: `${kpis.success_pct}% extracted and ingested so far`, subColor: '#16a34a' },
        { value: fmtCompact(kpis.error),      exact: fmtNum(kpis.error) },
        { value: fmtCompact(kpis.running),    exact: fmtNum(kpis.running),    sub: 'being extracted right now',                          subColor: '#2563eb' },
        { value: kpis.total_gb >= 1000 ? `${(kpis.total_gb / 1000).toFixed(2)} TB` : `${kpis.total_gb} GB`, exact: `${fmtNum(kpis.total_gb)} GB` },
      ]
    : [];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {KPI_CARD_DEFS.map((def, i) => {
        const v = values[i];
        return (
          <div key={i} className="rounded-xl shadow-sm px-5 py-4" style={{ background: def.accent }}>
            {loading || !v
              ? <div className="flex flex-col items-end gap-2">
                  <Pulse w="w-16" h="h-3" />
                  <Pulse w="w-24" h="h-6" />
                </div>
              : <>
                  <p className="text-xs font-johnson-text uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.75)' }}>{def.label}</p>
                  <p className="mt-1 text-2xl font-johnson-display text-white" style={{ lineHeight: '115%' }} title={v.exact}>
                    {v.value}
                  </p>
                  {v.sub && <p className="text-xs font-johnson-text mt-0.5 text-right" style={{ color: 'rgba(255,255,255,0.7)' }}>{v.sub}</p>}
                </>
            }
          </div>
        );
      })}
    </div>
  );
};

// ── Stall Alerts ──────────────────────────────────────────────────────────────
const StallAlerts = ({ stalls, onToggle }) => {
  const [open, setOpen] = React.useState(false);
  if (!stalls?.length) return null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    onToggle?.(next);
  };
  return (
    <div className="border-2 border-jj-yellow-01 rounded-xl bg-amber-50 overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-100 transition-colors duration-150"
      >
        <span className="text-xl">⚠️</span>
        <strong className="text-amber-800 font-johnson-display">Stalled Ingestion Alert</strong>
        <span className="text-xs text-amber-700 ml-1 flex-1">
          — {stalls.length} table{stalls.length > 1 ? 's' : ''} still RUNNING but last updated over 30 minutes ago
        </span>
        <span className="text-amber-600 text-xs font-johnson-text flex-shrink-0 flex items-center gap-1">
          <span>{open ? 'collapse' : 'click to expand'}</span>
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
        </span>
      </button>
      {open && (
        <div className="divide-y divide-amber-200 border-t border-amber-200 px-4">
          {stalls.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
              <Dot color={s.color} />
              <strong className="text-jj-gray-08 min-w-[180px] font-johnson-display">{s.label}</strong>
              <span className="text-red-600 font-semibold">⏳ {fmtNum(s.running)} file{s.running !== 1 ? 's' : ''} still RUNNING</span>
              <span className="text-amber-800 text-xs">
                🕐 Last updated <strong>{s.last_updated}</strong>
                {s.duration_str && <> — <strong className="text-amber-700">{s.duration_str} ago</strong></>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Summary Table ─────────────────────────────────────────────────────────────
const SummaryTable = ({ tables, availableCounts = {}, streaming, skeletonRows = 3 }) => {
  const rows = (tables || []).map(t => ({
    label:         t.label,
    color:         t.color,
    loadError:     t.error,
    total:         t.counts.total,
    success:       t.counts.success,
    available:     availableCounts[t.table],
    errorCount:    t.counts.error,
    running:       t.counts.running,
    total_size:    t.sizes.total_size,
    ingested_size: t.sizes.ingested_size,
  }));
  const { sorted, sort, toggle } = useSortedRows(rows, 'label');
  const skeletonCount = streaming ? Math.max(0, skeletonRows - (tables?.length || 0)) : 0;

  return (
    <div className={tableWrap}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-johnson-text">
          <THead>
            <Th label="Table"               sortKey="label"         sort={sort} onSort={toggle} />
            <Th label="Total Files"         sortKey="total"         sort={sort} onSort={toggle} right />
            <Th label="Success"             sortKey="success"       sort={sort} onSort={toggle} right />
            <Th label="Available"           sortKey="available"     sort={sort} onSort={toggle} right />
            <Th label="Error"               sortKey="errorCount"    sort={sort} onSort={toggle} right />
            <Th label="Running"             sortKey="running"       sort={sort} onSort={toggle} right />
            <Th label="Total Folder Size"   sortKey="total_size"    sort={sort} onSort={toggle} right />
            <Th label="Total Size Ingested" sortKey="ingested_size" sort={sort} onSort={toggle} right />
          </THead>
          <tbody className="divide-y divide-jj-gray-02">
            {sorted.map((r, i) => r.loadError ? (
              <tr key={i} className="bg-jj-gray-01">
                <td className="px-5 py-4 font-medium text-jj-gray-08">
                  <div className="flex items-center gap-2.5"><Dot color={r.color} />{r.label}</div>
                </td>
                <td colSpan={7} className="px-5 py-4 text-jj-gray-05 text-sm font-johnson-text">
                  <span className="inline-flex items-center gap-2">
                    <span>⏳</span><span>Ingestion not started</span>
                  </span>
                </td>
              </tr>
            ) : (
              <tr key={i} className="bg-white even:bg-jj-gray-01 hover:bg-blue-50 transition-colors">
                <td className="px-5 py-4 font-medium text-jj-gray-08">
                  <div className="flex items-center gap-2.5"><Dot color={r.color} />{r.label}</div>
                </td>
                <td className="px-5 py-4 text-right font-bold tabular-nums" style={{ color: r.color }}>{fmtNum(r.total)}</td>
                <td className="px-5 py-4 text-right font-bold tabular-nums text-green-600">{fmtNum(r.success)}</td>
                <td className="px-5 py-4 text-right font-bold tabular-nums text-cyan-600">
                  {r.available === undefined
                    ? <div className="flex justify-end"><Pulse w="w-12" h="h-3" /></div>
                    : r.available === null
                      ? <span className="text-jj-gray-04" title="Unavailable — doc_chunks table missing or query failed">—</span>
                      : fmtNum(r.available)}
                </td>
                <td className="px-5 py-4 text-right font-bold tabular-nums text-red-600">{fmtNum(r.errorCount)}</td>
                <td className="px-5 py-4 text-right font-bold tabular-nums text-blue-600">{fmtNum(r.running)}</td>
                <td className="px-5 py-4 text-right font-bold tabular-nums text-purple-700">{r.total_size}</td>
                <td className="px-5 py-4 text-right font-bold tabular-nums text-green-700">{r.ingested_size}</td>
              </tr>
            ))}
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <tr key={`sk-${i}`} className="bg-white">
                {Array.from({ length: 8 }).map((_, j) => <td key={j} className="px-5 py-4"><Pulse /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Size Cards ────────────────────────────────────────────────────────────────
const SizeCards = ({ tables, streaming, skeletonRows = 3 }) => {
  const skeletonCount = streaming ? Math.max(0, skeletonRows - (tables?.length || 0)) : 0;
  return (
    <div className="flex gap-4 overflow-x-auto pb-3" style={{ scrollbarWidth: 'thin' }}>
      {tables?.map((t, i) => {
        const s = t.sizes;
        const pct = s.pct_ingested ?? 0;
        return (
          <div key={i} className="min-w-[260px] bg-white rounded-xl border border-jj-gray-02 p-4 shadow-sm flex-shrink-0">
            <div className="flex items-center gap-2 mb-3">
              <Dot color={t.color} size={11} />
              <span className="font-johnson-display text-jj-gray-07 text-sm truncate">{t.label}</span>
            </div>
            <div className="mb-3">
              <div className="flex justify-between text-xs text-jj-gray-05 mb-1 font-johnson-text">
                <span>Ingested (Success)</span><span>{fmtPct(pct)}</span>
              </div>
              <div className="bg-jj-gray-02 rounded-full h-2 overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${(pct * 100).toFixed(1)}%`, background: t.color }} />
              </div>
            </div>
            <div className="space-y-1.5 text-xs font-johnson-text">
              {[
                { icon: '📁', label: 'Total Folder Size', value: s.total_size,       color: '#1e293b' },
                { icon: '✅', label: 'Size Ingested',     value: s.ingested_size,    color: '#16a34a' },
                { icon: '⏳', label: 'Size Remaining',    value: s.remaining_size,   color: '#2563eb' },
                { icon: '❌', label: 'Error Files Size',  value: s.error_size,       color: '#dc2626' },
                { icon: '🏆', label: 'Largest Ingested',  value: s.largest_ingested, color: t.color, border: true },
              ].map((row, j) => (
                <div key={j} className={`flex justify-between items-center ${row.border ? 'border-t border-jj-gray-02 pt-1.5 mt-1' : ''}`}>
                  <span className="text-jj-gray-06">{row.icon} {row.label}</span>
                  <span className="font-semibold" style={{ color: row.color }}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <div key={`sk-${i}`} className="min-w-[260px] bg-white rounded-xl border border-jj-gray-02 p-4 shadow-sm flex-shrink-0 space-y-1.5">
          {Array.from({ length: 6 }).map((_, j) => <Pulse key={j} w="w-full" h="h-3" />)}
        </div>
      ))}
    </div>
  );
};

// ── Timeline Table ────────────────────────────────────────────────────────────
const TimelineTable = ({ tables, streaming, skeletonRows = 3, rateUnit = 'hour' }) => {
  const rows = (tables || []).map(t => {
    const durSecs = t.timeline.duration_secs;
    // Rate = Total Files ÷ Duration. Null when there's no duration yet
    // (nothing finished, or only one timestamp) rather than showing a
    // misleading 0 or an Infinity from dividing by a near-zero span.
    const rate = durSecs && durSecs > 0
      ? (t.counts.total / durSecs) * RATE_MULTIPLIER[rateUnit]
      : null;
    return {
      label: t.label, color: t.color,
      running: t.counts.running,
      started_at: t.timeline.started_at,
      completed_at: t.timeline.completed_at,
      updated_ago: t.timeline.updated_ago,
      duration: t.timeline.duration,
      duration_secs: durSecs,
      is_done: t.counts.running === 0,
      rate,
    };
  });
  const { sorted, sort, toggle } = useSortedRows(rows, 'label');
  const skeletonCount = streaming ? Math.max(0, skeletonRows - (tables?.length || 0)) : 0;

  const completedCell = (r) => {
    const na = !r.completed_at || r.completed_at === 'N/A';
    if (na) return <span className="text-jj-gray-04">— Not Started</span>;
    if (!r.is_done) return <span className="text-blue-600 font-semibold">⏳ In Progress</span>;
    return (
      <>
        <span className="font-semibold text-jj-gray-08">{r.completed_at}</span>
        {r.updated_ago && <span className="text-jj-gray-04 text-xs ml-1">({r.updated_ago})</span>}
      </>
    );
  };

  return (
    <div className={tableWrap}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-johnson-text">
          <THead>
            <Th label="Table"                sortKey="label"         sort={sort} onSort={toggle} />
            <Th label="Ingestion Started At" sortKey="started_at"    sort={sort} onSort={toggle} right />
            <Th label="Last Updated At"      sortKey="completed_at"  sort={sort} onSort={toggle} right />
            <Th label="Completed At"         sortKey="is_done"       sort={sort} onSort={toggle} right />
            <Th label="Total Duration"       sortKey="duration_secs" sort={sort} onSort={toggle} right />
            <Th label="Rate"                  sortKey="rate"          sort={sort} onSort={toggle} right />
          </THead>
          <tbody className="divide-y divide-jj-gray-02">
            {sorted.map((r, i) => (
              <tr key={i} className="bg-white even:bg-jj-gray-01 hover:bg-blue-50 transition-colors">
                <td className="px-5 py-4 font-medium text-jj-gray-08">
                  <div className="flex items-center gap-2.5"><Dot color={r.color} />{r.label}</div>
                </td>
                <td className="px-5 py-4 text-right text-jj-gray-07 tabular-nums">
                  {r.started_at !== 'N/A' ? r.started_at : <span className="text-jj-gray-04">— Not Started</span>}
                </td>
                <td className="px-5 py-4 text-right text-jj-gray-07 tabular-nums">
                  {r.completed_at !== 'N/A'
                    ? <>{r.completed_at}{r.updated_ago && <span className="text-jj-gray-04 text-xs ml-1">({r.updated_ago})</span>}</>
                    : <span className="text-jj-gray-04">— Not Started</span>}
                </td>
                <td className="px-5 py-4 text-right">{completedCell(r)}</td>
                <td className="px-5 py-4 text-right font-bold tabular-nums" style={{ color: r.color }}>{r.duration}</td>
                <td className="px-5 py-4 text-right font-bold tabular-nums text-jj-gray-07">
                  {r.rate != null ? `${fmtNum(Math.round(r.rate))}${RATE_SUFFIX[rateUnit]}` : <span className="text-jj-gray-04">N/A</span>}
                </td>
              </tr>
            ))}
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <tr key={`sk-${i}`} className="bg-white">
                {Array.from({ length: 6 }).map((_, j) => <td key={j} className="px-5 py-4"><Pulse /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Charts ────────────────────────────────────────────────────────────────────
const Charts = ({ chartBar, chartDonut, loading }) => {
  const donutData = chartDonut
    ? Object.entries(chartDonut)
        .map(([k, v]) => ({ name: STATUS_LABEL[k] ?? k, value: v, color: STATUS_COLOR[k] ?? '#888' }))
        // Zero-value slices have zero arc width, so Recharts stacks their
        // labels on top of whatever's next to them instead of just hiding
        // them. Nothing to lose by dropping them — there was never a
        // visible sliver for a 0% status anyway.
        .filter(d => d.value > 0)
    : [];
  const total = donutData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">File Count by Status per Table</p>
        {loading
          ? <div className="h-48 bg-jj-gray-01 rounded animate-pulse" />
          : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartBar} margin={{ top: 4, right: 8, left: 0, bottom: 24 }}>
                <XAxis dataKey="table" tick={{ fontSize: 11, fontFamily: 'JohnsonText, Arial' }} angle={-15} textAnchor="end" />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v, n) => [fmtNum(v), n]} />
                <Legend />
                <Bar dataKey="Success" fill={STATUS_COLOR.success} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Error"   fill={STATUS_COLOR.error}   radius={[3, 3, 0, 0]} />
                <Bar dataKey="Running" fill={STATUS_COLOR.running} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
      </div>

      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">Overall Status Distribution</p>
        {loading
          ? <div className="h-48 bg-jj-gray-01 rounded animate-pulse" />
          : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={donutData}
                  cx="50%" cy="50%"
                  innerRadius={65} outerRadius={95}
                  paddingAngle={3} dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(1)}%`}
                  labelLine={false}
                >
                  {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [fmtNum(v), n]} />
                <text x="50%" y="46%" textAnchor="middle" fill="#312c2a" fontSize={13} fontFamily="JohnsonDisplay, Arial">All Tables</text>
                <text x="50%" y="54%" textAnchor="middle" fill="#6e6259" fontSize={12}>{fmtNum(total)} files</text>
              </PieChart>
            </ResponsiveContainer>
          )}
      </div>
    </div>
  );
};

// ── RIMDOCS Stats Page ─────────────────────────────────────────────────────────
// Structural clone of EPODStatsPage's EPODTab — same sections, same per-table
// counts/sizes/timeline shape — pointed at /api/rimdocs/dashboard instead.
export default function RIMDocsStatsPage() {
  const { user } = useAuth();
  const email = user?.email || user?.username || 'unknown';
  const [tables, setTables]    = useState([]);   // grows one entry at a time as each table streams in
  const [stalls, setStalls]    = useState([]);   // grows alongside tables
  const [chartBar, setChartBar]     = useState([]);   // only known once the "summary" line arrives
  const [chartDonut, setChartDonut] = useState(null);
  const [kpis, setKpis]             = useState(null);
  const [streaming, setStreaming]   = useState(false); // true while the dashboard stream is still in progress
  const [error, setError]      = useState(null);
  const [lastRefresh, setLast] = useState(null);
  const [autoRefresh, setAuto] = useState(false);
  const [tableCount, setTableCount] = useState(null); // null = unknown yet, skeleton falls back to 3
  const [rateUnit, setRateUnit]     = useState('hour'); // sec | minute | hour | day — drives the Timeline table's Rate column
  // Keyed by DB table name. undefined = still loading that row's count,
  // null = loaded but failed, number = loaded successfully.
  const [availableCounts, setAvailableCounts] = useState({});

  // Side effect must live outside the setState updater — React can invoke
  // a functional updater more than once (StrictMode does this on purpose),
  // which would double-log every toggle.
  const toggleAutoRefresh = () => {
    const next = !autoRefresh;
    setAuto(next);
    logAuditEvent('stats_auto_refresh_toggled', email, 'rimdocs', `Auto-refresh ${next ? 'enabled' : 'disabled'} on RIMDOCS Stats`);
  };

  const handleRateUnitChange = (unit) => {
    setRateUnit(unit);
    logAuditEvent('stats_rate_unit_changed', email, 'rimdocs', `Rate unit changed to "${unit}" on RIMDOCS Stats`);
  };

  // Lightweight, config-only — no DB hit — so the skeleton row/card count
  // can match the real number of configured tables instead of a guessed 3.
  useEffect(() => {
    apiFetch('/api/rimdocs/tables')
      .then(res => (res.ok ? res.json() : null))
      .then(body => { if (body?.tables?.length) setTableCount(body.tables.length); })
      .catch(() => {}); // best-effort only — falls back to the default of 3
  }, []);

  const dashboardAbortRef = useRef(null);
const fetchDashboard = useCallback(async () => {
    dashboardAbortRef.current?.abort();
    const controller = new AbortController();
    dashboardAbortRef.current = controller;

    setStreaming(true);
    setError(null);
    setTables([]);
    setStalls([]);
    setChartBar([]);
    setChartDonut(null);
    setKpis(null);
    try {
      const res = await apiFetch(`/api/rimdocs/dashboard/stream?_=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('Streaming not supported by this browser');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === 'table') {
            setTables(prev => [...prev, msg.data]);
            if (msg.data.stall) setStalls(prev => [...prev, msg.data.stall]);
          } else if (msg.type === 'summary') {
            setChartBar(msg.data.chart_bar || []);
            setChartDonut(msg.data.chart_donut || null);
            setKpis(msg.data.kpis || null);
          }
        }
      }
      setLast(new Date());
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(e.message);
    } finally {
      if (dashboardAbortRef.current === controller) setStreaming(false);
    }
  }, []);

  const fetchAvailableCounts = useCallback(async () => {
    setAvailableCounts({}); // mark all rows "loading" again for this refresh cycle
    try {
      const res = await apiFetch(`/api/rimdocs/available-counts?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      setAvailableCounts(body.available || {});
    } catch {
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    fetchAvailableCounts();
  }, [fetchDashboard, fetchAvailableCounts]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { fetchDashboard(); fetchAvailableCounts(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, fetchDashboard, fetchAvailableCounts]);

  const chartBarFlat = useMemo(() => {
    if (!chartBar.length) return [];
    const map = {};
    chartBar.forEach(({ table, status, count }) => {
      map[table] = map[table] || { table };
      map[table][status] = count;
    });
    return Object.values(map);
  }, [chartBar]);

  return (
    <div className="px-8 py-6 flex flex-col gap-6 max-w-screen-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-jj-blue-03 rounded-lg flex items-center justify-center text-2xl select-none">📡</div>
          <div>
            <h1 className="text-3xl font-johnson-display text-jj-gray-08" style={{ lineHeight: '110%' }}>RIMDOCS Stats</h1>
            <p className="text-jj-gray-05 font-johnson-text text-sm">
              RIMDocs ingestion log monitor
              {lastRefresh && (
                <span className="ml-2 text-jj-gray-04">
                  · Updated {lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-johnson-text text-jj-gray-06">
            <div className="relative" onClick={toggleAutoRefresh}>
              <div className={`w-9 h-5 rounded-full transition-colors duration-200 ${autoRefresh ? 'bg-jj-red' : 'bg-jj-gray-03'}`} />
              <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${autoRefresh ? 'translate-x-4' : ''}`} />
            </div>
            Auto-refresh (5 min)
          </label>
          <button
            onClick={() => { fetchDashboard(); fetchAvailableCounts(); }}
            disabled={streaming}
            className="flex items-center gap-2 px-4 py-2 border border-jj-gray-03 rounded-lg bg-white font-johnson-text text-sm text-jj-gray-07 hover:border-jj-red hover:text-jj-red transition-colors disabled:opacity-50"
          >
            <span className={streaming ? 'animate-spin inline-block' : ''}>↻</span> Refresh
          </button>
        </div>
      </div>

      {/* KPI row */}
      <KpiCards kpis={kpis} loading={!kpis} />

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-start gap-3">
          <span className="text-jj-red text-xl mt-0.5">⚠</span>
          <div>
            <p className="font-johnson-display text-jj-gray-08 font-semibold">Failed to load data</p>
            <p className="text-sm text-jj-gray-06 font-johnson-text mt-0.5">{error}</p>
            <button onClick={() => { fetchDashboard(); fetchAvailableCounts(); }} className="mt-2 text-sm text-jj-red font-johnson-text underline hover:no-underline">Try again</button>
          </div>
        </div>
      )}

      <StallAlerts
        stalls={stalls}
        onToggle={(open) => logAuditEvent('stats_stall_alert_toggled', email, 'rimdocs', `Stalled Ingestion Alert panel ${open ? 'expanded' : 'collapsed'} on RIMDOCS Stats`)}
      />

      <div><SectionHeader title="📦 Ingestion Log Tables – Summary" /><SummaryTable tables={tables} availableCounts={availableCounts} streaming={streaming} skeletonRows={tableCount ?? 3} /></div>
      <div><SectionHeader title="💾 Per-Table Size Metrics" /><SizeCards tables={tables} streaming={streaming} skeletonRows={tableCount ?? 3} /></div>
      <div>
        <SectionHeader
          title="🕐 Ingestion Timeline"
          subtitle="Start = MIN(ingested_at)  ·  Last Updated = MAX(updated_at)  ·  Duration = Last Updated − Start  ·  Rate = Total Files ÷ Duration"
        />
        <div className="flex justify-end mb-3">
          <label className="flex items-center gap-2 text-sm font-johnson-text text-jj-gray-06">
            Rate per
            <select
              value={rateUnit}
              onChange={(e) => handleRateUnitChange(e.target.value)}
              className="border border-jj-gray-03 rounded-lg px-2 py-1.5 text-sm font-johnson-text text-jj-gray-07 bg-white focus:outline-none focus:border-jj-red"
            >
              <option value="second">Second</option>
              <option value="minute">Minute</option>
              <option value="hour">Hour</option>
              <option value="day">Day</option>
            </select>
          </label>
        </div>
        <TimelineTable tables={tables} streaming={streaming} skeletonRows={tableCount ?? 3} rateUnit={rateUnit} />
      </div>
      <div><SectionHeader title="📈 Status & Size Breakdown" /><Charts chartBar={chartBarFlat} chartDonut={chartDonut} loading={!chartDonut} /></div>

      <p className="text-center text-xs text-jj-gray-04 font-johnson-text pb-2">
        Data sourced from PostgreSQL · RIMDocs Ingestion Pipeline
      </p>
    </div>
  );
}