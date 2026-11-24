import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { DIRECTORY_SCOPES } from '../msalConfig';
import { logAuditEvent } from '../utils/auditLog';
import { apiFetch, apiJson, downloadBlob, errorMessage, graphDisplayName, graphPhoto, isAbort, mapLimit } from '../utils/apiClient';
import { Avatar } from '../components/Header';
import { ClockDial } from '../components/HeroArt';
import {
  Alert, Badge, Button, Drawer, EmptyState, Icon, IconButton, KpiGrid, KpiTile, Page, PageHeader, SearchInput, Select, Skeleton, StatusChip, Tabs, TextField,
  cx, fmtNum, formatDateTime, relativeTime, useDebouncedValue, useFeedback, usePolling,
} from '../components/ui';

const PAGE_SIZE = 25;

const ACTION_META = {
  role_assigned: ['Role assigned', 'success'], role_removed: ['Role removed', 'danger'], role_created: ['Role created', 'info'],
  role_updated: ['Role updated', 'warning'], role_reset: ['Role reset', 'warning'], role_deleted: ['Role deleted', 'danger'],
  user_login: ['Sign in', 'success'], user_logout: ['Sign out', 'neutral'], session_expired: ['Session expired', 'warning'],
  page_access: ['Page visit', 'neutral'], page_refreshed: ['Page refresh', 'neutral'], audit_log_deleted: ['Audit entry deleted', 'danger'],
  audit_edit_mode_accessed: ['Audit edit mode', 'danger'], audit_exported: ['Audit exported', 'info'], 'in-page-audit': ['Audit log activity', 'neutral'],
  'in-page-extraction-pipelines': ['Pipeline monitor activity', 'neutral'], pipeline_action: ['Pipeline control', 'warning'],
  server_manager_action: ['Server control', 'warning'], stats_tab_switched: ['Stats tab switch', 'neutral'],
  stats_auto_refresh_toggled: ['Stats auto-refresh', 'neutral'], stats_stall_alert_toggled: ['Stall alert viewed', 'neutral'],
  stats_rate_unit_changed: ['Stats rate unit', 'neutral'], nas_scanner_segment_filtered: ['NAS filter', 'neutral'],
  nas_scanner_tab_changed: ['NAS tab switch', 'neutral'], nas_scanner_auto_refresh_toggled: ['NAS auto-refresh', 'neutral'],
};
const actionLabel = (a) => ACTION_META[a]?.[0] || a.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const ActionBadge = ({ action }) => <Badge tone={ACTION_META[action]?.[1] || 'neutral'}>{actionLabel(action)}</Badge>;

/** Resolves display names and photos for emails from the directory (best effort). */
function useDirectory(emails) {
  const { acquireToken } = useAuth();
  const [names, setNames] = useState({});
  const [photos, setPhotos] = useState({});
  const key = [...new Set(emails.filter((e) => e && e.includes('@')).map((e) => e.toLowerCase()))].sort().join(',');
  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    (async () => {
      let token;
      try { token = await acquireToken(DIRECTORY_SCOPES); } catch { return; }
      const list = key.split(',');
      await mapLimit(list, 6, async (email) => {
        const [name, photo] = await Promise.all([graphDisplayName(email, token), graphPhoto(email, token)]);
        if (cancelled) return;
        if (name) setNames((n) => (n[email] === name ? n : { ...n, [email]: name }));
        if (photo) setPhotos((p) => (p[email] === photo ? p : { ...p, [email]: photo }));
      });
    })();
    return () => { cancelled = true; };
  }, [key, acquireToken]);
  return { names, photos };
}

function Person({ email, names, photos, size = 'w-8 h-8' }) {
  const e = (email || '').toLowerCase();
  const name = names[e];
  return (
    <span className="flex items-center gap-2.5 min-w-0">
      <Avatar src={photos[e]} name={name || email} className={size} />
      <span className="min-w-0">
        <span className="block font-johnson-text text-sm text-jj-gray-08 truncate">{name || email || '—'}</span>
        {name && <span className="block font-johnson-text text-xs text-jj-gray-05 truncate">{email}</span>}
      </span>
    </span>
  );
}

