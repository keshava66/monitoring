import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useRBAC } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import { apiJson, isAbort, streamNdjson } from '../utils/apiClient';
import { RingGauge } from '../components/HeroArt';
import {
  Alert, Button, Dot, EmptyState, KpiGrid, KpiTile, Page, PageHeader, Panel, ProgressBar, Section, Select, Skeleton,
  SortTh, StatusChip, TableShell, Tabs, Td, Toggle, cx, fmtCompact, fmtNum, fmtPct, usePolling, useSortedRows,
} from '../components/ui';

const REFRESH_MS = 5 * 60 * 1000;
const STATUS = {
  success: { label: 'Success', color: '#328714' },
  error: { label: 'Error', color: '#eb1700' },
  running: { label: 'Running', color: '#0f68b2' },
};
const RATE = { second: [1, '/s'], minute: [60, '/min'], hour: [3600, '/h'], day: [86400, '/day'] };

const PRODUCTS = [
  { id: 'rimdocs', label: 'RIMDOCS', permission: 'viewEPODStatsRIMDOCS', title: 'RIMDOCS ingestion', subtitle: 'RIMDocs S3 ingestion log', chunks: true },
  { id: 'epod', label: 'EPOD', permission: 'viewEPODStatsEPOD', title: 'EPOD ingestion', subtitle: 'EPOD NAS drive ingestion log', chunks: false },
];

const TOOLTIP_STYLE = { borderRadius: 10, border: '1px solid #e8e6e3', boxShadow: '0 8px 24px rgba(49,44,42,0.12)', fontFamily: 'JohnsonText, Arial', fontSize: 12 };

// ── Sections ──────────────────────────────────────────────────────────────────

