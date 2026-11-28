import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { downloadBlob, requestJson } from '../utils/apiClient';
import { Dot, Icon, cx, useDialogBehaviour } from '../components/ui';

// ── ANSI rendering ────────────────────────────────────────────────────────────
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const CHARSET_RE = new RegExp(`${ESC}[()][0-9A-Za-z]`, 'g');
const CSI_RE = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])`, 'g');
const ANSI_16 = ['#484f58', '#ff7b72', '#7ee787', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#c9d1d9',
  '#6e7681', '#ffa198', '#56d364', '#f2cc60', '#a5d6ff', '#e2c5ff', '#b3f0ff', '#f0f6fc'];

const color256 = (n) => {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) { const v = Math.round(((n - 232) / 23) * 255); return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  const c = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor((i % 36) / 6))},${c(i % 6)})`;
};

const normalise = (raw) => raw.replace(OSC_RE, '').replace(CHARSET_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const stripAnsi = (raw) => normalise(raw).replace(CSI_RE, '');

function parseAnsi(raw) {
  const text = normalise(raw);
  const segs = [];
  let style = {};
  let last = 0;
  CSI_RE.lastIndex = 0;
  for (let m = CSI_RE.exec(text); m; m = CSI_RE.exec(text)) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), style });
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const p = m[1] === '' ? [0] : m[1].split(';').map(Number);
    style = { ...style };
    for (let i = 0; i < p.length; i += 1) {
      const c = p[i];
      if (c === 0) style = {};
      else if (c === 1) style.fontWeight = 'bold';
      else if (c === 2) style.opacity = 0.65;
      else if (c === 3) style.fontStyle = 'italic';
      else if (c === 4) style.textDecoration = 'underline';
      else if (c === 22) delete style.fontWeight;
      else if (c === 23) delete style.fontStyle;
      else if (c === 24) delete style.textDecoration;
      else if (c === 39) delete style.color;
      else if (c === 49) delete style.backgroundColor;
      else if (c >= 30 && c <= 37) style.color = ANSI_16[c - 30];
      else if (c >= 90 && c <= 97) style.color = ANSI_16[c - 82];
      else if (c >= 40 && c <= 47) style.backgroundColor = ANSI_16[c - 40];
      else if (c >= 100 && c <= 107) style.backgroundColor = ANSI_16[c - 92];
      else if ((c === 38 || c === 48) && p[i + 1] === 5 && p[i + 2] != null) {
        style[c === 38 ? 'color' : 'backgroundColor'] = color256(p[i + 2]); i += 2;
      } else if ((c === 38 || c === 48) && p[i + 1] === 2 && p[i + 4] != null) {
        style[c === 38 ? 'color' : 'backgroundColor'] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4;
      }
    }
  }
  if (last < text.length) segs.push({ text: text.slice(last), style });
  return segs;
}

// ── Command palette ───────────────────────────────────────────────────────────
const PALETTE = [
  { id: 'system', label: 'System', cmds: [
    ['Disk usage', 'df -h'], ['Memory', 'free -h'], ['Uptime / load', 'uptime'], ['CPU info', 'lscpu | head -20'],
    ['OS release', 'cat /etc/os-release'], ['Who / when / host', 'whoami && date && hostname'], ['Kernel', 'uname -r'],
  ] },
  { id: 'process', label: 'Processes', cmds: [
    ['Top by CPU', 'ps aux --sort=-%cpu | head -20'], ['Python processes', 'pgrep -af python'], ['Uvicorn', 'pgrep -af uvicorn'],
    ['Listening ports', 'ss -tlnp'], ['Snapshot (top)', 'top -bn1 | head -25'],
  ] },
  { id: 'files', label: 'Files', cmds: [
    ['List', 'ls -lah'], ['Sizes', 'du -sh * 2>/dev/null | sort -rh | head -20'], ['Large files (>10M)', 'find . -size +10M -type f | head -20'],
    ['Log files', 'find . -maxdepth 3 -name "*.log" | head -20'],
  ] },
  { id: 'logs', label: 'Logs', cmds: [
    ['Backend (100)', 'tail -100 backend.log 2>/dev/null || echo "backend.log not found here"'],
    ['Frontend (100)', 'tail -100 frontend.log 2>/dev/null || echo "frontend.log not found here"'],
    ['Errors', 'grep -inE "error|traceback" *.log 2>/dev/null | tail -30'],
    ['System journal', 'journalctl -n 50 --no-pager 2>/dev/null'],
  ] },
  { id: 'git', label: 'Git', cmds: [
    ['Status', 'git status'], ['Log (15)', 'git log --oneline -15'], ['Branches', 'git branch -a'],
    ['Diff stats', 'git diff --stat'], ['Remotes', 'git remote -v'],
  ] },
  { id: 'network', label: 'Network', cmds: [['IP addresses', 'ip -brief addr'], ['Routes', 'ip route'], ['DNS', 'cat /etc/resolv.conf']] },
];

