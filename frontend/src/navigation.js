export const PIPELINE_VIEW_PERMISSIONS = [
  'viewRimdocsDev', 'viewRimdocsQA', 'viewRimdocsProd', 'viewRimdocsDev1', 'viewRimdocsDev2',
  'viewRimdocsQA2', 'viewRimdocsProd2', 'viewEPodDev', 'viewEPodQA', 'viewEPodProd',
];
export const SERVER_MANAGER_PERMISSIONS = ['viewServerManagerDev', 'viewServerManagerQA', 'viewServerManagerProd', 'viewServerManagerPOC'];
export const STATS_PERMISSIONS = ['viewEPODStatsEPOD', 'viewEPODStatsRIMDOCS'];

const MANAGE_LEGACY_URL = import.meta.env.VITE_MANAGE_API_URL || '';
/** Server Manager hosts configured for this build, one per environment. */
export const MANAGE_SERVERS = [
  { id: 'dev', label: 'DEV', alias: 'SmartHub DEV', permission: 'viewServerManagerDev', admin: 'adminAccessDev', url: import.meta.env.VITE_MANAGE_API_DEV_URL || MANAGE_LEGACY_URL },
  { id: 'qa', label: 'QA', alias: 'SmartHub QA', permission: 'viewServerManagerQA', admin: 'adminAccessQA', url: import.meta.env.VITE_MANAGE_API_QA_URL || MANAGE_LEGACY_URL },
  { id: 'prod', label: 'PROD', alias: 'SmartHub PROD', permission: 'viewServerManagerProd', admin: 'adminAccessProd', url: import.meta.env.VITE_MANAGE_API_PROD_URL || MANAGE_LEGACY_URL },
  { id: 'poc', label: 'POC', alias: 'SmartHub POC', permission: 'viewServerManagerPOC', admin: 'adminAccessPOC', url: import.meta.env.VITE_MANAGE_API_POC_URL || MANAGE_LEGACY_URL },
].filter((s) => s.url).map((s) => {
  const target = s.url.replace(/\/$/, '');
  // In `npm run dev` requests go through Vite's proxy (vite.config.js), so a
  // local session needs neither the manager's CORS allow-list nor a trusted
  // certificate. Built bundles talk to the manager directly.
  return { ...s, target, url: import.meta.env.DEV ? `${window.location.origin}/__manage/${s.id}` : target };
});

export const NAV_ITEMS = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', permission: 'viewDashboard', group: 'Workspace', color: '#eb1700' },
  { path: '/ingestion-stats', group: 'Operations', label: 'Ingestion Stats', icon: 'database', anyPermissions: STATS_PERMISSIONS,
    description: 'EPOD NAS and RIMDocs S3 ingestion jobs: success rates, sizes, durations and stalls.', color: '#0f68b2' },
  { path: '/extraction-pipelines', group: 'Operations', label: 'Extraction Pipelines', icon: 'link', anyPermissions: PIPELINE_VIEW_PERMISSIONS,
    description: 'Live status, terminal output and stage-by-stage progress for every pipeline agent.', color: '#ff6017' },
  { path: '/server-manager', group: 'Operations', label: 'Server Manager', icon: 'server', anyPermissions: SERVER_MANAGER_PERMISSIONS,
    description: 'Start, stop and restart services, pull code, tail logs and open a terminal.', color: '#8c3bbb' },
  { path: '/nas-scanner', group: 'Operations', label: 'NAS Scanner', icon: 'archive', permission: 'viewNasScanner',
    description: 'EPOD archive segments, file-type mix, largest PDFs and scan trends.', color: '#004685' },
  { path: '/audit', group: 'Admin', label: 'Audit Log', icon: 'audit', permission: 'viewAudit',
    description: 'Every sign-in, role change and pipeline action, searchable and exportable.', color: '#6e6259' },
  { path: '/user-management', group: 'Admin', label: 'User Management', icon: 'gear', permission: 'viewUserManagement',
    description: 'Roles, permissions, AD group mappings and per-user assignments.', color: '#328714' },
];

export const NAV_GROUPS = ['Workspace', 'Operations', 'Admin'];

export const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/ingestion-stats': 'Ingestion Stats',
  '/extraction-pipelines': 'Extraction Pipelines',
  '/server-manager': 'Server Manager',
  '/nas-scanner': 'NAS Scanner',
  '/audit': 'Audit Log',
  '/audit-edit': 'Audit Log (Edit Mode)',
  '/audit-edit-force': 'Audit Log (Edit Mode)',
  '/user-management': 'User Management',
};

/** Pipeline agent states shared by the environment tabs and the agent page. */
export const AGENT_STATE = {
  running: { label: 'Running', color: '#328714' },
  stopped: { label: 'Stopped', color: '#857a73' },
  unreachable: { label: 'Unreachable', color: '#eb1700' },
  checking: { label: 'Checking…', color: '#cbc4bc' },
};
