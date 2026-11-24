/**
 * EPodPipelineViz.jsx
 * ─────────────────────────────────────────────────────────────────────────
 * Elite Ingestion Pipeline Orchestration & Deep Telemetry Canvas.
 */

import React, {
  useState, useEffect, useRef, useMemo,
} from 'react';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import { API_BASE_URL } from '../utils/apiClient';

const API_BASE = API_BASE_URL;

// Regex processing dictionary for telemetry string routing
const RE = {
  processing:   /── Processing:\s+(.+?)\s+\(([0-9.]+)\s*MB\)/,
  modified:     /Modified doc — deleting existing chunks/,
  step1:        /Step 1\/5/,
  step2:        /Step 2\/5.*?(\d+) page workers/,
  step3:        /Step 3\/5/,
  step4:        /Step 4\/5/,
  step5:        /Step 5\/5/,
  pages:        /Pages:\s*(\d+).*?TOC entries:\s*(\d+).*?Has TOC:\s*(True|False)/i,
  ocrPages:     /OCR pages:\s*(\d+).*?Table pages:\s*(\d+)/,
  ocrWorker:    /OCR worker failed page (\d+)/,
  chunks:       /Chunks:\s*(\d+).*?Levels:\s*\{([^}]+)\}/,
  embedProg:    /Embedded (\d+)\/(\d+) chunks.*?rate=([0-9.]+)\/s/,
  embedFinal:   /Embedded:\s*(\d+)\/(\d+)\s+Avg tokens:\s*([0-9.]+)/,
  embedFailed:  /(\d+) chunks have zero vectors/,
  dbSaving:     /Saving to database/,
  success:      /✅ SUCCESS\s*—\s*(\d+) chunks\s+(\d+) pages\s+([0-9.]+)s/,
  failed:       /❌ FAILED:\s*(.+)/,
  pipelineStart:  /EPOD INGESTION PIPELINE/,
  startIngestion: /Starting ingestion:\s*([\d,]+)[^,]*,\s*(\d+) parallel/,
  summaryHeader:  /EPOD PIPELINE RUN SUMMARY/,
  summaryTotal:   /Total files processed\s*:\s*(\d+)/,
  summaryElapsed: /Total elapsed\s*:\s*([0-9.]+)s/,
  summaryStatus:  /\s+(SUCCESS|ERROR|SKIPPED|WOULD_PROCESS)\s*:\s*(\d+)/,
  progress:     /── Progress:\s*([\d,]+)\/([\d,?]+)\s*([0-9.]+%)?.*?rate=([0-9.]+)\s*doc\/s.*?ETA=([^\s|]+)/,
  done:         /── DONE:\s*([\d,]+) docs in ([^\s|]+)/,
  rateLimit:    /Rate-limited.*?waiting (\d+\.?\d*)s/,
  rateLimitEmb: /rate limit/i,
  docWorkers:   /Doc workers\s*:\s*(\d+)/,
  pageWorkers:  /Page workers\s*:\s*(\d+)/,
  visionSlots:  /Vision slots\s*:\s*(\d+)/,
  gptSlots:     /GPT-4o slots\s*:\s*(\d+)/,
  embedSlots:   /Embed slots\s*:\s*(\d+)/,
  queueBuilt:   /Queue built.*?(\d[\d,]*) to process.*?(\d[\d,]*) skipped/,
};

// Topography node definitions and descriptor mappings
const NODES = {
  start:  { id: 'start', step: 'START', label: 'Pipeline Init', icon: '⚡', desc: 'Scan infrastructure storage configurations.', color: '#64748b' },
  pdf:    { id: 'pdf', step: 'STEP 1', label: 'PDF Blueprint', icon: '📄', desc: 'Layout structures, reading paths & TOC compilation.', color: '#6366f1' },
  ocr:    { id: 'ocr', step: 'STEP 2a', label: 'Vision OCR Pool', icon: '👁', desc: 'Google Cloud Vision asynchronous OCR clustering.', color: '#0ea5e9' },
  tables: { id: 'tables', step: 'STEP 2b', label: 'Table Matrix', icon: '⊞', desc: 'pdfplumber schema extractions & GPT mappings.', color: '#38bdf8' },
  chunk:  { id: 'chunk', step: 'STEP 3', label: 'Hierarchical Build', icon: '✂', desc: 'Parent-child semantic relational slicing.', color: '#f59e0b' },
  embed:  { id: 'embed', step: 'STEP 4', label: 'Vector Spaces', icon: '🧠', desc: 'High-density text-embedding-3 arrays.', color: '#a78bfa' },
  db:     { id: 'db', step: 'STEP 5', label: 'Database Core Sync', icon: '🗄', desc: 'pgvector memory state transaction commits.', color: '#10b981' },
  end:    { id: 'end', step: 'END', label: 'Telemetry Aggregation', icon: '🏁', desc: 'Run tracking execution diagnostics logging.', color: '#ec4899' },
};

const INIT_STAGES = () => Object.fromEntries(Object.keys(NODES).map(k => [k, { status: 'idle', meta: {}, pct: 0 }]));
const INIT_DOC    = () => ({ name: null, sizeMb: null, isModified: false });
const INIT_CONFIG = () => ({ docWorkers: null, pageWorkers: null, visionCap: 16, gptCap: 6, embedCap: 12 });
const INIT_SEM    = () => ({ vision: 0, gpt: 0, embed: 0 });

