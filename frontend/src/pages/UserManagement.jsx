import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { DIRECTORY_SCOPES } from '../msalConfig';
import { apiJson, cleanDisplayName, graphJson, graphPhoto, isAbort, mapLimit, odata } from '../utils/apiClient';
import { Avatar } from '../components/Header';
import {
  Alert, Badge, Button, Drawer, EmptyState, Icon, IconButton, LoadingBlock, Modal, Page, PageHeader, SearchInput, Select, Skeleton, Tabs, TextField,
  cx, fmtNum, useDebouncedValue, useFeedback,
} from '../components/ui';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_FIELDS = 'id,displayName,mail,userPrincipalName,jobTitle,department';
const userEmail = (u) => (u.mail || u.userPrincipalName || '').toLowerCase();

const walk = (nodes, fn, depth = 0, parent = null) => nodes.forEach((n) => { fn(n, depth, parent); walk(n.children || [], fn, depth + 1, n); });

// ── Data ──────────────────────────────────────────────────────────────────────

function useRbacAdmin() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    try {
      const d = await apiJson('/api/rbac/config');
      setConfig(d.config);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { config, error, reload };
}

function useGraph() {
  const { acquireToken } = useAuth();
  return useCallback(async (fn) => fn(await acquireToken(DIRECTORY_SCOPES)), [acquireToken]);
}

function usePhotos(ids) {
  const withToken = useGraph();
  const [photos, setPhotos] = useState({});
  const key = [...new Set(ids.filter(Boolean))].sort().join(',');
  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    withToken((token) => mapLimit(key.split(','), 6, async (id) => {
      const url = await graphPhoto(id, token);
      if (url && !cancelled) setPhotos((p) => ({ ...p, [id.toLowerCase()]: url }));
    })).catch(() => {});
    return () => { cancelled = true; };
  }, [key, withToken]);
  return photos;
}

// ── Roles ─────────────────────────────────────────────────────────────────────

function RoleBadge({ roleId, roles }) {
  const r = roles[roleId];
  return r ? <Badge color={r.color}>{r.name}</Badge> : <Badge tone="warning">{roleId} (missing)</Badge>;
}