const COMMON = ['ls -la', 'ls -lah', 'pwd', 'cd ..', 'cat ', 'tail -100 ', 'tail -f ', 'grep -rn ', 'find . -name ', 'du -sh *',
  'ps aux | grep ', 'df -h', 'free -h', 'uptime', 'ss -tlnp', 'git status', 'git log --oneline -10', 'git pull', 'git fetch',
  'python3 --version', 'pip list', 'journalctl -n 50 --no-pager', 'systemctl status ', 'clear'];

const suggest = (input, history) => {
  if (!input || input.length < 2) return [];
  const lc = input.toLowerCase();
  const hist = history.filter((h) => h.toLowerCase().startsWith(lc) && h !== input).slice(0, 4).map((cmd) => ({ cmd, src: 'history' }));
  const used = new Set(hist.map((h) => h.cmd));
  return [...hist, ...COMMON.filter((c) => c.startsWith(lc) && !used.has(c) && c !== input).slice(0, 5).map((cmd) => ({ cmd, src: 'command' }))].slice(0, 8);
};

const shortCwd = (cwd) => {
  const p = (cwd || '~').replace(/^\/home\/[^/]+/, '~');
  const parts = p.split('/');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
};

// ── Connection ────────────────────────────────────────────────────────────────
const CHUNK_SPLIT = 16_000;
const MAX_CHUNKS = 600;
const HISTORY_MAX = 100;
const RETRY_DELAYS = [1000, 2000, 4000];
const CLOSE_REASONS = { 4401: 'Not authorised', 4408: 'Closed after being idle' };

const historyKey = (url) => `terminal-history:${url}`;
const loadHistory = (url) => {
  try {
    const h = JSON.parse(localStorage.getItem(historyKey(url)) || '[]');
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string').slice(0, HISTORY_MAX) : [];
  } catch { return []; }
};
const saveHistory = (url, h) => {
  try { localStorage.setItem(historyKey(url), JSON.stringify(h)); } catch { /* storage blocked: history lasts this visit */ }
};

// Output is appended once per frame, so a command printing thousands of
// lines a second costs one render per frame, not one per message.
function appendOutput(prev, batch, nextId) {
  const out = prev.slice();
  for (const item of batch) {
    const { type, text } = item;
    const last = out[out.length - 1];
    const stream = type === 'stdout' || type === 'stderr';
    // Keep growing the last block until it is big, then cut at a line end so
    // ANSI styles never straddle two blocks.
    if (stream && last && last.type === type && !(last.text.length >= CHUNK_SPLIT && last.text.endsWith('\n'))) {
      out[out.length - 1] = { ...last, text: last.text + text };
    } else {
      out.push({ ...item, id: nextId() });
    }
  }
  return out.length > MAX_CHUNKS ? out.slice(-MAX_CHUNKS) : out;
}