const THEMES = {
  dark: {
    bg: '#05070f', panelBg: 'rgba(11, 17, 32, 0.75)', panelBorder: 'rgba(255, 255, 255, 0.08)', panelShadow: '0 12px 40px rgba(0, 0, 0, 0.6)',
    nodeIdle: 'rgba(22, 30, 49, 0.45)', nodeIdleBdr: 'rgba(255, 255, 255, 0.08)', iconIdleBg: '#131c30', iconIdleBdr: '#223150',
    textPrimary: '#f8fafc', textSecondary: '#cbd5e1', textMuted: '#64748b', textDim: '#475569', arrowIdle: '#1e293b', trackBg: '#0f172a',
    slotOff: '#0b1120', slotOffBdr: '#1e293b', rowAlt: 'rgba(255, 255, 255, 0.025)', rowDivider: 'rgba(255, 255, 255, 0.06)',
    badgeBg: '#161f38', canvasBg: 'radial-gradient(circle, rgba(255,255,255,0.015) 1px, transparent 1px)', statusDone: '#10b981', drawerBg: 'rgba(7, 11, 22, 0.96)',
    terminalBg: '#02040a', logTxt: '#e2e8f0', codeReadout: 'rgba(0, 0, 0, 0.35)'
  },
  light: {
    bg: '#f1f5f9', panelBg: 'rgba(255, 255, 255, 0.92)', panelBorder: 'rgba(15, 23, 42, 0.10)', panelShadow: '0 10px 30px rgba(15, 23, 42, 0.08)',
    nodeIdle: '#ffffff', nodeIdleBdr: '#cbd5e1', iconIdleBg: '#f8fafc', iconIdleBdr: '#e2e8f0',
    textPrimary: '#0f172a', textSecondary: '#334155', textMuted: '#64748b', textDim: '#94a3b8', arrowIdle: '#cbd5e1', trackBg: '#e2e8f0',
    slotOff: '#f1f5f9', slotOffBdr: '#cbd5e1', rowAlt: 'rgba(15, 23, 42, 0.03)', rowDivider: '#e2e8f0',
    badgeBg: '#e2e8f0', canvasBg: 'radial-gradient(circle, rgba(15,23,42,0.04) 1px, transparent 1px)', statusDone: '#059669', drawerBg: 'rgba(255, 255, 255, 0.99)',
    terminalBg: '#0f172a', logTxt: '#f8fafc', codeReadout: 'rgba(15, 23, 42, 0.04)'
  },
};

const num = s => parseInt((s || '0').replace(/,/g, ''), 10);

function parseLine(line, { setStages, setDoc, setQueue, setHistory, setRateLimit, setConfig, setSem, setRateHistory, docNameRef, setRawLogs }) {
  setRawLogs(prev => [...prev, { text: line, timestamp: new Date().toLocaleTimeString() }].slice(-150));

  let m;
  if ((m = line.match(RE.docWorkers)))  { setConfig(c => ({ ...c, docWorkers:  parseInt(m[1]) })); return; }
  if ((m = line.match(RE.pageWorkers))) { setConfig(c => ({ ...c, pageWorkers: parseInt(m[1]) })); return; }
  if ((m = line.match(RE.visionSlots))) { setConfig(c => ({ ...c, visionCap:  parseInt(m[1]) })); return; }
  if ((m = line.match(RE.gptSlots)))    { setConfig(c => ({ ...c, gptCap:     parseInt(m[1]) })); return; }
  if ((m = line.match(RE.embedSlots)))  { setConfig(c => ({ ...c, embedCap:   parseInt(m[1]) })); return; }

  if (RE.pipelineStart.test(line)) {
    setStages(s => ({ ...s, start: { status: 'active', meta: {}, pct: 0 } }));
    return;
  }
  if ((m = line.match(RE.startIngestion))) {
    setStages(s => ({ ...s, start: { status: 'done', meta: { docs: m[1], workers: m[2] }, pct: 100 } }));
    setQueue(q => ({ ...q, total: num(m[1]) }));
    return;
  }
  if (RE.summaryHeader.test(line)) {
    setStages(s => ({ ...s, db: { ...s.db, status: s.db.status === 'active' ? 'done' : s.db.status }, end: { status: 'active', meta: {}, pct: 0 } }));
    return;
  }
  if ((m = line.match(RE.summaryTotal))) {
    setStages(s => ({ ...s, end: { ...s.end, meta: { ...s.end.meta, total: m[1] } } }));
    return;
  }
  if ((m = line.match(RE.summaryElapsed))) {
    setStages(s => ({ ...s, end: { status: 'done', meta: { ...s.end.meta, elapsed: m[1] }, pct: 100 } }));
    setSem(INIT_SEM());
    return;
  }
  if ((m = line.match(RE.summaryStatus))) {
    setStages(s => ({ ...s, end: { ...s.end, meta: { ...s.end.meta, [m[1].toLowerCase()]: m[2] } } }));
    return;
  }
  if ((m = line.match(RE.queueBuilt))) {
    setQueue(q => ({ ...q, total: num(m[1]), skipped: num(m[2]) }));
    return;
  }
  if ((m = line.match(RE.processing))) {
    setStages(INIT_STAGES());
    if (docNameRef) docNameRef.current = m[1];
    setDoc({ name: m[1], sizeMb: parseFloat(m[2]), isModified: false });
    setRateLimit(null);
    setSem(INIT_SEM());
    return;
  }
  if (RE.modified.test(line)) {
    setDoc(d => ({ ...d, isModified: true }));
    return;
  }
  if (RE.step1.test(line)) {
    setStages(s => ({ ...s, pdf: { status: 'active', meta: {}, pct: 0 } }));
    return;
  }
  if ((m = line.match(RE.step2))) {
    const pWorkers = m[1] ? parseInt(m[1]) : null;
    setStages(s => ({ ...s, pdf: { ...s.pdf, status: 'done' }, ocr: { status: 'active', meta: { pWorkers }, pct: 0 }, tables: { status: 'active', meta: {}, pct: 0 } }));
    setSem(sm => ({ ...sm, vision: Math.min(sm.vision + (pWorkers || 4), 16) }));
    return;
  }
  if (RE.step3.test(line)) {
    setStages(s => ({ ...s, ocr: { ...s.ocr, status: 'done' }, tables: { ...s.tables, status: 'done' }, chunk: { status: 'active', meta: {}, pct: 0 } }));
    setSem(sm => ({ ...sm, vision: 0, gpt: 0 }));
    return;
  }
  if (RE.step4.test(line)) {
    setStages(s => ({ ...s, chunk: { ...s.chunk, status: 'done' }, embed: { status: 'active', meta: {}, pct: 0 } }));
    setSem(sm => ({ ...sm, embed: 8 }));
    return;
  }
  if (RE.step5.test(line)) {
    setStages(s => ({ ...s, embed: { ...s.embed, status: 'done' }, db: { status: 'active', meta: {}, pct: 0 } }));
    setSem(INIT_SEM());
    return;
  }
  if ((m = line.match(RE.pages))) {
    setStages(s => ({ ...s, pdf: { ...s.pdf, meta: { pages: m[1], tocEntries: m[2], hasToc: m[3] }, pct: 100 } }));
    return;
  }
  if ((m = line.match(RE.ocrPages))) {
    const tablePgs = parseInt(m[2]);
    setStages(s => ({
      ...s,
      ocr: { ...s.ocr, status: 'done', meta: { ...s.ocr.meta, ocrPages: m[1] }, pct: 100 },
      tables: { ...s.tables, status: tablePgs > 0 ? 'active' : 'done', meta: { tablePgs: m[2] }, pct: tablePgs > 0 ? 40 : 100 },
    }));
    setSem(sm => ({ ...sm, gpt: tablePgs > 0 ? Math.min(tablePgs, 6) : 0 }));
    return;
  }
  if ((m = line.match(RE.chunks))) {
    setStages(s => ({ ...s, chunk: { ...s.chunk, meta: { count: m[1], levels: m[2] }, pct: 100 } }));
    return;
  }
  if ((m = line.match(RE.embedProg))) {
    const done  = num(m[1]);
    const total = num(m[2]);
    setStages(s => ({ ...s, embed: { ...s.embed, meta: { ...s.embed.meta, done: m[1], total: m[2], rate: m[3] }, pct: total > 0 ? Math.round(done / total * 100) : 0 } }));
    return;
  }
  if ((m = line.match(RE.embedFinal))) {
    setStages(s => ({ ...s, embed: { ...s.embed, meta: { done: m[1], total: m[2], avgTokens: m[3] }, pct: 100 } }));
    return;
  }
  if ((m = line.match(RE.embedFailed))) {
    setStages(s => ({ ...s, embed: { ...s.embed, meta: { ...s.embed.meta, zeroVecs: m[1] } } }));
    return;
  }
  if ((m = line.match(RE.rateLimit))) {
    setRateLimit(`Rate-limit — pause ${m[1]}s`);
    return;
  }
  if ((m = line.match(RE.success))) {
    setStages(s => ({
      ...s, pdf: { ...s.pdf, status: 'done' }, ocr: { ...s.ocr, status: 'done' }, tables: { ...s.tables, status: 'done' },
      chunk: { ...s.chunk, status: 'done' }, embed: { ...s.embed, status: 'done' },
      db: { status: 'done', meta: { chunks: m[1], pages: m[2], elapsed: m[3] }, pct: 100 },
    }));
    setSem(INIT_SEM()); setRateLimit(null);
    const _sName = docNameRef?.current || '(unknown)';
    setHistory(h => [{ name: _sName, status: 'SUCCESS', chunks: m[1], pages: m[2], elapsed: m[3], ts: new Date().toLocaleTimeString() }, ...h].slice(0, 40));
    return;
  }
  if ((m = line.match(RE.failed))) {
    setStages(s => {
      const next = { ...s };
      for (const id of ['db', 'embed', 'chunk', 'tables', 'ocr', 'pdf']) {
        if (next[id].status === 'active') { next[id] = { ...next[id], status: 'error', meta: { ...next[id].meta, error: m[1] } }; break; }
      }
      return next;
    });
    setSem(INIT_SEM());
    const _fName = docNameRef?.current || '(unknown)';
    setHistory(h => [{ name: _fName, status: 'ERROR', error: m[1], ts: new Date().toLocaleTimeString() }, ...h].slice(0, 40));
    return;
  }
  if ((m = line.match(RE.progress))) {
    const currentRate = parseFloat(m[4]);
    setQueue(q => ({ ...q, done: num(m[1]), total: m[2] === '?' ? q.total : num(m[2]), pct: m[3] || null, rate: m[4], eta: m[5], finished: false }));
    if (!isNaN(currentRate)) { setRateHistory(prev => [...prev, currentRate].slice(-35)); }
    return;
  }
  if ((m = line.match(RE.done))) {
    setQueue(q => ({ ...q, done: num(m[1]), eta: '0s', finished: true }));
  }
}