function PermissionTree({ catalog, value, onChange, locked = [] }) {
  const parents = useMemo(() => {
    const out = {};
    walk(catalog, (n, _d, p) => { out[n.key] = p?.key || null; });
    return out;
  }, [catalog]);
  const enabled = (key) => { let p = parents[key]; while (p) { if (!value[p]) return false; p = parents[p]; } return true; };
  const toggle = (node) => {
    const next = !value[node.key];
    const patch = { [node.key]: next };
    if (!next) walk(node.children || [], (c) => { patch[c.key] = false; });
    onChange(patch);
  };
  const render = (nodes, depth) => (
    <ul className={cx('flex flex-col gap-1.5', depth > 0 && 'mt-1.5 ml-4 sm:ml-6 pl-3 border-l-2 border-jj-gray-02')}>
      {nodes.map((n) => {
        const reachable = enabled(n.key);
        const isLocked = locked.includes(n.key);
        const on = !!value[n.key] && reachable;
        return (
          <li key={n.key}>
            <label className={cx('flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
              !reachable || isLocked ? 'opacity-50 cursor-not-allowed bg-jj-gray-01 border-jj-gray-02' : 'cursor-pointer hover:bg-jj-gray-01',
              on ? 'border-jj-red/40 bg-red-50/40' : 'border-jj-gray-02 bg-white')}>
              <input type="checkbox" className="mt-0.5 w-4 h-4 accent-jj-red flex-shrink-0" checked={on} disabled={!reachable || isLocked} onChange={() => toggle(n)} />
              <span className="min-w-0">
                <span className="block font-johnson-text text-sm text-jj-gray-08">{n.label}{isLocked && <span className="ml-2 text-xs text-jj-gray-05">(required for Admin)</span>}</span>
                <span className="block font-johnson-text text-xs text-jj-gray-06">{n.description}</span>
              </span>
            </label>
            {n.children?.length > 0 && render(n.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );
  return render(catalog, 0);
}

const EMPTY_ROLE = { name: '', description: '', color: '#0f68b2', permissions: { viewDashboard: true } };
const slug = (name) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'r_$1').slice(0, 48);

function RoleEditor({ open, roleId, config, onClose, onSaved }) {
  const { toast } = useFeedback();
  const editing = !!roleId;
  const [form, setForm] = useState(() => structuredClone(editing ? config.roles[roleId] : EMPTY_ROLE));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const id = editing ? roleId : slug(form.name);
  const idTaken = !editing && id && config.roles[id];
  const allKeys = useMemo(() => { const k = []; walk(config.permission_catalog, (n) => k.push(n.key)); return k; }, [config]);
  const allOn = allKeys.every((k) => form.permissions[k]);
  const locked = roleId === 'admin' ? config.admin_locked_permissions : [];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing) await apiJson(`/api/rbac/roles/${encodeURIComponent(roleId)}`, { method: 'PUT', body: { role_definition: form } });
      else await apiJson('/api/rbac/roles', { body: { role_id: id, role_definition: form } });
      toast.success(editing ? `Saved ${form.name}` : `Created ${form.name}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title={editing ? `Edit ${config.roles[roleId]?.name || roleId}` : 'Create role'}
      description={editing ? (config.builtin_role_ids.includes(roleId) ? 'Built-in role · changes override the defaults and can be reset later' : 'Custom role') : 'Pick the pages and actions this role can use.'}
      footer={(
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" icon="save" onClick={save} loading={saving} disabled={!form.name.trim() || !id || !!idTaken}>{editing ? 'Save changes' : 'Create role'}</Button>
        </>
      )}>
      <div className="flex flex-col gap-5">
        {error && <Alert tone="error">{error}</Alert>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TextField label="Name" value={form.name} maxLength={64} data-autofocus placeholder="e.g. Pipeline operator" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <TextField label="Role ID" value={id} readOnly hint={editing ? 'Role IDs can’t change' : 'Generated from the name'} error={idTaken ? 'A role with this ID already exists' : null} />
        </div>
        <TextField label="Description" multiline rows={2} maxLength={256} value={form.description} placeholder="What is this role for?" onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        <div className="flex items-center gap-3">
          <label className="font-johnson-text text-xs font-semibold text-jj-gray-07" htmlFor="role-color">Badge colour</label>
          <input id="role-color" type="color" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} className="w-10 h-10 rounded-lg border border-jj-gray-03 p-0.5 cursor-pointer" />
          <Badge color={form.color}>{form.name || 'Preview'}</Badge>
        </div>
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="font-johnson-text text-xs font-semibold text-jj-gray-07">Permissions</p>
            <Button size="xs" variant="ghost" onClick={() => setForm((f) => ({ ...f, permissions: Object.fromEntries(allKeys.map((k) => [k, !allOn || locked.includes(k)])) }))}>
              {allOn ? 'Clear all' : 'Select all'}
            </Button>
          </div>
          <PermissionTree catalog={config.permission_catalog} value={form.permissions} locked={locked}
            onChange={(patch) => setForm((f) => ({ ...f, permissions: { ...f.permissions, ...patch } }))} />
        </div>
      </div>
    </Modal>
  );
}

function RolesTab({ config, reload, canManage }) {
  const { toast, confirm } = useFeedback();
  const [editor, setEditor] = useState({ open: false, roleId: null });
  const labels = useMemo(() => { const l = {}; walk(config.permission_catalog, (n, _d, p) => { l[n.key] = p ? `${p.label} › ${n.label}` : n.label; }); return l; }, [config]);
  const assignments = useMemo(() => {
    const c = {};
    Object.values(config.user_role_overrides).forEach((r) => { c[r] = (c[r] || 0) + 1; });
    return c;
  }, [config]);
  const adGroups = Object.entries(config.ad_group_roles);

  const removeRole = async (roleId) => {
    const role = config.roles[roleId];
    const builtin = config.builtin_role_ids.includes(roleId);
    const ok = await confirm(builtin
      ? { title: `Reset ${role.name}?`, message: 'Custom changes are discarded and the built-in definition is restored.', confirmLabel: 'Reset role', tone: 'danger' }
      : { title: `Delete ${role.name}?`, message: `${assignments[roleId] || 0} user(s) assigned to this role fall back to their AD group role.`, confirmLabel: 'Delete role', tone: 'danger' });
    if (!ok) return;
    try {
      await apiJson(`/api/rbac/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
      toast.success(builtin ? `${role.name} reset` : `${role.name} deleted`);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="font-johnson-text text-sm text-jj-gray-06">{Object.keys(config.roles).length} roles · manual assignments take precedence over AD group mappings.</p>
        {canManage && <Button variant="primary" icon="add" onClick={() => setEditor({ open: true, roleId: null })}>Create role</Button>}
      </div>
      <ul className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
        {Object.entries(config.roles).map(([id, role]) => {
          const builtin = config.builtin_role_ids.includes(id);
          const modified = builtin && config.custom_roles[id];
          const granted = Object.entries(role.permissions).filter(([, v]) => v).map(([k]) => k);
          return (
            <li key={id} className="bg-white rounded-xl border border-jj-gray-02 shadow-card flex flex-col">
              <div className="flex items-start justify-between gap-3 p-4 sm:p-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: role.color }} aria-hidden="true" />
                    <h3 className="font-johnson-display text-lg text-jj-gray-08 truncate">{role.name}</h3>
                    <Badge tone={modified ? 'warning' : builtin ? 'neutral' : 'info'}>{modified ? 'Modified' : builtin ? 'Built-in' : 'Custom'}</Badge>
                  </div>
                  <p className="mt-1 font-johnson-text text-sm text-jj-gray-06 line-clamp-2">{role.description || 'No description'}</p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <IconButton icon="edit" label={`Edit ${role.name}`} size="sm" onClick={() => setEditor({ open: true, roleId: id })} />
                    {(modified || !builtin) && <IconButton icon={builtin ? 'refresh' : 'trash'} label={builtin ? `Reset ${role.name}` : `Delete ${role.name}`} size="sm" onClick={() => removeRole(id)} />}
                  </div>
                )}
              </div>
              <div className="mt-auto px-4 sm:px-5 pb-4 sm:pb-5">
                <p className="font-johnson-text text-xs text-jj-gray-06 mb-2">
                  {granted.length} permission{granted.length === 1 ? '' : 's'} · {fmtNum(assignments[id] || 0)} manual assignment{assignments[id] === 1 ? '' : 's'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {granted.slice(0, 6).map((k) => <span key={k} className="px-2 py-0.5 rounded-md bg-jj-gray-01 border border-jj-gray-02 font-johnson-text text-xs text-jj-gray-07" title={labels[k]}>{labels[k]?.split(' › ').pop() || k}</span>)}
                  {granted.length > 6 && <span className="px-2 py-0.5 rounded-md bg-jj-gray-02 font-johnson-text text-xs text-jj-gray-07" title={granted.slice(6).map((k) => labels[k]).join('\n')}>+{granted.length - 6} more</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <section className="bg-white rounded-xl border border-jj-gray-02 shadow-card overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-jj-gray-02">
          <h3 className="font-johnson-display text-base text-jj-gray-08">AD group mappings</h3>
          <p className="font-johnson-text text-xs text-jj-gray-06">Members of these groups get the role automatically. Configured on the backend (AD_GROUP_*).</p>
        </div>
        {adGroups.length === 0 ? <p className="px-5 py-4 font-johnson-text text-sm text-jj-gray-06">No AD groups are mapped.</p> : (
          <ul className="divide-y divide-jj-gray-02">
            {adGroups.map(([group, roleId]) => (
              <li key={group} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 sm:px-5 py-3">
                <span className="font-mono text-xs sm:text-sm text-jj-gray-07 break-all">{group}</span>
                <RoleBadge roleId={roleId} roles={config.roles} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {editor.open && <RoleEditor key={editor.roleId || 'new'} open roleId={editor.roleId} config={config} onClose={() => setEditor({ open: false, roleId: null })} onSaved={reload} />}
    </div>
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────

function AssignModal({ target, config, onClose, onSaved }) {
  const { toast } = useFeedback();
  const [role, setRole] = useState(target.current || 'viewer');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await apiJson('/api/rbac/user-assignments', { body: { user_email: target.email, role_name: role } });
      toast.success(`${config.roles[role].name} assigned to ${target.name || target.email}`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={target.current ? 'Change role' : 'Assign role'} description={target.name ? `${target.name} · ${target.email}` : target.email}
      footer={<><Button onClick={onClose} disabled={saving}>Cancel</Button><Button variant="primary" onClick={save} loading={saving}>Save</Button></>}>
      <label className="flex flex-col gap-1.5 font-johnson-text text-xs font-semibold text-jj-gray-07">
        Role
        <Select value={role} onChange={setRole} label="Role" className="w-full">
          {Object.entries(config.roles).map(([id, r]) => <option key={id} value={id}>{r.name}</option>)}
        </Select>
      </label>
      <p className="mt-3 font-johnson-text text-xs text-jj-gray-06">A manual assignment overrides any role from AD group membership.</p>
    </Modal>
  );
}

function UserDrawer({ person, config, onClose, onAssign, onRemove, canManage }) {
  const withToken = useGraph();
  const [profile, setProfile] = useState(null);
  const photos = usePhotos(person ? [person.email] : []);
  useEffect(() => {
    if (!person) return undefined;
    let cancelled = false;
    withToken((t) => graphJson(`/users/${encodeURIComponent(person.id || person.email)}?$select=${USER_FIELDS},officeLocation,city,country,companyName,mobilePhone,businessPhones,employeeType,accountEnabled,createdDateTime`, t))
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch(() => { if (!cancelled) setProfile({}); });
    return () => { cancelled = true; };
  }, [person, withToken]);
  if (!person) return null;
  const override = config.user_role_overrides[person.email];
  const role = config.roles[override || 'viewer'];
  const labels = {};
  walk(config.permission_catalog, (n, _d, p) => { labels[n.key] = p ? `${p.label} › ${n.label}` : n.label; });
  const fields = profile ? [
    ['Job title', profile.jobTitle], ['Department', profile.department], ['Company', profile.companyName], ['Office', profile.officeLocation],
    ['Location', [profile.city, profile.country].filter(Boolean).join(', ')], ['Mobile', profile.mobilePhone], ['Phone', profile.businessPhones?.[0]],
    ['Employee type', profile.employeeType], ['Account', profile.accountEnabled == null ? null : profile.accountEnabled ? 'Enabled' : 'Disabled'],
    ['Created', profile.createdDateTime ? new Date(profile.createdDateTime).toLocaleDateString('en-US', { dateStyle: 'medium' }) : null],
  ].filter(([, v]) => v) : [];

  return (
    <Drawer open onClose={onClose} title={person.name || person.email} description={person.email}
      footer={canManage ? (
        <>
          <Button variant="primary" className="flex-1" onClick={onAssign}>{override ? 'Change role' : 'Assign role'}</Button>
          {override && <Button variant="dangerOutline" onClick={onRemove}>Remove</Button>}
        </>
      ) : null}>
      <div className="flex flex-col items-center text-center gap-2 px-5 py-6 bg-jj-gray-01 border-b border-jj-gray-02">
        <Avatar src={photos[person.email]} name={person.name || person.email} className="w-20 h-20 text-xl" />
        <p className="font-johnson-display text-lg text-jj-gray-08">{person.name || person.email}</p>
        {override ? <RoleBadge roleId={override} roles={config.roles} /> : <Badge>No manual role · AD group or Viewer</Badge>}
      </div>
      <div className="px-5 py-5 flex flex-col gap-6">
        <section>
          <h3 className="font-johnson-text text-xs font-semibold text-jj-gray-07 mb-2">Profile</h3>
          {!profile ? <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
            : fields.length === 0 ? <p className="font-johnson-text text-sm text-jj-gray-06">No directory details available.</p> : (
              <dl className="divide-y divide-jj-gray-02 border-y border-jj-gray-02">
                {fields.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 py-2 font-johnson-text text-sm"><dt className="text-jj-gray-06">{k}</dt><dd className="text-jj-gray-08 text-right break-words min-w-0">{v}</dd></div>
                ))}
              </dl>
            )}
        </section>
        {override && role && (
          <section>
            <h3 className="font-johnson-text text-xs font-semibold text-jj-gray-07 mb-2">Access through {role.name}</h3>
            <ul className="flex flex-col gap-1">
              {Object.entries(role.permissions).filter(([, v]) => v).map(([k]) => (
                <li key={k} className="flex items-center gap-2 font-johnson-text text-sm text-jj-gray-07"><Icon name="check" className="w-3.5 h-3.5 text-jj-green-03" />{labels[k] || k}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}

function UsersTab({ config, reload, canManage }) {
  const withToken = useGraph();
  const { toast, confirm } = useFeedback();
  const [mode, setMode] = useState('assigned');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const q = useDebouncedValue(search.trim(), 400);
  const [directory, setDirectory] = useState({ users: [], next: null, stack: [], loading: false, error: null });
  const [details, setDetails] = useState({});
  const [assignTarget, setAssignTarget] = useState(null);
  const [drawer, setDrawer] = useState(null);

  const assigned = useMemo(() => Object.entries(config.user_role_overrides)
    .filter(([, r]) => !roleFilter || r === roleFilter)
    .map(([email, role]) => ({ email, role, ...details[email] }))
    .filter((u) => !q || u.email.includes(q.toLowerCase()) || (u.name || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)), [config, roleFilter, details, q]);

  useEffect(() => {
    const missing = Object.keys(config.user_role_overrides).filter((e) => !details[e]);
    if (!missing.length) return undefined;
    let cancelled = false;
    withToken((t) => mapLimit(missing, 6, async (email) => {
      try {
        const u = await graphJson(`/users/${encodeURIComponent(email)}?$select=${USER_FIELDS}`, t);
        if (!cancelled) setDetails((d) => ({ ...d, [email]: { id: u.id, name: cleanDisplayName(u.displayName), jobTitle: u.jobTitle, department: u.department } }));
      } catch {
        if (!cancelled) setDetails((d) => ({ ...d, [email]: { missing: true } }));
      }
    })).catch(() => {});
    return () => { cancelled = true; };
  }, [config, withToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDirectory = useCallback(async (url, stack) => {
    setDirectory((d) => ({ ...d, loading: true, error: null }));
    try {
      const data = await withToken((t) => graphJson(url, t));
      setDirectory({ users: data.value || [], next: data['@odata.nextLink'] || null, stack, loading: false, error: null, current: url });
    } catch (e) {
      if (!isAbort(e)) setDirectory((d) => ({ ...d, loading: false, error: e.message }));
    }
  }, [withToken]);

  useEffect(() => {
    if (mode !== 'directory') return;
    const s = odata(q);
    const url = q
      ? `/users?$filter=${encodeURIComponent(`startswith(displayName,'${s}') or startswith(mail,'${s}') or startswith(userPrincipalName,'${s}')`)}&$top=25&$select=${USER_FIELDS}`
      : `/users?$top=25&$select=${USER_FIELDS}&$orderby=displayName`;
    loadDirectory(url, []);
  }, [mode, q, loadDirectory]);

  const rows = mode === 'assigned' ? assigned : directory.users.map((u) => ({
    email: userEmail(u), id: u.id, name: cleanDisplayName(u.displayName), jobTitle: u.jobTitle, department: u.department, role: config.user_role_overrides[userEmail(u)],
  }));
  const photos = usePhotos(rows.map((r) => r.email));

  const removeOverride = async (person) => {
    const ok = await confirm({ title: 'Remove manual role?', message: `${person.name || person.email} falls back to their AD group role, or Viewer.`, confirmLabel: 'Remove', tone: 'danger' });
    if (!ok) return;
    try {
      await apiJson(`/api/rbac/user-assignments/${encodeURIComponent(person.email)}`, { method: 'DELETE' });
      toast.success('Manual role removed');
      setDrawer(null);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const loading = mode === 'directory' && directory.loading;

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-card p-3 sm:p-4 flex flex-col lg:flex-row lg:items-center gap-3">
        <Tabs variant="pill" label="User list" value={mode} onChange={setMode}
          tabs={[{ id: 'assigned', label: `Assigned · ${Object.keys(config.user_role_overrides).length}` }, { id: 'directory', label: 'Directory' }]} />
        <SearchInput value={search} onChange={setSearch} placeholder={mode === 'assigned' ? 'Filter by name or email' : 'Search the directory (starts with)'} className="flex-1 lg:max-w-sm" />
        {mode === 'assigned' && (
          <Select value={roleFilter} onChange={setRoleFilter} label="Role filter" className="min-w-[11rem]">
            <option value="">All roles</option>
            {Object.entries(config.roles).map(([id, r]) => <option key={id} value={id}>{r.name}</option>)}
          </Select>
        )}
      </div>

      {mode === 'directory' && directory.error && (
        <Alert tone="error" title="Directory search failed" action={<Button size="sm" onClick={() => loadDirectory(directory.current || '/users?$top=25', directory.stack)}>Retry</Button>}>
          {directory.error}. Signing out and in again usually refreshes directory consent.
        </Alert>
      )}

      <div className="bg-white rounded-xl border border-jj-gray-02 shadow-card overflow-hidden">
        {loading && !rows.length ? <LoadingBlock label="Searching the directory…" /> : rows.length === 0 ? (
          <EmptyState icon="person" title={mode === 'assigned' ? 'No manual assignments' : 'No users found'}
            description={mode === 'assigned' ? 'Switch to Directory to find someone and assign them a role.' : 'Try a different name or email prefix.'} />
        ) : (
          <ul className={cx('divide-y divide-jj-gray-02', loading && 'opacity-60')}>
            {rows.map((u) => (
              <li key={u.email} className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 sm:px-5 py-3 hover:bg-jj-gray-01/70">
                <button type="button" onClick={() => setDrawer(u)} className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-lg focus-ring">
                  <Avatar src={photos[u.email]} name={u.name || u.email} className="w-10 h-10" />
                  <span className="min-w-0">
                    <span className="block font-johnson-text text-sm text-jj-gray-08 truncate">{u.name || (u.missing ? `${u.email} (not in directory)` : u.email)}</span>
                    <span className="block font-johnson-text text-xs text-jj-gray-06 truncate">{[u.email, u.jobTitle, u.department].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
                <div className="flex items-center gap-2 sm:justify-end pl-[3.25rem] sm:pl-0">
                  {u.role ? <RoleBadge roleId={u.role} roles={config.roles} /> : <span className="font-johnson-text text-xs text-jj-gray-05">No manual role</span>}
                  {canManage && <IconButton icon="edit" label={`Change role for ${u.name || u.email}`} size="sm" onClick={() => setAssignTarget({ email: u.email, name: u.name, current: u.role })} />}
                  {canManage && u.role && <IconButton icon="trash" label={`Remove role from ${u.name || u.email}`} size="sm" onClick={() => removeOverride(u)} />}
                </div>
              </li>
            ))}
          </ul>
        )}
        {mode === 'directory' && (directory.next || directory.stack.length > 0) && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-jj-gray-02 bg-jj-gray-01">
            <Button size="sm" icon="chevronLeft" disabled={!directory.stack.length || loading}
              onClick={() => { const s = [...directory.stack]; const prev = s.pop(); loadDirectory(prev, s); }}>Previous</Button>
            <span className="font-johnson-text text-sm text-jj-gray-06">Page {directory.stack.length + 1}</span>
            <Button size="sm" iconRight="chevronRight" disabled={!directory.next || loading}
              onClick={() => loadDirectory(directory.next, [...directory.stack, directory.current])}>Next</Button>
          </div>
        )}
      </div>

      {assignTarget && <AssignModal key={assignTarget.email} target={assignTarget} config={config} onClose={() => setAssignTarget(null)} onSaved={reload} />}
      <UserDrawer key={drawer?.email || 'none'} person={drawer} config={config} canManage={canManage} onClose={() => setDrawer(null)}
        onAssign={() => { setAssignTarget({ email: drawer.email, name: drawer.name, current: config.user_role_overrides[drawer.email] }); setDrawer(null); }}
        onRemove={() => removeOverride(drawer)} />
    </div>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────────

function GroupsTab({ config }) {
  const withToken = useGraph();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [members, setMembers] = useState(null);
  const entries = useMemo(() => Object.entries(config.ad_group_roles), [config]);
  const photos = usePhotos((members || []).map((m) => m.id));

  useEffect(() => {
    let cancelled = false;
    withToken((t) => mapLimit(entries, 4, async ([ref, roleId]) => {
      try {
        const g = GUID_RE.test(ref)
          ? await graphJson(`/groups/${ref}?$select=id,displayName,description,mail`, t)
          : (await graphJson(`/groups?$filter=${encodeURIComponent(`displayName eq '${odata(ref)}'`)}&$select=id,displayName,description,mail`, t)).value?.[0];
        return g ? { ...g, roleId, ref } : { ref, roleId, missing: true };
      } catch {
        return { ref, roleId, missing: true };
      }
    }))
      .then((list) => { if (!cancelled) setGroups(list); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [entries, withToken]);

  const showMembers = async (g) => {
    setOpen(g);
    setMembers(null);
    try {
      const all = [];
      let url = `/groups/${g.id}/members?$select=id,displayName,mail,userPrincipalName,jobTitle&$top=200`;
      while (url && all.length < 2000) {
        const page = await withToken((t) => graphJson(url, t));
        all.push(...(page.value || []));
        url = page['@odata.nextLink'];
      }
      setMembers(all.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '')));
    } catch (e) {
      setMembers([]);
      setError(e.message);
    }
  };

  if (!entries.length) return <EmptyState icon="community" title="No AD groups mapped" description="Set AD_GROUP_ADMIN / AD_GROUP_OPERATIONAL_SUPPORT on the backend to map groups to roles." />;
  if (error && !groups) return <Alert tone="error" title="Couldn’t load groups">{error}</Alert>;
  if (!groups) return <LoadingBlock label="Loading groups…" />;

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {groups.map((g) => (
          <li key={g.ref} className="bg-white rounded-xl border border-jj-gray-02 shadow-card p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <span className="w-11 h-11 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-jj-gray-07 flex items-center justify-center flex-shrink-0"><Icon name="community" className="w-5 h-5" /></span>
            <div className="flex-1 min-w-0">
              <p className="font-johnson-display text-base text-jj-gray-08 break-words">{g.displayName || g.ref}</p>
              <p className="font-johnson-text text-xs text-jj-gray-06 break-words">{g.missing ? 'Not found in the directory' : g.description || g.mail || g.id}</p>
              <div className="mt-2"><RoleBadge roleId={g.roleId} roles={config.roles} /></div>
            </div>
            {!g.missing && <Button size="sm" icon="community" onClick={() => showMembers(g)}>Members</Button>}
          </li>
        ))}
      </ul>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open?.displayName} description={members ? `${fmtNum(members.length)} members` : 'Loading members…'}>
        {!members ? <LoadingBlock /> : members.length === 0 ? <EmptyState icon="community" title="No members" /> : (
          <ul className="divide-y divide-jj-gray-02">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar src={photos[m.id?.toLowerCase()]} name={cleanDisplayName(m.displayName)} className="w-9 h-9" />
                <span className="min-w-0">
                  <span className="block font-johnson-text text-sm text-jj-gray-08 truncate">{cleanDisplayName(m.displayName)}</span>
                  <span className="block font-johnson-text text-xs text-jj-gray-06 truncate">{[m.mail || m.userPrincipalName, m.jobTitle].filter(Boolean).join(' · ')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'users', label: 'Users', icon: 'person' },
  { id: 'roles', label: 'Roles & permissions', icon: 'shield' },
  { id: 'groups', label: 'AD groups', icon: 'community' },
];

export default function UserManagement() {
  const { hasPermission, refresh } = useRBAC();
  const [params, setParams] = useSearchParams();
  const { config, error, reload } = useRbacAdmin();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'users';
  const reloadAll = useCallback(() => { reload(); refresh(); }, [reload, refresh]);

  return (
    <Page>
      <PageHeader icon="gear" title="User management" description="Who can see and do what across the monitoring tools." />
      <Tabs label="User management" tabs={TABS} value={tab} onChange={(id) => setParams({ tab: id }, { replace: true })} />
      {error ? (
        <Alert tone="error" title="Couldn’t load access configuration" action={<Button size="sm" onClick={reload}>Retry</Button>}>{error}</Alert>
      ) : !config ? <LoadingBlock /> : (
        <>
          {tab === 'users' && <UsersTab config={config} reload={reloadAll} canManage={hasPermission('manageUsers')} />}
          {tab === 'roles' && <RolesTab config={config} reload={reloadAll} canManage={hasPermission('manageRoles')} />}
          {tab === 'groups' && <GroupsTab config={config} />}
        </>
      )}
    </Page>
  );
}
