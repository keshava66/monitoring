import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { requestJson } from '../utils/apiClient';
import { Dot, Icon, cx } from '../components/ui';

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
function useTerminal(manageUrl) {
  const ws = useRef(null);
  const idRef = useRef(0);
  const started = useRef(null);
  const [state, setState] = useState('connecting');
  const [closeReason, setCloseReason] = useState('');
  const [cwd, setCwd] = useState('~');
  const [chunks, setChunks] = useState([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);

  const push = useCallback((type, text) => {
    if (!text) return;
    setChunks((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.type === type && (type === 'stdout' || type === 'stderr')) {
        return [...prev.slice(0, -1), { ...last, text: (last.text + text).slice(-200_000) }];
      }
      return [...prev, { id: ++idRef.current, type, text }].slice(-2000);
    });
  }, []);

  const connect = useCallback(async () => {
    ws.current?.close();
    setState('connecting');
    setCloseReason('');
    let ticket;
    try {
      ({ ticket } = await requestJson(`${manageUrl}/api/terminal/ticket`, { method: 'POST' }));
    } catch (e) {
      setState('closed');
      setCloseReason(e.status === 403 ? 'Admin group membership required on this server' : e.message);
      return;
    }
    const url = `${manageUrl.replace(/^http/, 'ws')}/ws/terminal?ticket=${encodeURIComponent(ticket)}`;
    const sock = new WebSocket(url);
    ws.current = sock;
    sock.onopen = () => setState('open');
    sock.onclose = (ev) => {
      if (ws.current !== sock) return;
      setState('closed');
      setRunning(false);
      setCloseReason(ev.code === 4401 ? 'Not authorised' : ev.reason || 'Connection closed');
    };
    sock.onmessage = ({ data }) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === 'cwd') setCwd(m.cwd);
      else if (m.type === 'stdout' || m.type === 'stderr') push(m.type, m.data);
      else if (m.type === 'clear') { setChunks([]); started.current = null; setRunning(false); }
      else if (m.type === 'exit') {
        setRunning(false);
        if (m.cwd) setCwd(m.cwd);
        const elapsed = started.current ? `${((Date.now() - started.current) / 1000).toFixed(2)}s` : null;
        started.current = null;
        push('meta', [m.code ? `exit ${m.code}` : null, elapsed].filter(Boolean).join(' · ') || 'done');
      }
    };
  }, [manageUrl, push]);

  useEffect(() => {
    connect();
    return () => { const s = ws.current; ws.current = null; s?.close(); };
  }, [connect]);

  const send = useCallback((cmd) => {
    const t = cmd.trim();
    if (!t || ws.current?.readyState !== WebSocket.OPEN) return;
    setChunks((prev) => [...prev, { id: ++idRef.current, type: 'cmd', text: t, cwd }]);
    ws.current.send(JSON.stringify({ cmd: t }));
    started.current = Date.now();
    setRunning(t !== 'clear' && t !== 'cls');
    setHistory((h) => [t, ...h.filter((x) => x !== t)].slice(0, 100));
  }, [cwd]);

  const interrupt = useCallback(() => {
    ws.current?.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
    push('meta', '^C');
  }, [push]);

  return { state, closeReason, cwd, chunks, running, history, send, interrupt, connect, clear: () => setChunks([]) };
}

