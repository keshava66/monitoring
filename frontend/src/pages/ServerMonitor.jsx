import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiJson, isAbort } from '../utils/apiClient';
import { logAuditEvent } from '../utils/auditLog';
import { Alert, Button, LoadingBlock, Page, PageHeader, Tabs, usePolling } from '../components/ui';
import { AGENT_STATE } from '../navigation';
import EPodAgentPage from './EPodAgentPage';

const FLEET_POLL_MS = 15_000;

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
const envVar = (id) => id.toUpperCase().replace('-', '_AGENT_');

export default function ServerMonitor() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [agents, setAgents] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [fleet, setFleet] = useState({});
  // The open agent reports its own (fresher, 5 s) state; it wins over the fleet poll.
  const [local, setLocal] = useState({});

  const loadAgents = useCallback(() => {
    setLoadError(null);
    apiJson('/api/agents').then((d) => setAgents(d.agents)).catch((e) => setLoadError(e.message));
  }, []);
  useEffect(() => { loadAgents(); }, [loadAgents]);

  const anyConfigured = !!agents?.some((a) => a.configured);
  const pollFleet = useCallback(async () => {
    try {
      const d = await apiJson('/api/agents/status', { timeoutMs: 12_000 });
      setFleet(Object.fromEntries(d.agents.map((a) => [a.id, a])));
    } catch (e) {
      if (!isAbort(e)) setFleet((f) => Object.fromEntries(Object.keys(f).map((id) => [id, { ...f[id], state: 'unreachable' }])));
    }
  }, []);
  usePolling(pollFleet, FLEET_POLL_MS, { enabled: anyConfigured });

  const envs = useMemo(() => {
    if (!agents) return [];
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    return ENVIRONMENTS.filter((e) => byId[e.id]).map((e) => ({ ...e, ...byId[e.id], title: `${e.product.toUpperCase()} ${e.label}` }));
  }, [agents]);

  const onAgentState = useCallback((id, state) => setLocal((l) => {
    if ((l[id] ?? null) === state) return l;
    const next = { ...l };
    if (state) next[id] = state; else delete next[id];
    return next;
  }), []);

  if (loadError) {
    return (
      <Page>
        <Alert tone="error" title="Couldn’t load pipeline agents" action={<Button size="sm" onClick={loadAgents}>Retry</Button>}>{loadError}</Alert>
      </Page>
    );
  }
  if (!agents) return <LoadingBlock label="Loading pipelines…" />;
  if (!envs.length) return <Navigate to="/dashboard" replace />;

  const stateOf = (e) => (e.configured ? local[e.id] || fleet[e.id]?.state || 'checking' : null);
  const nameOf = (e) => fleet[e.id]?.name || null;
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
  const envTabs = shown.map((e) => {
    const st = AGENT_STATE[stateOf(e)];
    return {
      id: e.id,
      label: e.configured ? (nameOf(e) || e.label) : `${e.label} (not configured)`,
      title: `${e.title}: ${st ? st.label : 'not configured'}`,
      dot: st ? st.color : AGENT_STATE.checking.color,
    };
  });

  const switcher = (
    <>
      {products.length > 1 && (
        <Tabs variant="pill" label="Product" value={active.product}
          tabs={products.map((p) => ({ id: p.id, label: p.label }))}
          onChange={(pid) => select(firstOf(pid).id)} />
      )}
      {envTabs.length > 1 && <Tabs variant="pill" label="Environment" tabs={envTabs} value={active.id} onChange={select} />}
    </>
  );
  if (!active.configured) {
    return (
      <Page>
        <PageHeader title="Extraction" accent="pipelines." chips={switcher}
          description="Start, stop and follow every extraction agent stage by stage, straight from its live terminal stream." />
        <Alert tone="info" title={`${active.title} has no agent configured`}>
          Set {envVar(active.id)}_URL and {envVar(active.id)}_TOKEN on the backend to enable this environment.
        </Alert>
      </Page>
    );
  }
  return (
    <EPodAgentPage key={active.id} agentId={active.id} title={nameOf(active) || active.title}
      canControl={active.can_control} chips={switcher} onState={onAgentState} />
  );
}