function useTerminal(manageUrl) {
  const ws = useRef(null);
  const idRef = useRef(0);
  const started = useRef(null);
  const queue = useRef([]);
  const frame = useRef(0);
  const retries = useRef(0);
  const retryTimer = useRef(0);
  const generation = useRef(0);
  const connectRef = useRef(null);
  const [state, setState] = useState('connecting');
  const [closeReason, setCloseReason] = useState('');
  const [cwd, setCwd] = useState('~');
  const [chunks, setChunks] = useState([]);
  const [running, setRunning] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [history, setHistory] = useState(() => loadHistory(manageUrl));

  const nextId = useCallback(() => ++idRef.current, []);
  const flush = useCallback(() => {
    frame.current = 0;
    const batch = queue.current;
    queue.current = [];
    if (batch.length) setChunks((prev) => appendOutput(prev, batch, nextId));
  }, [nextId]);
  const push = useCallback((type, text) => {
    if (!text) return;
    queue.current.push({ type, text });
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  }, [flush]);
  const clear = useCallback(() => {
    queue.current = [];
    setChunks([]);
  }, []);

  const connect = useCallback(async () => {
    const gen = ++generation.current;
    clearTimeout(retryTimer.current);
    const prev = ws.current;
    ws.current = null;
    prev?.close();
    setState('connecting');
    setCloseReason('');
    let ticket;
    try {
      ({ ticket } = await requestJson(`${manageUrl}/api/terminal/ticket`, { method: 'POST', timeoutMs: 15_000 }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState('closed');
      setCloseReason(e.status === 403 ? 'Admin group membership required on this server' : e.message);
      return;
    }
    // Unmounted, or another connect() started while this one waited.
    if (gen !== generation.current) return;
    const sock = new WebSocket(`${manageUrl.replace(/^http/, 'ws')}/ws/terminal?ticket=${encodeURIComponent(ticket)}`);
    ws.current = sock;
    sock.onopen = () => {
      if (retries.current) push('meta', 'reconnected · new shell session');
      retries.current = 0;
      setState('open');
    };
    sock.onclose = (ev) => {
      if (ws.current !== sock) return;
      ws.current = null;
      setRunning(false);
      setInterrupted(false);
      started.current = null;
      // Unexpected drops (network blip, manager restart) retry on their own;
      // auth and idle closes wait for the user.
      if (!CLOSE_REASONS[ev.code] && ev.code !== 1000 && retries.current < RETRY_DELAYS.length) {
        push('meta', 'connection lost · reconnecting');
        setState('connecting');
        retryTimer.current = setTimeout(() => connectRef.current?.(), RETRY_DELAYS[retries.current++]);
        return;
      }
      retries.current = 0;
      setState('closed');
      setCloseReason(ev.reason || CLOSE_REASONS[ev.code] || 'Connection closed');
    };
    sock.onmessage = ({ data }) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === 'cwd') setCwd(m.cwd);
      else if (m.type === 'stdout' || m.type === 'stderr') push(m.type, m.data);
      else if (m.type === 'clear') { clear(); started.current = null; setRunning(false); }
      else if (m.type === 'exit') {
        setRunning(false);
        setInterrupted(false);
        if (m.cwd) setCwd(m.cwd);
        const elapsed = started.current ? `${((Date.now() - started.current) / 1000).toFixed(2)}s` : null;
        started.current = null;
        push('meta', [m.code ? `exit ${m.code}` : null, elapsed].filter(Boolean).join(' · ') || 'done');
      }
    };
  }, [manageUrl, push, clear]);

  useEffect(() => {
    connectRef.current = connect;
    connect();
    return () => {
      generation.current += 1;
      clearTimeout(retryTimer.current);
      cancelAnimationFrame(frame.current);
      const s = ws.current;
      ws.current = null;
      s?.close();
    };
  }, [connect]);

  const send = useCallback((cmd) => {
    const t = cmd.trim();
    if (!t || ws.current?.readyState !== WebSocket.OPEN) return;
    flush();
    setChunks((prev) => appendOutput(prev, [{ type: 'cmd', text: t, cwd }], nextId));
    ws.current.send(JSON.stringify({ cmd: t }));
    started.current = Date.now();
    setRunning(t !== 'clear' && t !== 'cls');
    setHistory((h) => {
      const next = [t, ...h.filter((x) => x !== t)].slice(0, HISTORY_MAX);
      saveHistory(manageUrl, next);
      return next;
    });
  }, [cwd, flush, nextId, manageUrl]);

  /** First press sends SIGINT; pressing again while the command ignores it sends SIGKILL. */
  const interrupt = useCallback(() => {
    if (ws.current?.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({ type: 'signal', signal: interrupted ? 'SIGKILL' : 'SIGINT' }));
    push('meta', interrupted ? 'killed' : '^C');
    setInterrupted(true);
  }, [interrupted, push]);

  return { state, closeReason, cwd, chunks, running, interrupted, history, send, interrupt, connect, clear };
}

