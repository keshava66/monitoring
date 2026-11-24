import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { useProfilePhoto } from '../context/ProfilePhotoContext';

import userIcon       from "/icons/JJ_Icon_Profile_red.svg";
import timeIcon       from "/icons/JJ_Icon_Time_RGB.svg";
import sessionIcon    from "/icons/JJ_Icon_Slow_RGB.svg";
import statusIcon     from "/icons/JJIM_Icon_Fingernail.svg";
import arrowIcon      from "/icons/JJ_Icon_Chevron_Right.svg";
import calendarIcon   from "/icons/JJ_Icon_Calendar_RGB.svg";
import nasIcon        from "/icons/JJ_Icon_Research_Publications.svg";
import networkIcon    from "/icons/JJ_Icon_Database_RGB.svg";
import auditIcon      from "/icons/JJ_Icon_Stationery_RGB.svg";
import gearIcon       from "/icons/JJ_Icon_Gear_RGB.svg";
import serverIcon     from "/icons/JJ_Icon_Link_RGB.svg";
import serverMgrIcon  from "/icons/JJ_Icon_Application_On_Computer_RGB.svg";

const Icon = ({ src, alt, className = "w-6 h-6", style = {} }) => (
  <img src={src} alt={alt} className={className} style={style} />
);

const RED_ICON_FILTER   = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';
const WHITE_ICON_FILTER = 'brightness(0) invert(1)';
const BORDER_DEFAULT    = '#e8e6e3';

const COLORS = {
  blue:   { hex: '#0f68b2', filter: 'brightness(0) saturate(100%) invert(37%) sepia(93%) saturate(1535%) hue-rotate(189deg) brightness(91%) contrast(101%)' },
  gray:   { hex: '#6e6259', filter: 'brightness(0) saturate(100%) invert(42%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)' },
  green:  { hex: '#328714', filter: 'brightness(0) saturate(100%) invert(35%) sepia(80%) saturate(800%) hue-rotate(85deg) brightness(88%) contrast(95%)' },
  orange: { hex: '#ff6017', filter: 'brightness(0) saturate(100%) invert(48%) sepia(97%) saturate(2446%) hue-rotate(347deg) brightness(102%) contrast(105%)' },
  violet: { hex: '#8c3bbb', filter: 'brightness(0) saturate(100%) invert(29%) sepia(60%) saturate(1500%) hue-rotate(255deg) brightness(85%) contrast(95%)' },
};

