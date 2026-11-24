export const PIPELINE_VIEW_PERMISSIONS = [
  'viewRimdocsDev', 'viewRimdocsQA', 'viewRimdocsProd', 'viewRimdocsDev1', 'viewRimdocsDev2',
  'viewRimdocsQA2', 'viewRimdocsProd2', 'viewEPodDev', 'viewEPodQA', 'viewEPodProd',
];
export const SERVER_MANAGER_PERMISSIONS = ['viewServerManagerDev', 'viewServerManagerQA', 'viewServerManagerProd', 'viewServerManagerPOC'];
export const STATS_PERMISSIONS = ['viewEPODStatsEPOD', 'viewEPODStatsRIMDOCS'];

export const NAV_ITEMS = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', permission: 'viewDashboard' },
  { path: '/ingestion-stats', label: 'Ingestion Stats', icon: 'database', anyPermissions: STATS_PERMISSIONS,
    description: 'EPOD NAS and RIMDocs S3 ingestion jobs: success rates, sizes, durations and stalls.', color: '#0f68b2' },
  { path: '/extraction-pipelines', label: 'Extraction Pipelines', icon: 'link', anyPermissions: PIPELINE_VIEW_PERMISSIONS,
    description: 'Live status, terminal output and stage-by-stage progress for every pipeline agent.', color: '#ff6017' },
  { path: '/server-manager', label: 'Server Manager', icon: 'server', anyPermissions: SERVER_MANAGER_PERMISSIONS,
    description: 'Start, stop and restart services, pull code, tail logs and open a terminal.', color: '#8c3bbb' },
  { path: '/nas-scanner', label: 'NAS Scanner', icon: 'archive', permission: 'viewNasScanner',
    description: 'EPOD archive segments, file-type mix, largest PDFs and scan trends.', color: '#004685' },
  { path: '/audit', label: 'Audit Log', icon: 'audit', permission: 'viewAudit',
    description: 'Every sign-in, role change and pipeline action, searchable and exportable.', color: '#6e6259' },
  { path: '/user-management', label: 'User Management', icon: 'gear', permission: 'viewUserManagement',
    description: 'Roles, permissions, AD group mappings and per-user assignments.', color: '#328714' },
];

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
