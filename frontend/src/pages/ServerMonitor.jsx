import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiJson } from '../utils/apiClient';
import { logAuditEvent } from '../utils/auditLog';
import { Alert, Button, LoadingBlock, Tabs, usePolling } from '../components/ui';
import EPodAgentPage from './EPodAgentPage';

const STATUS_POLL_MS = 10_000;
const DOT = { online: '#328714', offline: '#eb1700', unknown: '#cbc4bc' };

const ENVIRONMENTS = [
  { id: 'rimdocs-dev', product: 'rimdocs', label: 'DEV' },
  { id: 'rimdocs-qa', product: 'rimdocs', label: 'QA' },
  { id: 'rimdocs-prod', product: 'rimdocs', label: 'PROD' },
  { id: 'rimdocs-dev1', product: 'rimdocs', label: 'DEV1' },
  { id: 'rimdocs-dev2', product: 'rimdocs', label: 'DEV2' },
  { id: 'rimdocs-qa2', product: 'rimdocs', label: 'QA2' },
  { id: 'rimdocs-prod2', product: 'rimdocs', label: 'PROD2' },
  { id: 'epod-dev', product: 'epod', label: 'DEV' },
  { id: 'epod-qa', product: 'epod', label: 'QA' },
  { id: 'epod-prod', product: 'epod', label: 'PROD' },
];
const PRODUCTS = [{ id: 'rimdocs', label: 'RIMDOCS' }, { id: 'epod', label: 'EPOD' }];

export default function ServerMonitor() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [agents, setAgents] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [status, setStatus] = useState({});
  const [names, setNames] = useState({});

  const loadAgents = useCallback(() => {
    setLoadError(null);
    apiJson('/api/agents').then((d) => setAgents(d.agents)).catch((e) => setLoadError(e.message));
  }, []);
  useEffect(() => { loadAgents(); }, [loadAgents]);

  const envs = useMemo(() => {
    if (!agents) return [];
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    return ENVIRONMENTS.filter((e) => byId[e.id]).map((e) => ({ ...e, ...byId[e.id], title: `${e.product.toUpperCase()} ${e.label}` }));
  }, [agents]);

  const poll = useCallback(() => {
    envs.filter((e) => e.configured).forEach((e) => {
      apiJson(`/${e.id}/status`, { timeoutMs: 8000 })
        .then((d) => setStatus((s) => ({ ...s, [e.id]: d.running ? 'online' : 'offline' })))
        .catch(() => setStatus((s) => ({ ...s, [e.id]: 'unknown' })));
    });
  }, [envs]);
  usePolling(poll, STATUS_POLL_MS, { enabled: envs.length > 0 });

  useEffect(() => {
    envs.filter((e) => e.configured && !names[e.id]).forEach((e) => {
      apiJson(`/${e.id}/info`, { timeoutMs: 8000 }).then((d) => d?.server_name && setNames((n) => ({ ...n, [e.id]: d.server_name }))).catch(() => {});
    });
  }, [envs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <Alert tone="error" title="Couldn’t load pipeline agents" action={<Button size="sm" onClick={loadAgents}>Retry</Button>}>{loadError}</Alert>
      </div>
    );
  }
  if (!agents) return <LoadingBlock label="Loading pipelines…" />;
  if (!envs.length) return <Navigate to="/dashboard" replace />;

  const firstOf = (product) => envs.find((e) => e.configured && (!product || e.product === product)) || envs.find((e) => !product || e.product === product);
  const active = envs.find((e) => e.id === params.get('tab')) || firstOf();
  const products = PRODUCTS.filter((p) => envs.some((e) => e.product === p.id));
  const select = (id) => {
    if (id === active.id) return;
    const to = envs.find((e) => e.id === id);
    logAuditEvent('in-page-extraction-pipelines', user?.email, id, `Switched from ${active.title} to ${to.title} on Extraction Pipelines`);
    setParams((prev) => { const n = new URLSearchParams(prev); n.set('tab', id); n.delete('view'); return n; });
  };

  // Unconfigured environments only get a tab when the product has nothing else to show.
  const productEnvs = envs.filter((e) => e.product === active.product);
  const shown = productEnvs.some((e) => e.configured) ? productEnvs.filter((e) => e.configured || e.id === active.id) : productEnvs;
  const envTabs = shown.map((e) => ({
    id: e.id,
    label: e.configured ? (names[e.id] || e.label) : `${e.label} (not configured)`,
    title: `${e.title}: ${e.configured ? status[e.id] || 'checking' : 'not configured'}`,
    dot: e.configured ? DOT[status[e.id] || 'unknown'] : DOT.unknown,
  }));

  return (
    <div className="flex flex-col min-h-full">
      <div className="sticky top-0 z-20 bg-white border-b border-jj-gray-02">
        <div className="flex flex-col gap-2 md:flex-row md:items-center px-3 sm:px-6 pt-3 md:pt-0">
          {products.length > 1 && (
            <Tabs variant="pill" label="Product" value={active.product}
              tabs={products.map((p) => ({ id: p.id, label: p.label }))}
              onChange={(pid) => select(firstOf(pid).id)} className="self-start shrink-0 md:mr-4 md:my-2" />
          )}
          <Tabs label="Environment" tabs={envTabs} value={active.id} onChange={select} className="border-b-0 -mx-1 md:mx-0" />
        </div>
      </div>
      {active.configured ? (
        <EPodAgentPage key={active.id} agentId={active.id} title={names[active.id] || active.title} canControl={active.can_control} />
      ) : (
        <div className="p-4 sm:p-6 lg:p-8">
          <Alert tone="info" title={`${active.title} has no agent configured`}>
            Set {active.id.toUpperCase().replace('-', '_AGENT_')}_URL and _TOKEN on the backend to enable this environment.
          </Alert>
        </div>
      )}
    </div>
  );
}
