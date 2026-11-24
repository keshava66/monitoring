import React, { useState, useEffect } from 'react';
import { useSearchParams, Navigate } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import EPodAgentPage from './EPodAgentPage';
import { apiFetch } from '../utils/apiClient';

const STATUS_POLL_MS  = 10_000;

// Same status colors as EPodAgentPage's own header dot — keeps the tab bar
// and the page content visually consistent.
const DOT_ONLINE  = '#639922';
const DOT_OFFLINE = '#eb1700';
const DOT_UNKNOWN = '#cbc4bc';

const PRODUCTS = [
  { id: 'rimdocs', label: 'RIMDOCS' },
  { id: 'epod',    label: 'EPOD'    },
];

const ALL_TABS = [
  { id: 'rimdocs-dev',   product: 'rimdocs', label: 'DEV',   permission: 'viewRimdocsDev',   proxyBase: '/rimdocs-dev',   title: 'RIMDOCS DEV',   adminPermission: 'stopScriptRimdocsDev'   },
  { id: 'rimdocs-qa',    product: 'rimdocs', label: 'QA',    permission: 'viewRimdocsQA',    proxyBase: '/rimdocs-qa',    title: 'RIMDOCS QA',    adminPermission: 'stopScriptRimdocsQA'    },
  { id: 'rimdocs-prod',  product: 'rimdocs', label: 'PROD',  permission: 'viewRimdocsProd',  proxyBase: '/rimdocs-prod',  title: 'RIMDOCS PROD',  adminPermission: 'stopScriptRimdocsProd'  },
  { id: 'rimdocs-dev1',  product: 'rimdocs', label: 'DEV1',  permission: 'viewRimdocsDev1',  proxyBase: '/rimdocs-dev1',  title: 'RIMDOCS DEV1',  adminPermission: 'stopScriptRimdocsDev1'  },
  { id: 'rimdocs-dev2',  product: 'rimdocs', label: 'DEV2',  permission: 'viewRimdocsDev2',  proxyBase: '/rimdocs-dev2',  title: 'RIMDOCS DEV2',  adminPermission: 'stopScriptRimdocsDev2'  },
  { id: 'rimdocs-qa2',   product: 'rimdocs', label: 'QA2',   permission: 'viewRimdocsQA2',   proxyBase: '/rimdocs-qa2',   title: 'RIMDOCS QA2',   adminPermission: 'stopScriptRimdocsQA2'   },
  { id: 'rimdocs-prod2', product: 'rimdocs', label: 'PROD2', permission: 'viewRimdocsProd2', proxyBase: '/rimdocs-prod2', title: 'RIMDOCS PROD2', adminPermission: 'stopScriptRimdocsProd2' },
  { id: 'epod-dev',      product: 'epod',    label: 'DEV',   permission: 'viewEPodDev',      proxyBase: '/epod-dev',      title: 'EPOD DEV',      adminPermission: 'stopScriptDev'          },
  { id: 'epod-qa',       product: 'epod',    label: 'QA',    permission: 'viewEPodQA',       proxyBase: '/epod-qa',       title: 'EPOD QA',       adminPermission: 'stopScriptQA'           },
  { id: 'epod-prod',     product: 'epod',    label: 'PROD',  permission: 'viewEPodProd',     proxyBase: '/epod-prod',     title: 'EPOD PROD',     adminPermission: 'stopScriptProd'         },
];

