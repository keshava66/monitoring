import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { apiFetch } from '../utils/apiClient';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area, LineChart, Line,
  Treemap,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';

const REFRESH_MS   = 30_000;

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  pdf:   '#eb1700',
  xml:   '#0f68b2',
  other: '#a39992',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());

// Compact form for big counts — 3,823,823 -> "3.8M". Exact count still
// shown as a subtitle on the card so nothing is lost.
const fmtCompact = (n) => {
  if (n == null) return '—';
  const num = Number(n);
  const abs = Math.abs(num);
  if (abs >= 1e9) return (num / 1e9).toFixed(2) + ' B';
  if (abs >= 1e6) return (num / 1e6).toFixed(2) + ' M';
  if (abs >= 1e3) return (num / 1e3).toFixed(2) + ' K';
  return String(num);
};

const Pulse = ({ w = 'w-24', h = 'h-4' }) => (
  <div className={`${w} ${h} bg-jj-gray-02 rounded animate-pulse`} />
);

// ── Shared sub-components ─────────────────────────────────────────────────────
const SectionHeader = ({ title, subtitle }) => (
  <div className="flex items-start gap-3 mb-4">
    <div className="w-1 self-stretch rounded-full bg-jj-red flex-shrink-0 min-h-[2rem]" />
    <div>
      <h2 className="font-johnson-display text-jj-gray-08 text-xl">{title}</h2>
      {subtitle && <p className="text-jj-gray-05 font-johnson-text text-xs mt-0.5">{subtitle}</p>}
    </div>
  </div>
);

const KpiCard = ({ label, value, sub, accent }) => (
  <div
    className="bg-white rounded-xl border border-jj-gray-02 shadow-sm px-5 py-4 flex flex-col gap-1 relative overflow-hidden"
  >
    <div
      className="absolute top-0 left-0 right-0 h-0.5"
      style={{ background: accent || '#eb1700' }}
    />
    <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-wider">{label}</p>
    <p className="font-johnson-display text-jj-gray-08 text-2xl" style={{ fontWeight: 600 }}>
      {value ?? '—'}
    </p>
    {sub && <p className="text-xs font-johnson-text text-jj-gray-04">{sub}</p>}
  </div>
);

// ── Sortable table helpers ────────────────────────────────────────────────────
function useSortedRows(rows, defaultKey) {
  const [sort, setSort] = useState({ key: defaultKey, asc: false });
  const toggle = (key) => setSort(s => ({ key, asc: s.key === key ? !s.asc : false }));
  const sorted = useMemo(() => {
    if (!rows?.length) return [];
    return [...rows].sort((a, b) => {
      const va = a[sort.key] ?? '';
      const vb = b[sort.key] ?? '';
      const na = parseFloat(va);
      const nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return sort.asc ? na - nb : nb - na;
      return sort.asc
        ? String(va).localeCompare(String(vb))
        : String(vb).localeCompare(String(va));
    });
  }, [rows, sort]);
  return { sorted, sort, toggle };
}

const THead = ({ children }) => (
  <thead>
    <tr style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)' }}>
      {children}
    </tr>
  </thead>
);

const Th = ({ label, sortKey, sort, onSort, right }) => {
  const active = sort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`px-4 py-3 text-xs font-semibold text-jj-gray-04 uppercase tracking-wider cursor-pointer select-none whitespace-nowrap hover:text-white transition-colors ${right ? 'text-right' : 'text-left'}`}
    >
      {label}
      <span className="ml-1 opacity-60">{active ? (sort.asc ? '▲' : '▼') : '⬍'}</span>
    </th>
  );
};

const tableWrap = 'rounded-xl overflow-hidden shadow border border-jj-gray-02';

