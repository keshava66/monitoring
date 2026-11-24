/* Shared design-system primitives, formatters and hooks used by every page. */
import React, {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';

export const cx = (...parts) => parts.filter(Boolean).join(' ');

// ── Formatters ────────────────────────────────────────────────────────────────

export const fmtNum = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));

export const fmtCompact = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n));
};

export const fmtBytes = (b) => {
  if (b == null || Number.isNaN(Number(b))) return '—';
  let v = Number(b);
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (Math.abs(v) < 1024 || unit === 'TB') return unit === 'B' ? `${Math.round(v)} B` : `${v.toFixed(2)} ${unit}`;
    v /= 1024;
  }
  return '—';
};

export const fmtPct = (ratio, digits = 1) => (ratio == null ? '—' : `${(Number(ratio) * 100).toFixed(digits)}%`);

export const formatDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export const relativeTime = (iso) => {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** Calls fn every `ms` while enabled and the tab is visible; refires on return. */
export function usePolling(fn, ms, { enabled = true, immediate = true } = {}) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);
  useEffect(() => {
    if (!enabled || !ms) return undefined;
    let timer = null;
    const tick = () => { if (document.visibilityState === 'visible') fnRef.current(); };
    const start = () => { clearInterval(timer); timer = setInterval(tick, ms); };
    const onVisibility = () => { if (document.visibilityState === 'visible') { tick(); start(); } };
    if (immediate) tick();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, ms, immediate]);
}

export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Client-side sorting. `getters` maps a sort key to a value accessor. */
export function useSortedRows(rows, defaultKey, { defaultAsc = true, getters = {} } = {}) {
  const [sort, setSort] = useState({ key: defaultKey, asc: defaultAsc });
  const toggle = useCallback((key) => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true })), []);
  const sorted = useMemo(() => {
    if (!rows?.length) return [];
    const get = getters[sort.key] || ((r) => r[sort.key]);
    const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb));
      return sort.asc ? cmp : -cmp;
    });
  }, [rows, sort, getters]);
  return { sorted, sort, toggle };
}

// ── Icons ─────────────────────────────────────────────────────────────────────
// Brand SVGs rendered as CSS masks so they inherit currentColor.

const ICONS = {
  dashboard: 'JJ_Icon_Dashboard_RGB', database: 'JJ_Icon_Database_RGB', link: 'JJ_Icon_Link_RGB',
  server: 'JJ_Icon_Application_On_Computer_RGB', archive: 'JJ_Icon_Research_Publications',
  audit: 'JJ_Icon_Stationery_RGB', gear: 'JJ_Icon_Gear_RGB', logout: 'JJ_Icon_Log_Out_RGB',
  login: 'JJ_Icon_Login_RGB', chevronDown: 'JJ_Icon_Chevron_Down', chevronLeft: 'JJ_Icon_Chevron_Left',
  chevronRight: 'JJ_Icon_Chevron_Right', close: 'JJ_Icon_Close', refresh: 'JJ_Icon_Refresh_RGB',
  sync: 'JJ_Icon_Refresh_Sync_RGB', play: 'JJ_Icon_Video_Play_RGB', alert: 'JJ_Icon_Alert_RGB',
  info: 'JJ_Icon_Info_RGB', check: 'JJ_Icon_Check_RGB', search: 'JJ_Icon_Search_RGB', filter: 'JJ_Icon_Filter',
  download: 'JJ_Icon_Download_PDF_RGB', person: 'JJ_Icon_Person_RGB', profile: 'JJ_Icon_Profile_red',
  community: 'JJ_Icon_Community_RGB', shield: 'JJ_Icon_Shield_RGB', safety: 'JJ_Icon_Safety',
  time: 'JJ_Icon_Time_RGB', timer: 'JJ_Icon_Timer_RGB', calendar: 'JJ_Icon_Calendar_RGB',
  remove: 'JJ_Icon_Remove', trash: 'JJ_Icon_Delete_RGB', edit: 'JJ_Icon_Edit_RGB', add: 'JJ_Icon_Add',
  save: 'JJ_Icon_Save_RGB', records: 'JJ_Icon_Records_Information_RGB', globe: 'JJ_Icon_Globe_RGB',
  mail: 'JJ_Icon_Communication_RGB', phone: 'JJ_Icon_Phone_RGB', office: 'JJ_Icon_Office_RGB',
  user: 'JJ_Icon_user_black', chart: 'JJ_Icon_Graph_Chart_RGB', analysis: 'JJ_Icon_Analysis_RGB',
  activity: 'JJIM_Icon_Fingernail', slow: 'JJ_Icon_Slow_RGB', lock: 'JJ_Icon_Lock_black',
  sort: 'JJ_Icon_Sort', network: 'JJ_Icon_Network_RGB', data: 'JJ_Icon_Data_Visualization',
  menu: 'JJ_Icon_Unfold_All_More', help: 'JJ_Icon_Help', error: 'JJ_Icon_New_Error',
};

