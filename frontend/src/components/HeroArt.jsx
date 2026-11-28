/* Live hero illustrations. Each one is drawn from the page's real data and
   moves slowly; under prefers-reduced-motion everything holds still. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, cx } from './ui';
import { useReducedMotion } from '../utils/motion';


/** True while the element is narrower than `px`, so art can shed detail on phones. */
function useNarrow(ref, px = 480) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < px));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return narrow;
}

/** Shared backdrop: two dashed ellipses, a slow conic sweep and soft core light. */
function OrbitBackdrop({ sweep = true }) {
  return (
    <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
      <svg viewBox="0 0 100 62" preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible">
        <ellipse cx="50" cy="31" rx="49" ry="28" fill="none" stroke="rgba(110,98,89,0.22)" strokeWidth="0.18" vectorEffect="non-scaling-stroke" />
        <ellipse cx="50" cy="31" rx="43" ry="22.3" fill="none" stroke="rgba(235,23,0,0.28)" strokeWidth="0.15" strokeDasharray="0.6 1.2" vectorEffect="non-scaling-stroke" />
        <ellipse cx="50" cy="31" rx="27" ry="13.5" fill="none" stroke="rgba(15,104,178,0.18)" strokeWidth="0.15" vectorEffect="non-scaling-stroke" />
      </svg>
      {sweep && (
        <div className="absolute left-1/2 top-1/2 w-[94%] aspect-square" style={{ transform: 'translate(-50%, -50%) scaleY(0.55)' }}>
          <div className="absolute inset-0 rounded-full animate-spin-med"
            style={{
              background: 'conic-gradient(from 0deg, rgba(235,23,0,0.06) 0deg, rgba(235,23,0,0.015) 50deg, transparent 100deg, transparent 360deg)',
              WebkitMaskImage: 'radial-gradient(circle, transparent 18%, #000 19%, #000 70%, transparent 71%)',
              maskImage: 'radial-gradient(circle, transparent 18%, #000 19%, #000 70%, transparent 71%)',
            }} />
        </div>
      )}
    </div>
  );
}

function CoreDisc({ title, sub, size = 132 }) {
  return (
    <div className="absolute left-1/2 top-1/2 z-[5] pointer-events-none" style={{ width: size, height: size, margin: `${-size / 2}px 0 0 ${-size / 2}px` }}>
      <span className="absolute -inset-4 rounded-full border border-jj-red/40 animate-ring" />
      <span className="absolute -inset-4 rounded-full border border-jj-blue-03/35 animate-ring [animation-delay:1.6s]" />
      <span className="absolute -inset-3 rounded-full border-[1.5px] border-dashed border-jj-red/25 animate-spin-slow" />
      <div className="absolute inset-0 rounded-full grid place-items-center text-center border border-jj-gray-02 shadow-lift"
        style={{ background: 'radial-gradient(circle at 35% 28%, #fff 0%, #fbfaf8 55%, #f3efeb 100%)' }}>
        <div>
          <i className="block mx-auto mb-2 w-1.5 h-1.5 rounded-full bg-jj-red shadow-[0_0_10px_rgba(235,23,0,0.7)] animate-breathe" />
          <b className="block font-johnson-display font-bold leading-none tracking-[0.01em] text-jj-gray-08" style={{ fontSize: Math.round(size * 0.19) }}>{title}</b>
          {sub && size >= 90 && <small className="block mt-1.5 font-johnson-text font-medium text-[11px] text-jj-gray-06">{sub}</small>}
        </div>
      </div>
    </div>
  );
}

/**
 * The six tools circle a core disc on a tilted ellipse. Front nodes are larger,
 * back nodes recede; hovering or focusing any node pauses the orbit.
 */