// ── NEW SUB-COMPONENT: REAL-TIME TREND VELOCITY SPARKLINE ────────────────────────
function Sparkline({ data, color }) {
  if (data.length < 2) return null;
  const width = 140; const height = 24;
  const max = Math.max(...data) * 1.1 || 1;
  const min = Math.min(...data) * 0.9 || 0;
  const points = data.map((val, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - ((val - min) / (max - min || 1)) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} style={{ overflow: 'visible', opacity: 0.85 }}>
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

// ── NEW SUB-COMPONENT: ISOLATED RE-RENDER PIPELINE NODE ──────────────────────────
function PipelineNode({ node, state, T, isDark, onSelect, isSelected, onHover }) {
  const { status, pct } = state;
  const isActive = status === 'active'; const isDone = status === 'done'; const isError = status === 'error'; const isIdle = status === 'idle';

  const borderColor = isError ? '#ef4444' : isDone ? node.color : isActive ? node.color : T.nodeIdleBdr;
  const bgColor = isError ? (isDark ? 'rgba(239, 68, 68, 0.06)' : '#fef2f2') : isDone ? `${node.color}08` : isActive ? `${node.color}12` : T.nodeIdle;
  const readableStatusTag = isActive ? '[RUNNING]' : isDone ? '[STABLE]' : isError ? '[HALTED]' : '[IDLE]';

  return (
    <div
      onClick={() => onSelect({ node, state })}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      className={`pipeline-node ${isActive ? 'node-active' : ''}`}
      style={{
        width: 174, flexShrink: 0, border: `1px solid ${borderColor}`, borderRadius: 12, padding: '14px 12px',
        background: bgColor, transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)', backdropFilter: 'blur(8px)',
        boxShadow: isActive ? `0 0 30px ${node.color}33, 0 10px 20px -4px ${node.color}22` : isSelected ? `0 0 0 2px ${node.color}` : 'none',
        position: 'relative', overflow: 'hidden', cursor: 'pointer', transform: isSelected ? 'scale(1.02)' : 'none'
      }}
    >
      {isActive && <div style={{ position: 'absolute', inset: 0, borderRadius: 11, background: `linear-gradient(90deg, transparent, ${node.color}15, transparent)`, animation: 'shimmer 1.5s infinite', pointerEvents: 'none' }} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: isIdle ? T.iconIdleBg : `${node.color}18`, border: `1px solid ${isIdle ? T.iconIdleBdr : node.color}44`, color: isIdle ? T.textMuted : node.color,
          boxShadow: isActive ? `0 0 12px ${node.color}44` : 'none', transform: isActive ? 'scale(1.08)' : 'none', transition: 'transform 0.2s ease'
        }}>{isError ? '✕' : isDone ? '✓' : node.icon}</div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
          <div style={{ fontSize: 8.5, fontWeight: 700, color: isIdle ? T.textDim : node.color, letterSpacing: 0.7, textTransform: 'uppercase' }}>{node.step}</div>
          <span style={{ fontSize: 7, fontWeight: 600, fontFamily: 'monospace', color: isError ? '#ef4444' : isDone ? T.statusDone : isActive ? node.color : T.textDim }}>{readableStatusTag}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: isIdle ? T.textSecondary : isError ? '#ef4444' : T.textPrimary, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.label}</div>
      <div style={{ fontSize: 9.5, color: T.textMuted, lineHeight: 1.4, height: 26, overflow: 'hidden' }}>{node.desc}</div>
      {pct > 0 && (isActive || isDone) && (
        <div style={{ marginTop: 8, height: 4, background: T.trackBg, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: node.color, transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }} />
        </div>
      )}
    </div>
  );
}