export default function ServerMonitor() {
  const { hasPermission } = useRBAC();
  const { user } = useAuth();
  const email = user?.email || user?.username || 'unknown';
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs     = ALL_TABS.filter(t => hasPermission(t.permission));
  const products = PRODUCTS.filter(p => tabs.some(t => t.product === p.id));

  // Initialise from the URL, falling back to the first permitted tab.
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get('tab');
    if (tabs.some(t => t.id === tab)) return tab;
    return tabs[0]?.id ?? '';
  });

  const handleTabChange = (id) => {
    if (id === activeTab) return;
    const fromTitle = ALL_TABS.find(t => t.id === activeTab)?.title ?? activeTab;
    const toTitle   = ALL_TABS.find(t => t.id === id)?.title ?? id;
    logAuditEvent('in-page-extraction-pipelines', email, id, `Switched from ${fromTitle} to ${toTitle} on Extraction Pipelines Monitor`);
    setActiveTab(id);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    });
  };

  // Switching product jumps to the first permitted environment within it.
  const handleProductChange = (productId) => {
    const firstTab = tabs.find(t => t.product === productId);
    if (firstTab) handleTabChange(firstTab.id);
  };

  // Poll /status for every permitted tab so the dot reflects real state —
  // independent of which tab is actually open, so switching products shows
  // correct dots immediately instead of "unknown" until clicked.
  const [statusMap, setStatusMap] = useState({}); // { [tabId]: true | false | null }
  const [nameMap,   setNameMap]   = useState({}); // { [tabId]: server_name from /info }

  useEffect(() => {
    let cancelled = false;
    const controllers   = new Set();
    const namesFetched  = new Set(); // server_name is static config — fetch once per tab, not every poll

    // Fire each tab's check independently — a slow/unreachable agent only
    // leaves its OWN dot gray, instead of Promise.all holding back every
    // dot until the slowest one resolves.
    const pollOne = async (t) => {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const r = await apiFetch(`${t.proxyBase}/status`, { signal: controller.signal });
        const running = r.ok ? !!(await r.json()).running : null;
        if (!cancelled) setStatusMap(prev => ({ ...prev, [t.id]: running }));

        if (running === true && !namesFetched.has(t.id)) {
          namesFetched.add(t.id);
          apiFetch(`${t.proxyBase}/info`, { signal: controller.signal })
            .then(res => res.ok ? res.json() : null)
            .then(d => {
              if (d?.server_name && !cancelled) {
                setNameMap(prev => ({ ...prev, [t.id]: d.server_name }));
              } else {
                namesFetched.delete(t.id); // fetch failed — retry on a later poll
              }
            })
            .catch(() => namesFetched.delete(t.id));
        }
      } catch {
        if (!cancelled) setStatusMap(prev => ({ ...prev, [t.id]: null }));
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    };

    const pollAll = () => {
      ALL_TABS.filter(t => hasPermission(t.permission)).forEach(pollOne);
    };

    pollAll();
    const id = setInterval(pollAll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      controllers.forEach(c => c.abort());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync state when the browser navigates back/forward.
  useEffect(() => {
    const tab = searchParams.get('tab');
    const resolved = tabs.some(t => t.id === tab) ? tab : tabs[0]?.id ?? '';
    if (resolved !== activeTab) {
      setActiveTab(resolved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // No permitted tabs — redirect to dashboard.
  if (tabs.length === 0) return <Navigate to="/dashboard" replace />;

  // Active tab is no longer permitted (e.g. role changed) — snap to first.
  const safeTab       = tabs.some(t => t.id === activeTab) ? activeTab : tabs[0].id;
  const activeConfig  = ALL_TABS.find(t => t.id === safeTab);
  const activeProduct = activeConfig?.product;
  const envTabs        = tabs.filter(t => t.product === activeProduct);

  return (
    <div className="flex flex-col h-full">
      {/* Product Switch */}
      {products.length > 1 && (
        <div className="flex items-center gap-3 px-6 pt-4 pb-3 bg-white">
          <div className="w-1 h-4 rounded-full bg-jj-red flex-shrink-0" />
          <div className="inline-flex bg-jj-gray-01 rounded-full p-1">
            {products.map(p => (
              <button
                key={p.id}
                onClick={() => handleProductChange(p.id)}
                className={`px-4 py-1.5 rounded-full text-xs font-johnson-text font-semibold tracking-wide transition-colors duration-200 ${
                  activeProduct === p.id
                    ? 'bg-jj-red text-white'
                    : 'text-jj-gray-06 hover:text-jj-gray-08'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Environment Tabs */}
      <div className="flex items-center border-b border-jj-gray-03 bg-white px-6 sticky top-0 z-10 overflow-x-auto">
        {envTabs.map((tab, i) => {
          const running     = statusMap[tab.id];
          const dotColor    = running === true ? DOT_ONLINE : running === false ? DOT_OFFLINE : DOT_UNKNOWN;
          const dotLabel    = running === true ? 'Online' : running === false ? 'Offline' : 'Checking…';
          const displayName = running === true && nameMap[tab.id] ? nameMap[tab.id] : tab.label;
          const isActive    = safeTab === tab.id;
          return (
            <React.Fragment key={tab.id}>
              {i > 0 && (
                <span className="text-jj-red text-2xl font-bold select-none flex-shrink-0 leading-none" style={{ transform: 'rotate(15deg)', display: 'inline-block', opacity: 0.5 }}>/</span>
              )}
              <button
                onClick={() => handleTabChange(tab.id)}
                title={`${tab.title} — ${dotLabel}`}
                className={`flex items-center gap-1.5 px-5 py-3 font-johnson-text text-sm font-medium whitespace-nowrap transition-colors duration-200 border-b-2 -mb-px ${
                  isActive
                    ? 'border-jj-red text-jj-red'
                    : 'border-transparent text-jj-gray-06 hover:text-jj-gray-08 hover:border-jj-gray-04'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                {displayName}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {activeConfig && (
          <EPodAgentPage
            key={activeConfig.id}
            proxyBase={activeConfig.proxyBase}
            title={activeConfig.title}
            adminPermission={activeConfig.adminPermission}
          />
        )}
      </div>
    </div>
  );
}