export function ToolOrbit({ tools, onLaunch, status = {} }) {
  const wrap = useRef(null);
  const nodes = useRef([]);
  const paused = useRef(false);
  const [active, setActive] = useState(null);
  const small = useNarrow(wrap);
  const still = useReducedMotion();

  useEffect(() => {
    const place = (t) => {
      const n = tools.length || 1;
      nodes.current.forEach((el, i) => {
        if (!el) return;
        const a = (i / n) * Math.PI * 2 + t;
        const depth = (Math.sin(a) + 1) / 2;
        const x = 50 + 40 * Math.cos(a);
        const y = 50 + 36 * Math.sin(a);
        el.style.left = `${x}%`;
        el.style.top = `${y}%`;
        el.style.transform = `scale(${0.78 + depth * 0.32})`;
        el.style.zIndex = String(depth > 0.5 ? 10 : 2);
        el.style.opacity = String(0.55 + depth * 0.45);
        el.style.setProperty('--lo', String(depth));
      });
    };
    let t = -Math.PI / 2;
    place(t);
    if (still) return undefined;
    let raf = 0;
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (!paused.current && document.visibilityState === 'visible') t += dt * 0.00009;
      place(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tools.length, still]);

  const hold = (id) => { paused.current = !!id; setActive(id); };

  return (
    <div ref={wrap} className="relative w-full max-w-[34rem] mx-auto pb-11">
      <div className="relative w-full aspect-[5/4] sm:aspect-[16/9] mx-auto">
      <OrbitBackdrop />
      <CoreDisc title="RDI" sub="AI · Monitoring" size={small ? 92 : 132} />
      {tools.map((tool, i) => {
        const s = status[tool.path];
        const on = active === tool.path;
        return (
          <button key={tool.path} ref={(el) => { nodes.current[i] = el; }} type="button"
            onClick={() => onLaunch(tool)} onMouseEnter={() => hold(tool.path)} onMouseLeave={() => hold(null)}
            onFocus={() => hold(tool.path)} onBlur={() => hold(null)}
            aria-label={`Open ${tool.label}`}
            className={cx('group absolute rounded-full focus:outline-none will-change-transform', small ? 'w-11 h-11 -ml-[22px] -mt-[22px]' : 'w-14 h-14 -ml-7 -mt-7')}
            style={{ '--c': tool.color }}>
            <span className={cx('absolute inset-0 rounded-full grid place-items-center border transition-[background-color,border-color,box-shadow,transform] duration-300 ease-out',
              on ? 'scale-[1.18] border-transparent' : 'bg-white border-jj-gray-02 shadow-[0_16px_30px_-18px_rgba(49,44,42,0.55)] group-focus-visible:ring-2 group-focus-visible:ring-jj-red')}
              style={on ? { background: tool.color, boxShadow: `0 22px 40px -16px ${tool.color}` } : undefined}>
              <span className="absolute inset-1 rounded-full opacity-[0.07]" style={{ background: tool.color }} />
              <Icon name={tool.icon} className={cx('relative transition-colors duration-300', small ? 'w-5 h-5' : 'w-6 h-6')} style={{ color: on ? '#fff' : tool.color }} />
            </span>
            {s?.color && (
              <span className="absolute -right-0.5 -top-0.5 w-3.5 h-3.5 rounded-full border-2 border-white" style={{ background: s.color, boxShadow: `0 0 10px ${s.color}` }} />
            )}
            {!small && (
              <span className={cx('absolute left-1/2 top-[3.9rem] -translate-x-1/2 whitespace-nowrap font-johnson-text font-medium text-[12px] transition-colors duration-300', on ? 'text-jj-gray-08' : 'text-jj-gray-07')}>
                {tool.label}
              </span>
            )}
          </button>
        );
      })}
      </div>
      <div className="absolute left-1/2 bottom-0 -translate-x-1/2 inline-flex items-center gap-2 h-8 px-3.5 rounded-full bg-white/85 border border-jj-gray-07/15 font-johnson-text font-medium text-[12px] text-jj-gray-07 whitespace-nowrap">
        <span className="w-1.5 h-1.5 rounded-full bg-jj-violet-03 shadow-[0_0_8px_rgba(140,59,187,0.6)]" aria-hidden="true" />
        {active ? tools.find((t) => t.path === active)?.label : small ? 'Tap a tool to open it' : 'Hover a tool · click to open'}
      </div>
    </div>
  );
}

/** Arc path helper for a ring segment between two angles (degrees, 0 at top). */
function arc(cx0, cy0, r, a0, a1) {
  const rad = (a) => ((a - 90) * Math.PI) / 180;
  const p0 = [cx0 + r * Math.cos(rad(a0)), cy0 + r * Math.sin(rad(a0))];
  const p1 = [cx0 + r * Math.cos(rad(a1)), cy0 + r * Math.sin(rad(a1))];
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0[0]} ${p0[1]} A ${r} ${r} 0 ${large} 1 ${p1[0]} ${p1[1]}`;
}

/**
 * Ring gauge: an outer ring split into the given segments, an inner progress
 * arc for `value` (0-100) and a big centre figure. Segments draw in on mount.
 */
export function RingGauge({ value, segments = [], center, sub, caption, loading, color = '#312c2a' }) {
  const total = segments.reduce((a, s) => a + (Number(s.value) || 0), 0);
  const arcs = useMemo(() => {
    if (!total) return [];
    let a = 0;
    const gap = segments.length > 1 ? 1.6 : 0;
    return segments.filter((s) => s.value > 0).map((s) => {
      const sweep = (s.value / total) * 360;
      const out = { ...s, a0: a + gap / 2, a1: a + Math.max(sweep - gap / 2, gap / 2 + 0.5) };
      a += sweep;
      return out;
    });
  }, [segments, total]);
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const R = 76;
  const C = 2 * Math.PI * R;
  return (
    <div className={cx('relative h-full aspect-square', segments.length ? 'mr-auto' : 'mx-auto')}>
      <div aria-hidden="true" className="absolute inset-[8%] rounded-full animate-halo"
        style={{ background: 'radial-gradient(circle, rgba(235,23,0,0.10), rgba(15,104,178,0.06) 45%, transparent 70%)' }} />
      <svg viewBox="0 0 200 200" className="relative w-full h-full overflow-visible" role="img" aria-label={caption || `${pct}%`}>
        <g opacity="0.5">
          {Array.from({ length: 60 }, (_, i) => {
            const a = (i * 6 * Math.PI) / 180;
            const r0 = i % 5 === 0 ? 95 : 97;
            return <line key={i} x1={100 + r0 * Math.sin(a)} y1={100 - r0 * Math.cos(a)} x2={100 + 99 * Math.sin(a)} y2={100 - 99 * Math.cos(a)} stroke="#a39992" strokeWidth={i % 5 === 0 ? 0.8 : 0.4} />;
          })}
        </g>
        <circle cx="100" cy="100" r="88" fill="none" stroke="#e8e6e3" strokeWidth="7" />
        {arcs.map((s, i) => (
          <path key={s.label} d={arc(100, 100, 88, s.a0, s.a1)} fill="none" stroke={s.color} strokeWidth="7" strokeLinecap="round"
            pathLength="100" strokeDasharray="100" className="[stroke-dashoffset:100] animate-[draw_1.4s_cubic-bezier(0.16,1,0.3,1)_forwards]"
            style={{ animationDelay: `${0.2 + i * 0.15}s` }} />
        ))}
        <circle cx="100" cy="100" r={R} fill="none" stroke="#f1efed" strokeWidth="2" />
        <circle cx="100" cy="100" r={R} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} transform="rotate(-90 100 100)"
          className="transition-[stroke-dashoffset] duration-[1600ms] ease-out" />
        <g className="origin-center animate-spin-slow" style={{ transformBox: 'view-box' }}>
          <circle cx="100" cy={100 - 64} r="2" fill="#0f68b2" />
          <circle cx={100 + 64} cy="100" r="1.4" fill="#8c3bbb" opacity="0.7" />
        </g>
        <circle cx="100" cy="100" r="58" fill="url(#rg-disc)" stroke="#e8e6e3" strokeWidth="0.6" />
        <defs>
          <radialGradient id="rg-disc" cx="35%" cy="28%">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="60%" stopColor="#fbfaf8" />
            <stop offset="100%" stopColor="#f3efeb" />
          </radialGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        {loading ? (
          <span className="w-16 h-7 rounded-md bg-jj-gray-02 animate-pulse" />
        ) : (
          <span className="font-johnson-display font-light text-[1.9rem] lg:text-[2.2rem] leading-none tracking-[-0.03em] text-jj-gray-08 tabular-nums">{center}</span>
        )}
        {sub && <span className="mt-1.5 font-johnson-text font-medium text-[12px] text-jj-gray-06">{sub}</span>}
      </div>
      {arcs.length > 0 && (
        <ul className="absolute top-1/2 -translate-y-1/2 left-full ml-3 flex flex-col gap-1.5 w-max">
          {arcs.slice(0, 4).map((s) => (
            <li key={s.label} className="flex items-center gap-1.5 font-johnson-text text-[12px] text-jj-gray-07 whitespace-nowrap">
              <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Clock dial with a sweeping second hand; centre shows a live count. */
export function ClockDial({ count, label, loading }) {
  const [now, setNow] = useState(() => new Date());
  const still = useReducedMotion();
  useEffect(() => {
    // Reduced motion: the hands still tell the time, once a minute instead of sweeping.
    const id = setInterval(() => setNow(new Date()), still ? 60_000 : 1000);
    return () => clearInterval(id);
  }, [still]);
  const h = (now.getHours() % 12) * 30 + now.getMinutes() * 0.5;
  const m = now.getMinutes() * 6 + now.getSeconds() * 0.1;
  const sec = now.getSeconds() * 6;
  return (
    <div className="relative h-full aspect-square mx-auto">
      <svg viewBox="0 0 200 200" className="w-full h-full overflow-visible" aria-hidden="true">
        <circle cx="100" cy="100" r="96" fill="none" stroke="rgba(110,98,89,0.22)" strokeWidth="0.6" />
        <circle cx="100" cy="100" r="80" fill="none" stroke="rgba(235,23,0,0.25)" strokeWidth="0.6" strokeDasharray="2 3" className="origin-center animate-spin-slow" style={{ transformBox: 'view-box' }} />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          return (
            <text key={i} x={100 + 88 * Math.sin(a)} y={100 - 88 * Math.cos(a) + 2.5} textAnchor="middle"
              className="fill-jj-gray-05 font-johnson-text" style={{ fontSize: 7, fontWeight: i % 3 === 0 ? 700 : 300 }}>
              {i === 0 ? 12 : i}
            </text>
          );
        })}
        {Array.from({ length: 60 }, (_, i) => {
          const a = (i * 6 * Math.PI) / 180;
          return <line key={i} x1={100 + 72 * Math.sin(a)} y1={100 - 72 * Math.cos(a)} x2={100 + (i % 5 ? 75 : 77) * Math.sin(a)} y2={100 - (i % 5 ? 75 : 77) * Math.cos(a)} stroke={i % 5 ? '#d5cfc9' : '#eb1700'} strokeWidth={i % 5 ? 0.5 : 1} />;
        })}
        <line x1="100" y1="100" x2="100" y2="58" stroke="#312c2a" strokeWidth="2.4" strokeLinecap="round" transform={`rotate(${h} 100 100)`} />
        <line x1="100" y1="100" x2="100" y2="40" stroke="#6e6259" strokeWidth="1.6" strokeLinecap="round" transform={`rotate(${m} 100 100)`} />
        <g transform={`rotate(${sec} 100 100)`} className="transition-transform duration-300 ease-out">
          <line x1="100" y1="112" x2="100" y2="30" stroke="#eb1700" strokeWidth="0.9" />
          <circle cx="100" cy="30" r="3" fill="#eb1700" style={{ filter: 'drop-shadow(0 0 4px rgba(235,23,0,0.7))' }} />
        </g>
        <circle cx="100" cy="100" r="34" fill="#fff" stroke="#e8e6e3" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        {loading ? <span className="w-12 h-7 rounded bg-jj-gray-02 animate-pulse" /> : (
          <span className="font-johnson-display font-light text-3xl leading-none tabular-nums text-jj-gray-08">{count}</span>
        )}
        <span className="mt-1.5 font-johnson-text font-medium text-[12px] text-jj-gray-06">{label}</span>
      </div>
    </div>
  );
}

/**
 * The extraction run as a flowing line: one station per stage, legs between
 * finished stations filled, the live leg animated. Driven by parsed stage data.
 */
export function PipelineFlow({ nodes, stages, running }) {
  const wrap = useRef(null);
  const small = useNarrow(wrap, 300);
  const n = nodes.length;
  // Two rows snake left-to-right then right-to-left so labels stay readable.
  const perRow = Math.ceil(n / 2);
  const pos = nodes.map((_, i) => {
    const row = i < perRow ? 0 : 1;
    const col = row === 0 ? i : n - 1 - i;
    const span = row === 0 ? perRow : n - perRow;
    return { x: 10 + (col * 80) / Math.max(1, (row === 0 ? perRow : span) - 1), y: row === 0 ? 30 : 74 };
  });
  const stateOf = (id) => {
    const st = stages[id]?.status || 'idle';
    return !running && st === 'active' ? 'halted' : st;
  };
  const colorOf = (node, st) => (st === 'error' ? '#eb1700' : st === 'idle' ? '#d5cfc9' : st === 'halted' ? '#857a73' : node.color);
  const done = nodes.filter((nd) => stateOf(nd.id) === 'done').length;
  return (
    <div ref={wrap} className="relative w-full h-full">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" aria-hidden="true">
        <path d={`M ${pos[perRow - 1].x} 30 C ${pos[perRow - 1].x + 7} 30, ${pos[perRow - 1].x + 7} 74, ${pos[perRow]?.x ?? 90} 74`} fill="none" stroke="#d5cfc9" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        {pos.slice(1).map((p, i) => {
          const a = pos[i];
          if (i + 1 === perRow) return null;
          const from = nodes[i];
          const to = nodes[i + 1];
          const sFrom = stateOf(from.id);
          const sTo = stateOf(to.id);
          const live = sTo === 'active';
          const lit = sFrom === 'done' && sTo !== 'idle';
          return (
            <g key={to.id}>
              <line x1={a.x} y1={a.y} x2={p.x} y2={p.y} stroke={lit ? colorOf(to, sTo) : '#d5cfc9'} strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              {live && <line x1={a.x} y1={a.y} x2={p.x} y2={p.y} stroke="#fff" strokeWidth="3" strokeDasharray="3 9" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="animate-dash" />}
            </g>
          );
        })}
        {(() => {
          const a = nodes[perRow - 1];
          const b = nodes[perRow];
          if (!b) return null;
          const lit = stateOf(a.id) === 'done' && stateOf(b.id) !== 'idle';
          return (
            <path d={`M ${pos[perRow - 1].x} 30 C ${pos[perRow - 1].x + 7} 30, ${pos[perRow - 1].x + 7} 74, ${pos[perRow].x} 74`} fill="none"
              stroke={lit ? colorOf(b, stateOf(b.id)) : 'transparent'} strokeWidth="3" vectorEffect="non-scaling-stroke" />
          );
        })()}
      </svg>
      {nodes.map((node, i) => {
        const st = stateOf(node.id);
        const c = colorOf(node, st);
        return (
          <div key={node.id} className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center animate-rise" style={{ left: `${pos[i].x}%`, top: `${pos[i].y}%`, animationDelay: `${0.15 + i * 0.06}s` }}>
            <span className="relative grid place-items-center rounded-full bg-white" style={{ width: small ? 20 : 26, height: small ? 20 : 26, border: `${small ? 4 : 5}px solid ${c}` }}>
              {st === 'active' && <span className="absolute -inset-2 rounded-full border animate-ring" style={{ borderColor: c }} />}
            </span>
            {!small && (
              <span className="absolute top-full mt-2 text-center whitespace-nowrap">
                <span className={cx('block font-johnson-text font-medium text-[11px]', st === 'idle' ? 'text-jj-gray-05' : 'text-jj-gray-08')}>{node.label}</span>
                <span className="block font-johnson-text text-[11px]" style={{ color: st === 'idle' ? '#a39992' : c }}>
                  {{ idle: 'Waiting', active: 'Running', done: 'Done', error: 'Failed', halted: 'Halted' }[st]}
                </span>
              </span>
            )}
          </div>
        );
      })}
      <p className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap font-johnson-text font-medium text-[12px] text-jj-gray-06">
        <span className="font-johnson-display font-light text-xl text-jj-gray-08 tabular-nums">{done}/{n}</span> stages done
      </p>
    </div>
  );
}

/** Heartbeat trace whose amplitude follows the CPU load. */
function Trace({ load, color, live }) {
  const amp = 4 + Math.min(100, Number(load) || 0) * 0.22;
  const beat = (x) => `L ${x} 20 L ${x + 3} ${20 - amp} L ${x + 6} ${20 + amp * 0.6} L ${x + 9} 20`;
  let d = 'M 0 20';
  for (let x = 0; x < 200; x += 25) d += ` L ${x + 8} 20 ${beat(x + 8)}`;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full h-7 my-1 overflow-hidden" aria-hidden="true">
      <g className={live ? 'animate-[trace_4s_linear_infinite]' : ''}>
        <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity={live ? 1 : 0.35} />
      </g>
    </svg>
  );
}

/** One lane per service: live trace driven by CPU, plus memory and uptime. */
export function ServicePulse({ services }) {
  return (
    <div className="w-full h-full flex flex-col justify-center gap-2">
      {services.map((s, i) => (
        <div key={s.id} className="rounded-2xl bg-white/85 border border-jj-gray-02 px-4 py-2.5 animate-rise" style={{ animationDelay: `${0.15 + i * 0.1}s` }}>
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 min-w-0 font-johnson-display font-medium text-[14px] text-jj-gray-08">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="truncate">{s.label}</span>
            </p>
            <span className="font-johnson-text font-medium text-[13px] shrink-0" style={{ color: s.color }}>{s.state}</span>
          </div>
          <Trace load={s.cpu} color={s.color} live={s.live} />
          <dl className="flex gap-4 font-johnson-text text-[12px]">
            {[['CPU', s.cpu != null ? `${s.cpu}%` : '—'], ['Mem', s.mem != null ? `${s.mem}%` : '—'], ['Up', s.uptime || '—']].map(([k, v]) => (
              <div key={k} className="flex gap-1.5 min-w-0">
                <dt className="text-jj-gray-06">{k}</dt>
                <dd className="tabular-nums text-jj-gray-08 font-medium truncate">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/** AD groups on the left, roles on the right, each mapping drawn as a curve. */
export function AccessGraph({ groups, roles, links }) {
  const rowY = (i, n) => (n <= 1 ? 50 : 12 + (i * 76) / (n - 1));
  const gy = Object.fromEntries(groups.map((g, i) => [g.id, rowY(i, groups.length)]));
  const ry = Object.fromEntries(roles.map((r, i) => [r.id, rowY(i, roles.length)]));
  return (
    <div className="relative w-full h-full">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden="true">
        {links.filter(([g, r]) => gy[g] != null && ry[r] != null).map(([g, r], i) => {
          const color = roles.find((x) => x.id === r)?.color || '#6e6259';
          return (
            <g key={`${g}-${r}`} className="animate-fade-in" style={{ animationDelay: `${0.3 + i * 0.15}s`, animationFillMode: 'both' }}>
              <path d={`M 38 ${gy[g]} C 50 ${gy[g]}, 50 ${ry[r]}, 62 ${ry[r]}`} fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="6" vectorEffect="non-scaling-stroke" />
              <path d={`M 38 ${gy[g]} C 50 ${gy[g]}, 50 ${ry[r]}, 62 ${ry[r]}`} fill="none" stroke={color} strokeWidth="2" strokeDasharray="4 10" vectorEffect="non-scaling-stroke" className="animate-dash" />
            </g>
          );
        })}
      </svg>
      {groups.map((g) => (
        <div key={g.id} className="absolute left-0 w-[38%] -translate-y-1/2 flex justify-end" style={{ top: `${gy[g.id]}%` }}>
          <span className="inline-flex items-center gap-2 max-w-full h-8 pl-2.5 pr-3 rounded-xl bg-white border border-jj-gray-02 font-johnson-text font-medium text-[12.5px] text-jj-gray-08">
            <span className="w-1.5 h-1.5 rounded-full bg-jj-blue-03 shrink-0" />
            <span className="truncate" title={g.label}>{g.label}</span>
          </span>
        </div>
      ))}
      {roles.map((r) => (
        <div key={r.id} className="absolute right-0 w-[38%] -translate-y-1/2" style={{ top: `${ry[r.id]}%` }}>
          <span className="inline-flex items-center gap-2 max-w-full h-8 pl-2.5 pr-3 rounded-xl font-johnson-text font-medium text-[12.5px] text-white"
            style={{ background: r.color || '#6e6259' }}>
            <span className="truncate" title={r.label}>{r.label}</span>
            {r.count > 0 && <span className="shrink-0 tabular-nums text-white/80">{r.count}</span>}
          </span>
        </div>
      ))}
      <p className="absolute left-0 -top-1 font-johnson-text font-medium text-[12px] text-jj-gray-06">AD groups</p>
      <p className="absolute right-0 -top-1 font-johnson-text font-medium text-[12px] text-jj-gray-06">Roles</p>
    </div>
  );
}
