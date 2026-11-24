import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { apiJson, isAbort } from '../utils/apiClient';
import { logAuditEvent } from '../utils/auditLog';
import {
  Alert, Button, EmptyState, KpiGrid, KpiTile, Page, PageHeader, Panel, SearchInput, Skeleton, SortTh, TableShell, Tabs, Td, Toggle,
  fmtBytes, fmtCompact, fmtNum, useDebouncedValue, usePolling, useSortedRows,
} from '../components/ui';

const REFRESH_MS = 30_000;
const C = { pdf: '#eb1700', xml: '#0f68b2', other: '#857a73' };
const TABS = [
  { id: 'folders', label: 'Segments' },
  { id: 'overview', label: 'Overview' },
  { id: 'trends', label: 'Trends' },
  { id: 'pdfs', label: 'Largest PDFs' },
];
const TT = { borderRadius: 10, border: '1px solid #e8e6e3', boxShadow: '0 8px 24px rgba(49,44,42,0.12)', fontFamily: 'JohnsonText, Arial', fontSize: 12 };
const AXIS = { fontSize: 11, fill: '#6e6259' };
const truncate = (s, n = 18) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function ChartSkeleton({ h = 'h-64' }) {
  return <div className="bg-white rounded-xl border border-jj-gray-02 p-5"><Skeleton className={`${h} w-full`} /></div>;
}