// ── NEW SUB-COMPONENT: REFLOW-READY INTEGRATED CANVASTOPOGRAPHY ────────────────
function TopologyCanvas({ stages, T, isDark, onSelectNode, selectedNodeId, onActiveHoverChange }) {
  const getBranchColor = (n1, n2, targetActive) => {
    if (stages[n1].status === 'error' || stages[n2].status === 'error') return '#ef4444';
    if (stages[n1].status === 'done' && targetActive) return NODES[n2].color;
    if (stages[n1].status === 'done' && stages[n2].status === 'done') return T.statusDone;
    if (stages[n1].status === 'active') return NODES[n1].color;
    return T.arrowIdle;
  };

  const isFlowing = (n1, n2) => {
    return stages[n1].status === 'active' || (stages[n1].status === 'done' && stages[n2].status === 'active');
  };

  return (
    <div className="topology-grid-layout" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, position: 'relative', width: '100%', padding: '32px 0' }}>

      <PipelineNode node={NODES.start} state={stages.start} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.start.id} onHover={onActiveHoverChange} />

      <div className="canvas-horiz-connector" style={{ width: 34, height: 2, position: 'relative', overflow: 'hidden', background: T.arrowIdle }}>
        <div style={{
          position: 'absolute', inset: 0, background: getBranchColor('start', 'pdf', stages.pdf.status === 'active'),
          animation: isFlowing('start', 'pdf') ? 'lineFlow 1s linear infinite' : 'none',
          backgroundImage: isFlowing('start', 'pdf') ? `linear-gradient(90deg, transparent 0%, ${NODES.pdf.color} 50%, transparent 100%)` : 'none',
          backgroundSize: '200% 100%'
        }} />
      </div>

      <PipelineNode node={NODES.pdf} state={stages.pdf} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.pdf.id} onHover={onActiveHoverChange} />

      <div className="canvas-fork-container" style={{ position: 'relative', width: 44, height: 130, flexShrink: 0 }}>
        <svg width="44" height="130" style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
          <path d="M 0 65 Q 20 65, 22 25 T 44 25" fill="none" stroke={getBranchColor('pdf', 'ocr', stages.ocr.status === 'active')} strokeWidth="2"
                strokeDasharray={isFlowing('pdf', 'ocr') ? "4 4" : "none"} style={{ animation: isFlowing('pdf', 'ocr') ? 'svgFlow 0.5s linear infinite' : 'none' }} />
          <path d="M 0 65 Q 20 65, 22 105 T 44 105" fill="none" stroke={getBranchColor('pdf', 'tables', stages.tables.status === 'active')} strokeWidth="2"
                strokeDasharray={isFlowing('pdf', 'tables') ? "4 4" : "none"} style={{ animation: isFlowing('pdf', 'tables') ? 'svgFlow 0.5s linear infinite' : 'none' }} />
        </svg>
      </div>

      <div className="canvas-stack-column" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PipelineNode node={NODES.ocr} state={stages.ocr} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.ocr.id} onHover={onActiveHoverChange} />
        <PipelineNode node={NODES.tables} state={stages.tables} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.tables.id} onHover={onActiveHoverChange} />
      </div>

      <div className="canvas-fork-container" style={{ position: 'relative', width: 44, height: 130, flexShrink: 0 }}>
        <svg width="44" height="130" style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
          <path d="M 0 25 Q 22 25, 24 65 T 44 65" fill="none" stroke={getBranchColor('ocr', 'chunk', stages.chunk.status === 'active')} strokeWidth="2"
                strokeDasharray={isFlowing('ocr', 'chunk') ? "4 4" : "none"} style={{ animation: isFlowing('ocr', 'chunk') ? 'svgFlow 0.5s linear infinite' : 'none' }} />
          <path d="M 0 105 Q 22 105, 24 65 T 44 65" fill="none" stroke={getBranchColor('tables', 'chunk', stages.chunk.status === 'active')} strokeWidth="2"
                strokeDasharray={isFlowing('tables', 'chunk') ? "4 4" : "none"} style={{ animation: isFlowing('tables', 'chunk') ? 'svgFlow 0.5s linear infinite' : 'none' }} />
        </svg>
      </div>

      <div className="canvas-linear-group" style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <PipelineNode node={NODES.chunk} state={stages.chunk} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.chunk.id} onHover={onActiveHoverChange} />
        <div className="canvas-horiz-connector" style={{ width: 34, height: 2, position: 'relative', overflow: 'hidden', background: T.arrowIdle }}>
          <div style={{ position: 'absolute', inset: 0, background: getBranchColor('chunk', 'embed', stages.embed.status === 'active'), animation: isFlowing('chunk', 'embed') ? 'lineFlow 1s linear infinite' : 'none', backgroundImage: isFlowing('chunk', 'embed') ? `linear-gradient(90deg, transparent 0%, ${NODES.embed.color} 50%, transparent 100%)` : 'none', backgroundSize: '200% 100%' }} />
        </div>

        <PipelineNode node={NODES.embed} state={stages.embed} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.embed.id} onHover={onActiveHoverChange} />
        <div className="canvas-horiz-connector" style={{ width: 34, height: 2, position: 'relative', overflow: 'hidden', background: T.arrowIdle }}>
          <div style={{ position: 'absolute', inset: 0, background: getBranchColor('embed', 'db', stages.db.status === 'active'), animation: isFlowing('embed', 'db') ? 'lineFlow 1s linear infinite' : 'none', backgroundImage: isFlowing('embed', 'db') ? `linear-gradient(90deg, transparent 0%, ${NODES.db.color} 50%, transparent 100%)` : 'none', backgroundSize: '200% 100%' }} />
        </div>

        <PipelineNode node={NODES.db} state={stages.db} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.db.id} onHover={onActiveHoverChange} />
        <div className="canvas-horiz-connector" style={{ width: 34, height: 2, position: 'relative', overflow: 'hidden', background: T.arrowIdle }}>
          <div style={{ position: 'absolute', inset: 0, background: getBranchColor('db', 'end', stages.end.status === 'active'), animation: isFlowing('db', 'end') ? 'lineFlow 1s linear infinite' : 'none', backgroundImage: isFlowing('db', 'end') ? `linear-gradient(90deg, transparent 0%, ${NODES.end.color} 50%, transparent 100%)` : 'none', backgroundSize: '200% 100%' }} />
        </div>

        <PipelineNode node={NODES.end} state={stages.end} T={T} isDark={isDark} onSelect={onSelectNode} isSelected={selectedNodeId === NODES.end.id} onHover={onActiveHoverChange} />
      </div>

    </div>
  );
}