// ── Custom Recharts tooltip ───────────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label, fmtValue }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-jj-gray-02 rounded-lg shadow-lg px-3 py-2 text-xs font-johnson-text">
      {label && <p className="font-semibold text-jj-gray-08 mb-1">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-jj-gray-06">{p.name}:</span>
          <span className="font-semibold text-jj-gray-08">
            {fmtValue ? fmtValue(p.value) : fmtNum(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

// ── TAB 1: Overview ───────────────────────────────────────────────────────────
const TabOverview = ({ segments, kpis, loading }) => {
  const pieData = kpis
    ? [
        { name: 'PDF',   value: kpis.pdf_files,   color: C.pdf   },
        { name: 'XML',   value: kpis.xml_files,   color: C.xml   },
        { name: 'Other', value: kpis.other_files, color: C.other },
      ]
    : [];

  const sizeData = kpis
    ? [
        { name: 'PDF',   bytes: kpis.pdf_bytes,   color: C.pdf,   label: kpis.pdf_size   },
        { name: 'XML',   bytes: kpis.xml_bytes,   color: C.xml,   label: kpis.xml_size   },
        { name: 'Other', bytes: kpis.other_bytes, color: C.other, label: kpis.other_size },
      ]
    : [];

  const segmentSizeData = useMemo(
    () => [...(segments || [])].sort((a, b) => a.total_bytes - b.total_bytes),
    [segments],
  );

  const stackedData = useMemo(
    () =>
      (segments || []).map(s => ({
        name:  s.segment,
        PDF:   s.pdf_files,
        XML:   s.xml_files,
        Other: s.other_files,
      })),
    [segments],
  );

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="bg-white rounded-xl border border-jj-gray-02 p-5 h-64 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Row 1: Pie + Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
          <p className="font-johnson-display text-jj-gray-08 mb-4">File Count by Type</p>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData} cx="50%" cy="50%"
                innerRadius={60} outerRadius={90}
                paddingAngle={3} dataKey="value"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(1)}%`}
                labelLine={false}
              >
                {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
          <p className="font-johnson-display text-jj-gray-08 mb-4">Storage by Type</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={sizeData} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fontSize: 12, fontFamily: 'JohnsonText, Arial' }} />
              <YAxis hide />
              <Tooltip
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="bg-white border border-jj-gray-02 rounded-lg shadow px-3 py-2 text-xs font-johnson-text">
                      <p className="font-semibold text-jj-gray-08">{label}</p>
                      <p className="text-jj-gray-06">{payload[0]?.payload?.label}</p>
                    </div>
                  ) : null
                }
              />
              {sizeData.map((d, i) => (
                <Bar key={i} dataKey="bytes" name="Size" fill={d.color} radius={[4, 4, 0, 0]}
                  label={{ position: 'top', formatter: (_, __, idx) => sizeData[idx]?.label, fontSize: 11, fontFamily: 'JohnsonText, Arial', fill: '#6e6259' }}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Row 2: Total size per segment (horizontal bar) */}
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">Total Size per Segment</p>
        <ResponsiveContainer width="100%" height={Math.max(280, segmentSizeData.length * 36)}>
          <BarChart data={segmentSizeData} layout="vertical" margin={{ top: 4, right: 80, left: 8, bottom: 4 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="segment" width={140} tick={{ fontSize: 11, fontFamily: 'JohnsonText, Arial', fill: '#6e6259' }} />
            <Tooltip
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="bg-white border border-jj-gray-02 rounded-lg shadow px-3 py-2 text-xs font-johnson-text">
                    <p className="font-semibold text-jj-gray-08">{label}</p>
                    <p className="text-jj-gray-06">{payload[0]?.payload?.total_size}</p>
                  </div>
                ) : null
              }
            />
            <Bar dataKey="total_bytes" name="Total Size" fill="#0f68b2" radius={[0, 4, 4, 0]}
              label={{ position: 'right', formatter: (_, __, i) => segmentSizeData[i]?.total_size, fontSize: 10, fontFamily: 'JohnsonText, Arial', fill: '#6e6259' }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Row 3: Stacked file mix */}
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">File Mix per Segment</p>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={stackedData} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
            <XAxis dataKey="name" tick={{ fontSize: 10, fontFamily: 'JohnsonText, Arial' }} angle={-20} textAnchor="end" interval={0} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Legend />
            <Bar dataKey="PDF"   stackId="a" fill={C.pdf}   radius={[0, 0, 0, 0]} />
            <Bar dataKey="XML"   stackId="a" fill={C.xml}   radius={[0, 0, 0, 0]} />
            <Bar dataKey="Other" stackId="a" fill={C.other} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ── TAB 2: Folder Breakdown ───────────────────────────────────────────────────
const TabFolderBreakdown = ({ segments, loading }) => {
  const { sorted, sort, toggle } = useSortedRows(segments, 'total_bytes');

  const treemapData = useMemo(
    () =>
      (segments || []).map(s => ({
        name:  s.segment,
        size:  s.total_bytes,
        label: s.total_size,
      })),
    [segments],
  );

  const stackedSizeData = useMemo(
    () =>
      (segments || []).map(s => ({
        name:  s.segment,
        PDF:   s.pdf_bytes,
        XML:   s.xml_bytes,
        Other: s.other_bytes,
      })),
    [segments],
  );

  const TreemapContent = ({ root, depth, x, y, width, height, name, size, label }) => {
    if (width < 30 || height < 20) return null;
    return (
      <g>
        <rect x={x} y={y} width={width} height={height}
          style={{ fill: `hsl(${214 + (size / (root?.value || 1)) * 30}, 70%, ${35 + depth * 10}%)`, stroke: '#fff', strokeWidth: 2 }}
        />
        {width > 60 && height > 30 && (
          <text x={x + width / 2} y={y + height / 2} textAnchor="middle" dominantBaseline="middle"
            style={{ fontSize: Math.min(12, width / 8), fontFamily: 'JohnsonText, Arial', fill: '#fff', pointerEvents: 'none' }}>
            {name}
          </text>
        )}
        {width > 60 && height > 48 && (
          <text x={x + width / 2} y={y + height / 2 + 14} textAnchor="middle" dominantBaseline="middle"
            style={{ fontSize: 10, fontFamily: 'JohnsonText, Arial', fill: 'rgba(255,255,255,0.8)', pointerEvents: 'none' }}>
            {label}
          </text>
        )}
      </g>
    );
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-5">
        <div className="bg-white rounded-xl border border-jj-gray-02 p-5 h-48 animate-pulse" />
        <div className="bg-white rounded-xl border border-jj-gray-02 p-5 h-64 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Segment table */}
      <div className={tableWrap}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-johnson-text">
            <THead>
              <Th label="Segment"      sortKey="segment"     sort={sort} onSort={toggle} />
              <Th label="Total Files"  sortKey="total_files" sort={sort} onSort={toggle} right />
              <Th label="PDF Files"    sortKey="pdf_files"   sort={sort} onSort={toggle} right />
              <Th label="XML Files"    sortKey="xml_files"   sort={sort} onSort={toggle} right />
              <Th label="Other Files"  sortKey="other_files" sort={sort} onSort={toggle} right />
              <Th label="Total Size"   sortKey="total_bytes" sort={sort} onSort={toggle} right />
              <Th label="PDF Size"     sortKey="pdf_bytes"   sort={sort} onSort={toggle} right />
              <Th label="XML Size"     sortKey="xml_bytes"   sort={sort} onSort={toggle} right />
              <Th label="Other Size"   sortKey="other_bytes" sort={sort} onSort={toggle} right />
              <Th label="Last Modified" sortKey="last_modified" sort={sort} onSort={toggle} />
            </THead>
            <tbody className="divide-y divide-jj-gray-02">
              {sorted.map((r, i) => (
                <tr key={i} className="bg-white even:bg-jj-gray-01 hover:bg-blue-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-jj-gray-08 max-w-[200px] truncate" title={r.folder_path}>{r.segment}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold text-jj-gray-07">{fmtNum(r.total_files)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold" style={{ color: C.pdf }}>{fmtNum(r.pdf_files)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold" style={{ color: C.xml }}>{fmtNum(r.xml_files)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold text-jj-gray-05">{fmtNum(r.other_files)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold text-purple-700">{r.total_size}</td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: C.pdf }}>{r.pdf_size}</td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: C.xml }}>{r.xml_size}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-jj-gray-05">{r.other_size}</td>
                  <td className="px-4 py-3 text-xs text-jj-gray-05 whitespace-nowrap">{r.last_modified ?? '—'}</td>
                </tr>
              ))}
              {!sorted.length && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-jj-gray-05 font-johnson-text">No segments found</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-jj-gray-02 bg-jj-gray-01 text-xs font-johnson-text text-jj-gray-05">
          {sorted.length} segment{sorted.length !== 1 ? 's' : ''} — sorted by {sort.key} ({sort.asc ? 'asc' : 'desc'})
        </div>
      </div>

      {/* Treemap */}
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">Storage Treemap</p>
        <ResponsiveContainer width="100%" height={400}>
          <Treemap data={treemapData} dataKey="size" aspectRatio={4 / 3} content={<TreemapContent />} />
        </ResponsiveContainer>
      </div>

      {/* Stacked size per segment */}
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">Size Breakdown per Segment (Stacked)</p>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={stackedSizeData} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
            <XAxis dataKey="name" tick={{ fontSize: 10, fontFamily: 'JohnsonText, Arial' }} angle={-20} textAnchor="end" interval={0} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="bg-white border border-jj-gray-02 rounded-lg shadow px-3 py-2 text-xs font-johnson-text">
                    <p className="font-semibold text-jj-gray-08 mb-1">{label}</p>
                    {payload.map((p, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.fill }} />
                        <span className="text-jj-gray-06">{p.name}:</span>
                        <span className="font-semibold text-jj-gray-08">{p.payload[`${p.name.toLowerCase()}_size`] || fmtNum(p.value)}</span>
                      </div>
                    ))}
                  </div>
                ) : null
              }
            />
            <Legend />
            <Bar dataKey="PDF"   stackId="a" fill={C.pdf}   radius={[0, 0, 0, 0]} />
            <Bar dataKey="XML"   stackId="a" fill={C.xml}   radius={[0, 0, 0, 0]} />
            <Bar dataKey="Other" stackId="a" fill={C.other} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ── TAB 3: Largest PDFs ───────────────────────────────────────────────────────
const TabLargestPdfs = ({ files, loading }) => {
  const { sorted, sort, toggle } = useSortedRows(files, 'size_bytes');
  const chartData = useMemo(
    () => [...(files || [])].sort((a, b) => a.size_bytes - b.size_bytes),
    [files],
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-5">
        <div className="bg-white rounded-xl border border-jj-gray-02 p-5 h-64 animate-pulse" />
        <div className="bg-white rounded-xl border border-jj-gray-02 p-5 h-48 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Horizontal bar chart */}
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">Top {files?.length ?? 0} Largest PDF Files</p>
        <ResponsiveContainer width="100%" height={Math.max(300, (files?.length ?? 0) * 26)}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 100, left: 8, bottom: 4 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="file_name" width={200} tick={{ fontSize: 10, fontFamily: 'JohnsonText, Arial', fill: '#6e6259' }} />
            <Tooltip
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="bg-white border border-jj-gray-02 rounded-lg shadow px-3 py-2 text-xs font-johnson-text">
                    <p className="font-semibold text-jj-gray-08 mb-0.5 max-w-xs truncate">{label}</p>
                    <p className="text-jj-gray-06">Segment: {payload[0]?.payload?.segment}</p>
                    <p className="text-jj-red font-semibold">{payload[0]?.payload?.size_fmt}</p>
                  </div>
                ) : null
              }
            />
            <Bar dataKey="size_bytes" fill="#0f68b2" radius={[0, 4, 4, 0]}
              label={{ position: 'right', formatter: (_, __, i) => chartData[i]?.size_fmt, fontSize: 10, fontFamily: 'JohnsonText, Arial', fill: '#6e6259' }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* File details table */}
      <div className={tableWrap}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-johnson-text">
            <THead>
              <Th label="File Name"     sortKey="file_name"     sort={sort} onSort={toggle} />
              <Th label="Segment"       sortKey="segment"       sort={sort} onSort={toggle} />
              <Th label="Size"          sortKey="size_bytes"    sort={sort} onSort={toggle} right />
              <Th label="Last Modified" sortKey="last_modified" sort={sort} onSort={toggle} />
            </THead>
            <tbody className="divide-y divide-jj-gray-02">
              {sorted.map((f, i) => (
                <tr key={i} className="bg-white even:bg-jj-gray-01 hover:bg-blue-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-jj-gray-08 max-w-[280px] truncate" title={f.file_name}>{f.file_name}</td>
                  <td className="px-4 py-3 text-jj-gray-06 max-w-[160px] truncate" title={f.folder_path}>{f.segment}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold text-jj-red">{f.size_fmt}</td>
                  <td className="px-4 py-3 text-xs text-jj-gray-05 whitespace-nowrap">{f.last_modified ?? '—'}</td>
                </tr>
              ))}
              {!sorted.length && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-jj-gray-05 font-johnson-text">No PDF files found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ── TAB 4: Trends ─────────────────────────────────────────────────────────────
const TabTrends = ({ daily, loading }) => {
  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {[0, 1, 2].map(i => (
          <div key={i} className="bg-white rounded-xl border border-jj-gray-02 p-5 h-56 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!daily?.length) {
    return (
      <div className="bg-white rounded-xl border border-jj-gray-02 p-8 text-center text-jj-gray-05 font-johnson-text">
        No trend data available
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Folders completed per day */}
        <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
          <p className="font-johnson-display text-jj-gray-08 mb-4">Folders Completed Per Day</p>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={daily} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="foldersGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#0f68b2" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#0f68b2" stopOpacity={0}    />
                </linearGradient>
              </defs>
              <XAxis dataKey="day" tick={{ fontSize: 10, fontFamily: 'JohnsonText, Arial' }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="folders_completed" name="Folders"
                stroke="#0f68b2" strokeWidth={2} fill="url(#foldersGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* File types over time */}
        <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
          <p className="font-johnson-display text-jj-gray-08 mb-4">File Types Over Time</p>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={daily} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                {[['pdfGrad', C.pdf], ['xmlGrad', C.xml], ['otherGrad', C.other]].map(([id, color]) => (
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={color} stopOpacity={0.12} />
                    <stop offset="95%" stopColor={color} stopOpacity={0}    />
                  </linearGradient>
                ))}
              </defs>
              <XAxis dataKey="day" tick={{ fontSize: 10, fontFamily: 'JohnsonText, Arial' }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <Legend />
              <Area type="monotone" dataKey="pdf"   name="PDF"   stroke={C.pdf}   strokeWidth={2} fill="url(#pdfGrad)"   />
              <Area type="monotone" dataKey="xml"   name="XML"   stroke={C.xml}   strokeWidth={2} fill="url(#xmlGrad)"   />
              <Area type="monotone" dataKey="other" name="Other" stroke={C.other} strokeWidth={2} fill="url(#otherGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Cumulative folders */}
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm p-5">
        <p className="font-johnson-display text-jj-gray-08 mb-4">Cumulative Folders Scanned</p>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={daily} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="day" tick={{ fontSize: 10, fontFamily: 'JohnsonText, Arial' }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Line type="monotone" dataKey="cumulative" name="Total Folders"
              stroke="#8c3bbb" strokeWidth={2.5} dot={{ r: 3, fill: '#8c3bbb' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ── KPI Strip ─────────────────────────────────────────────────────────────────
const KpiStrip = ({ kpis, loading }) => {
  const cards = [
    { label: 'Segments',    value: loading ? null : fmtNum(kpis?.segments),                                                  accent: '#0f68b2' },
    { label: 'Total Files', value: loading ? null : fmtCompact(kpis?.total_files), sub: loading ? null : fmtNum(kpis?.total_files), accent: '#6e6259' },
    { label: 'PDF Files',   value: loading ? null : fmtCompact(kpis?.pdf_files),   sub: loading ? null : fmtNum(kpis?.pdf_files),   accent: C.pdf     },
    { label: 'XML Files',   value: loading ? null : fmtCompact(kpis?.xml_files),   sub: loading ? null : fmtNum(kpis?.xml_files),   accent: C.xml     },
    { label: 'Other Files', value: loading ? null : fmtCompact(kpis?.other_files), sub: loading ? null : fmtNum(kpis?.other_files), accent: C.other   },
    { label: 'Total Size',  value: loading ? null : kpis?.total_size,                                                         accent: '#8c3bbb' },
  ];
  const sizeCards = [
    { label: 'PDF Size',   value: loading ? null : kpis?.pdf_size,   accent: C.pdf   },
    { label: 'XML Size',   value: loading ? null : kpis?.xml_size,   accent: C.xml   },
    { label: 'Other Size', value: loading ? null : kpis?.other_size, accent: C.other },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {cards.map((c, i) => (
          loading
            ? <div key={i} className="bg-white rounded-xl border border-jj-gray-02 shadow-sm px-5 py-4 h-20 animate-pulse" />
            : <KpiCard key={i} {...c} />
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {sizeCards.map((c, i) => (
          loading
            ? <div key={i} className="bg-white rounded-xl border border-jj-gray-02 shadow-sm px-5 py-4 h-20 animate-pulse" />
            : <KpiCard key={i} {...c} />
        ))}
      </div>
    </div>
  );
};

// ── Main Page ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'folders',    label: '📁 Folder Breakdown'   },
  { id: 'overview',   label: '📊 Overview'          },
  { id: 'trends',     label: '📈 Trends'             },
  { id: 'pdfs',       label: '📄 Largest PDFs'       },
];

export default function EPODNasScannerPage() {
  const { user } = useAuth();
  const email = user?.email || user?.username || 'unknown';
  const [activeTab,   setActiveTab]   = useState('folders');
  const [search,      setSearch]      = useState('');

  const [overview,    setOverview]    = useState(null);
  const [pdfs,        setPdfs]        = useState(null);
  const [trends,      setTrends]      = useState(null);

  const [loadingOv,   setLoadingOv]   = useState(false);
  const [loadingPdfs, setLoadingPdfs] = useState(false);
  const [loadingTr,   setLoadingTr]   = useState(false);

  const [errorOv,     setErrorOv]     = useState(null);
  const [errorPdfs,   setErrorPdfs]   = useState(null);
  const [errorTr,     setErrorTr]     = useState(null);

  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Keep search in a ref so fetch callbacks never need it as a dependency
  const searchRef = React.useRef('');
  useEffect(() => { searchRef.current = search; }, [search]);

  const fetchOverview = useCallback(async (searchOverride, signal) => {
    setLoadingOv(true);
    setErrorOv(null);
    try {
      const term = searchOverride !== undefined ? searchOverride : searchRef.current;
      const params = new URLSearchParams({ _: Date.now() });
      if (term) params.set('search', term);
      const res = await apiFetch(`/api/nas/overview?${params}`, { cache: 'no-store', signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
      setOverview(await res.json());
      setLastRefresh(new Date());
      setLoadingOv(false);
    } catch (e) {
      // Aborted requests (e.g. StrictMode's mount→cleanup→remount in dev)
      // must NOT touch loading state — a newer request may still be
      // in flight and owns that flag. Touching it here flips loading to
      // false prematurely, showing "no data" until the real request lands.
      if (e.name === 'AbortError') return;
      setErrorOv(e.message);
      setLoadingOv(false);
    }
  }, []);

  const fetchPdfs = useCallback(async (signal) => {
    setLoadingPdfs(true);
    setErrorPdfs(null);
    try {
      const res = await apiFetch(`/api/nas/largest-pdfs?_=${Date.now()}`, { cache: 'no-store', signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
      setPdfs(await res.json());
      setLoadingPdfs(false);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setErrorPdfs(e.message);
      setLoadingPdfs(false);
    }
  }, []);

  const fetchTrends = useCallback(async (signal) => {
    setLoadingTr(true);
    setErrorTr(null);
    try {
      const res = await apiFetch(`/api/nas/trends?_=${Date.now()}`, { cache: 'no-store', signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
      setTrends(await res.json());
      setLoadingTr(false);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setErrorTr(e.message);
      setLoadingTr(false);
    }
  }, []);

  const refreshControllerRef = React.useRef(null);
  const refreshAll = useCallback(() => {
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    fetchOverview(undefined, controller.signal);
    fetchPdfs(controller.signal);
    fetchTrends(controller.signal);
  }, [fetchOverview, fetchPdfs, fetchTrends]);

  // Initial load — stable refs mean this only fires once
  useEffect(() => {
    refreshAll();
    // Cancel any still-in-flight requests when navigating away — otherwise
    // they keep occupying the browser's per-origin connection slots and
    // block other pages' requests from going out.
    return () => refreshControllerRef.current?.abort();
  }, [refreshAll]);

  // Re-fetch overview when search changes (debounced).
  // isFirstRun skips the mount-time fire (search === '') — that's not a
  // user action, it's the initial empty state.
  const isFirstSearchRun = React.useRef(true);
  useEffect(() => {
    const t = setTimeout(() => {
      fetchOverview(search);
      if (isFirstSearchRun.current) {
        isFirstSearchRun.current = false;
      } else {
        logAuditEvent(
          'nas_scanner_segment_filtered', email, search || '(cleared)',
          search ? `Filtered segments by "${search}"` : 'Cleared segment filter'
        );
      }
    }, 400);
    return () => clearTimeout(t);
  }, [search, fetchOverview, email]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, refreshAll]);

  const handleTabChange = (id) => {
    if (id === activeTab) return;
    const fromLabel = TABS.find(t => t.id === activeTab)?.label ?? activeTab;
    const toLabel   = TABS.find(t => t.id === id)?.label ?? id;
    logAuditEvent('nas_scanner_tab_changed', email, id, `Switched from ${fromLabel} to ${toLabel} on NAS Scanner`);
    setActiveTab(id);
  };

  // NOTE: the log call must live OUTSIDE the setState updater. React may
  // invoke a functional updater more than once (StrictMode does this on
  // purpose, to catch impure updaters) — a side effect inside one fires
  // every time React decides to re-run it, which is exactly why this was
  // logging every toggle twice.
  const toggleAutoRefresh = () => {
    const next = !autoRefresh;
    setAutoRefresh(next);
    logAuditEvent('nas_scanner_auto_refresh_toggled', email, 'nas_scanner', `Auto-refresh ${next ? 'enabled' : 'disabled'} on NAS Scanner`);
  };

  const anyError = errorOv || errorPdfs || errorTr;

  return (
    <div className="h-full overflow-auto bg-jj-gray-01">
      <div className="px-8 py-6 flex flex-col gap-6 max-w-screen-2xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-jj-red rounded-lg flex items-center justify-center text-2xl select-none">🗄️</div>
            <div>
              <h1 className="text-3xl font-johnson-display text-jj-gray-08" style={{ lineHeight: '110%' }}>
                EPOD NAS Scanner
              </h1>
              <p className="text-jj-gray-05 font-johnson-text text-xs mt-0.5 font-mono">
                {overview?.base_prefix ?? '\\\\jnj.com\\grausdfsroot\\ERIS\\EPOD\\Archive\\eCTD'}
                {lastRefresh && (
                  <span className="ml-2 text-jj-gray-04 not-italic font-johnson-text">
                    · Refreshed {lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Search */}
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter segments…"
              className="border border-jj-gray-03 rounded-lg px-3 py-2 text-sm font-johnson-text text-jj-gray-08 w-48 focus:outline-none focus:border-jj-red transition-colors"
            />
            {/* Auto-refresh toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-johnson-text text-jj-gray-06">
              <div className="relative" onClick={toggleAutoRefresh}>
                <div className={`w-9 h-5 rounded-full transition-colors duration-200 ${autoRefresh ? 'bg-jj-red' : 'bg-jj-gray-03'}`} />
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${autoRefresh ? 'translate-x-4' : ''}`} />
              </div>
              Auto-refresh (30s)
            </label>
            <button
              onClick={refreshAll}
              disabled={loadingOv || loadingPdfs || loadingTr}
              className="flex items-center gap-2 px-4 py-2 border border-jj-gray-03 rounded-lg bg-white font-johnson-text text-sm text-jj-gray-07 hover:border-jj-red hover:text-jj-red transition-colors disabled:opacity-50"
            >
              <span className={(loadingOv || loadingPdfs || loadingTr) ? 'animate-spin inline-block' : ''}>↻</span>
              Refresh
            </button>
          </div>
        </div>

        {/* Error banner */}
        {anyError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-start gap-3">
            <span className="text-jj-red text-xl mt-0.5">⚠</span>
            <div>
              <p className="font-johnson-display text-jj-gray-08 font-semibold">Failed to load data</p>
              <p className="text-sm text-jj-gray-06 font-johnson-text mt-0.5">{anyError}</p>
              <button onClick={refreshAll} className="mt-2 text-sm text-jj-red font-johnson-text underline hover:no-underline">
                Try again
              </button>
            </div>
          </div>
        )}

        {/* KPI Strip */}
        <KpiStrip kpis={overview?.kpis} loading={loadingOv} />

        {/* Tabs */}
        <div className="border-b border-jj-gray-02 -mb-2">
          <div className="flex gap-0">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`px-5 py-3 font-johnson-text text-sm font-medium transition-colors duration-200 border-b-2 -mb-px whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-jj-red text-jj-red'
                    : 'border-transparent text-jj-gray-06 hover:text-jj-gray-08 hover:border-jj-gray-04'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div>
          {activeTab === 'overview' && (
            <TabOverview
              segments={overview?.segments}
              kpis={overview?.kpis}
              loading={loadingOv}
            />
          )}
          {activeTab === 'folders' && (
            <TabFolderBreakdown
              segments={overview?.segments}
              loading={loadingOv}
            />
          )}
          {activeTab === 'pdfs' && (
            <TabLargestPdfs
              files={pdfs?.files}
              loading={loadingPdfs}
            />
          )}
          {activeTab === 'trends' && (
            <TabTrends
              daily={trends?.daily}
              loading={loadingTr}
            />
          )}
        </div>

        <p className="text-center text-xs text-jj-gray-04 font-johnson-text pb-2">
          Data sourced from PostgreSQL · EPOD NAS Scanner ·{' '}
          {overview?.base_prefix ?? 'BASE_PREFIX'}\\[FOLDER]
        </p>
      </div>
    </div>
  );
}