function Overview({ data, loading }) {
  const k = data?.kpis;
  const segments = useMemo(() => [...(data?.segments || [])].sort((a, b) => b.total_bytes - a.total_bytes), [data]);
  if (loading && !data) return <div className="grid grid-cols-1 lg:grid-cols-2 gap-4"><ChartSkeleton /><ChartSkeleton /></div>;
  if (!k || !k.total_files) return <EmptyState icon="archive" title="No scan data" description="Nothing has been scanned under the archive root yet." />;
  const pie = [['PDF', k.pdf_files, C.pdf], ['XML', k.xml_files, C.xml], ['Other', k.other_files, C.other]]
    .map(([name, value, color]) => ({ name, value, color })).filter((d) => d.value > 0);
  const sizes = [['PDF', k.pdf_bytes, C.pdf], ['XML', k.xml_bytes, C.xml], ['Other', k.other_bytes, C.other]].map(([name, bytes, color]) => ({ name, bytes, color }));
  const mix = segments.map((s) => ({ name: s.segment, PDF: s.pdf_files, XML: s.xml_files, Other: s.other_files }));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Files by type">
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <div className="w-48 h-48 flex-shrink-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pie} dataKey="value" innerRadius="60%" outerRadius="95%" paddingAngle={2} stroke="none">
                    {pie.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={TT} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex-1 w-full flex flex-col gap-2 font-johnson-text text-sm">
              {pie.map((d) => (
                <li key={d.name} className="flex justify-between gap-3">
                  <span className="flex items-center gap-2 text-jj-gray-07"><span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />{d.name}</span>
                  <span className="tabular-nums font-semibold text-jj-gray-08">{fmtNum(d.value)} <span className="font-normal text-jj-gray-05">({((d.value / k.total_files) * 100).toFixed(1)}%)</span></span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
        <Panel title="Storage by type">
          <div className="h-52">
            <ResponsiveContainer>
              <BarChart data={sizes} margin={{ top: 20, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e8e6e3" />
                <XAxis dataKey="name" tick={AXIS} tickLine={false} axisLine={{ stroke: '#d5cfc9' }} />
                <YAxis hide />
                <Tooltip formatter={(v) => [fmtBytes(v), 'Size']} contentStyle={TT} cursor={{ fill: 'rgba(49,44,42,0.04)' }} />
                <Bar dataKey="bytes" radius={[4, 4, 0, 0]} maxBarSize={72} label={{ position: 'top', formatter: (v) => fmtBytes(v), fontSize: 11, fill: '#6e6259' }}>
                  {sizes.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
      <Panel title="Size by segment">
        <div style={{ height: Math.max(240, segments.length * 30) }}>
          <ResponsiveContainer>
            <BarChart data={segments} layout="vertical" margin={{ top: 0, right: 72, left: 0, bottom: 0 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="segment" width={120} tick={AXIS} tickFormatter={(v) => truncate(v, 16)} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v) => [fmtBytes(v), 'Size']} contentStyle={TT} cursor={{ fill: 'rgba(49,44,42,0.04)' }} />
              <Bar dataKey="total_bytes" fill="#0f68b2" radius={[0, 4, 4, 0]} maxBarSize={20}
                label={{ position: 'right', formatter: (v) => fmtBytes(v), fontSize: 11, fill: '#6e6259' }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <Panel title="File mix by segment">
        <div className="h-80">
          <ResponsiveContainer>
            <BarChart data={mix} margin={{ top: 8, right: 8, left: -8, bottom: 40 }}>
              <CartesianGrid vertical={false} stroke="#e8e6e3" />
              <XAxis dataKey="name" tick={AXIS} angle={-35} textAnchor="end" interval={0} height={60} tickFormatter={(v) => truncate(v, 12)} />
              <YAxis tick={AXIS} tickFormatter={fmtCompact} tickLine={false} axisLine={false} width={48} />
              <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={TT} cursor={{ fill: 'rgba(49,44,42,0.04)' }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} verticalAlign="top" />
              <Bar dataKey="PDF" stackId="a" fill={C.pdf} />
              <Bar dataKey="XML" stackId="a" fill={C.xml} />
              <Bar dataKey="Other" stackId="a" fill={C.other} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </div>
  );
}

function TreemapCell({ x, y, width, height, name, label, index }) {
  if (width < 4 || height < 4) return null;
  const shades = ['#0f68b2', '#004685', '#1f78c1', '#0b5591', '#2c86cf', '#003a6e'];
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={shades[index % shades.length]} stroke="#fff" strokeWidth={2} />
      {width > 70 && height > 34 && (
        <>
          <text x={x + 8} y={y + 18} fill="#fff" fontSize={12} fontFamily="JohnsonText, Arial">{truncate(name, Math.floor(width / 7))}</text>
          <text x={x + 8} y={y + 33} fill="rgba(255,255,255,0.8)" fontSize={11} fontFamily="JohnsonText, Arial">{label}</text>
        </>
      )}
    </g>
  );
}

const SEGMENT_COLS = [
  ['segment', 'Segment'], ['total_files', 'Files'], ['pdf_files', 'PDF'], ['xml_files', 'XML'], ['other_files', 'Other'],
  ['total_bytes', 'Total size'], ['pdf_bytes', 'PDF size'], ['xml_bytes', 'XML size'], ['last_modified', 'Last modified'],
];

function Segments({ data, loading }) {
  const rows = useMemo(() => data?.segments || [], [data]);
  const { sorted, sort, toggle } = useSortedRows(rows, 'total_bytes', { defaultAsc: false });
  const treemap = useMemo(() => rows.filter((s) => s.total_bytes > 0).map((s) => ({ name: s.segment, size: s.total_bytes, label: s.total_size })), [rows]);
  if (loading && !data) return <div className="flex flex-col gap-4"><ChartSkeleton h="h-48" /><ChartSkeleton /></div>;
  return (
    <div className="flex flex-col gap-4">
      <TableShell footer={`${sorted.length} segment${sorted.length === 1 ? '' : 's'}`}>
        <thead>
          <tr>{SEGMENT_COLS.map(([k, l], i) => <SortTh key={k} label={l} sortKey={k} sort={sort} onSort={toggle} align={i && i < 8 ? 'right' : 'left'} />)}</tr>
        </thead>
        <tbody className="divide-y divide-jj-gray-02">
          {sorted.length === 0 ? (
            <tr><Td colSpan={9}><EmptyState icon="search" title="No segments match" className="py-8" /></Td></tr>
          ) : sorted.map((r) => (
            <tr key={r.folder_path} className="hover:bg-jj-gray-01 transition-colors">
              <Td className="font-medium text-jj-gray-08 max-w-[16rem] truncate" title={r.folder_path}>{r.segment}</Td>
              <Td align="right" className="font-semibold">{fmtNum(r.total_files)}</Td>
              <Td align="right">{fmtNum(r.pdf_files)}</Td>
              <Td align="right">{fmtNum(r.xml_files)}</Td>
              <Td align="right">{fmtNum(r.other_files)}</Td>
              <Td align="right" className="font-semibold whitespace-nowrap">{r.total_size}</Td>
              <Td align="right" className="whitespace-nowrap">{r.pdf_size}</Td>
              <Td align="right" className="whitespace-nowrap">{r.xml_size}</Td>
              <Td className="whitespace-nowrap text-xs text-jj-gray-06">{r.last_modified || '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
      {treemap.length > 0 && (
        <Panel title="Storage treemap">
          <div className="h-80 sm:h-96">
            <ResponsiveContainer>
              <Treemap data={treemap} dataKey="size" aspectRatio={4 / 3} isAnimationActive={false} content={<TreemapCell />}>
                <Tooltip formatter={(v) => [fmtBytes(v), 'Size']} contentStyle={TT} />
              </Treemap>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Trends({ data, loading }) {
  const daily = data?.daily || [];
  if (loading && !data) return <div className="grid grid-cols-1 lg:grid-cols-2 gap-4"><ChartSkeleton /><ChartSkeleton /></div>;
  if (!daily.length) return <EmptyState icon="chart" title="No trend data yet" description="Trends appear once folders report a last-modified date." />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Folders completed per day">
          <div className="h-60">
            <ResponsiveContainer>
              <AreaChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <defs><linearGradient id="nasFolders" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0f68b2" stopOpacity={0.2} /><stop offset="100%" stopColor="#0f68b2" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="#e8e6e3" />
                <XAxis dataKey="day" tick={AXIS} tickLine={false} minTickGap={24} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={fmtCompact} />
                <Tooltip formatter={(v) => [fmtNum(v), 'Folders']} contentStyle={TT} />
                <Area type="monotone" dataKey="folders_completed" stroke="#0f68b2" strokeWidth={2} fill="url(#nasFolders)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Files by type per day">
          <div className="h-60">
            <ResponsiveContainer>
              <AreaChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e8e6e3" />
                <XAxis dataKey="day" tick={AXIS} tickLine={false} minTickGap={24} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={fmtCompact} />
                <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={TT} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="pdf" name="PDF" stroke={C.pdf} fill={C.pdf} fillOpacity={0.08} strokeWidth={2} />
                <Area type="monotone" dataKey="xml" name="XML" stroke={C.xml} fill={C.xml} fillOpacity={0.08} strokeWidth={2} />
                <Area type="monotone" dataKey="other" name="Other" stroke={C.other} fill={C.other} fillOpacity={0.08} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
      <Panel title="Cumulative folders scanned">
        <div className="h-60">
          <ResponsiveContainer>
            <LineChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#e8e6e3" />
              <XAxis dataKey="day" tick={AXIS} tickLine={false} minTickGap={24} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={fmtCompact} />
              <Tooltip formatter={(v) => [fmtNum(v), 'Folders']} contentStyle={TT} />
              <Line type="monotone" dataKey="cumulative" stroke="#8c3bbb" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </div>
  );
}

const PDF_COLS = [['file_name', 'File'], ['segment', 'Segment'], ['size_bytes', 'Size'], ['last_modified', 'Last modified']];

function LargestPdfs({ data, loading }) {
  const files = data?.files || [];
  const { sorted, sort, toggle } = useSortedRows(files, 'size_bytes', { defaultAsc: false });
  if (loading && !data) return <ChartSkeleton />;
  if (!files.length) return <EmptyState icon="records" title="No PDF files recorded" />;
  return (
    <div className="flex flex-col gap-4">
      <Panel title={`Top ${files.length} largest PDFs`}>
        <div style={{ height: Math.max(260, files.length * 26) }}>
          <ResponsiveContainer>
            <BarChart data={files} layout="vertical" margin={{ top: 0, right: 72, left: 0, bottom: 0 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="file_name" width={150} tick={AXIS} tickFormatter={(v) => truncate(v, 22)} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v) => [fmtBytes(v), 'Size']} contentStyle={TT} cursor={{ fill: 'rgba(49,44,42,0.04)' }} />
              <Bar dataKey="size_bytes" fill={C.pdf} radius={[0, 4, 4, 0]} maxBarSize={18} label={{ position: 'right', formatter: (v) => fmtBytes(v), fontSize: 11, fill: '#6e6259' }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <TableShell>
        <thead><tr>{PDF_COLS.map(([k, l]) => <SortTh key={k} label={l} sortKey={k} sort={sort} onSort={toggle} align={k === 'size_bytes' ? 'right' : 'left'} />)}</tr></thead>
        <tbody className="divide-y divide-jj-gray-02">
          {sorted.map((f) => (
            <tr key={`${f.folder_path}/${f.file_name}`} className="hover:bg-jj-gray-01 transition-colors">
              <Td className="font-medium text-jj-gray-08 max-w-[20rem] truncate" title={f.file_name}>{f.file_name}</Td>
              <Td className="text-jj-gray-07 max-w-[12rem] truncate" title={f.folder_path}>{f.segment}</Td>
              <Td align="right" className="font-semibold whitespace-nowrap">{f.size_fmt}</Td>
              <Td className="text-xs text-jj-gray-06 whitespace-nowrap">{f.last_modified || '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  );
}

export default function NasScannerPage() {
  const { user } = useAuth();
  const email = user?.email;
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'folders';
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim(), 400);
  const [overview, setOverview] = useState(null);
  const [pdfs, setPdfs] = useState(null);
  const [trends, setTrends] = useState(null);
  const [loading, setLoading] = useState({ overview: true, pdfs: true, trends: true });
  const [error, setError] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const ctrl = useRef(null);

  const load = useCallback(async (term) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setLoading({ overview: true, pdfs: true, trends: true });
    const q = new URLSearchParams(term ? { search: term } : {}).toString();
    const run = (key, path, setter) => apiJson(path, { signal: c.signal, timeoutMs: 120_000 })
      .then(setter)
      .catch((e) => { if (!isAbort(e)) setError(e.message); })
      .finally(() => { if (!c.signal.aborted) setLoading((l) => ({ ...l, [key]: false })); });
    await Promise.all([
      run('overview', `/api/nas/overview${q ? `?${q}` : ''}`, setOverview),
      run('pdfs', '/api/nas/largest-pdfs', setPdfs),
      run('trends', '/api/nas/trends', setTrends),
    ]);
    if (!c.signal.aborted) setUpdated(new Date());
  }, []);

  const searchRef = useRef(debounced);
  useEffect(() => { searchRef.current = debounced; }, [debounced]);
  const firstSearch = useRef(true);
  useEffect(() => {
    load(debounced);
    if (firstSearch.current) { firstSearch.current = false; return; }
    logAuditEvent('nas_scanner_segment_filtered', email, debounced || '(cleared)', debounced ? `Filtered segments by "${debounced}"` : 'Cleared segment filter');
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ctrl.current?.abort(), []);
  const refresh = useCallback(() => load(searchRef.current), [load]);
  usePolling(refresh, REFRESH_MS, { enabled: autoRefresh, immediate: false });

  const selectTab = (id) => {
    if (id === tab) return;
    logAuditEvent('nas_scanner_tab_changed', email, id, `Switched from ${TABS.find((t) => t.id === tab).label} to ${TABS.find((t) => t.id === id).label} on NAS Scanner`);
    setParams((p) => { const n = new URLSearchParams(p); n.set('tab', id); return n; }, { replace: true });
  };

  const k = overview?.kpis;
  const busy = Object.values(loading).some(Boolean);

  return (
    <Page>
      <PageHeader icon="archive" title="EPOD NAS scanner"
        description={<span className="font-mono text-xs break-all">{overview?.base_prefix || '\\\\jnj.com\\grausdfsroot\\ERIS\\EPOD\\Archive\\eCTD'}</span>}
        meta={updated ? `refreshed ${updated.toLocaleTimeString('en-US')}` : null}
        actions={(
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Filter segments" className="w-full sm:w-56" />
            <Toggle checked={autoRefresh} onChange={(v) => { setAutoRefresh(v); logAuditEvent('nas_scanner_auto_refresh_toggled', email, 'nas_scanner', `Auto-refresh ${v ? 'enabled' : 'disabled'} on NAS Scanner`); }} label="Auto-refresh (30s)" />
            <Button icon="refresh" onClick={refresh} loading={busy}>Refresh</Button>
          </>
        )}
      />
      {error && <Alert tone="error" title="Some data failed to load" action={<Button size="sm" onClick={refresh}>Retry</Button>}>{error}</Alert>}

      <KpiGrid className="sm:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Segments" value={fmtNum(k?.segments)} accent="#0f68b2" loading={loading.overview && !k} />
        <KpiTile label="Total files" value={fmtCompact(k?.total_files)} hint={fmtNum(k?.total_files)} loading={loading.overview && !k} />
        <KpiTile label="PDF files" value={fmtCompact(k?.pdf_files)} hint={k?.pdf_size} accent={C.pdf} loading={loading.overview && !k} />
        <KpiTile label="XML files" value={fmtCompact(k?.xml_files)} hint={k?.xml_size} accent={C.xml} loading={loading.overview && !k} />
        <KpiTile label="Other files" value={fmtCompact(k?.other_files)} hint={k?.other_size} accent={C.other} loading={loading.overview && !k} />
        <KpiTile label="Total size" value={k?.total_size} accent="#8c3bbb" loading={loading.overview && !k} />
      </KpiGrid>

      <div className="flex flex-col gap-4">
        <Tabs label="NAS views" tabs={TABS} value={tab} onChange={selectTab} />
        {tab === 'folders' && <Segments data={overview} loading={loading.overview} />}
        {tab === 'overview' && <Overview data={overview} loading={loading.overview} />}
        {tab === 'trends' && <Trends data={trends} loading={loading.trends} />}
        {tab === 'pdfs' && <LargestPdfs data={pdfs} loading={loading.pdfs} />}
      </div>
    </Page>
  );
}