// ── NEW SUB-COMPONENT: REAL-TIME DEEP TELEMETRY DIAGNOSTIC DRAWER ───────────────
function DiagnosticDrawer({ selection, onClose, T }) {
  if (!selection) return null;
  const { node, state } = selection;
  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 400, background: T.drawerBg, borderLeft: `1px solid ${T.panelBorder}`,
      boxShadow: '-15px 0 45px rgba(0,0,0,0.35)', zIndex: 100, padding: 28, display: 'flex', flexDirection: 'column', gap: 24, backdropFilter: 'blur(30px)',
      animation: 'slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 9, fontWeight: 700, color: node.color, letterSpacing: 1.5 }}>{node.step} TELEMETRY</span>
          <h2 style={{ margin: '2px 0 0 0', fontSize: 18, fontWeight: 600, color: T.textPrimary }}>{node.label}</h2>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.textMuted, fontSize: 20, cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%' }} className="close-btn">✕</button>
      </div>

      <div style={{ background: T.nodeIdle, border: `1px solid ${T.panelBorder}`, borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 6, fontWeight: 600, letterSpacing: 0.5 }}>RUNTIME STATUS</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: state.status === 'active' ? node.color : state.status === 'done' ? T.statusDone : state.status === 'error' ? '#ef4444' : T.textMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ animation: state.status === 'active' ? 'pulseRing 1.5s infinite' : 'none', display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'currentColor' }} />
          <span style={{ textTransform: 'uppercase' }}>{state.status} {state.pct > 0 ? `(${state.pct}%)` : ''}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 8, fontWeight: 600, letterSpacing: 0.5 }}>STATE READOUT VALUES</div>
        <div style={{ flex: 1, background: T.codeReadout, fontFamily: 'monospace', fontSize: 11.5, padding: 16, borderRadius: 10, border: `1px solid ${T.panelBorder}`, color: T.textSecondary, overflowY: 'auto', lineHeight: 1.5 }}>
          {Object.keys(state.meta || {}).length === 0 ? (
            <span style={{ color: T.textDim }}>// No metadata descriptors loaded for context state</span>
          ) : (
            JSON.stringify(state.meta, null, 2)
          )}
        </div>
      </div>

      {state.status === 'error' && (
        <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: '#f87171', fontWeight: 600, marginBottom: 6, letterSpacing: 0.5 }}>STACK ERROR MONITOR TRACE</div>
          <div style={{ fontSize: 11.5, color: '#ef4444', fontFamily: 'monospace', lineHeight: 1.5 }}>{state.meta?.error || 'Unknown critical instruction exception fault.'}</div>
        </div>
      )}
    </div>
  );
}