function Chunk({ chunk, fontSize, query }) {
  const [copied, setCopied] = useState(false);
  const plain = useMemo(() => stripAnsi(chunk.text), [chunk.text]);
  const copy = () => {
    navigator.clipboard?.writeText(plain).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };
  const style = { fontSize: chunk.type === 'meta' ? Math.max(10, fontSize - 2) : fontSize, lineHeight: 1.55 };
  let body;
  if (chunk.type === 'cmd') {
    body = <><span className="text-[#7ee787] select-none">{shortCwd(chunk.cwd)} $ </span><span className="text-white font-semibold">{plain}</span></>;
  } else if (chunk.type === 'meta') {
    body = <span className="text-[#6e7681]">[{plain}]</span>;
  } else if (query) {
    const parts = plain.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    body = parts.map((p, i) => (p.toLowerCase() === query.toLowerCase() ? <mark key={i} className="bg-[#e3b341]/30 text-[#f2cc60] rounded-sm">{p}</mark> : p));
  } else {
    body = parseAnsi(chunk.text).map((s, i) => <span key={i} style={s.style}>{s.text}</span>);
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
}

export default function Terminal({ manageUrl, title, onClose }) {
  const term = useTerminal(manageUrl);
  const inputRef = useRef(null);
  const outRef = useRef(null);
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const [sugIdx, setSugIdx] = useState(-1);
  const [openCat, setOpenCat] = useState('system');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [fontSize, setFontSize] = useState(13);
  const [scripts, setScripts] = useState([]);
  const suggestions = useMemo(() => suggest(input, term.history), [input, term.history]);
  const connected = term.state === 'open';

  useEffect(() => {
    if (!connected) return;
    requestJson(`${manageUrl}/api/scripts`).then((d) => setScripts(d.scripts || [])).catch(() => {});
  }, [connected, manageUrl]);

  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape' && !searching && !suggestions.length) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); };
  }, [onClose, searching, suggestions.length]);

  useEffect(() => {
    const el = outRef.current;
    if (el && !searching && !window.getSelection()?.toString()) el.scrollTop = el.scrollHeight;
  }, [term.chunks, searching]);

  useEffect(() => { if (!term.running && connected) inputRef.current?.focus(); }, [term.running, connected]);

  const palette = useMemo(() => [
    ...PALETTE,
    ...(scripts.length ? [{ id: 'scripts', label: 'Scripts', cmds: scripts.map((s) => [s.name.replace(/\.sh$/, ''), s.cmd]) }] : []),
  ], [scripts]);

  const run = (cmd) => {
    if (!cmd.trim() || !connected || term.running) return;
    term.send(cmd);
    setInput('');
    setHistIdx(-1);
    setSugIdx(-1);
    setPaletteOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && term.running) { e.preventDefault(); term.interrupt(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); term.clear(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearching((s) => !s); return; }
    if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); setInput(suggestions[Math.max(0, sugIdx)].cmd); setSugIdx(-1); return; }
    if (e.key === 'Escape' && suggestions.length) { e.preventDefault(); setSugIdx(-1); setInput((v) => `${v}`); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(sugIdx >= 0 ? suggestions[sugIdx].cmd : input); return; }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
      e.preventDefault();
      setSugIdx((i) => Math.max(-1, Math.min(suggestions.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (e.key === 'ArrowUp' && term.history.length) {
      e.preventDefault();
      const n = Math.min(histIdx + 1, term.history.length - 1);
      setHistIdx(n); setInput(term.history[n]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const n = Math.max(histIdx - 1, -1);
      setHistIdx(n); setInput(n < 0 ? '' : term.history[n]);
    }
  };

  const shown = searching && query ? term.chunks.filter((c) => stripAnsi(c.text).toLowerCase().includes(query.toLowerCase())) : term.chunks;
  const chip = 'h-7 px-2.5 rounded-md font-johnson-text text-xs text-[#c9d1d9] bg-white/5 border border-white/10 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jj-red';

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
    <div className="fixed inset-0 z-[75] flex sm:p-3 bg-black/60 backdrop-blur-sm animate-fade-in" role="dialog" aria-modal="true" aria-label={`Terminal on ${title}`}>
      <div className="relative flex flex-col w-full h-full bg-[#010409] sm:rounded-2xl overflow-hidden border border-white/10 shadow-overlay animate-dialog-in pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <header className="flex items-center gap-2 sm:gap-3 h-12 px-3 sm:px-4 border-b border-white/10 flex-shrink-0">
          <button type="button" onClick={() => setPaletteOpen((v) => !v)} className={cx(chip, 'md:hidden')} aria-expanded={paletteOpen}>Commands</button>
          <span className="font-johnson-display text-sm text-white truncate">Terminal · {title}</span>
          <span className="hidden sm:inline font-mono text-xs text-[#8b949e] truncate">{shortCwd(term.cwd)}</span>
          <span className={cx('ml-auto flex items-center gap-1.5 font-johnson-text text-xs', connected ? 'text-[#7ee787]' : term.state === 'connecting' ? 'text-[#e3b341]' : 'text-[#ff7b72]')}>
            <Dot color={connected ? '#7ee787' : term.state === 'connecting' ? '#e3b341' : '#ff7b72'} pulse={connected} className="w-1.5 h-1.5" />
            <span className="hidden sm:inline">{connected ? 'Connected' : term.state === 'connecting' ? 'Connecting…' : term.closeReason || 'Disconnected'}</span>
          </span>
          {!connected && term.state !== 'connecting' && <button type="button" className={chip} onClick={term.connect}>Reconnect</button>}
          <div className="hidden sm:flex">
            <button type="button" className={cx(chip, 'rounded-r-none')} onClick={() => setFontSize((s) => Math.max(10, s - 1))} aria-label="Smaller text">A−</button>
            <button type="button" className={cx(chip, 'rounded-l-none border-l-0')} onClick={() => setFontSize((s) => Math.min(20, s + 1))} aria-label="Larger text">A+</button>
          </div>
          <button type="button" className={cx(chip, searching && 'bg-white/15')} onClick={() => setSearching((s) => !s)} aria-pressed={searching}>Search</button>
          <button type="button" className={cx(chip, 'hidden sm:inline-flex items-center')} onClick={term.clear}>Clear</button>
          <button type="button" onClick={onClose} aria-label="Close terminal"
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
                  className="flex-1 bg-transparent outline-none font-mono text-xs text-white placeholder:text-[#6e7681]" />
                {query && <span className="font-johnson-text text-xs text-[#8b949e]">{shown.length} match{shown.length === 1 ? '' : 'es'}</span>}
              </div>
            )}
            <div ref={outRef} className="flex-1 overflow-y-auto terminal-scroll px-3 sm:px-4 py-3" onClick={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}>
              {term.chunks.length === 0 ? (
                <div className="font-johnson-text text-sm text-[#8b949e] leading-7">
                  <p className="font-mono text-xs text-[#79c0ff]">{manageUrl}</p>
                  <p>Run a command below or pick one from the command list.</p>
                  <p className="hidden sm:block">↑ ↓ history · Tab complete · Ctrl+C interrupt · Ctrl+L clear · Ctrl+F search</p>
                </div>
              ) : shown.map((c) => <Chunk key={c.id} chunk={c} fontSize={fontSize} query={searching ? query : ''} />)}
              {term.running && <span className="inline-block w-2 bg-[#c9d1d9] align-middle animate-blink" style={{ height: fontSize + 2 }} aria-hidden="true" />}
            </div>

            <div className="relative border-t border-white/10 flex-shrink-0">
              {suggestions.length > 0 && !term.running && (
                <ul className="absolute bottom-full inset-x-3 mb-2 rounded-xl overflow-hidden border border-white/10 bg-[#161b22] shadow-overlay" role="listbox" aria-label="Suggestions">
                  {suggestions.map((s, i) => (
                    <li key={s.cmd} role="option" aria-selected={i === sugIdx}>
                      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setInput(s.cmd); inputRef.current?.focus(); }}
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
                <input ref={inputRef} value={input} onChange={(e) => { setInput(e.target.value); setSugIdx(-1); }} onKeyDown={onKeyDown}
                  disabled={!connected} spellCheck={false} autoCapitalize="none" autoCorrect="off" autoComplete="off" aria-label="Command"
                  placeholder={!connected ? 'Not connected' : term.running ? 'Running… (Ctrl+C to interrupt)' : ''}
                  className="flex-1 min-w-0 bg-transparent outline-none font-mono text-white placeholder:text-[#6e7681] disabled:opacity-50" style={{ fontSize }} />
                {term.running && (
                  <button type="button" onClick={term.interrupt} className="h-7 px-2.5 rounded-md border border-[#ff7b72]/60 text-[#ff7b72] font-johnson-text text-xs font-semibold hover:bg-[#ff7b72]/10">
                    Interrupt
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