const plainCache = new WeakMap();
const plainOf = (chunk) => {
  let p = plainCache.get(chunk);
  if (p === undefined) { p = stripAnsi(chunk.text); plainCache.set(chunk, p); }
  return p;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const Chunk = React.memo(function Chunk({ chunk, fontSize, query }) {
  const [copied, setCopied] = useState(false);
  const segments = useMemo(() => (chunk.type === 'stdout' || chunk.type === 'stderr' ? parseAnsi(chunk.text) : null), [chunk.text, chunk.type]);
  const copy = () => {
    navigator.clipboard?.writeText(plainOf(chunk)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };
  const style = { fontSize: chunk.type === 'meta' ? Math.max(10, fontSize - 2) : fontSize, lineHeight: 1.55 };
  let body;
  if (chunk.type === 'cmd') {
    body = <><span className="text-[#7ee787] select-none">{shortCwd(chunk.cwd)} $ </span><span className="text-white font-semibold">{chunk.text}</span></>;
  } else if (chunk.type === 'meta') {
    body = <span className="text-[#6e7681]">[{chunk.text}]</span>;
  } else if (query) {
    const lc = query.toLowerCase();
    body = plainOf(chunk).split(new RegExp(`(${escapeRe(query)})`, 'gi'))
      .map((p, i) => (p.toLowerCase() === lc ? <mark key={i} className="bg-[#e3b341]/30 text-[#f2cc60] rounded-sm">{p}</mark> : p));
  } else {
    body = segments.map((s, i) => <span key={i} style={s.style}>{s.text}</span>);
  }
  return (
    <div className={cx('group relative', chunk.type === 'cmd' && 'mt-3 first:mt-0')}>
      <pre className={cx('m-0 whitespace-pre-wrap break-words font-mono', chunk.type === 'stderr' ? 'text-[#ffa198]' : 'text-[#c9d1d9]')} style={style}>{body}</pre>
      {chunk.type !== 'meta' && (
        <button type="button" onClick={copy} aria-label="Copy output"
          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 focus:opacity-100 px-2 h-6 rounded bg-white/10 text-[11px] font-johnson-text text-[#c9d1d9] hover:bg-white/20 transition-opacity">
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  );
});

export default function Terminal({ manageUrl, title, onClose }) {
  const term = useTerminal(manageUrl);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const outRef = useRef(null);
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const [sugIdx, setSugIdx] = useState(-1);
  const [sugHidden, setSugHidden] = useState(false);
  const [openCat, setOpenCat] = useState('system');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [fontSize, setFontSize] = useState(13);
  const [scripts, setScripts] = useState([]);
  const allSuggestions = useMemo(() => suggest(input, term.history), [input, term.history]);
  const suggestions = sugHidden || term.running ? [] : allSuggestions;
  const connected = term.state === 'open';

  const closeSearch = () => { setSearching(false); setQuery(''); inputRef.current?.focus(); };
  // Escape steps back one layer: search, then the dialog. A running command
  // keeps the dialog open; the close button is the deliberate way out.
  useDialogBehaviour(true, () => {
    if (searching) closeSearch();
    else if (paletteOpen) setPaletteOpen(false);
    else if (!term.running) onClose();
  }, dialogRef);

  useEffect(() => {
    if (!connected) return;
    requestJson(`${manageUrl}/api/scripts`).then((d) => setScripts(d.scripts || [])).catch(() => {});
  }, [connected, manageUrl]);

  // Stay pinned to the newest output unless the reader scrolled up or is selecting text.
  const stickRef = useRef(true);
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && stickRef.current && !searching && !window.getSelection()?.toString()) el.scrollTop = el.scrollHeight;
  }, [term.chunks, term.running, searching]);
  const onOutputScroll = (e) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  useEffect(() => { if (!term.running && connected) inputRef.current?.focus(); }, [term.running, connected]);

  const palette = useMemo(() => [
    ...PALETTE,
    ...(scripts.length ? [{ id: 'scripts', label: 'Scripts', cmds: scripts.map((s) => [s.name.replace(/\.sh$/, ''), s.cmd]) }] : []),
  ], [scripts]);

  const shown = useMemo(() => {
    if (!searching || !query) return term.chunks;
    const lc = query.toLowerCase();
    return term.chunks.filter((c) => plainOf(c).toLowerCase().includes(lc));
  }, [term.chunks, searching, query]);

  const run = (cmd) => {
    if (!cmd.trim() || !connected || term.running) return;
    stickRef.current = true;
    term.send(cmd);
    setInput('');
    setHistIdx(-1);
    setSugIdx(-1);
    setPaletteOpen(false);
  };

  const saveTranscript = () => {
    const text = term.chunks.map((c) => (c.type === 'cmd' ? `${c.cwd} $ ${c.text}` : c.type === 'meta' ? `[${c.text}]` : plainOf(c).replace(/\n$/, ''))).join('\n');
    downloadBlob(new Blob([`${text}\n`], { type: 'text/plain' }), `terminal_${title.replace(/\W+/g, '-')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`);
  };

  const onKeyDown = (e) => {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'c' && term.running) { e.preventDefault(); term.interrupt(); return; }
    if (e.ctrlKey && key === 'l') { e.preventDefault(); term.clear(); return; }
    if (e.ctrlKey && key === 'f') { e.preventDefault(); if (searching) closeSearch(); else setSearching(true); return; }
    if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); setInput(suggestions[Math.max(0, sugIdx)].cmd); setSugIdx(-1); return; }
    if (e.key === 'Escape' && suggestions.length) { e.preventDefault(); e.stopPropagation(); setSugIdx(-1); setSugHidden(true); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(sugIdx >= 0 ? suggestions[sugIdx].cmd : input); return; }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
      e.preventDefault();
      setSugIdx((i) => Math.max(-1, Math.min(suggestions.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (e.key === 'ArrowUp' && term.history.length) {
      e.preventDefault();
      const n = Math.min(histIdx + 1, term.history.length - 1);
      setHistIdx(n); setInput(term.history[n]); setSugHidden(true);
    } else if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const n = histIdx - 1;
      setHistIdx(n); setInput(n < 0 ? '' : term.history[n]); setSugHidden(true);
    }
  };

  const chip = 'h-7 px-2.5 rounded-md font-johnson-text text-xs text-[#c9d1d9] bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jj-red';
  const statusText = connected ? 'Connected' : term.state === 'connecting' ? 'Connecting…' : term.closeReason || 'Disconnected';
  const statusColor = connected ? '#7ee787' : term.state === 'connecting' ? '#e3b341' : '#ff7b72';

  const paletteList = (
    <nav aria-label="Command palette" className="flex-1 overflow-y-auto terminal-scroll py-2">
      {palette.map((cat) => (
        <div key={cat.id}>
          <button type="button" onClick={() => setOpenCat((c) => (c === cat.id ? null : cat.id))} aria-expanded={openCat === cat.id}
            className="w-full flex items-center justify-between px-4 h-9 font-johnson-text text-xs font-semibold text-[#8b949e] hover:text-white focus-visible:outline-none focus-visible:bg-white/5">
            {cat.label}
            <Icon name="chevronRight" className={cx('w-3 h-3 transition-transform', openCat === cat.id && 'rotate-90')} />
          </button>
          {openCat === cat.id && cat.cmds.map(([label, cmd]) => (
            <button key={label} type="button" title={cmd} disabled={!connected || term.running} onClick={() => run(cmd)}
              className="w-full flex flex-col items-start px-5 py-1.5 text-left hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:bg-white/10">
              <span className="font-johnson-text text-xs text-[#c9d1d9]">{label}</span>
              <span className="font-mono text-[10px] text-[#6e7681] truncate max-w-full">{cmd}</span>
            </button>
          ))}
        </div>
      ))}
      {term.history.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/10">
          <p className="px-4 h-8 flex items-center font-johnson-text text-xs font-semibold text-[#8b949e]">Recent</p>
          {term.history.slice(0, 10).map((cmd) => (
            <button key={cmd} type="button" title={cmd} disabled={!connected || term.running} onClick={() => run(cmd)}
              className="w-full px-5 py-1 text-left font-mono text-[11px] text-[#8b949e] hover:text-white hover:bg-white/5 truncate disabled:opacity-40">{cmd}</button>
          ))}
        </div>
      )}
    </nav>
  );

  return createPortal(
    <div className="fixed inset-0 z-[75] flex sm:p-3 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Terminal on ${title}`}
        className="relative flex flex-col w-full h-full bg-[#010409] sm:rounded-2xl overflow-hidden border border-white/10 shadow-overlay animate-dialog-in outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <header className="flex items-center gap-2 sm:gap-3 h-12 px-3 sm:px-4 border-b border-white/10 flex-shrink-0">
          <button type="button" onClick={() => setPaletteOpen((v) => !v)} className={cx(chip, 'md:hidden')} aria-expanded={paletteOpen}>Commands</button>
          <span className="font-johnson-display text-sm text-white truncate">Terminal · {title}</span>
          <span className="hidden sm:inline font-mono text-xs text-[#8b949e] truncate" title={term.cwd}>{shortCwd(term.cwd)}</span>
          <span className="ml-auto flex items-center gap-1.5 min-w-0 font-johnson-text text-xs" style={{ color: statusColor }} role="status" title={statusText}>
            <Dot color={statusColor} pulse={connected} className="w-1.5 h-1.5 flex-shrink-0" />
            <span className="sr-only sm:not-sr-only truncate max-w-[16rem]">{statusText}</span>
          </span>
          {term.state === 'closed' && <button type="button" className={chip} onClick={term.connect}>Reconnect</button>}
          <div className="hidden lg:flex">
            <button type="button" className={cx(chip, 'rounded-r-none')} onClick={() => setFontSize((s) => Math.max(10, s - 1))} aria-label="Smaller text">A−</button>
            <button type="button" className={cx(chip, 'rounded-l-none border-l-0')} onClick={() => setFontSize((s) => Math.min(20, s + 1))} aria-label="Larger text">A+</button>
          </div>
          <button type="button" className={cx(chip, searching && 'bg-white/15')} onClick={() => (searching ? closeSearch() : setSearching(true))} aria-pressed={searching}>Search</button>
          <button type="button" className={cx(chip, 'hidden sm:inline-flex items-center')} onClick={saveTranscript} disabled={!term.chunks.length}>Save</button>
          <button type="button" className={cx(chip, 'hidden sm:inline-flex items-center')} onClick={term.clear} disabled={!term.chunks.length}>Clear</button>
          <button type="button" onClick={onClose} aria-label={term.running ? 'Close terminal and stop the running command' : 'Close terminal'}
            className="w-8 h-8 flex items-center justify-center rounded-md text-[#c9d1d9] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jj-red">
            <Icon name="close" className="w-3.5 h-3.5" />
          </button>
        </header>

        <div className="flex flex-1 min-h-0">
          <aside className="hidden md:flex w-60 flex-shrink-0 flex-col border-r border-white/10">{paletteList}</aside>
          {paletteOpen && (
            <aside className="md:hidden absolute inset-x-0 top-12 bottom-0 z-10 flex flex-col bg-[#0d1117] animate-fade-in">{paletteList}</aside>
          )}

          <div className="flex flex-col flex-1 min-w-0">
            {searching && (
              <div className="flex items-center gap-2 px-3 h-10 border-b border-white/10 bg-white/5">
                <Icon name="search" className="w-3.5 h-3.5 text-[#8b949e]" />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search output" aria-label="Search output"
                  className="flex-1 min-w-0 bg-transparent outline-none font-mono text-xs text-white placeholder:text-[#6e7681]" />
                {query && <span className="font-johnson-text text-xs text-[#8b949e]" aria-live="polite">{shown.length} match{shown.length === 1 ? '' : 'es'}</span>}
              </div>
            )}
            <div ref={outRef} onScroll={onOutputScroll} className="flex-1 overflow-y-auto terminal-scroll px-3 sm:px-4 py-3" onClick={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}>
              {term.chunks.length === 0 ? (
                <div className="font-johnson-text text-sm text-[#8b949e] leading-7">
                  <p className="font-mono text-xs text-[#79c0ff] break-all">{manageUrl}</p>
                  <p>Run a command below or pick one from the command list. cd, export and unset carry over between commands.</p>
                  <p className="hidden sm:block">↑ ↓ history · Tab complete · Ctrl+C interrupt (twice to kill) · Ctrl+L clear · Ctrl+F search</p>
                </div>
              ) : shown.map((c) => <Chunk key={c.id} chunk={c} fontSize={fontSize} query={searching ? query : ''} />)}
              {term.running && <span className="inline-block w-2 bg-[#c9d1d9] align-middle animate-blink" style={{ height: fontSize + 2 }} aria-hidden="true" />}
            </div>

            <div className="relative border-t border-white/10 flex-shrink-0">
              {suggestions.length > 0 && (
                <ul className="absolute bottom-full inset-x-3 mb-2 rounded-xl overflow-hidden border border-white/10 bg-[#161b22] shadow-overlay" role="listbox" aria-label="Suggestions">
                  {suggestions.map((s, i) => (
                    <li key={s.cmd} role="option" aria-selected={i === sugIdx}>
                      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => { setInput(s.cmd); setSugHidden(true); inputRef.current?.focus(); }}
                        className={cx('w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left font-mono text-xs', i === sugIdx ? 'bg-white/10 text-white' : 'text-[#c9d1d9] hover:bg-white/5')}>
                        <span className="truncate">{s.cmd}</span>
                        <span className={cx('font-johnson-text text-[10px] font-semibold', s.src === 'history' ? 'text-[#e3b341]' : 'text-[#79c0ff]')}>{s.src}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className={cx('font-mono flex-shrink-0 select-none', term.running ? 'text-[#6e7681]' : 'text-[#7ee787]')} style={{ fontSize }}>
                  {shortCwd(term.cwd)} $
                </span>
                <input ref={inputRef} data-autofocus value={input} onChange={(e) => { setInput(e.target.value); setSugIdx(-1); setSugHidden(false); setHistIdx(-1); }} onKeyDown={onKeyDown}
                  disabled={!connected} spellCheck={false} autoCapitalize="none" autoCorrect="off" autoComplete="off" aria-label="Command"
                  enterKeyHint="send"
                  placeholder={!connected ? 'Not connected' : term.running ? 'Running… (Ctrl+C to interrupt)' : ''}
                  className="flex-1 min-w-0 bg-transparent outline-none font-mono text-white placeholder:text-[#6e7681] disabled:opacity-50" style={{ fontSize }} />
                {term.running && (
                  <button type="button" onClick={term.interrupt} className="h-7 px-2.5 flex-shrink-0 rounded-md border border-[#ff7b72]/60 text-[#ff7b72] font-johnson-text text-xs font-semibold hover:bg-[#ff7b72]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff7b72]">
                    {term.interrupted ? 'Force kill' : 'Interrupt'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
