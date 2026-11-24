/**
 * Terminal.jsx — interactive WebSocket terminal
 *
 * Features added in this version:
 *  1. ANSI color rendering  — stdout/stderr render real escape-code colors
 *  2. Scripts palette       — auto-discovers .sh files via GET /api/scripts
 *  3. Command timing        — every exit line shows elapsed duration
 *  4. Copy button           — hover any output block to copy its plain text
 *  5. Font-size controls    — A− / A+ in the title bar (9–20 px range)
 *  +  Auto-refocus          — input regains focus the moment a command exits
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import logoutIcon       from '/icons/JJ_Icon_Log_Out_RGB.svg';
import chevronRightIcon from '/icons/JJ_Icon_Chevron_Right.svg';
import alertIcon        from '/icons/JJ_Icon_Alert_RGB.svg';
import stationeryIcon   from '/icons/JJ_Icon_Stationery_RGB.svg';
import { useAuth } from '../context/AuthContext';

const DEFAULT_MANAGE_API = import.meta.env.VITE_MANAGE_API_URL ?? '';

// Tailwind JIT safelist — keep dynamic class names scannable:
// text-jj-blue-03 text-jj-green-03 text-jj-green-01 text-jj-orange-03
// text-jj-yellow-01 text-jj-violet-03 text-jj-red text-jj-gray-05 text-jj-gray-01
// bg-jj-blue-03 bg-jj-green-03 bg-jj-green-01 bg-jj-orange-03 bg-jj-yellow-01
// bg-jj-violet-03 border-jj-blue-03 border-jj-green-03 border-jj-orange-03
// border-jj-violet-03 border-jj-red border-jj-orange-03

const cx = (...args) => args.filter(Boolean).join(' ');
const F_WHITE = 'brightness(0) invert(1)';
const F_GRAY  = 'brightness(0) saturate(100%) invert(65%) sepia(6%) saturate(556%) hue-rotate(346deg) brightness(92%) contrast(88%)';
const F_RED   = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';


// ══════════════════════════════════════════════════════════════════════════════
// Feature 1 — ANSI COLOR RENDERING
// ══════════════════════════════════════════════════════════════════════════════

// Standard 16 colors mapped to the JJ design-system Tailwind palette.
// Normal blue/green use the *bright* JJ variants (jj-blue-01, jj-green-01)
// because ls, git etc. output them on a dark background where the dark
// corporate variants (jj-blue-03, jj-green-03) look faded and unreadable.
const ANSI_16 = [
  '#000000', '#cc0000', '#4e9a06', '#c4a000',
  '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f',
  '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

function get256Color(n) {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) {
    const v = Math.round(((n - 232) / 23) * 255);
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const c = x => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

/**
 * Parse a raw string (possibly containing ANSI escape codes) into an array of
 * { text, style } segments ready for React rendering as inline <span>s.
 */