export function Icon({ name, className = 'w-4 h-4', label, style }) {
  const file = ICONS[name] || name;
  const url = `url("/icons/${file}.svg")`;
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx('inline-block flex-shrink-0 bg-current', className)}
      style={{ WebkitMaskImage: url, maskImage: url, WebkitMaskSize: 'contain', maskSize: 'contain', WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', WebkitMaskPosition: 'center', maskPosition: 'center', ...style }}
    />
  );
}

// ── Buttons ───────────────────────────────────────────────────────────────────

const BTN_BASE = 'inline-flex items-center justify-center gap-2 font-johnson-text font-medium rounded-xl transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out select-none whitespace-nowrap active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-ring';
const BTN_VARIANTS = {
  primary: 'bg-jj-red text-white shadow-glow hover:bg-[#d41500] hover:shadow-glow-lg',
  secondary: 'bg-white text-jj-gray-08 border border-jj-gray-02 shadow-[0_8px_20px_-16px_rgba(49,44,42,0.6)] hover:border-jj-gray-04',
  ghost: 'text-jj-gray-07 hover:bg-white hover:text-jj-gray-08',
  danger: 'bg-jj-red text-white shadow-glow hover:bg-[#d41500]',
  dangerOutline: 'bg-white text-jj-red border border-jj-red/40 hover:border-jj-red hover:bg-red-50/60',
  dark: 'bg-jj-gray-08 text-white shadow-[0_10px_24px_-12px_rgba(49,44,42,0.8)] hover:bg-[#1f1b18]',
};
const BTN_SIZES = { xs: 'h-7 px-2.5 text-xs rounded-lg', sm: 'h-9 px-3.5 text-[13px]', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-[15px]' };

export const Button = React.forwardRef(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading = false, className, children, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={cx(BTN_BASE, BTN_VARIANTS[variant], BTN_SIZES[size], className)} {...rest}>
      {loading ? <Spinner className="w-4 h-4" /> : icon && <Icon name={icon} className={size === 'xs' || size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      {children}
      {iconRight && <Icon name={iconRight} className="w-3.5 h-3.5" />}
    </button>
  );
});

export function IconButton({ icon, label, variant = 'ghost', size = 'md', className, iconClassName, ...rest }) {
  const dims = { sm: 'w-9 h-9', md: 'w-10 h-10' }[size];
  return (
    <button type="button" aria-label={label} title={label} className={cx(BTN_BASE, BTN_VARIANTS[variant], dims, 'px-0', className)} {...rest}>
      <Icon name={icon} className={iconClassName || 'w-4 h-4'} />
    </button>
  );
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export function Spinner({ className = 'w-5 h-5', label }) {
  return (
    <span role={label ? 'status' : undefined} aria-label={label} className={cx('inline-block rounded-full border-2 border-current border-t-transparent animate-spin opacity-80', className)} />
  );
}

export function Skeleton({ className = 'h-4 w-24' }) {
  return (
    <span aria-hidden="true" className={cx('relative block overflow-hidden rounded-md bg-jj-gray-02/80', className)}>
      <span className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/70 to-transparent animate-shimmer" />
    </span>
  );
}

const TONES = {
  error: { box: 'bg-[#fff6f4] border-jj-red/20 text-jj-maroon-05', icon: 'alert', iconColor: 'text-jj-red', ring: 'bg-jj-red/10' },
  warning: { box: 'bg-[#fffaf0] border-amber-300/50 text-amber-900', icon: 'alert', iconColor: 'text-amber-600', ring: 'bg-amber-500/10' },
  info: { box: 'bg-[#f5f9fd] border-jj-blue-03/20 text-jj-blue-05', icon: 'info', iconColor: 'text-jj-blue-03', ring: 'bg-jj-blue-03/10' },
  success: { box: 'bg-[#f6fbf3] border-jj-green-03/20 text-jj-green-05', icon: 'check', iconColor: 'text-jj-green-03', ring: 'bg-jj-green-03/10' },
};

export function Alert({ tone = 'info', title, children, action, className }) {
  const t = TONES[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-3 rounded-2xl border px-4 py-3.5 animate-rise', t.box, className)}>
      <span className={cx('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0', t.ring)}>
        <Icon name={t.icon} className={cx('w-4 h-4', t.iconColor)} />
      </span>
      <div className="flex-1 min-w-0 font-johnson-text text-sm pt-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx(title && 'mt-0.5', 'opacity-90 break-words')}>{children}</div>}
      </div>
      {action && <div className="flex-shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({ icon = 'info', title, description, action, className }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center px-6 py-14', className)}>
      <span className="relative w-24 h-24 mb-5 flex items-center justify-center" aria-hidden="true">
        <span className="absolute inset-0 rounded-full border border-dashed border-jj-red/30 animate-spin-slow" />
        <span className="absolute inset-3 rounded-full border border-jj-red/15" />
        <span className="w-11 h-11 rounded-full bg-white shadow-soft flex items-center justify-center text-jj-red">
          <Icon name={icon} className="w-5 h-5" />
        </span>
      </span>
      <p className="font-johnson-display text-xl text-jj-gray-08">{title}</p>
      {description && <p className="mt-1.5 max-w-md font-johnson-text font-light text-sm text-jj-gray-06 text-pretty">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…', className }) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-4 py-20', className)}>
      <span className="relative w-14 h-14" aria-hidden="true">
        <span className="absolute inset-0 rounded-full border border-jj-red/30 animate-ring" />
        <span className="absolute inset-0 rounded-full border-2 border-jj-red/15 border-t-jj-red animate-spin" />
        <span className="absolute inset-[22px] rounded-full bg-jj-red animate-breathe" />
      </span>
      <p role="status" className="font-johnson-text text-sm text-jj-gray-06">{label}</p>
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

export function Page({ children, className, wide = false }) {
  return (
    <div className={cx('w-full mx-auto px-4 sm:px-6 lg:px-10 pt-5 sm:pt-8 pb-10 flex flex-col gap-6 sm:gap-8', wide ? 'max-w-none' : 'max-w-[1600px]', className)}>
      {children}
    </div>
  );
}

/** Live status chip: a breathing dot plus tracked caps. */
export function StatusChip({ color = '#328714', live = false, children, className }) {
  return (
    <span className={cx('chip', className)}>
      <span className="relative flex w-1.5 h-1.5" aria-hidden="true">
        {live && <span className="absolute inset-0 rounded-full animate-ping opacity-60" style={{ background: color }} />}
        <span className="relative w-full h-full rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      </span>
      {children}
    </span>
  );
}

function AnimatedWords({ text, delay = 0 }) {
  const words = String(text).split(' ');
  return words.map((w, i) => (
    <React.Fragment key={i}>
      <span className="inline-block animate-word-in" style={{ animationDelay: `${delay + i * 0.06}s` }}>{w}</span>
      {i < words.length - 1 ? ' ' : ''}
    </React.Fragment>
  ));
}

/**
 * Page hero, kept compact so the working surface starts above the fold: a bold
 * display line with a light italic red ending, a lede, live chips and actions,
 * and a small data-driven illustration on the right (hidden on phones).
 */
export function PageHeader({ title, accent, description, meta, actions, chips, art }) {
  return (
    <header className={cx('relative isolate grid items-center gap-x-8 gap-y-4', art && 'md:grid-cols-[minmax(0,1fr)_auto]')}>
      <div aria-hidden="true" className="pointer-events-none absolute -z-10 -inset-x-10 -top-8 -bottom-4 hero-grid" />
      <div aria-hidden="true" className="pointer-events-none absolute -z-10 -top-20 right-0 w-[28rem] max-w-full aspect-square rounded-full animate-halo"
        style={{ background: 'radial-gradient(circle, rgba(235,23,0,0.09) 0%, rgba(140,59,187,0.07) 40%, rgba(255,255,255,0) 70%)' }} />
      <div className="min-w-0">
        {chips && <div className="flex flex-wrap items-center gap-2 mb-3 animate-rise">{chips}</div>}
        <h1 className="font-johnson-display font-bold text-jj-gray-08 text-[1.75rem] sm:text-[2.25rem] xl:text-[2.6rem] tracking-[-0.03em] leading-[1.05] text-balance">
          <AnimatedWords text={title} />
          {accent && (
            <>
              {' '}
              <span className="font-light italic text-jj-red"><AnimatedWords text={accent} delay={0.2} /></span>
            </>
          )}
        </h1>
        {(description || meta) && (
          <p className="mt-2 max-w-2xl font-johnson-text font-light text-[15px] leading-relaxed text-jj-gray-07 text-pretty animate-rise [animation-delay:0.15s]">
            {description}
            {meta && <span className="text-jj-gray-05 whitespace-nowrap">{description ? ' · ' : ''}{meta}</span>}
          </p>
        )}
        {actions && <div className="mt-4 flex flex-wrap items-center gap-2.5 animate-rise [animation-delay:0.25s]">{actions}</div>}
      </div>
      {art && (
        <div className="relative hidden md:block w-[16rem] lg:w-[20rem] xl:w-[23rem] h-[11rem] lg:h-[12.5rem] xl:h-[13.5rem] animate-fade-in [animation-duration:1.2s]">
          {art}
        </div>
      )}
    </header>
  );
}

export function Section({ title, accent, description, actions, children, className }) {
  return (
    <section className={cx('flex flex-col gap-4', className)}>
      {(title || actions) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            {title && (
              <h2 className="font-johnson-display text-2xl sm:text-[1.75rem] text-jj-gray-08 tracking-[-0.02em]">
                {title}{accent && <> <span className="font-light italic text-jj-red">{accent}</span></>}
              </h2>
            )}
            {description && <p className="mt-1 font-johnson-text font-light text-sm text-jj-gray-06">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ title, actions, children, className, bodyClassName }) {
  return (
    <div className={cx('surface', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 pt-5">
          {title && <h3 className="font-johnson-display text-lg text-jj-gray-08">{title}</h3>}
          {actions}
        </div>
      )}
      <div className={cx('p-5 sm:p-6', bodyClassName)}>{children}</div>
    </div>
  );
}

// ── Data display ──────────────────────────────────────────────────────────────

export function Dot({ color, className = 'w-2.5 h-2.5', pulse = false }) {
  return (
    <span className={cx('relative inline-flex flex-shrink-0', className)} aria-hidden="true">
      {pulse && <span className="absolute inset-0 rounded-full animate-ping opacity-50" style={{ background: color }} />}
      <span className="relative inline-block w-full h-full rounded-full" style={{ background: color }} />
    </span>
  );
}

export function Badge({ children, color, tone = 'neutral', className }) {
  const tones = {
    neutral: 'bg-jj-gray-01 text-jj-gray-07 border-jj-gray-02',
    success: 'bg-[#f2f9ee] text-jj-green-03 border-jj-green-03/20',
    danger: 'bg-[#fff3f1] text-jj-red border-jj-red/20',
    warning: 'bg-[#fff8e8] text-amber-800 border-amber-300/50',
    info: 'bg-[#f1f7fd] text-jj-blue-03 border-jj-blue-03/20',
  };
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-johnson-text font-medium whitespace-nowrap', !color && tones[tone], className)}
      style={color ? { backgroundColor: `${color}14`, borderColor: `${color}40`, color } : undefined}
    >
      {children}
    </span>
  );
}

export function KpiTile({ label, value, hint, accent, loading, title }) {
  return (
    <div className="group relative h-full overflow-hidden bg-white rounded-2xl border border-jj-gray-02 shadow-card px-5 py-4 sm:py-5 min-w-0 transition-[box-shadow,transform] duration-300 ease-out hover:-translate-y-0.5 hover:shadow-lift">
      <p className="flex items-center gap-2 font-johnson-text text-xs text-jj-gray-06 min-w-0">
        {accent && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: accent }} aria-hidden="true" />}
        <span className="truncate">{label}</span>
      </p>
      {loading ? (
        <Skeleton className="h-8 w-24 mt-2.5" />
      ) : (
        <p className="mt-1.5 font-johnson-display text-[1.75rem] sm:text-[2rem] leading-none tracking-[-0.02em] text-jj-gray-08 tabular-nums truncate" title={title}>{value ?? '—'}</p>
      )}
      {hint && !loading && <p className="mt-2 font-johnson-text text-xs text-jj-gray-05 truncate">{hint}</p>}
    </div>
  );
}

/** Grid for KpiTile rows; a lone tile on the last row spans the full width on small screens. */
export function KpiGrid({ className, children }) {
  return <div className={cx('grid grid-cols-2 gap-3 sm:gap-4 stagger max-sm:[&>*:last-child:nth-child(odd)]:col-span-2', className)}>{children}</div>;
}

export function ProgressBar({ value, color = '#eb1700', className = 'h-1.5', label }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={cx('w-full rounded-full bg-jj-gray-02 overflow-hidden', className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}99, ${color})` }} />
    </div>
  );
}

export function TableShell({ children, footer, className }) {
  return (
    <div className={cx('bg-white rounded-3xl border border-jj-gray-02 shadow-soft overflow-hidden', className)}>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full text-sm font-johnson-text">{children}</table>
      </div>
      {footer && <div className="px-5 py-3 border-t border-jj-gray-02 bg-[#faf9f7] text-xs font-johnson-text text-jj-gray-06">{footer}</div>}
    </div>
  );
}

const TH_BASE = 'bg-[#faf9f7] border-b border-jj-gray-02 text-[12.5px] font-medium text-jj-gray-06 whitespace-nowrap';

export function Th({ children, align = 'left', className }) {
  return (
    <th scope="col" className={cx('px-5 py-3.5', TH_BASE, align === 'right' ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  );
}

export function SortTh({ label, sortKey, sort, onSort, align = 'left', className }) {
  const active = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={active ? (sort.asc ? 'ascending' : 'descending') : 'none'} className={cx('px-0 py-0', TH_BASE, className)}>
      <button type="button" onClick={() => onSort(sortKey)}
        className={cx('w-full px-5 py-3.5 flex items-center gap-1.5 transition-colors focus-ring-inset',
          align === 'right' ? 'justify-end' : 'justify-start', active ? 'text-jj-red' : 'hover:text-jj-gray-08')}>
        {label}
        <svg aria-hidden="true" viewBox="0 0 10 10" className={cx('w-2.5 h-2.5 transition-transform duration-200', active ? 'opacity-100' : 'opacity-30', active && !sort.asc && 'rotate-180')}>
          <path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </th>
  );
}

export function Td({ children, align = 'left', className, ...rest }) {
  return <td className={cx('px-5 py-3.5 align-middle', align === 'right' && 'text-right tabular-nums', className)} {...rest}>{children}</td>;
}

// ── Inputs ────────────────────────────────────────────────────────────────────

const FIELD = 'border border-jj-gray-02 bg-white/95 text-jj-gray-08 placeholder:text-jj-gray-05 shadow-[0_10px_24px_-22px_rgba(49,44,42,0.7)] transition-[border-color,box-shadow] duration-200 focus:outline-none focus:border-jj-red/50 focus:shadow-[0_0_0_4px_rgba(235,23,0,0.08),0_16px_34px_-24px_rgba(235,23,0,0.45)]';

export function Toggle({ checked, onChange, label, disabled = false, className }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cx('inline-flex items-center gap-2.5 select-none rounded-full focus-ring disabled:opacity-40 disabled:cursor-not-allowed', className)}>
      <span className={cx('relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-300', checked ? 'bg-jj-red shadow-glow' : 'bg-jj-gray-03')}>
        <span className={cx('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-300 ease-out', checked && 'translate-x-5')} />
      </span>
      {label && <span className="font-johnson-text text-sm text-jj-gray-07 whitespace-nowrap">{label}</span>}
    </button>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className, label }) {
  return (
    <div className={cx('relative', className)}>
      <Icon name="search" className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-jj-red pointer-events-none" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        aria-label={label || placeholder}
        className={cx('w-full h-11 pl-10 pr-3 rounded-xl font-johnson-text text-sm', FIELD)} />
    </div>
  );
}

export function Select({ value, onChange, children, className, label, size = 'md', ...rest }) {
  return (
    <div className={cx('relative inline-flex', className)}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className={cx('w-full appearance-none pl-3.5 pr-9 font-johnson-text cursor-pointer', FIELD, size === 'sm' ? 'h-9 text-xs rounded-lg' : 'h-11 text-sm rounded-xl')} {...rest}>
        {children}
      </select>
      <Icon name="chevronDown" className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 text-jj-gray-05 pointer-events-none" />
    </div>
  );
}

export function TextField({ label, hint, error, className, inputClassName, multiline = false, ...rest }) {
  const id = useId();
  const Comp = multiline ? 'textarea' : 'input';
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label && <label htmlFor={id} className="font-johnson-text text-xs font-medium text-jj-gray-07">{label}</label>}
      <Comp id={id} aria-invalid={!!error} aria-describedby={hint || error ? `${id}-hint` : undefined}
        className={cx('w-full rounded-xl px-3.5 font-johnson-text text-sm read-only:bg-jj-gray-01 read-only:text-jj-gray-06 read-only:shadow-none',
          FIELD, multiline ? 'py-2.5 resize-none' : 'h-11', error && '!border-jj-red', inputClassName)}
        {...rest} />
      {(hint || error) && <p id={`${id}-hint`} className={cx('font-johnson-text text-xs', error ? 'text-jj-red' : 'text-jj-gray-05')}>{error || hint}</p>}
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

export function Tabs({ tabs, value, onChange, label, variant = 'underline', className }) {
  const refs = useRef({});
  const onKeyDown = (e) => {
    const idx = tabs.findIndex((t) => t.id === value);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
    if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length];
    if (e.key === 'Home') next = tabs[0];
    if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      onChange(next.id);
      refs.current[next.id]?.focus();
    }
  };
  if (variant === 'pill') {
    return (
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown}
        className={cx('inline-flex max-w-full overflow-x-auto scroll-none bg-white/90 border border-jj-gray-02 rounded-2xl p-1 gap-1 shadow-[0_12px_30px_-24px_rgba(49,44,42,0.7)]', className)}>
        {tabs.map((t) => {
          const on = value === t.id;
          return (
            <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} role="tab" type="button" aria-selected={on} tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)} title={t.title}
              className={cx('shrink-0 flex items-center gap-2 px-4 h-9 rounded-xl font-johnson-text text-[13px] sm:text-sm whitespace-nowrap transition-[background-color,color,box-shadow] duration-300 ease-out focus-ring',
                on ? 'bg-jj-red text-white shadow-glow' : 'text-jj-gray-07 hover:text-jj-gray-08 hover:bg-jj-gray-01')}>
              {t.icon && <Icon name={t.icon} className="w-3.5 h-3.5" />}
              {t.dot && <Dot color={on ? '#fff' : t.dot} className="w-1.5 h-1.5" />}
              {t.label}
              {t.count != null && <span className={cx('text-[11px] tabular-nums', on ? 'text-white/80' : 'text-jj-gray-05')}>{t.count}</span>}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cx('flex overflow-x-auto scroll-none border-b border-jj-gray-02', className)}>
      {tabs.map((t) => {
        const on = value === t.id;
        return (
          <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} role="tab" type="button" aria-selected={on} tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)} title={t.title}
            className={cx('relative shrink-0 flex items-center gap-2 px-4 sm:px-5 h-12 font-johnson-text text-sm whitespace-nowrap transition-colors focus-ring-inset',
              on ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-06 hover:text-jj-gray-08')}>
            {t.icon && <Icon name={t.icon} className={cx('w-4 h-4', on && 'text-jj-red')} />}
            {t.dot && <Dot color={t.dot} className="w-2 h-2" />}
            {t.label}
            {t.count != null && <span className="ml-0.5 px-1.5 rounded-full bg-jj-gray-02 text-[11px] text-jj-gray-07 tabular-nums">{t.count}</span>}
            <span className={cx('absolute left-3 right-3 bottom-0 h-[3px] rounded-full transition-[background-color,box-shadow,transform] duration-300 ease-out origin-center',
              on ? 'bg-jj-red shadow-[0_0_10px_rgba(235,23,0,0.5)] scale-x-100' : 'bg-transparent scale-x-50')} />
          </button>
        );
      })}
    </div>
  );
}

// ── Overlays ──────────────────────────────────────────────────────────────────

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useDialogBehaviour(open, onClose, containerRef) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const node = containerRef.current;
    const first = node?.querySelector('[data-autofocus]') || node?.querySelector(FOCUSABLE);
    (first || node)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current?.(); }
      if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const [head, tail] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === head) { e.preventDefault(); tail.focus(); }
        else if (!e.shiftKey && document.activeElement === tail) { e.preventDefault(); head.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (previouslyFocused?.focus) previouslyFocused.focus();
    };
  }, [open, containerRef]);
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md', dismissable = true }) {
  const ref = useRef(null);
  const titleId = useId();
  useDialogBehaviour(open, dismissable ? onClose : undefined, ref);
  if (!open) return null;
  const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' };
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-[#1f1b18]/45 backdrop-blur-[3px] animate-fade-in" onClick={dismissable ? onClose : undefined} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={cx('relative w-full bg-white shadow-overlay flex flex-col max-h-[92dvh] rounded-t-[28px] sm:rounded-[28px] animate-dialog-in outline-none', widths[size])}>
        <div className="flex items-start justify-between gap-4 px-6 sm:px-7 pt-6 pb-4 border-b border-jj-gray-02">
          <div className="min-w-0">
            <h2 id={titleId} className="font-johnson-display text-xl sm:text-2xl tracking-[-0.02em] text-jj-gray-08">{title}</h2>
            {description && <p className="mt-0.5 font-johnson-text text-sm text-jj-gray-06 break-words">{description}</p>}
          </div>
          {dismissable && <IconButton icon="close" label="Close" size="sm" onClick={onClose} className="-mr-2 -mt-1" />}
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin px-6 sm:px-7 py-6">{children}</div>
        {footer && <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-6 sm:px-7 py-4 border-t border-jj-gray-02 bg-[#faf9f7] rounded-b-none sm:rounded-b-[28px] pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, description, children, footer, width = 'sm:max-w-md' }) {
  const ref = useRef(null);
  const titleId = useId();
  useDialogBehaviour(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div className="absolute inset-0 bg-[#1f1b18]/40 backdrop-blur-[2px] animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={cx('relative h-full w-full bg-white shadow-overlay flex flex-col animate-drawer-in outline-none sm:rounded-l-[28px] overflow-hidden', width)}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-jj-gray-02 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <h2 id={titleId} className="font-johnson-display text-xl tracking-[-0.02em] text-jj-gray-08 truncate">{title}</h2>
            {description && <p className="font-johnson-text text-xs text-jj-gray-06 truncate">{description}</p>}
          </div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} className="-mr-2" />
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">{children}</div>
        {footer && <div className="flex gap-2 px-5 py-4 border-t border-jj-gray-02 bg-white pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Popover menu anchored under its trigger; closes on outside click / Escape. */
export function Menu({ trigger, children, align = 'right', className, open, onOpenChange }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) onOpenChange(false); };
    const onKey = (e) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);
  return (
    <div ref={ref} className="relative">
      {trigger}
      {open && (
        <div role="menu" className={cx('absolute z-50 mt-2 min-w-[14rem] max-w-[calc(100vw-2rem)] bg-white rounded-2xl border border-jj-gray-02 shadow-overlay p-1.5 animate-pop-in', align === 'right' ? 'right-0' : 'left-0', className)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, tone, title, disabled = false }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} title={title} disabled={disabled}
      className={cx('w-full text-left px-3 py-2 rounded-xl font-johnson-text text-sm transition-colors focus-ring-inset disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        tone === 'danger' ? 'text-jj-red hover:bg-red-50' : 'text-jj-gray-07 hover:bg-jj-gray-01',
        active && 'text-jj-red font-semibold')}>
      {children}
    </button>
  );
}

/** A setting inside a menu: label, hint and a switch. Toggling keeps the menu open. */
export function MenuToggle({ label, hint, checked, onChange }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-4 px-3 py-2.5 rounded-xl text-left transition-colors hover:bg-jj-gray-01 focus-ring-inset">
      <span className="min-w-0">
        <span className="block font-johnson-text text-sm text-jj-gray-08">{label}</span>
        {hint && <span className="block font-johnson-text text-xs text-jj-gray-05">{hint}</span>}
      </span>
      <span aria-hidden="true" className={cx('relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors duration-300', checked ? 'bg-jj-red' : 'bg-jj-gray-03')}>
        <span className={cx('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-300 ease-out', checked && 'translate-x-4')} />
      </span>
    </button>
  );
}

// ── Toasts & confirmation ─────────────────────────────────────────────────────

const FeedbackContext = createContext(null);

export function FeedbackProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((tone, message, ms = 4000) => {
    const id = ++idRef.current;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => dismiss(id), ms);
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (m) => push('success', m),
    error: (m) => push('error', m, 6000),
    info: (m) => push('info', m),
  }), [push]);

  const confirm = useCallback((opts) => new Promise((resolve) => setConfirmState({ ...opts, resolve })), []);
  const settle = (result) => { confirmState?.resolve(result); setConfirmState(null); };
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {createPortal(
        <div aria-live="polite" className="fixed z-[80] bottom-4 right-4 left-4 sm:left-auto flex flex-col gap-2 items-stretch sm:items-end pointer-events-none pb-[env(safe-area-inset-bottom)]">
          {toasts.map((t) => (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex items-start gap-3 sm:min-w-[18rem] sm:max-w-sm bg-[#1f1b18]/95 backdrop-blur text-white rounded-2xl shadow-overlay px-4 py-3.5 animate-toast-in">
              <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'success' ? 'check' : 'info'}
                className={cx('w-4 h-4 mt-0.5', t.tone === 'error' ? 'text-red-300' : t.tone === 'success' ? 'text-jj-green-01' : 'text-jj-blue-01')} />
              <p className="flex-1 font-johnson-text text-sm break-words">{t.message}</p>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-jj-gray-04 hover:text-white rounded focus-ring">
                <Icon name="close" className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
      <Modal open={!!confirmState} onClose={() => settle(false)} title={confirmState?.title || 'Are you sure?'} size="sm"
        footer={(
          <>
            <Button onClick={() => settle(false)}>{confirmState?.cancelLabel || 'Cancel'}</Button>
            <Button variant={confirmState?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => settle(true)} data-autofocus>
              {confirmState?.confirmLabel || 'Confirm'}
            </Button>
          </>
        )}>
        <p className="font-johnson-text font-light text-[15px] leading-relaxed text-jj-gray-07 break-words">{confirmState?.message}</p>
      </Modal>
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used within a FeedbackProvider');
  return ctx;
}
