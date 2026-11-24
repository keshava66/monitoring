#!/usr/bin/env bash
# usage: frontend.sh {start|stop|restart} <dir> <port>
# Optional env: SSL_CERTFILE, SSL_KEYFILE, NODE_BIN
set -euo pipefail

ACTION="${1:-}"; DIR="${2:-}"; PORT="${3:-}"
die() { echo "ERROR: $*" >&2; exit 1; }

[ -n "$ACTION" ] && [ -n "$DIR" ] && [ -n "$PORT" ] || die "usage: $0 {start|stop|restart} <dir> <port>"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "invalid port: $PORT"
[ -d "$DIR" ] || die "directory not found: $DIR"
cd "$DIR"

NODE="${NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE" ] || die "node not found (set NODE_BIN)"
PIDFILE="$DIR/frontend.pid"
LOGFILE="$DIR/frontend.log"
SERVE="node_modules/serve/build/main.js"
MAX_LOG_BYTES=$((20 * 1024 * 1024))

running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

stop_it() {
  local pid
  if pid="$(running_pid)"; then
    echo "Stopping frontend (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    echo "Frontend stopped"
  else
    echo "Frontend is not running"
  fi
  rm -f "$PIDFILE"
}

install_deps() {
  if [ -f package-lock.json ]; then
    if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
      echo "Installing dependencies (npm ci)..."
      npm ci --no-audit --no-fund
    fi
  elif [ ! -d node_modules ]; then
    echo "Installing dependencies (npm install)..."
    npm install --no-audit --no-fund
  fi
  [ -f "$SERVE" ] || npm install --no-save --no-audit --no-fund serve@14.2.5
}

start_it() {
  local pid
  if pid="$(running_pid)"; then
    echo "Frontend already running (PID $pid)"
    return 0
  fi
  install_deps
  if [ ! -f dist/index.html ]; then
    echo "Building..."
    npm run build
  fi

  local scheme=http
  local -a ssl_args=()
  if [ -n "${SSL_CERTFILE:-}" ] && [ -n "${SSL_KEYFILE:-}" ] && [ -f "$SSL_CERTFILE" ] && [ -f "$SSL_KEYFILE" ]; then
    ssl_args=(--ssl-cert "$SSL_CERTFILE" --ssl-key "$SSL_KEYFILE")
    scheme=https
  fi

  if [ -f "$LOGFILE" ] && [ "$(stat -c %s "$LOGFILE")" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOGFILE" "$LOGFILE.1"
  fi
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') starting on :$PORT =====" >> "$LOGFILE"

  nohup "$NODE" "$SERVE" -s dist -l "tcp://0.0.0.0:$PORT" --no-clipboard --no-port-switching \
    "${ssl_args[@]}" >> "$LOGFILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PIDFILE"

  for _ in $(seq 1 15); do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"
      echo "FAILED to start. Last log lines:"
      tail -25 "$LOGFILE"
      exit 1
    fi
    if [ "$(curl -sk -o /dev/null -w '%{http_code}' "$scheme://127.0.0.1:$PORT/" || true)" = "200" ]; then
      echo "Frontend started on :$PORT over ${scheme^^} (PID $pid)"
      return 0
    fi
  done
  echo "Frontend process is up (PID $pid) but :$PORT is not answering yet; check $LOGFILE"
}

case "$ACTION" in
  start)   start_it ;;
  stop)    stop_it ;;
  restart) stop_it; rm -rf dist; start_it ;;
  *)       die "unknown action: $ACTION" ;;
esac