function parseAnsi(raw) {
  const text = raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // strip OSC (title changes)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')              // strip charset designators
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const CSI_RE = /\x1b\[([0-9;]*)([A-Za-z])/g;
  const segs   = [];
  let style    = {};
  let lastIdx  = 0;
  let m;

  while ((m = CSI_RE.exec(text)) !== null) {
    if (m.index > lastIdx) segs.push({ text: text.slice(lastIdx, m.index), style: { ...style } });
    lastIdx = m.index + m[0].length;
    if (m[2] !== 'm') continue; // only handle SGR (Select Graphic Rendition)

    const params = m[1] === '' ? [0] : m[1].split(';').map(Number);
    let i = 0;
    while (i < params.length) {
      const p = params[i];
      if      (p === 0)  { style = {}; }
      else if (p === 1)  { style = { ...style, fontWeight: 'bold' }; }
      else if (p === 2)  { style = { ...style, opacity: '0.6' }; }
      else if (p === 3)  { style = { ...style, fontStyle: 'italic' }; }
      else if (p === 4)  { style = { ...style, textDecoration: 'underline' }; }
      else if (p === 22) { const { fontWeight,    ...r } = style; style = r; }
      else if (p === 23) { const { fontStyle,     ...r } = style; style = r; }
      else if (p === 24) { const { textDecoration,...r } = style; style = r; }
      else if (p === 39) { const { color,          ...r } = style; style = r; }
      else if (p === 49) { const { backgroundColor,...r } = style; style = r; }
      else if (p >= 30  && p <= 37 ) { style = { ...style, color: ANSI_16[p - 30] }; }
      else if (p >= 90  && p <= 97 ) { style = { ...style, color: ANSI_16[p - 90 + 8] }; }
      else if (p >= 40  && p <= 47 ) { style = { ...style, backgroundColor: ANSI_16[p - 40] }; }
      else if (p >= 100 && p <= 107) { style = { ...style, backgroundColor: ANSI_16[p - 100 + 8] }; }
      else if (p === 38) {
        if (params[i+1] === 5 && params[i+2] != null) { style = { ...style, color: get256Color(params[i+2]) }; i += 2; }
        else if (params[i+1] === 2 && params[i+4] != null) { style = { ...style, color: `rgb(${params[i+2]},${params[i+3]},${params[i+4]})` }; i += 4; }
      }
      else if (p === 48) {
        if (params[i+1] === 5 && params[i+2] != null) { style = { ...style, backgroundColor: get256Color(params[i+2]) }; i += 2; }
        else if (params[i+1] === 2 && params[i+4] != null) { style = { ...style, backgroundColor: `rgb(${params[i+2]},${params[i+3]},${params[i+4]})` }; i += 4; }
      }
      i++;
    }
  }

  if (lastIdx < text.length) segs.push({ text: text.slice(lastIdx), style: { ...style } });
  return segs;
}

// Keep stripAnsi for emptiness checks and search — don't render with it
const stripAnsi = (s) =>
  s.replace(/\x1b\[([0-9]{1,4}(;[0-9]{0,4})*)?[mGKHFJlh]/g, '')
   .replace(/\x1b\][^\x07]*\x07/g, '')
   .replace(/\r\n/g, '\n')
   .replace(/\r/g, '\n');


// ══════════════════════════════════════════════════════════════════════════════
// Command palette  (static; Scripts category appended dynamically)
// ══════════════════════════════════════════════════════════════════════════════
const PALETTE = [
  {
    id: 'system', label: 'System', icon: '⚙',
    textCls: 'text-jj-blue-03', dotCls: 'bg-jj-blue-03',
    cmds: [
      { label: 'Disk usage',        cmd: 'df -h' },
      { label: 'Memory',            cmd: 'free -h' },
      { label: 'Uptime / load',     cmd: 'uptime' },
      { label: 'CPU info',          cmd: 'lscpu | head -20' },
      { label: 'OS release',        cmd: 'cat /etc/os-release' },
      { label: 'Who / when / host', cmd: 'whoami && date && hostname' },
      { label: 'Environment',       cmd: 'env | sort | head -30' },
      { label: 'Kernel version',    cmd: 'uname -r' },
    ],
  },
  {
    id: 'process', label: 'Process', icon: '⚡',
    textCls: 'text-jj-green-03', dotCls: 'bg-jj-green-03',
    cmds: [
      { label: 'Top processes',  cmd: 'ps aux --sort=-%cpu | head -20' },
      { label: 'Python procs',   cmd: 'ps aux | grep python' },
      { label: 'Uvicorn PID',    cmd: 'pgrep -a uvicorn' },
      { label: 'Open ports',     cmd: 'ss -tlnp' },
      { label: 'Port 8001',      cmd: "ss -tlnp | grep ':8001'" },
      { label: 'Snapshot (top)', cmd: 'top -bn1 | head -25' },
    ],
  },
  {
    id: 'files', label: 'Files', icon: '📂',
    textCls: 'text-jj-green-01', dotCls: 'bg-jj-green-01',
    cmds: [
      { label: 'List (long)',        cmd: 'ls -lah' },
      { label: 'Sizes (sorted)',     cmd: 'du -sh * 2>/dev/null | sort -rh | head -20' },
      { label: 'Recent files',       cmd: 'find . -maxdepth 3 -type f -newer . | head -20' },
      { label: 'Large files (>10M)', cmd: 'find . -size +10M -type f | head -20' },
      { label: 'Python files',       cmd: 'find . -name "*.py" -maxdepth 4' },
      { label: 'Log files',          cmd: 'find . -name "*.log" | head -20' },
    ],
  },
  {
    id: 'logs', label: 'Logs', icon: '📋',
    textCls: 'text-jj-orange-03', dotCls: 'bg-jj-orange-03',
    cmds: [
      { label: 'Backend  (50)',    cmd: 'tail -50 backend.log 2>/dev/null || echo "not found"' },
      { label: 'Frontend (50)',    cmd: 'tail -50 frontend.log 2>/dev/null || echo "not found"' },
      { label: 'Errors in logs',   cmd: 'grep -i "error\\|traceback" *.log 2>/dev/null | tail -30' },
      { label: 'Warnings in logs', cmd: 'grep -i "warn" *.log 2>/dev/null | tail -20' },
      { label: 'System journal',   cmd: 'journalctl -n 50 --no-pager 2>/dev/null' },
    ],
  },
  {
    id: 'git', label: 'Git', icon: '⎇',
    textCls: 'text-jj-yellow-01', dotCls: 'bg-jj-yellow-01',
    cmds: [
      { label: 'Status',     cmd: 'git status' },
      { label: 'Log (10)',   cmd: 'git log --oneline -10' },
      { label: 'Branches',   cmd: 'git branch -a' },
      { label: 'Diff stats', cmd: 'git diff --stat' },
      { label: 'Remotes',    cmd: 'git remote -v' },
      { label: 'Stash list', cmd: 'git stash list' },
    ],
  },
  {
    id: 'network', label: 'Network', icon: '🌐',
    textCls: 'text-jj-violet-03', dotCls: 'bg-jj-violet-03',
    cmds: [
      { label: 'IP addresses',   cmd: 'ip addr' },
      { label: 'Routes',         cmd: 'ip route' },
      { label: 'DNS config',     cmd: 'cat /etc/resolv.conf' },
      { label: 'Health check',   cmd: `curl -sk ${DEFAULT_MANAGE_API}/health` },
      { label: 'Open connections', cmd: 'ss -tlnp' },
    ],
  },
];


// ══════════════════════════════════════════════════════════════════════════════
// Autocomplete
// ══════════════════════════════════════════════════════════════════════════════
const COMMON_CMDS = [
  'ls -la','ls -lah','ls -ltr','pwd','cd ~','cd ..','cd /',
  'cat ','head -20 ','tail -50 ','tail -f ','grep -r ','grep -i ',
  'find . -name ','find . -type f -name ','du -sh *',
  'ps aux','ps aux | grep ','pgrep ','top -bn1 | head -25',
  'df -h','free -h','uptime','uname -a','hostname','whoami','date',
  'ss -tlnp','ip addr','ip route',
  'git status','git log --oneline -10','git branch -a','git diff --stat','git pull','git fetch',
  'python3 --version','which python3','pip3 list',
  'curl -s ','wget ','echo $PATH','echo $HOME','env | sort',
  'journalctl -n 50 --no-pager','systemctl status ',
  'history | tail -20','clear',
];

function getSuggestions(input, history) {
  if (!input || input.length < 2) return [];
  const lc = input.toLowerCase();
  const hist = history
    .filter(h => h.toLowerCase().startsWith(lc) && h !== input)
    .slice(0, 4).map(cmd => ({ cmd, src: 'history' }));
  const used = new Set(hist.map(h => h.cmd));
  const common = COMMON_CMDS
    .filter(c => c.toLowerCase().startsWith(lc) && !used.has(c))
    .slice(0, 5).map(cmd => ({ cmd, src: 'cmd' }));
  return [...hist, ...common].slice(0, 9);
}


// ══════════════════════════════════════════════════════════════════════════════
// useTerminal hook
// ══════════════════════════════════════════════════════════════════════════════
function useTerminal(isOpen, manageUrl) {
  const { getAccessToken } = useAuth();
  const WS_BASE = manageUrl.replace(/\/$/, '').replace(/^https/, 'wss').replace(/^http/, 'ws');
  const wsRef       = useRef(null);
  const idRef          = useRef(0);
  const cmdStartRef    = useRef(null);
  const cwdRef         = useRef('~');
  const promptWidthRef = useRef(0);

  const [connected, setConnected] = useState(false);
  const [closeInfo, setCloseInfo] = useState(null); // { code, reason } from the last WS close, for diagnosing why
  const [cwd,       setCwd]       = useState('~');
  const [chunks,    setChunks]    = useState([]);
  const [running,   setRunning]   = useState(false);
  const [history,   setHistory]   = useState([]);
  const [histIdx,   setHistIdx]   = useState(-1);
  const [inputVal,  setInputVal]  = useState('');

  useEffect(() => { cwdRef.current = cwd; }, [cwd]);

  const push = useCallback((type, text) => {
    if (!stripAnsi(text)) return;
    setChunks(prev => {
      if (prev.length && prev.at(-1).type === type && type !== 'cmd' && type !== 'meta') {
        const last = prev.at(-1);
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: ++idRef.current, type, text, indent: promptWidthRef.current }];
    });
  }, []);

  const connect = useCallback(async () => {
    if (!WS_BASE) return;
    // manage.py requires an admin token — browsers can't set headers on a
    // WebSocket handshake, so it goes on the URL as a query param instead
    // (validated server-side before any command can run).
    let token = '';
    try { token = await getAccessToken(); } catch { /* fall through, server will reject */ }
    const ws = new WebSocket(`${WS_BASE}/ws/terminal?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen  = () => { setConnected(true); setCloseInfo(null); };
    ws.onclose = (ev) => {
      setConnected(false); setRunning(false);
      // 4401 = manage.py rejected the token (see manage.py require_admin /
      // terminal_ws) — most common cause is AD_GROUP_ADMIN not set/matching
      // in that box's own .env. Anything else is a network/reachability issue.
      setCloseInfo({ code: ev.code, reason: ev.reason || (ev.code === 4401 ? 'Not authorized' : 'Connection closed') });
    };
    ws.onerror = () => { setConnected(false); setRunning(false); };
    ws.onmessage = ({ data }) => {
      try {
        const m = JSON.parse(data);
        if      (m.type === 'cwd')    { setCwd(m.cwd); }
        else if (m.type === 'stdout') { push('stdout', m.data); }
        else if (m.type === 'stderr') { push('stderr', m.data); }
        else if (m.type === 'clear')  {
          setChunks([]);
          cmdStartRef.current = null; // clear never emits exit, reset timing
        }
        else if (m.type === 'exit') {
          setRunning(false);
          if (m.cwd) setCwd(m.cwd);
          // Feature 3: always show how long the command took
          const elapsed = cmdStartRef.current !== null
            ? `${((Date.now() - cmdStartRef.current) / 1000).toFixed(2)}s`
            : null;
          cmdStartRef.current = null;
          const info = [
            m.code !== 0 && m.code != null ? `exit ${m.code}` : null,
            elapsed,
          ].filter(Boolean).join(' · ');
          push('meta', `[${info || 'done'}]\n`);
        }
      } catch { /* ignore malformed messages */ }
    };
  }, [push, getAccessToken]);

  const disconnect = useCallback(() => {
    wsRef.current?.close(); wsRef.current = null;
    setConnected(false); setRunning(false);
  }, []);

  useEffect(() => { if (isOpen) connect(); else disconnect(); return disconnect; }, [isOpen]); // eslint-disable-line

  const send = useCallback((cmd) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const t = cmd.trim();
    const rawCwd  = cwdRef.current.replace(/^\/home\/[^/]+/, '~');
    const parts   = rawCwd.split('/');
    const dispCwd = parts.length > 3 ? '~/' + parts.slice(-2).join('/') : rawCwd;
    promptWidthRef.current = dispCwd.length + 3;
    setChunks(prev => [...prev, { id: ++idRef.current, type: 'cmd', text: t, cwd: cwdRef.current }]);
    ws.send(JSON.stringify({ cmd: t }));
    cmdStartRef.current = Date.now();
    setRunning(true); setInputVal(''); setHistIdx(-1);
    if (t) setHistory(prev => [t, ...prev.filter(c => c !== t).slice(0, 99)]);
  }, []);

  const interrupt = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
    push('meta', '^C\n');
    setRunning(false);
    cmdStartRef.current = null; // interrupted — skip timing
  }, [push]);

  return {
    connected, closeInfo, cwd, chunks, running, history, histIdx, setHistIdx,
    inputVal, setInputVal, send, interrupt,
    clear:     () => setChunks([]),
    reconnect: () => { disconnect(); setTimeout(connect, 150); },
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// Terminal — main export
// ══════════════════════════════════════════════════════════════════════════════
export default function Terminal({ isOpen, onClose, manageUrl = DEFAULT_MANAGE_API }) {
  const MANAGE_API = manageUrl;
  const term      = useTerminal(isOpen, manageUrl);
  const outputRef = useRef(null);
  const inputRef  = useRef(null);
  const isSelectingRef = useRef(false);

  const [suggestions, setSuggestions] = useState([]);
  const [suggIdx,     setSuggIdx]     = useState(-1);
  const [openCat,     setOpenCat]     = useState('system');
  const [searching,   setSearching]   = useState(false);
  const [searchQ,     setSearchQ]     = useState('');
  const [fontSize,    setFontSize]    = useState(13);   // Feature 5
  const [scripts,     setScripts]     = useState([]);   // Feature 2

  // Feature 2: fetch .sh scripts from manage API once connected
  const { getAccessToken: getManageToken } = useAuth();
  useEffect(() => {
    if (!term.connected || !MANAGE_API) return;
    (async () => {
      try {
        const token = await getManageToken();
        const r = await fetch(`${MANAGE_API}/api/scripts`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = r.ok ? await r.json() : { scripts: [] };
        setScripts(d.scripts || []);
      } catch { /* non-critical */ }
    })();
  }, [term.connected]);

  // Build full palette — patch health check with active server URL, append Scripts
  const fullPalette = useMemo(() => [
    ...PALETTE.map(cat =>
      cat.id === 'network'
        ? { ...cat, cmds: cat.cmds.map(c =>
            c.label === 'Health check'
              ? { ...c, cmd: `curl -sk ${MANAGE_API}/health` }
              : c
          )}
        : cat
    ),
    ...(scripts.length > 0 ? [{
      id:      'scripts',
      label:   'Scripts',
      icon:    '📜',
      textCls: 'text-jj-orange-03',
      dotCls:  'bg-jj-orange-03',
      cmds: scripts.map(s => ({ label: s.name.replace(/\.sh$/, ''), cmd: s.cmd })),
    }] : []),
  ], [scripts, MANAGE_API]);

  useEffect(() => {
    if (!outputRef.current || searching) return;
    const sel = window.getSelection();
    const hasSelection = sel && sel.toString().length > 0 &&
      outputRef.current.contains(sel.anchorNode);
    if (!hasSelection)
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [term.chunks, searching]);

  // Focus input on open
  useEffect(() => { if (isOpen) setTimeout(() => inputRef.current?.focus(), 120); }, [isOpen]);

  useEffect(() => {
    if (!term.running && isOpen) {
      const sel = window.getSelection();
      if (!sel || sel.toString().length === 0) inputRef.current?.focus();
    }
  }, [term.running, isOpen]);

  useEffect(() => {
    setSuggestions(getSuggestions(term.inputVal, term.history));
    setSuggIdx(-1);
  }, [term.inputVal, term.history]);

  const run = useCallback((cmd) => {
    if (!cmd.trim() || !term.connected || term.running) return;
    setSuggestions([]); term.send(cmd);
  }, [term]);

  const handleKey = useCallback((e) => {
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (!suggestions.length) return;
      const n = Math.max(-1, Math.min(suggestions.length - 1, suggIdx + (e.key === 'ArrowDown' ? 1 : -1)));
      setSuggIdx(n); term.setInputVal(n >= 0 ? suggestions[n].cmd : term.inputVal); return;
    }
    if (e.key === 'Tab' && suggestions.length) {
      e.preventDefault(); term.setInputVal(suggestions[Math.max(0, suggIdx)].cmd); setSuggestions([]); return;
    }
    if (e.key === 'Escape') { setSuggestions([]); setSuggIdx(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(suggIdx >= 0 ? (suggestions[suggIdx]?.cmd ?? term.inputVal) : term.inputVal);
      setSuggestions([]); return;
    }
    if (e.ctrlKey) {
      if (e.key === 'c') { e.preventDefault(); if (term.running) term.interrupt(); return; }
      if (e.key === 'l') { e.preventDefault(); term.clear(); return; }
      if (e.key === 'f') { e.preventDefault(); setSearching(s => !s); return; }
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const n = Math.min(term.histIdx + 1, term.history.length - 1);
      term.setHistIdx(n); if (term.history[n]) term.setInputVal(term.history[n]); return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const n = Math.max(term.histIdx - 1, -1);
      term.setHistIdx(n); term.setInputVal(n < 0 ? '' : (term.history[n] ?? '')); return;
    }
  }, [term, suggestions, suggIdx, run]);

  const shortCwd = useMemo(() => {
    const parts = term.cwd.replace(/^\/home\/[^/]+/, '~').split('/');
    return parts.length > 3 ? '~/' + parts.slice(-2).join('/') : term.cwd.replace(/^\/home\/[^/]+/, '~');
  }, [term.cwd]);

  const filteredChunks = useMemo(() => {
    if (!searching || !searchQ) return term.chunks;
    const lc = searchQ.toLowerCase();
    // Feature 1: search on stripped text, render raw
    return term.chunks.filter(c => stripAnsi(c.text).toLowerCase().includes(lc));
  }, [term.chunks, searching, searchQ]);

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 z-40 bg-jj-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Window */}
      <div
        className="fixed inset-3 z-50 flex flex-col rounded-2xl overflow-hidden bg-jj-black border border-jj-gray-07"
        style={{ boxShadow: '0 32px 96px rgba(0,0,0,0.7)' }}
        onClick={e => e.stopPropagation()}
      >

        {/* ── Title bar ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 bg-jj-black border-b border-jj-gray-07 flex-shrink-0 select-none"
          style={{ height: '46px' }}>

          <div className="flex items-center gap-3">
            {/* Traffic lights */}
            <div className="flex items-center gap-1.5">
              <button onClick={onClose} title="Close"
                className="w-3 h-3 rounded-full bg-jj-red hover:bg-jj-maroon-05 transition-colors" />
              <div className="w-3 h-3 rounded-full bg-jj-yellow-01 opacity-40" />
              <div className="w-3 h-3 rounded-full bg-jj-green-03 opacity-40" />
            </div>
            <div className="w-px h-4 bg-jj-gray-07" />
            {/* Title */}
            <div className="flex items-center gap-2">
              <span className="font-johnson-display font-bold text-jj-red"
                style={{ fontSize: '14px', letterSpacing: '-.02em' }}>{'> _'}</span>
              <span className="font-johnson-display text-jj-gray-01 font-bold text-sm">Terminal</span>
            </div>
            {/* CWD pill */}
            <div className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded-md bg-jj-gray-07 border border-jj-gray-06">
              <span className="font-johnson-text text-jj-green-03" style={{ fontSize: '11px' }}>~/</span>
              <span className="font-johnson-text text-jj-gray-03" style={{ fontSize: '11px' }}>
                {term.cwd.split('/').pop() || '~'}
              </span>
            </div>
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-2">
            {/* Connection badge */}
            <div className={cx(
              'flex items-center gap-1.5 px-2 py-0.5 rounded border font-johnson-text',
              term.connected ? 'text-jj-green-03 border-jj-green-03' : 'text-jj-red border-jj-red',
            )} style={{ fontSize: '11px' }}>
              <span className={cx('w-1.5 h-1.5 rounded-full flex-shrink-0',
                term.connected ? 'bg-jj-green-03 animate-pulse' : 'bg-jj-red')} />
              {term.connected ? 'Connected' : 'Disconnected'}
              {!term.connected && term.closeInfo && (
                <span className="opacity-70" title={`WebSocket closed: code ${term.closeInfo.code}`}>
                  ({term.closeInfo.code === 4401 ? 'not authorized' : term.closeInfo.reason})
                </span>
              )}
            </div>

            {/* Feature 5: Font size A− / A+ */}
            <div className="hidden sm:flex items-center overflow-hidden rounded border border-jj-gray-06">
              {[['A−', -1], ['A+', 1]].map(([label, delta]) => (
                <button key={label}
                  onClick={() => setFontSize(s => Math.max(9, Math.min(20, s + delta)))}
                  title={delta < 0 ? 'Smaller text' : 'Larger text'}
                  className="px-2 py-0.5 font-johnson-text text-jj-gray-05 hover:text-jj-gray-01 hover:bg-jj-gray-07 transition-colors border-r border-jj-gray-06 last:border-r-0"
                  style={{ fontSize: '11px' }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Action chips */}
            {[
              !term.connected && { label: 'Reconnect', action: term.reconnect },
              { label: searching ? 'Search ✓' : 'Search', action: () => setSearching(s => !s) },
              { label: 'Clear', action: term.clear },
            ].filter(Boolean).map(({ label, action }) => (
              <button key={label} onClick={action}
                className="font-johnson-text text-jj-gray-05 hover:text-jj-gray-01 px-2 py-0.5 rounded bg-jj-gray-07 border border-jj-gray-06 hover:border-jj-gray-05 transition-colors"
                style={{ fontSize: '11px' }}>
                {label}
              </button>
            ))}

            <button onClick={onClose} className="ml-1 opacity-60 hover:opacity-100 transition-opacity">
              <img src={logoutIcon} alt="Close" className="w-4 h-4" style={{ filter: F_WHITE }} />
            </button>
          </div>
        </div>

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="flex flex-1 overflow-hidden">

          {/* Sidebar */}
          <div className="flex-shrink-0 flex flex-col overflow-hidden bg-jj-black border-r border-jj-gray-07"
            style={{ width: '224px' }}>
            <div className="flex-1 overflow-y-auto py-2" style={{ scrollbarWidth: 'thin' }}>
              {fullPalette.map(cat => (
                <PaletteCategory key={cat.id} cat={cat}
                  open={openCat === cat.id}
                  onToggle={() => setOpenCat(p => p === cat.id ? null : cat.id)}
                  onRun={run}
                  disabled={term.running || !term.connected}
                />
              ))}
            </div>

            {/* Recent history */}
            {term.history.length > 0 && (
              <div className="border-t border-jj-gray-07">
                <div className="px-3 pt-2 pb-1">
                  <span className="font-johnson-text font-bold uppercase text-jj-gray-06"
                    style={{ fontSize: '9px', letterSpacing: '.12em' }}>Recent</span>
                </div>
                <div className="pb-2 overflow-y-auto" style={{ maxHeight: '144px', scrollbarWidth: 'thin' }}>
                  {term.history.slice(0, 12).map((cmd, i) => (
                    <button key={i} title={cmd}
                      onClick={() => !term.running && term.connected && run(cmd)}
                      className="w-full text-left px-3 py-1 hover:bg-jj-gray-07/30 group transition-colors"
                      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="font-johnson-text text-jj-gray-06 group-hover:text-jj-gray-03 transition-colors"
                        style={{ fontSize: '11px' }}>
                        <span className="text-jj-gray-07 mr-1">↺</span>{cmd}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Main panel */}
          <div className="flex-1 flex flex-col overflow-hidden">

            {/* Search bar */}
            {searching && (
              <div className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0 bg-jj-gray-07 border-b border-jj-gray-06">
                <img src={stationeryIcon} alt="" className="w-3.5 h-3.5 flex-shrink-0" style={{ filter: F_GRAY }} />
                <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
                  className="flex-1 bg-transparent outline-none font-johnson-text text-jj-gray-01 text-xs"
                  placeholder="Search output…" autoFocus />
                {searchQ && (
                  <span className="font-johnson-text text-jj-gray-05" style={{ fontSize: '10px' }}>
                    {filteredChunks.length} result{filteredChunks.length !== 1 ? 's' : ''}
                  </span>
                )}
                <button onClick={() => { setSearching(false); setSearchQ(''); }}
                  className="opacity-60 hover:opacity-100 transition-opacity">
                  <img src={logoutIcon} alt="Close search" className="w-3 h-3" style={{ filter: F_WHITE }} />
                </button>
              </div>
            )}

            {/* Output */}
            <div ref={outputRef}
              onMouseDown={() => { isSelectingRef.current = false; }}
              onMouseMove={e => { if (e.buttons === 1) isSelectingRef.current = true; }}
              onMouseUp={() => {
                setTimeout(() => {
                  const sel = window.getSelection();
                  if (!sel || sel.toString().length === 0) {
                    isSelectingRef.current = false;
                    inputRef.current?.focus();
                  }
                }, 10);
              }}
              onContextMenu={e => {
                e.preventDefault();
                const sel = window.getSelection()?.toString() ?? '';
                if (sel) {
                  window.getSelection().removeAllRanges();
                  term.setInputVal(prev => prev + sel.replace(/\n/g, ' ').trim());
                } else {
                  navigator.clipboard.readText()
                    .then(text => { if (text) term.setInputVal(prev => prev + text); })
                    .catch(() => {});
                }
                inputRef.current?.focus();
              }}
              className="flex-1 overflow-y-auto px-4 py-3 bg-jj-black"
              style={{ scrollbarWidth: 'thin', cursor: 'text', userSelect: 'text', WebkitUserSelect: 'text' }}
            >
              {term.chunks.length === 0 && (
                <div className="font-johnson-text text-jj-gray-06" style={{ lineHeight: '1.9', fontSize: `${fontSize}px` }}>
                  <div className="text-jj-blue-03 mb-1" style={{ fontSize: `${Math.max(9, fontSize - 2)}px` }}>
                    {'// '}{MANAGE_API || 'server'}
                  </div>
                  <div>Use the command palette to run common operations.</div>
                  <div>Type below. ↑↓ history · Tab complete · Ctrl+C interrupt · Ctrl+L clear · Ctrl+F search</div>
                </div>
              )}

              {filteredChunks.map(chunk => (
                <OutputChunk key={chunk.id} chunk={chunk} shortCwd={shortCwd}
                  searchQ={searching ? searchQ : ''} fontSize={fontSize} />
              ))}

              {term.running && (
                <span className="inline-block bg-jj-gray-01 align-middle"
                  style={{ width: '8px', height: `${fontSize + 2}px`, animation: 'tblink 1s step-end infinite' }} />
              )}
            </div>

            {/* Divider */}
            <div className="h-px bg-jj-gray-07 flex-shrink-0" />

            {/* Input zone */}
            <div className="flex-shrink-0 bg-jj-black relative">

              {/* Suggestion dropdown */}
              {suggestions.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mx-3 mb-1 rounded-xl overflow-hidden bg-jj-gray-07 border border-jj-gray-06"
                  style={{ boxShadow: '0 -8px 24px rgba(0,0,0,0.5)', zIndex: 10 }}>
                  <div className="px-3 py-1.5 flex items-center justify-between bg-jj-gray-08 border-b border-jj-gray-07">
                    <span className="font-johnson-text font-bold uppercase text-jj-gray-05"
                      style={{ fontSize: '9px', letterSpacing: '.1em' }}>Suggestions</span>
                    <span className="font-johnson-text text-jj-gray-06" style={{ fontSize: '9px' }}>Tab · ↑↓ · Enter</span>
                  </div>
                  {suggestions.map((s, i) => (
                    <button key={i}
                      onClick={() => { term.setInputVal(s.cmd); setSuggestions([]); inputRef.current?.focus(); }}
                      className={cx(
                        'w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors',
                        i < suggestions.length - 1 && 'border-b border-jj-gray-06',
                        i === suggIdx ? 'bg-jj-gray-06' : 'hover:bg-jj-gray-06/50'
                      )}>
                      <span className={cx('font-johnson-text text-xs', i === suggIdx ? 'text-jj-gray-01' : 'text-jj-gray-03')}>
                        {s.cmd}
                      </span>
                      <span className={cx('ml-2 flex-shrink-0 font-johnson-text font-bold px-1.5 py-0.5 rounded',
                        s.src === 'history' ? 'text-jj-orange-03' : 'text-jj-blue-03')}
                        style={{ fontSize: '9px', letterSpacing: '.04em' }}>
                        {s.src === 'history' ? 'HIST' : 'CMD'}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Input row */}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className={cx('font-mono flex-shrink-0 select-none',
                  term.running ? 'text-jj-gray-06' : 'text-jj-green-03')}
                  style={{ fontSize: `${fontSize}px`, whiteSpace: 'nowrap' }}>
                  {shortCwd} $
                </span>
                <input ref={inputRef}
                  value={term.inputVal}
                  onChange={e => { if (!term.running) term.setInputVal(e.target.value); }}
                  onKeyDown={handleKey}
                  disabled={!term.connected || term.running}
                  spellCheck={false} autoCapitalize="none" autoComplete="off"
                  className={cx('flex-1 bg-transparent outline-none border-none font-mono min-w-0 text-white',
                    !term.connected && 'opacity-40')}
                  style={{ fontSize: `${fontSize}px`, caretColor: 'currentColor' }}
                  placeholder={!term.connected ? 'not connected…' : term.running ? 'running…' : ''}
                />
                {term.running && (
                  <button onClick={term.interrupt}
                    className="flex items-center gap-1 px-2 py-0.5 rounded border border-jj-red text-jj-red font-johnson-text font-bold flex-shrink-0 hover:bg-jj-red hover:text-jj-white transition-colors"
                    style={{ fontSize: '11px' }}>
                    <img src={alertIcon} alt="" className="w-3 h-3" style={{ filter: F_RED }} />
                    <span>Ctrl+C</span>
                  </button>
                )}
                {/* Keyboard hints */}
                <div className="hidden lg:flex items-center gap-3 flex-shrink-0">
                  {[['↑↓','history'],['Alt+↑↓','suggest'],['Tab','complete'],['Ctrl+L','clear'],['Ctrl+F','search']].map(([k, l]) => (
                    <span key={k} className="flex items-center gap-1 font-johnson-text text-jj-gray-06" style={{ fontSize: '10px' }}>
                      <kbd className="font-johnson-text bg-jj-gray-07 border border-jj-gray-06 rounded text-jj-gray-04 px-1"
                        style={{ fontSize: '9px' }}>{k}</kbd>
                      <span>{l}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

      <style>{`@keyframes tblink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </>
  );
}


// ══════════════════════════════════════════════════════════════════════════════
// PaletteCategory
// ══════════════════════════════════════════════════════════════════════════════
function PaletteCategory({ cat, open, onToggle, onRun, disabled }) {
  return (
    <div>
      <button onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-jj-gray-07/30 group transition-colors">
        <div className="flex items-center gap-2">
          <span className="text-sm">{cat.icon}</span>
          <span className={cx('font-johnson-text font-bold uppercase',
            open ? cat.textCls : 'text-jj-gray-05 group-hover:text-jj-gray-03')}
            style={{ fontSize: '11px', letterSpacing: '.04em', transition: 'color .15s' }}>
            {cat.label}
          </span>
        </div>
        <img src={chevronRightIcon} alt=""
          className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          style={{ filter: F_GRAY }} />
      </button>
      {open && (
        <div className="pb-1.5">
          {cat.cmds.map((c, i) => (
            <button key={i} title={c.cmd}
              onClick={() => !disabled && onRun(c.cmd)}
              disabled={disabled}
              className="w-full text-left px-4 py-1.5 flex items-center gap-2 hover:bg-jj-gray-07/30 disabled:opacity-40 disabled:cursor-not-allowed group transition-colors">
              <span className={cx('w-1 h-1 rounded-full flex-shrink-0 group-hover:scale-150 transition-transform', cat.dotCls)} />
              <span className="font-johnson-text text-jj-gray-05 group-hover:text-jj-gray-02 transition-colors flex-1 truncate"
                style={{ fontSize: '11px' }}>
                {c.label}
              </span>
              <span className="font-johnson-text text-jj-gray-07 group-hover:text-jj-gray-06 transition-colors"
                style={{ fontSize: '9px', maxWidth: '72px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.cmd}
              </span>
              <img src={chevronRightIcon} alt=""
                className="w-3 h-3 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// ══════════════════════════════════════════════════════════════════════════════
// OutputChunk — Features 1 (ANSI colors) + 4 (copy button)
// ══════════════════════════════════════════════════════════════════════════════
function OutputChunk({ chunk, shortCwd, searchQ, fontSize }) {
  const [copied, setCopied] = useState(false);

  // Plain text used for: copying, search, and cmd/meta rendering (no ANSI needed)
  const plainText = useMemo(() => stripAnsi(chunk.text), [chunk.text]);

  // Feature 4: copy to clipboard
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(plainText).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [plainText]);

  const isSmall  = chunk.type === 'meta';
  const fs       = isSmall ? Math.max(9, fontSize - 2) : fontSize;
  const indent   = chunk.indent ?? 0;
  const preStyle = { margin: 0, whiteSpace: 'pre-wrap', fontSize: `${fs}px`, lineHeight: '1.6' };
  const outStyle = { ...preStyle, paddingLeft: indent ? `${indent}ch` : undefined };

  // Feature 4: copy button — hidden until the row is hovered (Tailwind group)
  const CopyBtn = (
    <button
      onClick={e => { e.stopPropagation(); handleCopy(); }}
      className="absolute top-0.5 right-1 opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded bg-jj-gray-07 border border-jj-gray-06 font-johnson-text text-jj-gray-05 hover:text-jj-gray-01 hover:border-jj-gray-05"
      style={{ fontSize: '9px', letterSpacing: '.04em', lineHeight: '1.6' }}
      title="Copy to clipboard"
    >
      {copied ? '✓' : 'copy'}
    </button>
  );

  if (chunk.type === 'cmd') {
    const cmdCwd = (chunk.cwd || shortCwd).replace(/^\/home\/[^/]+/, '~');
    const cwdParts = cmdCwd.split('/');
    const displayCwd = cwdParts.length > 3 ? '~/' + cwdParts.slice(-2).join('/') : cmdCwd;
    return (
      <div className="relative group">
        <pre className="border-l-2 border-jj-gray-06 pl-2 mb-0.5 font-mono" style={preStyle}>
          <span className="text-jj-green-03 select-none">{displayCwd} $ </span>
          <span className="text-white font-bold">{plainText}</span>
        </pre>
        {CopyBtn}
      </div>
    );
  }
  if (chunk.type === 'meta') {
    return (
      <div className="relative group">
        <pre className="font-mono text-jj-gray-06 opacity-70" style={outStyle}>{plainText}</pre>
        {CopyBtn}
      </div>
    );
  }
  if (searchQ && plainText.toLowerCase().includes(searchQ.toLowerCase())) {
    const escaped = searchQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts   = plainText.split(new RegExp(`(${escaped})`, 'gi'));
    return (
      <div className="relative group">
        <pre className={cx('font-mono', chunk.type === 'stderr' ? 'text-jj-orange-03' : 'text-jj-gray-01')} style={outStyle}>
          {parts.map((part, i) =>
            part.toLowerCase() === searchQ.toLowerCase()
              ? <mark key={i} className="bg-jj-yellow-01/30 text-jj-yellow-01 rounded">{part}</mark>
              : part
          )}
        </pre>
        {CopyBtn}
      </div>
    );
  }
  const segs = parseAnsi(chunk.text);
  return (
    <div className="relative group">
      <pre className={cx('font-mono', chunk.type === 'stderr' ? 'text-jj-orange-03' : 'text-jj-gray-01')} style={outStyle}>
        {segs.map((seg, i) => <span key={i} style={seg.style}>{seg.text}</span>)}
      </pre>
      {CopyBtn}
    </div>
  );
}