export default function EPodPipelineViz({ proxyBase, title, lineRef, sseStatus: externalSseStatus }) {
  const base = `${API_BASE}${proxyBase}`;
  const { user, getAccessToken } = useAuth();
  const email = user?.email || user?.username || 'unknown';

  const [stages, setStages] = useState(INIT_STAGES);
  const [doc, setDoc] = useState(INIT_DOC);
  const [queue, setQueue] = useState({});
  const [history, setHistory] = useState([]);
  const [rateLimit, setRateLimit] = useState(null);
  const [config, setConfig] = useState(INIT_CONFIG);
  const [sem, setSem] = useState(INIT_SEM);
  const [rateHistory, setRateHistory] = useState([]);
  const [sseStatus, setSseStatus] = useState('off');
  const [themeKey, setThemeKey] = useState(() => { try { return localStorage.getItem('epod-viz-theme') || 'dark'; } catch { return 'dark'; } });
  const [drawerSelect, setDrawerSelect] = useState(null);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const [rawLogs, setRawLogs] = useState([]);
  const [showConsole, setShowConsole] = useState(false);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);

  const T = THEMES[themeKey] || THEMES.dark;
  const isDark = themeKey === 'dark';
  const docNameRef = useRef(null);
  const logContainerRef = useRef(null);

  useEffect(() => {
    if (autoScrollLogs && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [rawLogs, autoScrollLogs, showConsole]);

  useEffect(() => {
    const id = 'epod-viz-kf-advanced'; if (document.getElementById(id)) return;
    const s = document.createElement('style'); s.id = id;
    s.textContent = `
      @keyframes pulseRing { 0%{box-shadow:0 0 0 0 rgba(99,102,241,0.5); opacity: 0.6;} 70%{box-shadow:0 0 0 8px rgba(99,102,241,0); opacity: 1;} 100%{box-shadow:0 0 0 0 rgba(99,102,241,0); opacity: 0.6;} }
      @keyframes pulseGreen { 0%{box-shadow:0 0 0 0 rgba(16,185,129,0.5);} 70%{box-shadow:0 0 0 6px rgba(16,185,129,0);} 100%{box-shadow:0 0 0 0 rgba(16,185,129,0);} }
      @keyframes shimmer   { 0%{transform:translateX(-150%)} 100%{transform:translateX(150%)} }
      @keyframes lineFlow  { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
      @keyframes svgFlow   { from { stroke-dashoffset: 8; } to { stroke-dashoffset: 0; } }
      @keyframes slideIn   { from { transform: translateX(100%); } to { transform: translateX(0); } }
      
      .pipeline-node:hover { transform: translateY(-3px) scale(1.01); box-shadow: 0 12px 24px -6px rgba(0,0,0,0.25) !important; }
      [data-theme="dark"] .pipeline-node:hover { border-color: rgba(255,255,255,0.18) !important; }
      [data-theme="light"] .pipeline-node:hover { border-color: rgba(15,23,42,0.22) !important; }
      .filter-btn { border: 1px solid transparent; background: none; cursor: pointer; padding: 5px 12px; borderRadius: 6px; fontSize: 10px; font-weight: 600; transition: all 0.2s; }
      .filter-btn:hover { opacity: 0.85; }
      .interactive-input { transition: all 0.2s ease; }
      .interactive-input:focus { border-color: #6366f1 !important; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
      [data-theme="dark"] .close-btn:hover { background: rgba(255,255,255,0.08); color: #ef4444 !important; }
      [data-theme="light"] .close-btn:hover { background: rgba(15,23,42,0.06); color: #ef4444 !important; }
      .history-row { transition: background 0.2s ease; }
      [data-theme="dark"] .history-row:hover { background: rgba(255,255,255,0.04) !important; }
      [data-theme="light"] .history-row:hover { background: rgba(15,23,42,0.04) !important; }

      /* Responsive Media Topology Restructuring Framework */
      .topology-grid-layout { min-width: 1040px; }
      @media (max-width: 1100px) {
        .topology-grid-layout { flex-direction: column !important; min-width: 100% !important; gap: 20px !important; padding: 16px 0 !important; }
        .canvas-horiz-connector { width: 2px !important; height: 24px !important; }
        .canvas-fork-container { width: 100% !important; height: 32px !important; display: flex; justify-content: center; }
        .canvas-fork-container svg { width: 100px !important; height: 32px !important; position: relative !important; }
        .canvas-fork-container svg path:nth-child(1) { d: path("M 50 0 L 15 32") !important; }
        .canvas-fork-container svg path:nth-child(2) { d: path("M 50 0 L 85 32") !important; }
        .canvas-fork-container:nth-of-type(2) svg path:nth-child(1) { d: path("M 15 0 L 50 32") !important; }
        .canvas-fork-container:nth-of-type(2) svg path:nth-child(2) { d: path("M 85 0 L 50 32") !important; }
        .canvas-stack-column { flex-direction: row !important; gap: 16px !important; justify-content: center; width: 100%; }
        .canvas-linear-group { flex-direction: column !important; width: 100%; gap: 20px !important; }
      }
    `;
    document.head.appendChild(s);
  }, []);

  // Prefer the shared connection status from EPodAgentPage; fall back to own when standalone
  const displaySseStatus = externalSseStatus ?? sseStatus;

  // ── When EPodAgentPage owns the SSE, register as its line handler ──────────
  useEffect(() => {
    if (!lineRef) return;
    lineRef.current = (line) => {
      parseLine(line, { setStages, setDoc, setQueue, setHistory, setRateLimit, setConfig, setSem, setRateHistory, docNameRef, setRawLogs });
    };
    return () => { if (lineRef) lineRef.current = null; };
  }, []); // lineRef is a stable ref object — registering once on mount is correct

  // ── Fallback own SSE — only used when rendered without a parent lineRef ────
  useEffect(() => {
    if (lineRef) return; // parent manages the connection

    let es = null;
    let retryTimer = null;
    let unmounted = false;

    const openSSE = async () => {
      if (unmounted) return;
      let token = '';
      try { token = await getAccessToken(); } catch { /* server will reject, that's fine */ }
      if (unmounted) return;
      es = new EventSource(`${base}/terminal/stream?access_token=${encodeURIComponent(token)}`);
      setSseStatus('connecting');
      es.onopen = () => setSseStatus('connected');
      es.onmessage = e => {
        if (e.data) parseLine(e.data, { setStages, setDoc, setQueue, setHistory, setRateLimit, setConfig, setSem, setRateHistory, docNameRef, setRawLogs });
      };
      es.onerror = () => {
        es.close();
        setSseStatus('error');
        if (!unmounted) retryTimer = setTimeout(openSSE, 4000);
      };
    };

    openSSE();
    return () => {
      unmounted = true;
      clearTimeout(retryTimer);
      es?.close();
      setSseStatus('off');
    };
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredHistory = useMemo(() => {
    return history.filter(h => {
      const matchesSearch = h.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'ALL' || h.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [history, searchQuery, statusFilter]);

  // Debounced audit log for the artifact filter input — mirrors the NAS
  // scanner's segment-filter pattern. isFirstRun skips the mount-time fire
  // (searchQuery === '') since that's not a user action.
  const isFirstSearchRun = useRef(true);
  useEffect(() => {
    const t = setTimeout(() => {
      if (isFirstSearchRun.current) {
        isFirstSearchRun.current = false;
        return;
      }
      logAuditEvent(
        'in-page-extraction-pipelines', email, proxyBase,
        searchQuery ? `Filtered artifacts by "${searchQuery}" on ${title || proxyBase}` : `Cleared artifact filter on ${title || proxyBase}`
      );
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery, email, proxyBase, title]);

  const handleStatusFilterChange = (f) => {
    if (f === statusFilter) return;
    setStatusFilter(f);
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Filtered ledger by "${f}" on ${title || proxyBase}`);
  };

  const handleToggleConsole = () => {
    const next = !showConsole;
    setShowConsole(next);
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `${next ? 'View Stream Console' : 'Hide Stream Console'} clicked on ${title || proxyBase}`);
  };

  const handleToggleTail = (checked) => {
    setAutoScrollLogs(checked);
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `Tail Output Logs ${checked ? 'enabled' : 'disabled'} on ${title || proxyBase}`);
  };

  const handleToggleTheme = () => {
    const nextTheme = isDark ? 'light' : 'dark';
    setThemeKey(nextTheme);
    try { localStorage.setItem('epod-viz-theme', nextTheme); } catch(e){}
    logAuditEvent('in-page-extraction-pipelines', email, proxyBase, `${nextTheme === 'dark' ? 'Dark mode' : 'Light mode'} clicked on ${title || proxyBase}`);
  };

  const activeHoverNode = NODES[hoveredNodeId];
  const activeHoverStage = stages[hoveredNodeId];

  return (
    <div data-theme={themeKey} style={{ minHeight: '100%', background: T.bg, padding: '24px', display: 'flex', flexDirection: 'column', gap: 20, transition: 'background 0.3s ease', position: 'relative', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>

      {/* Structural Flyout Telemetry Drawer Context */}
      <DiagnosticDrawer selection={drawerSelect} onClose={() => setDrawerSelect(null)} T={T} />

      {/* Primary Global Dashboard Nav Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: T.textPrimary, letterSpacing: '-0.01em' }}>
            {title} <span style={{ fontWeight: 300, color: T.textMuted }}>/ Advanced Processing Topography</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={handleToggleConsole} style={{ background: showConsole ? '#6366f1' : T.panelBg, border: `1px solid ${showConsole ? '#6366f1' : T.panelBorder}`, color: showConsole ? '#ffffff' : T.textSecondary, padding: '6px 14px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', boxShadow: '0 2px 6px rgba(0,0,0,0.05)' }}>
            ⚙️ {showConsole ? 'Hide Stream Console' : 'View Stream Console'}
          </button>
          <button onClick={handleToggleTheme} style={{ background: T.panelBg, border: `1px solid ${T.panelBorder}`, color: T.textSecondary, padding: '6px 14px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', boxShadow: '0 2px 6px rgba(0,0,0,0.05)' }}>
            {isDark ? '☀️ Light Engine' : '🌙 Core Midnight'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.badgeBg, border: `1px solid ${T.panelBorder}`, padding: '5px 12px', borderRadius: 20 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: displaySseStatus === 'connected' ? T.statusDone : '#ef4444', animation: displaySseStatus === 'connected' ? 'pulseGreen 2s infinite' : 'none' }} />
            <span style={{ fontSize: 10, color: T.textSecondary, fontWeight: 600, letterSpacing: 0.3 }}>{displaySseStatus === 'connected' ? 'LIVE SYNCED' : 'DISCONNECTED'}</span>
          </div>
        </div>
      </div>

      {/* Collapsible Under-the-Hood Terminal Shell */}
      {showConsole && (
        <div style={{ background: T.terminalBg, border: `1px solid ${T.panelBorder}`, borderRadius: 12, padding: 14, boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8), 0 10px 30px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${T.panelBorder}`, paddingBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
              <span style={{ fontSize: 10, color: T.textMuted, fontFamily: 'monospace', fontWeight: 600, marginLeft: 4 }}>EPOD_TERMINAL_STREAM_FEED.log</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: T.textMuted, fontFamily: 'monospace', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoScrollLogs} onChange={e => handleToggleTail(e.target.checked)} style={{ accentColor: '#6366f1' }} />
              Tail Output Logs
            </label>
          </div>
          <div ref={logContainerRef} style={{ height: 160, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, color: T.logTxt, lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 4 }}>
            {rawLogs.length === 0 ? (
              <div style={{ color: T.textDim, fontStyle: 'italic' }}>// Awaiting initialization packets from the log router pipeline...</div>
            ) : (
              rawLogs.map((log, index) => {
                let color = T.logTxt;
                if (/SUCCESS|✅/i.test(log.text)) color = T.statusDone;
                else if (/FAILED|❌|Error/i.test(log.text)) color = '#f87171';
                else if (/Step \d/i.test(log.text)) color = '#6366f1';
                return (
                  <div key={index} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <span style={{ color: T.textDim, flexShrink: 0, userSelect: 'none' }}>[{log.timestamp}]</span>
                    <span style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log.text}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Global Ingestion Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ padding: '16px', background: T.panelBg, border: `1px solid ${T.panelBorder}`, borderRadius: 14, boxShadow: T.panelShadow, display: 'flex', alignItems: 'center', gap: 14, backdropFilter: 'blur(12px)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700, letterSpacing: 0.6, marginBottom: 4 }}>ACTIVE DATA PIPELINE STREAM TARGET</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: doc.name ? T.textPrimary : T.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.name || 'Awaiting transactional ingestion broadcast data...'}
            </div>
          </div>
          {doc.sizeMb && <span style={{ fontSize: 10, fontWeight: 600, background: isDark ? 'rgba(99,102,241,0.15)' : '#e0e7ff', color: '#6366f1', padding: '5px 10px', borderRadius: 8 }}>{doc.sizeMb} MB</span>}
        </div>

        <div style={{ padding: '16px', background: T.panelBg, border: `1px solid ${T.panelBorder}`, borderRadius: 14, boxShadow: T.panelShadow, display: 'flex', alignItems: 'center', justifyContent: 'space-between', backdropFilter: 'blur(12px)' }}>
          <div>
            <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700, letterSpacing: 0.6, marginBottom: 4 }}>BATCH THROUGHPUT TRACKING</div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: T.textPrimary }}>
              {queue.done ?? '0'} <span style={{ color: T.textMuted, fontWeight: 400, fontSize: 11.5 }}>/ {queue.total || '0'} docs</span>
              {queue.rate && <span style={{ color: '#6366f1', fontSize: 11.5, marginLeft: 10, fontWeight: 600 }}>@{queue.rate} doc/s</span>}
            </div>
          </div>
          {rateHistory.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <Sparkline data={rateHistory} color="#6366f1" />
              <span style={{ fontSize: 8, color: T.textMuted, fontWeight: 700, letterSpacing: 0.3 }}>VELOCITY COEFFICIENT INDEX</span>
            </div>
          )}
        </div>
      </div>

      {/* STICKY TOPOGRAPHY CONTAINER & INTEGRATED BROADCAST BAR HEADER */}
      <div style={{ background: T.panelBg, border: `1px solid ${T.panelBorder}`, boxShadow: T.panelShadow, borderRadius: 16, overflowX: 'auto', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: T.canvasBg, pointerEvents: 'none' }} />

        {/* Unified Broadcast Header Bar */}
        <div style={{
          height: 38, borderBottom: `1px solid ${T.panelBorder}`, display: 'flex', alignItems: 'center',
          padding: '0 20px', zIndex: 10, background: 'rgba(0,0,0,0.08)', fontFamily: 'monospace', fontSize: 11, color: T.textSecondary
        }}>
          {activeHoverNode && activeHoverStage ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, animation: 'fadeIn 0.15s ease' }}>
              <span style={{ color: activeHoverNode.color, fontWeight: 700 }}>🔍 {activeHoverNode.label} Telemetry:</span>
              <span>
                {activeHoverStage.status === 'idle' && 'Awaiting operational context.'}
                {activeHoverStage.status === 'error' && `Fault: ${activeHoverStage.meta?.error || 'Exception handler drop'}`}
                {activeHoverStage.status !== 'idle' && activeHoverStage.status !== 'error' && (Object.keys(activeHoverStage.meta || {}).length === 0 ? 'Execution standard initialization.' : Object.entries(activeHoverStage.meta).map(([k, v]) => `${k}: ${v}`).join(' | '))}
              </span>
            </div>
          ) : (
            <span style={{ color: T.textDim }}>// Hover over an active pipeline step node to preview live telemetry data metrics...</span>
          )}
        </div>

        {/* Modular Topology Layout Canvas Map */}
        <TopologyCanvas
          stages={stages} T={T} isDark={isDark}
          onSelectNode={setDrawerSelect} selectedNodeId={drawerSelect?.node?.id}
          onActiveHoverChange={setHoveredNodeId}
        />
      </div>

      {/* Resource Allocation Capacitors Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {[
          { label: 'GOOGLE VISION CAPACITOR', current: sem.vision, cap: config.visionCap, color: '#0ea5e9' },
          { label: 'OPENAI MODEL DEPLOYMENT CAP', current: sem.gpt, cap: config.gptCap, color: '#10b981' },
          { label: 'INFERENCE BATCH VECTOR BOUND', current: sem.embed, cap: config.embedCap, color: '#a78bfa' },
        ].map(s => (
          <div key={s.label} style={{ background: T.panelBg, border: `1px solid ${T.panelBorder}`, borderRadius: 12, padding: 14, boxShadow: T.panelShadow }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 700, color: T.textSecondary, marginBottom: 8, letterSpacing: 0.3 }}>
              <span>{s.label}</span>
              <span style={{ color: s.current > 0 ? s.color : T.textMuted, fontFamily: 'monospace' }}>{s.current} / {s.cap}</span>
            </div>
            <div style={{ display: 'flex', gap: 3.5 }}>
              {Array.from({ length: s.cap }).map((_, i) => (
                <div key={i} style={{
                  flex: 1, height: 7, borderRadius: 2,
                  background: i < s.current ? s.color : T.slotOff,
                  border: i < s.current ? 'none' : `1px solid ${T.slotOffBdr}`,
                  boxShadow: i < s.current ? `0 0 8px ${s.color}aa` : 'none',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
                }} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Historical Ledger Record Auditing Engine */}
      <div style={{ background: T.panelBg, border: `1px solid ${T.panelBorder}`, borderRadius: 14, overflow: 'hidden', boxShadow: T.panelShadow, backdropFilter: 'blur(12px)' }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.rowDivider}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, letterSpacing: 0.6 }}>LEDGER RECORD ROUTING ENGINE</span>
            <input
              type="text"
              placeholder="Filter artifact hash/name..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="interactive-input"
              style={{
                background: T.slotOff, border: `1px solid ${T.panelBorder}`, color: T.textPrimary, fontSize: 11, padding: '5px 10px', borderRadius: 8, outline: 'none', width: 180,
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 4, background: T.slotOff, padding: 3, borderRadius: 8, border: `1px solid ${T.panelBorder}` }}>
            {['ALL', 'SUCCESS', 'ERROR'].map(f => (
              <button key={f} onClick={() => handleStatusFilterChange(f)} className="filter-btn" style={{
                color: statusFilter === f ? T.textPrimary : T.textMuted,
                background: statusFilter === f ? T.badgeBg : 'transparent',
                border: statusFilter === f ? `1px solid ${T.panelBorder}` : '1px solid transparent',
                boxShadow: statusFilter === f ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
              }}>{f}</button>
            ))}
          </div>
        </div>

        <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 11.5 }}>
          {filteredHistory.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: T.textMuted, fontSize: 12 }}>No telemetry records discovered matching the search criteria filters.</div>
          ) : (
            filteredHistory.map((h, i) => (
              <div key={i} className="history-row" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 16px', background: i % 2 === 0 ? T.rowAlt : 'transparent', borderBottom: `1px solid ${T.rowDivider}` }}>
                <span style={{ color: h.status === 'SUCCESS' ? T.statusDone : '#ef4444', fontSize: 9 }}>●</span>
                <span style={{ flex: 1, fontWeight: 500, color: T.textPrimary, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{h.name}</span>
                <span style={{ color: T.textMuted, fontSize: 11 }}>
                  {h.status === 'SUCCESS' ? `${h.chunks} chunks · ${h.pages} pages · ${h.elapsed}s` : h.error}
                </span>
                <span style={{ color: T.textDim, fontSize: 10, fontFamily: 'monospace' }}>{h.ts}</span>
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}