function StallAlert({ stalls, onToggle }) {
  const [open, setOpen] = useState(false);
  if (!stalls.length) return null;
  const toggle = () => { setOpen(!open); onToggle(!open); };
  return (
    <Alert tone="warning" title={`${stalls.length} table${stalls.length > 1 ? 's' : ''} may be stalled`}
      action={<Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open}>{open ? 'Hide' : 'Details'}</Button>}>
      Files are still marked running but nothing has been updated for over 30 minutes.
      {open && (
        <ul className="mt-3 divide-y divide-amber-200 border-t border-amber-200">
          {stalls.map((s) => (
            <li key={s.label} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <span className="flex items-center gap-2 font-semibold text-jj-gray-08 min-w-[10rem]"><Dot color={s.color} />{s.label}</span>
              <span>{fmtNum(s.running)} running</span>
              <span className="text-amber-800">last update {s.last_updated} ({s.duration_str} ago)</span>
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

function TableLabel({ row }) {
  return <span className="flex items-center gap-2.5 font-medium text-jj-gray-08 whitespace-nowrap"><Dot color={row.color} />{row.label}</span>;
}

const SUMMARY_GETTERS = {
  label: (r) => r.label, total: (r) => r.counts.total, success: (r) => r.counts.success, available: (r) => r.available,
  error: (r) => r.counts.error, running: (r) => r.counts.running, size: (r) => r.sizes.total_size_bytes, ingested: (r) => r.sizes.ingested_size_bytes,
};

function SummaryTable({ rows, available, showAvailable, skeletons }) {
  const data = useMemo(() => rows.map((r) => {
    if (Object.hasOwn(available, r.table)) return { ...r, available: available[r.table] };
    return { ...r, available: available.__settled ? null : undefined };
  }), [rows, available]);
  const { sorted, sort, toggle } = useSortedRows(data, 'label', { getters: SUMMARY_GETTERS });
  const cols = showAvailable ? 8 : 7;
  return (
    <TableShell>
      <thead>
        <tr>
          <SortTh label="Table" sortKey="label" sort={sort} onSort={toggle} />
          <SortTh label="Total files" sortKey="total" sort={sort} onSort={toggle} align="right" />
          <SortTh label="Success" sortKey="success" sort={sort} onSort={toggle} align="right" />
          {showAvailable && <SortTh label="Available" sortKey="available" sort={sort} onSort={toggle} align="right" />}
          <SortTh label="Error" sortKey="error" sort={sort} onSort={toggle} align="right" />
          <SortTh label="Running" sortKey="running" sort={sort} onSort={toggle} align="right" />
          <SortTh label="Total size" sortKey="size" sort={sort} onSort={toggle} align="right" />
          <SortTh label="Ingested size" sortKey="ingested" sort={sort} onSort={toggle} align="right" />
        </tr>
      </thead>
      <tbody className="divide-y divide-jj-gray-02">
        {sorted.map((r) => (r.status !== 'ok' ? (
          <tr key={r.table} className="bg-jj-gray-01/60">
            <Td><TableLabel row={r} /></Td>
            <Td colSpan={cols - 1} className={r.status === 'error' ? 'text-jj-red' : 'text-jj-gray-06'}>{r.error}</Td>
          </tr>
        ) : (
          <tr key={r.table} className="hover:bg-jj-gray-01 transition-colors">
            <Td><TableLabel row={r} /></Td>
            <Td align="right" className="font-semibold text-jj-gray-08">{fmtNum(r.counts.total)}</Td>
            <Td align="right" className="text-jj-green-03 font-semibold">{fmtNum(r.counts.success)}</Td>
            {showAvailable && (
              <Td align="right" className="text-jj-blue-05">
                {r.available === undefined ? <Skeleton className="h-3 w-12 ml-auto" /> : r.available === null
                  ? <span className="text-jj-gray-05" title="doc_chunks table missing or unreadable">—</span> : fmtNum(r.available)}
              </Td>
            )}
            <Td align="right" className={r.counts.error ? 'text-jj-red font-semibold' : 'text-jj-gray-06'}>{fmtNum(r.counts.error)}</Td>
            <Td align="right" className={r.counts.running ? 'text-jj-blue-03 font-semibold' : 'text-jj-gray-06'}>{fmtNum(r.counts.running)}</Td>
            <Td align="right" className="whitespace-nowrap">{r.sizes.total_size}</Td>
            <Td align="right" className="whitespace-nowrap">{r.sizes.ingested_size}</Td>
          </tr>
        )))}
        {Array.from({ length: skeletons }).map((_, i) => (
          <tr key={`sk-${i}`}>{Array.from({ length: cols }).map((__, j) => <Td key={j}><Skeleton className={j ? 'h-4 w-14 ml-auto' : 'h-4 w-32'} /></Td>)}</tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function SizePanels({ rows, skeletons }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
      {rows.map((t) => (
        <div key={t.table} className="surface p-4 sm:p-5">
          <p className="flex items-center gap-2 font-johnson-display text-base text-jj-gray-08 truncate"><Dot color={t.color} />{t.label}</p>
          <div className="mt-3 flex items-baseline justify-between font-johnson-text text-xs text-jj-gray-06">
            <span>Ingested by size</span><span className="font-semibold text-jj-gray-08 tabular-nums">{fmtPct(t.sizes.pct_ingested)}</span>
          </div>
          <ProgressBar value={(t.sizes.pct_ingested || 0) * 100} color={t.color} className="h-2 mt-1.5" label={`${t.label} ingested`} />
          <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2.5 font-johnson-text text-xs">
            {[
              ['Total', t.sizes.total_size, 'text-jj-gray-08'],
              ['Ingested', t.sizes.ingested_size, 'text-jj-green-03'],
              ['Remaining', t.sizes.remaining_size, 'text-jj-blue-03'],
              ['Errored', t.sizes.error_size, 'text-jj-red'],
            ].map(([k, v, c]) => (
              <div key={k}><dt className="text-jj-gray-06">{k}</dt><dd className={cx('mt-0.5 font-semibold tabular-nums', c)}>{v}</dd></div>
            ))}
            <div className="col-span-2 pt-2.5 border-t border-jj-gray-02 flex justify-between">
              <dt className="text-jj-gray-06">Largest file ingested</dt><dd className="font-semibold tabular-nums text-jj-gray-08">{t.sizes.largest_ingested}</dd>
            </div>
          </dl>
        </div>
      ))}
      {Array.from({ length: skeletons }).map((_, i) => (
        <div key={`sk-${i}`} className="surface p-5 flex flex-col gap-3">
          <Skeleton className="h-5 w-32" /><Skeleton className="h-2 w-full" />
          <div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((j) => <Skeleton key={j} className="h-8 w-full" />)}</div>
        </div>
      ))}
    </div>
  );
}

const TIMELINE_GETTERS = {
  label: (r) => r.label, started: (r) => r.timeline.started_at_iso, updated: (r) => r.timeline.completed_at_iso,
  state: (r) => (r.status !== 'ok' ? 2 : r.counts.running ? 1 : 0), duration: (r) => r.timeline.duration_secs, rate: (r) => r.rate,
};

function TimelineTable({ rows, unit, skeletons }) {
  const data = useMemo(() => rows.map((r) => {
    const secs = r.timeline.duration_secs;
    return { ...r, rate: secs > 0 ? (r.counts.total / secs) * RATE[unit][0] : null };
  }), [rows, unit]);
  const { sorted, sort, toggle } = useSortedRows(data, 'label', { getters: TIMELINE_GETTERS });
  return (
    <TableShell>
      <thead>
        <tr>
          <SortTh label="Table" sortKey="label" sort={sort} onSort={toggle} />
          <SortTh label="Started" sortKey="started" sort={sort} onSort={toggle} />
          <SortTh label="Last updated" sortKey="updated" sort={sort} onSort={toggle} />
          <SortTh label="State" sortKey="state" sort={sort} onSort={toggle} />
          <SortTh label="Duration" sortKey="duration" sort={sort} onSort={toggle} align="right" />
          <SortTh label="Rate" sortKey="rate" sort={sort} onSort={toggle} align="right" />
        </tr>
      </thead>
      <tbody className="divide-y divide-jj-gray-02">
        {sorted.map((r) => {
          const notStarted = r.status !== 'ok' || r.timeline.started_at === 'N/A';
          return (
            <tr key={r.table} className="hover:bg-jj-gray-01 transition-colors">
              <Td><TableLabel row={r} /></Td>
              <Td className="whitespace-nowrap tabular-nums text-jj-gray-07">{notStarted ? '—' : r.timeline.started_at}</Td>
              <Td className="whitespace-nowrap tabular-nums text-jj-gray-07">
                {notStarted ? '—' : <>{r.timeline.completed_at} <span className="text-jj-gray-05 text-xs">({r.timeline.updated_ago})</span></>}
              </Td>
              <Td>
                {notStarted ? <span className="text-jj-gray-05">Not started</span>
                  : r.counts.running ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-jj-blue-03 font-semibold"><Dot color="#0f68b2" pulse className="w-2 h-2" />In progress</span>
                    : <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-jj-green-03 font-semibold"><Dot color="#328714" className="w-2 h-2" />Complete</span>}
              </Td>
              <Td align="right" className="font-semibold text-jj-gray-08 whitespace-nowrap">{notStarted ? '—' : r.timeline.duration}</Td>
              <Td align="right" className="whitespace-nowrap">{r.rate != null ? `${fmtNum(Math.round(r.rate))}${RATE[unit][1]}` : '—'}</Td>
            </tr>
          );
        })}
        {Array.from({ length: skeletons }).map((_, i) => (
          <tr key={`sk-${i}`}>{Array.from({ length: 6 }).map((__, j) => <Td key={j}><Skeleton className="h-4 w-20" /></Td>)}</tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function Charts({ bar, donut, loading }) {
  const bars = useMemo(() => {
    const map = {};
    (bar || []).forEach(({ table, status, count }) => { map[table] = { ...(map[table] || { table }), [status]: count }; });
    return Object.values(map);
  }, [bar]);
  const pie = donut ? Object.entries(donut).map(([k, v]) => ({ name: STATUS[k].label, value: v, color: STATUS[k].color })).filter((d) => d.value > 0) : [];
  const total = pie.reduce((s, d) => s + d.value, 0);
  const placeholder = <Skeleton className="h-64 w-full" />;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
      <Panel title="Files by status per table" className="xl:col-span-3">
        {loading ? placeholder : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e8e6e3" />
                <XAxis dataKey="table" tick={{ fontSize: 11, fill: '#6e6259' }} tickLine={false} axisLine={{ stroke: '#d5cfc9' }} interval={0} />
                <YAxis tick={{ fontSize: 11, fill: '#6e6259' }} tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={48} />
                <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(49,44,42,0.04)' }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                {Object.values(STATUS).map((s) => <Bar key={s.label} dataKey={s.label} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={36} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      <Panel title="Overall status" className="xl:col-span-2">
        {loading ? placeholder : total === 0 ? <EmptyState icon="chart" title="No files yet" className="py-16" /> : (
          <div className="flex flex-col sm:flex-row xl:flex-col 2xl:flex-row items-center gap-4">
            <div className="relative w-52 h-52 flex-shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pie} dataKey="value" innerRadius="64%" outerRadius="96%" paddingAngle={pie.length > 1 ? 2 : 0} stroke="none">
                    {pie.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={TOOLTIP_STYLE} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="font-johnson-display text-2xl text-jj-gray-08 tabular-nums">{fmtCompact(total)}</span>
                <span className="font-johnson-text text-xs text-jj-gray-06">files</span>
              </div>
            </div>
            <ul className="flex-1 w-full flex flex-col gap-2.5">
              {pie.map((d) => (
                <li key={d.name} className="flex items-center justify-between gap-3 font-johnson-text text-sm">
                  <span className="flex items-center gap-2 text-jj-gray-07"><Dot color={d.color} />{d.name}</span>
                  <span className="tabular-nums text-jj-gray-08 font-semibold">{fmtNum(d.value)} <span className="text-jj-gray-05 font-normal">({fmtPct(d.value / total)})</span></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── Product tab ───────────────────────────────────────────────────────────────

function ProductStats({ product, switcher }) {
  const { user } = useAuth();
  const email = user?.email;
  const [tables, setTables] = useState([]);
  const [summary, setSummary] = useState(null);
  const [expected, setExpected] = useState(3);
  const [available, setAvailable] = useState({});
  const [streaming, setStreaming] = useState(true);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [unit, setUnit] = useState('hour');
  const controller = useRef(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setStreaming(true);
    setError(null);
    setTables([]);
    setSummary(null);
    setAvailable({});
    if (product.chunks) {
      apiJson(`/api/${product.id}/available-counts`, { signal: ctrl.signal, timeoutMs: 120_000 })
        .then((d) => setAvailable({ ...(d.available || {}), __settled: true }))
        .catch((e) => { if (!isAbort(e)) setAvailable({ __settled: true }); });
    }
    try {
      await streamNdjson(`/api/${product.id}/dashboard/stream`, {
        signal: ctrl.signal,
        onMessage: (msg) => {
          if (msg.type === 'meta') setExpected(msg.data.table_count);
          if (msg.type === 'table') setTables((prev) => [...prev, msg.data]);
          if (msg.type === 'summary') setSummary(msg.data);
        },
      });
      setUpdatedAt(new Date());
    } catch (e) {
      if (!isAbort(e)) setError(e.message || 'Failed to load data');
    } finally {
      if (controller.current === ctrl) setStreaming(false);
    }
  }, [product]);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);
  usePolling(load, REFRESH_MS, { enabled: autoRefresh, immediate: false });

  const stalls = tables.map((t) => t.stall).filter(Boolean);
  const skeletons = streaming ? Math.max(0, expected - tables.length) : 0;
  const k = summary?.kpis;
  const loadingKpis = !summary && !error;

  return (
    <Page>
      <PageHeader
        title={product.title}
        accent="in flight."
        description={`${product.subtitle}, read straight from the production database.`}
        chips={(
          <>
            {switcher}
            {summary && (stalls.length
              ? <StatusChip color="#e8a317" live>{stalls.length} stalled {stalls.length === 1 ? 'table' : 'tables'}</StatusChip>
              : <StatusChip color="#328714" live={!!k?.running}>{k?.running ? 'Ingesting now' : 'Idle'}</StatusChip>)}
          </>
        )}
        art={(
          <RingGauge color="#328714" value={k?.success_pct} loading={loadingKpis} center={k ? `${k.success_pct}%` : '—'} sub="ingested"
            caption={k ? `${k.success_pct}% of ${fmtNum(k.total_docs)} documents ingested` : undefined}
            segments={summary?.chart_donut ? Object.entries(STATUS).map(([key, v]) => ({ label: v.label, color: v.color, value: summary.chart_donut[key] || 0 })) : []} />
        )}
        meta={updatedAt ? `updated ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : null}
        actions={(
          <>
            <Toggle checked={autoRefresh} onChange={(v) => { setAutoRefresh(v); logAuditEvent('stats_auto_refresh_toggled', email, product.id, `Auto-refresh ${v ? 'enabled' : 'disabled'} on ${product.label} Stats`); }} label="Auto-refresh (5 min)" />
            <Button icon="refresh" onClick={load} loading={streaming}>Refresh</Button>
          </>
        )}
      />

      {error && <Alert tone="error" title="Failed to load ingestion data" action={<Button size="sm" onClick={load}>Retry</Button>}>{error}</Alert>}

      <KpiGrid className="md:grid-cols-3 xl:grid-cols-5">
        <KpiTile label="Total documents" value={fmtCompact(k?.total_docs)} title={fmtNum(k?.total_docs)} hint="discovered so far" loading={loadingKpis} />
        <KpiTile label="Completed" value={fmtCompact(k?.success)} title={fmtNum(k?.success)} hint={k ? `${k.success_pct}% ingested` : null} accent="#328714" loading={loadingKpis} />
        <KpiTile label="Failed" value={fmtCompact(k?.error)} title={fmtNum(k?.error)} accent="#eb1700" loading={loadingKpis} />
        <KpiTile label="Running" value={fmtCompact(k?.running)} title={fmtNum(k?.running)} hint="in flight now" accent="#0f68b2" loading={loadingKpis} />
        <KpiTile label="Total storage" value={k?.total_size} hint={k ? `${k.ingested_size} ingested` : null} accent="#8c3bbb" loading={loadingKpis} />
      </KpiGrid>

      <StallAlert stalls={stalls} onToggle={(o) => logAuditEvent('stats_stall_alert_toggled', email, product.id, `Stalled ingestion details ${o ? 'expanded' : 'collapsed'} on ${product.label} Stats`)} />

      <Section title="Tables" description="Counts per ingestion log table">
        <SummaryTable rows={tables} available={available} showAvailable={product.chunks} skeletons={skeletons} />
      </Section>

      <Section title="Size by table">
        <SizePanels rows={tables.filter((t) => t.status === 'ok')} skeletons={skeletons} />
      </Section>

      <Section title="Timeline" description="Started = first ingested_at · Last updated = latest updated_at · Rate = files ÷ duration"
        actions={(
          <label className="flex items-center gap-2 font-johnson-text text-sm text-jj-gray-07">
            Rate per
            <Select size="sm" value={unit} label="Rate unit" onChange={(u) => { setUnit(u); logAuditEvent('stats_rate_unit_changed', email, product.id, `Rate unit changed to ${u} on ${product.label} Stats`); }}>
              {Object.keys(RATE).map((u) => <option key={u} value={u}>{u[0].toUpperCase() + u.slice(1)}</option>)}
            </Select>
          </label>
        )}>
        <TimelineTable rows={tables} unit={unit} skeletons={skeletons} />
      </Section>

      <Section title="Status breakdown">
        <Charts bar={summary?.chart_bar} donut={summary?.chart_donut} loading={!summary && streaming} />
      </Section>
    </Page>
  );
}

export default function IngestionStatsPage() {
  const { hasPermission } = useRBAC();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const products = PRODUCTS.filter((p) => hasPermission(p.permission));
  if (!products.length) return <Navigate to="/dashboard" replace />;
  const active = products.find((p) => p.id === params.get('statsTab')) || products[0];

  const change = (id) => {
    if (id === active.id) return;
    logAuditEvent('stats_tab_switched', user?.email, id, `Switched from ${active.label} to ${PRODUCTS.find((p) => p.id === id).label} on Stats page`);
    setParams((prev) => { const n = new URLSearchParams(prev); n.set('statsTab', id); return n; });
  };

  return (
    <div className="flex flex-col min-h-full">
      <ProductStats key={active.id} product={active}
        switcher={products.length > 1 && (
          <Tabs variant="pill" label="Product" tabs={products.map((p) => ({ id: p.id, label: p.label }))} value={active.id} onChange={change} />
        )} />
    </div>
  );
}