// ─── Welcome Banner ────────────────────────────────────────────────────────────
const WelcomeBanner = ({ displayName, displayEmail, currentTime, profilePhoto, photoLoading }) => {
  const getGreeting = () => {
    const hour = currentTime.getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <div className="bg-white rounded-xl overflow-hidden shadow-sm border border-jj-gray-02">
      <div className="flex items-center justify-between px-8 py-6">
        <div className="flex items-center gap-6 min-w-0">
          <div className="flex-shrink-0 relative">
            {photoLoading ? (
              <div className="w-16 h-16 rounded-full bg-jj-gray-02 animate-pulse" />
            ) : profilePhoto ? (
              <img src={profilePhoto} alt={displayName}
                className="w-16 h-16 rounded-full object-cover border-2 border-jj-gray-04" />
            ) : (
              <div className="w-16 h-16 rounded-full flex items-center justify-center bg-jj-gray-01 border-2 border-jj-red">
                <Icon src={userIcon} alt="User" className="w-9 h-9" style={{ filter: RED_ICON_FILTER }} />
              </div>
            )}
            <span className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-jj-green-03 border-2 border-white" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-widest mb-0.5">
              {getGreeting()}
            </p>
            <h1 className="font-johnson-display text-jj-gray-08 truncate"
              style={{ fontSize: '1.75rem', lineHeight: '115%', fontWeight: 400 }}>
              {displayName}
            </h1>
            <p className="text-sm font-johnson-text text-jj-gray-05 mt-0.5 truncate">{displayEmail}</p>
          </div>
        </div>
        <div className="flex-shrink-0 text-right hidden sm:block">
          <div className="inline-flex flex-col items-end gap-1 pl-8 border-l border-jj-gray-03">
            <div className="flex items-center gap-2 text-jj-gray-05">
              <Icon src={calendarIcon} alt="Calendar" className="w-4 h-4" style={{ filter: RED_ICON_FILTER }} />
              <span className="text-xs font-johnson-text uppercase tracking-widest">
                {currentTime.toLocaleDateString('en-US', { weekday: 'long' })}
              </span>
            </div>
            <p className="font-johnson-display text-jj-gray-08 text-2xl" style={{ fontWeight: 300 }}>
              {currentTime.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Status Strip ──────────────────────────────────────────────────────────────
const StatusStrip = ({ currentTime, sessionStart }) => {
  const getCurrentTime = () =>
    currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  const getSessionDuration = () => {
    const duration = Math.floor((currentTime - sessionStart) / 60000);
    if (duration < 1) return 'Just started';
    if (duration === 1) return '1 min';
    if (duration < 60) return `${duration} min`;
    const hours = Math.floor(duration / 60);
    return hours === 1 ? '1 hr' : `${hours} hrs`;
  };

  const stats = [
    { icon: timeIcon,    label: 'Current time',    value: getCurrentTime() },
    { icon: sessionIcon, label: 'Session duration', value: getSessionDuration() },
    { icon: statusIcon,  label: 'Account status',   value: 'Active' },
  ];

  return (
    <div className="bg-white rounded-xl border border-jj-gray-02 shadow-sm overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-jj-gray-02">
        {stats.map((stat, i) => (
          <div key={i} className="flex items-center gap-4 px-6 py-5">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-jj-gray-01">
              <Icon src={stat.icon} alt={stat.label} className="w-5 h-5" style={{ filter: RED_ICON_FILTER }} />
            </div>
            <div>
              <p className="text-xs font-johnson-text text-jj-gray-05 uppercase tracking-wider mb-0.5">
                {stat.label}
              </p>
              <p className="font-johnson-display text-jj-gray-08 text-lg" style={{ fontWeight: 600, lineHeight: '120%' }}>
                {stat.value}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Section Header ────────────────────────────────────────────────────────────
const SectionHeader = ({ title, subtitle }) => (
  <div className="flex items-start gap-4">
    <div className="w-1 self-stretch rounded-full bg-jj-red flex-shrink-0" style={{ minHeight: '2.5rem' }} />
    <div>
      <h2 className="font-johnson-display text-jj-gray-08"
        style={{ fontSize: '1.35rem', fontWeight: 400, lineHeight: '115%' }}>
        {title}
      </h2>
      {subtitle && (
        <p className="font-johnson-text text-jj-gray-05 text-sm mt-1" style={{ lineHeight: '145%' }}>
          {subtitle}
        </p>
      )}
    </div>
  </div>
);

// ─── Tool Card ─────────────────────────────────────────────────────────────────
const ToolCard = ({ title, description, icon, onClick, colorKey }) => {
  const c = COLORS[colorKey] || COLORS.blue;
  return (
    <div
      onClick={onClick}
      className="group bg-white rounded-xl border border-jj-gray-02 shadow-sm hover:shadow-md cursor-pointer overflow-hidden flex flex-col"
      style={{ transition: 'box-shadow 0.2s ease, border-color 0.2s ease' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = c.hex}
      onMouseLeave={e => e.currentTarget.style.borderColor = BORDER_DEFAULT}
    >
      <div className="p-6 flex flex-col flex-1">
        <div className="flex items-start justify-between mb-4">
          <div className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm"
            style={{ background: c.hex }}>
            <Icon src={icon} alt={title} className="w-6 h-6" style={{ filter: WHITE_ICON_FILTER }} />
          </div>
        </div>
        <h3
          className="font-johnson-display text-jj-gray-08 mb-2 transition-colors duration-200"
          style={{ fontSize: '1.1rem', fontWeight: 400, lineHeight: '120%' }}
          onMouseEnter={e => e.currentTarget.style.color = c.hex}
          onMouseLeave={e => e.currentTarget.style.color = ''}
        >
          {title}
        </h3>
        <p className="font-johnson-text text-jj-gray-06 text-sm mb-4" style={{ lineHeight: '155%' }}>
          {description}
        </p>
        <div className="flex-1" />
        <div className="flex items-center gap-1 font-johnson-text font-semibold text-sm"
          style={{ color: c.hex }}>
          <span>Launch</span>
          <Icon src={arrowIcon} alt="Arrow" className="w-4 h-4" style={{ filter: c.filter }} />
        </div>
      </div>
    </div>
  );
};

// ─── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { hasPermission, hasAnyPermission } = useRBAC();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [sessionStart] = useState(new Date());
  const { profilePhoto, photoLoading } = useProfilePhoto();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const rawName      = user?.name || user?.username?.split('@')[0] || 'User';
  const displayName  = rawName.replace(/\s*\[.*?\]\s*/g, '').trim();
  const displayEmail = user?.email || user?.username || '';

  const allTools = [
    {
      id: 'ingestion-stats',
      title: 'Ingestion Stats',
      description: 'Monitor EPOD NAS Drive and RIMDocs S3 extraction and ingestion jobs — track success rates, file sizes, and processing durations.',
      icon: networkIcon, path: '/ingestion-stats',
      permission: 'viewEPODStats', colorKey: 'blue',
    },
    {
      id: 'extraction-pipelines',
      title: 'Extraction Pipelines Monitor',
      description: 'Monitor EPOD and RIMDocs extraction pipelines — track ingestion health, pipeline status, and live job activity.',
      icon: serverIcon, path: '/extraction-pipelines',
      anyPermissions: ['viewEPodQA', 'viewEPodProd'],
      colorKey: 'orange',
    },
    {
      id: 'server-manager',
      title: 'Server Manager',
      description: 'Start, stop, and restart backend and frontend services. Run live terminal commands and tail logs.',
      icon: serverMgrIcon, path: '/server-manager',
      anyPermissions: ['viewServerManagerDev', 'viewServerManagerQA', 'viewServerManagerProd', 'viewServerManagerPOC'],
      colorKey: 'violet',
    },
    {
      id: 'nas-scanner',
      title: 'NAS Scanner',
      description: 'Browse and analyse EPOD NAS archive contents — segment sizes, file type breakdown, largest PDFs, and ingestion trends across 7+ TB of eCTD data.',
      icon: nasIcon, path: '/nas-scanner',
      permission: 'viewNasScanner', colorKey: 'blue',
    },
    {
      id: 'audit',
      title: 'Audit Log',
      description: 'Track all user actions, role changes, login events, and system activity across the platform.',
      icon: auditIcon, path: '/audit',
      permission: 'viewAudit', colorKey: 'gray',
    },
    {
      id: 'user-management',
      title: 'User Management',
      description: 'Manage user roles, permissions, and access controls. Assign AD group mappings and configure role-based access.',
      icon: gearIcon, path: '/user-management',
      permission: 'viewUserManagement', colorKey: 'green',
    },
  ];

  const tools = allTools.filter(t =>
    t.anyPermissions
      ? hasAnyPermission(t.anyPermissions)
      : hasPermission(t.permission)
  );

  return (
    <div className="h-full flex flex-col overflow-auto bg-jj-gray-01">
      <div className="flex flex-col px-8 py-6 gap-5">

        <div className="flex-shrink-0">
          <WelcomeBanner
            displayName={displayName}
            displayEmail={displayEmail}
            currentTime={currentTime}
            profilePhoto={profilePhoto}
            photoLoading={photoLoading}
          />
        </div>

        <div className="flex-shrink-0">
          <StatusStrip currentTime={currentTime} sessionStart={sessionStart} />
        </div>

        <div className="flex-shrink-0 border-t border-jj-gray-02" />

        <div className="flex-shrink-0">
          <SectionHeader title="Applications" subtitle="Select a tool below to get started" />
        </div>

        <div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {tools.map(tool => (
              <ToolCard
                key={tool.id}
                title={tool.title}
                description={tool.description}
                icon={tool.icon}
                colorKey={tool.colorKey}
                onClick={() => navigate(tool.path)}
              />
            ))}
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-jj-gray-02 pt-3 flex items-center justify-center">
          <p className="text-xs font-johnson-text text-jj-gray-04">
            © {new Date().getFullYear()} RDI · Johnson &amp; Johnson
          </p>
        </div>

      </div>
    </div>
  );
}