let lastEditLog = { path: null, at: 0 };

export default function AuditPage({ editable = false, forceSilent = false }) {
  const { user } = useAuth();
  const email = user?.email;
  const { hasRole } = useRBAC();
  const { toast, confirm } = useFeedback();
  const canDelete = editable && hasRole('admin');

  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pageState, setPageState] = useState({ key: '', n: 1 });
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [person, setPerson] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [stats, setStats] = useState(null);
  const [actions, setActions] = useState([]);
  const [uniqueUsers, setUniqueUsers] = useState([]);
  const [active, setActive] = useState(null);
  const [peopleTab, setPeopleTab] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ctrl = useRef(null);

  const q = useDebouncedValue(search.trim(), 350);
  const who = useDebouncedValue(person.trim(), 350);
  const filters = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('search', q);
    if (action) p.set('action', action);
    if (who) p.set('performed_by', who);
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    return p;
  }, [q, action, who, dateFrom, dateTo]);
  const filterKey = filters.toString();
  const page = pageState.key === filterKey ? pageState.n : 1;
  const setPage = (n) => setPageState({ key: filterKey, n: typeof n === 'function' ? n(page) : n });

  useEffect(() => {
    if (!editable) return;
    const path = forceSilent ? '/audit-edit-force' : '/audit-edit';
    if (lastEditLog.path === path && Date.now() - lastEditLog.at < 1500) return;
    lastEditLog = { path, at: Date.now() };
    logAuditEvent('audit_edit_mode_accessed', email, path, forceSilent ? 'Opened audit edit mode (silent deletions)' : 'Opened audit edit mode');
  }, [editable, forceSilent, email]);

  const fetchLogs = useCallback(async (pg) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    try {
      const p = new URLSearchParams(filterKey);
      p.set('page', pg);
      p.set('page_size', PAGE_SIZE);
      const d = await apiJson(`/api/audit/logs?${p}`, { signal: c.signal });
      setLogs(d.logs);
      setTotal(d.total);
      setError(null);
    } catch (e) {
      if (!isAbort(e)) setError(e.message);
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [filterKey]);

  const fetchMeta = useCallback(() => {
    apiJson('/api/audit/stats').then(setStats).catch(() => {});
    apiJson('/api/audit/actions').then((d) => setActions(d.actions)).catch(() => {});
    apiJson('/api/audit/unique-users').then((d) => setUniqueUsers(d.users)).catch(() => {});
  }, []);

  useEffect(() => { setSelected(new Set()); }, [filterKey]);
  useEffect(() => { fetchLogs(page); }, [fetchLogs, page]);
  useEffect(() => { fetchMeta(); }, [fetchMeta]);
  useEffect(() => () => ctrl.current?.abort(), []);
  usePolling(() => apiJson('/api/audit/active-users').then(setActive).catch(() => {}), 30_000);

  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) { firstFilter.current = false; return; }
    logAuditEvent('in-page-audit', email, '', filterKey ? `Filtered audit log: ${decodeURIComponent(filterKey).replace(/&/g, ', ')}` : 'Cleared audit log filters');
  }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const directory = useDirectory(useMemo(() => [
    ...logs.map((l) => l.performed_by),
    ...(peopleTab ? uniqueUsers.slice(0, 60).map((u) => u.email) : []),
    ...(peopleTab ? (active?.users || []).map((u) => u.email) : []),
  ], [logs, uniqueUsers, active, peopleTab]));

  const actionOptions = useMemo(() => {
    const keys = new Set([...Object.keys(ACTION_META), ...actions.map((a) => a.action)]);
    return [...keys].map((k) => ({ key: k, label: actionLabel(k) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [actions]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = !!(search || action || person || dateFrom || dateTo);
  const advancedCount = [person, dateFrom, dateTo].filter(Boolean).length;

  const clearFilters = () => { setSearch(''); setAction(''); setPerson(''); setDateFrom(''); setDateTo(''); };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await apiFetch(`/api/audit/export?${filterKey}`, { timeoutMs: 300_000 });
      if (!res.ok) throw new Error(await errorMessage(res));
      downloadBlob(await res.blob(), `audit_log_${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success('Export downloaded');
    } catch (e) {
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  const remove = async (ids) => {
    const n = ids.length;
    const ok = await confirm({
      title: `Delete ${n} audit entr${n === 1 ? 'y' : 'ies'}?`,
      message: forceSilent ? 'This is permanent and will not be recorded.' : 'This is permanent. The deletion itself is recorded in the audit log.',
      confirmLabel: 'Delete', tone: 'danger',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const silent = forceSilent ? '?silent=true' : '';
      if (n === 1) await apiJson(`/api/audit/logs/${encodeURIComponent(ids[0])}${silent}`, { method: 'DELETE' });
      else await apiJson(`/api/audit/logs${silent}`, { method: 'DELETE', body: { ids } });
      toast.success(`Deleted ${n} entr${n === 1 ? 'y' : 'ies'}`);
      setSelected(new Set());
      fetchLogs(page);
      fetchMeta();
    } catch (e) {
      toast.error(`Delete failed: ${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const selectAllMatching = async () => {
    if (selected.size && selected.size === total) { setSelected(new Set()); return; }
    try {
      const d = await apiJson(`/api/audit/logs/ids?${filterKey}`);
      setSelected(new Set(d.ids));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const openPeople = (tab) => {
    setPeopleTab(tab);
    logAuditEvent('in-page-audit', email, '', `Opened ${tab === 'active' ? 'active users' : 'unique users'} list`);
  };

  return (
    <Page>
      <PageHeader title="Every action," accent="on the record."
        description="Sign-ins, role changes and every operational action across the platform. Search it, slice it, export it."
        chips={(
          <>
            <StatusChip color="#328714" live>Recording · live</StatusChip>
            {active && <StatusChip color="#8c3bbb">{fmtNum(active.count)} active now</StatusChip>}
          </>
        )}
        art={<ClockDial count={fmtNum(stats?.today)} label="Events today" loading={!stats} />}
        actions={(
          <>
            <Button icon="refresh" onClick={() => { fetchLogs(page); fetchMeta(); }} loading={loading}>Refresh</Button>
            <Button variant="dark" icon="download" onClick={exportCsv} loading={exporting}>Export CSV</Button>
          </>
        )} />

      {canDelete && (
        <Alert tone="error" title={forceSilent ? 'Edit mode — silent deletions' : 'Edit mode'}>
          {forceSilent ? 'Deletions are permanent and are not recorded.' : 'Deletions are permanent and are themselves recorded in the audit log.'}
        </Alert>
      )}

      <KpiGrid className="sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile label="Total events" value={fmtNum(stats?.total)} accent="#0f68b2" loading={!stats} />
        <KpiTile label="Today" value={fmtNum(stats?.today)} accent="#328714" loading={!stats} />
        <KpiTile label="Role changes" value={fmtNum(stats?.role_changes)} accent="#eb1700" loading={!stats} />
        <button type="button" onClick={() => openPeople('all')} className="text-left rounded-2xl focus-ring">
          <KpiTile label="Unique users" value={fmtNum(stats?.unique_users)} hint="View list" accent="#8c3bbb" loading={!stats} />
        </button>
        <button type="button" onClick={() => openPeople('active')} className="text-left rounded-2xl focus-ring">
          <KpiTile label="Active now" value={active ? fmtNum(active.count) : '—'} hint={active ? `in the last ${active.timeout_minutes} min · view` : null} accent="#328714" loading={!active} />
        </button>
      </KpiGrid>

      <div className="surface p-3 sm:p-4 flex flex-col gap-3 relative z-10">
        <div className="flex flex-col lg:flex-row lg:items-center gap-2 sm:gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search user, action, target or details" className="flex-1 lg:max-w-md" />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={action} onChange={setAction} label="Action" className="min-w-[12rem]">
              <option value="">All actions</option>
              {actionOptions.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </Select>
            <Button icon="filter" variant={showFilters || advancedCount ? 'dark' : 'secondary'} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
              Filters{advancedCount ? ` · ${advancedCount}` : ''}
            </Button>
            {hasFilters && <Button variant="ghost" icon="close" onClick={clearFilters}>Clear</Button>}
          </div>
        </div>
        {showFilters && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-jj-gray-02">
            <TextField label="User" placeholder="name@its.jnj.com" value={person} onChange={(e) => setPerson(e.target.value)} />
            <TextField label="From" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
            <TextField label="To" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        )}
        {canDelete && (
          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-jj-gray-02">
            <Button size="sm" onClick={selectAllMatching} disabled={!total}>{selected.size && selected.size === total ? 'Clear selection' : `Select all ${fmtNum(total)} matching`}</Button>
            {selected.size > 0 && (
              <>
                <span className="font-johnson-text text-sm text-jj-gray-07">{fmtNum(selected.size)} selected</span>
                <Button size="sm" variant="danger" icon="trash" onClick={() => remove([...selected])} loading={deleting}>Delete selected</Button>
              </>
            )}
          </div>
        )}
      </div>

      {error ? (
        <Alert tone="error" title="Couldn’t load audit events" action={<Button size="sm" onClick={() => fetchLogs(page)}>Retry</Button>}>{error}</Alert>
      ) : (
        <div className="surface overflow-hidden">
          {loading && !logs.length ? (
            <div className="divide-y divide-jj-gray-02">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex gap-4 p-4"><Skeleton className="h-6 w-28" /><Skeleton className="h-6 flex-1" /></div>)}</div>
          ) : !logs.length ? (
            <EmptyState icon="activity" title="No audit events" description={hasFilters ? 'Nothing matches these filters.' : 'Events appear here as people use the platform.'}
              action={hasFilters ? <Button onClick={clearFilters}>Clear filters</Button> : null} />
          ) : (
            <>
              <div className={cx('hidden lg:block overflow-x-auto scroll-thin transition-opacity', loading && 'opacity-60')}>
                <table className="w-full text-sm font-johnson-text">
                  <thead>
                    <tr className="bg-jj-gray-01 border-b border-jj-gray-02 text-left text-xs text-jj-gray-06">
                      {canDelete && <th className="w-10 px-4 py-3"><span className="sr-only">Select</span></th>}
                      <th className="px-4 py-3 font-semibold">Action</th>
                      <th className="px-4 py-3 font-semibold">Performed by</th>
                      <th className="px-4 py-3 font-semibold">Target</th>
                      <th className="px-4 py-3 font-semibold">Details</th>
                      <th className="px-4 py-3 font-semibold whitespace-nowrap">When</th>
                      {canDelete && <th className="w-12 px-4 py-3"><span className="sr-only">Delete</span></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-jj-gray-02">
                    {logs.map((l) => (
                      <tr key={l.id} className={cx('align-top hover:bg-jj-gray-01/70', selected.has(l.id) && 'bg-red-50/50')}>
                        {canDelete && <td className="px-4 py-3"><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} aria-label="Select entry" className="w-4 h-4 accent-jj-red" /></td>}
                        <td className="px-4 py-3 whitespace-nowrap"><ActionBadge action={l.action} /></td>
                        <td className="px-4 py-3 max-w-[16rem]"><Person email={l.performed_by} {...directory} /></td>
                        <td className="px-4 py-3 text-jj-gray-07 max-w-[12rem] break-words">{l.target || '—'}</td>
                        <td className="px-4 py-3 text-jj-gray-07 max-w-xl break-words">{l.details || '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-jj-gray-07"><span title={formatDateTime(l.timestamp)}>{formatDateTime(l.timestamp)}</span></td>
                        {canDelete && <td className="px-2 py-2"><IconButton icon="trash" label="Delete entry" size="sm" onClick={() => remove([l.id])} disabled={deleting} /></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className={cx('lg:hidden divide-y divide-jj-gray-02', loading && 'opacity-60')}>
                {logs.map((l) => (
                  <li key={l.id} className="p-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <ActionBadge action={l.action} />
                      <span className="font-johnson-text text-xs text-jj-gray-05" title={formatDateTime(l.timestamp)}>{relativeTime(l.timestamp)}</span>
                    </div>
                    <Person email={l.performed_by} {...directory} />
                    {l.details && <p className="font-johnson-text text-sm text-jj-gray-07 break-words">{l.details}</p>}
                    {l.target && <p className="font-johnson-text text-xs text-jj-gray-05 break-all">Target: {l.target}</p>}
                    {canDelete && (
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 font-johnson-text text-sm text-jj-gray-07">
                          <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} className="w-4 h-4 accent-jj-red" />Select
                        </label>
                        <Button size="sm" variant="dangerOutline" icon="trash" onClick={() => remove([l.id])} disabled={deleting}>Delete</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-jj-gray-02 bg-jj-gray-01">
                <p className="font-johnson-text text-sm text-jj-gray-06 tabular-nums">
                  {fmtNum((page - 1) * PAGE_SIZE + 1)}–{fmtNum(Math.min(page * PAGE_SIZE, total))} of {fmtNum(total)}
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" icon="chevronLeft" onClick={() => setPage((p) => p - 1)} disabled={page <= 1 || loading}>Previous</Button>
                  <span className="font-johnson-text text-sm text-jj-gray-07 tabular-nums px-1">{page} / {totalPages}</span>
                  <Button size="sm" iconRight="chevronRight" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages || loading}>Next</Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <Drawer open={!!peopleTab} onClose={() => setPeopleTab(null)} title="People"
        description={peopleTab === 'active' ? 'Signed in and active in the last few minutes' : 'Everyone who has appeared in the audit log'}>
        <div className="px-3 pt-2 sticky top-0 bg-white z-10 border-b border-jj-gray-02">
          <Tabs label="People" value={peopleTab || 'all'} onChange={setPeopleTab} className="border-b-0"
            tabs={[{ id: 'all', label: 'All time', count: uniqueUsers.length }, { id: 'active', label: 'Active now', count: active?.count ?? 0 }]} />
        </div>
        {(peopleTab === 'active' ? active?.users || [] : uniqueUsers).length === 0 ? (
          <EmptyState icon="community" title={peopleTab === 'active' ? 'Nobody active right now' : 'No users yet'} />
        ) : (
          <ul className="divide-y divide-jj-gray-02">
            {(peopleTab === 'active' ? active.users : uniqueUsers).map((u) => (
              <li key={u.email}>
                <button type="button" onClick={() => { setPerson(u.email); setShowFilters(true); setPeopleTab(null); }}
                  className="w-full flex items-center justify-between gap-3 px-5 py-3 text-left hover:bg-jj-gray-01 focus-ring-inset">
                  <Person email={u.email} {...directory} size="w-9 h-9" />
                  <span className="flex-shrink-0 text-right font-johnson-text">
                    {u.event_count != null && <span className="block text-sm font-semibold text-jj-gray-08 tabular-nums">{fmtNum(u.event_count)}</span>}
                    <span className="block text-xs text-jj-gray-05">{relativeTime(u.last_activity || u.last_seen)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="px-5 py-3 font-johnson-text text-xs text-jj-gray-05 flex items-center gap-1.5"><Icon name="info" className="w-3.5 h-3.5" />Select a person to filter the log.</p>
      </Drawer>
    </Page>
  );
}
