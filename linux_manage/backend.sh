#!/usr/bin/env bash
# usage: backend.sh {start|stop|restart} <dir> <port> [entry, e.g. Backend:app]
# Optional env: SSL_CERTFILE, SSL_KEYFILE, FORWARDED_ALLOW_IPS, PYTHON_BIN
set -euo pipefail

ACTION="${1:-}"; DIR="${2:-}"; PORT="${3:-}"; ENTRY="${4:-}"
die() { echo "ERROR: $*" >&2; exit 1; }

[ -n "$ACTION" ] && [ -n "$DIR" ] && [ -n "$PORT" ] || die "usage: $0 {start|stop|restart} <dir> <port> [entry]"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "invalid port: $PORT"
[ -d "$DIR" ] || die "directory not found: $DIR"
cd "$DIR"

PY="$DIR/venv/bin/python"
PIDFILE="$DIR/backend.pid"
LOGFILE="$DIR/backend.log"
MAX_LOG_BYTES=$((50 * 1024 * 1024))

running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

stop_it() {
  local pid
  if pid="$(running_pid)"; then
    echo "Stopping backend (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Backend did not exit in 20s, killing"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    echo "Backend stopped"
  else
    echo "Backend is not running"
  fi
  rm -f "$PIDFILE"
}

# venv + requirements, done before any stop so a restart only takes the
# service down for the few seconds uvicorn needs to boot.
prepare() {
  [[ "$ENTRY" =~ ^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid entry '$ENTRY' (expected module:app)"
  if [ ! -x "$PY" ]; then
    echo "Creating virtual environment..."
    "${PYTHON_BIN:-python3}" -m venv "$DIR/venv"
  fi
  if [ -f requirements.txt ]; then
    local stamp="$DIR/venv/.requirements.sha256" sum
    sum="$(sha256sum requirements.txt | cut -d' ' -f1)"
    if [ "$(cat "$stamp" 2>/dev/null || true)" != "$sum" ]; then
      echo "Installing requirements..."
      "$PY" -m pip install -q --disable-pip-version-check -r requirements.txt
      echo "$sum" > "$stamp"
    else
      echo "Requirements unchanged"
    fi
  fi
}

launch() {
  local scheme=http pid code
  local -a ssl_args=()
  if [ -n "${SSL_CERTFILE:-}" ] && [ -n "${SSL_KEYFILE:-}" ] && [ -f "$SSL_CERTFILE" ] && [ -f "$SSL_KEYFILE" ]; then
    ssl_args=(--ssl-certfile "$SSL_CERTFILE" --ssl-keyfile "$SSL_KEYFILE")
    scheme=https
  fi

  if [ -f "$LOGFILE" ] && [ "$(stat -c %s "$LOGFILE")" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOGFILE" "$LOGFILE.1"
  fi
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') starting $ENTRY on :$PORT =====" >> "$LOGFILE"

  nohup "$PY" -m uvicorn "$ENTRY" --host 0.0.0.0 --port "$PORT" \
    --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
    --timeout-graceful-shutdown 15 "${ssl_args[@]}" >> "$LOGFILE" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$PIDFILE"
  echo "Launched uvicorn (PID $pid), waiting for :$PORT..."

  for _ in $(seq 1 30); do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"
      echo "FAILED to start. Last log lines:"
      tail -25 "$LOGFILE"
      exit 1
    fi
    code="$(curl -sk -o /dev/null -w '%{http_code}' "$scheme://127.0.0.1:$PORT/" || true)"
    if [ "$code" != "000" ]; then
      echo "Backend started on :$PORT over ${scheme^^} (PID $pid)"
      return 0
    fi
  done
  echo "Backend process is up (PID $pid) but :$PORT is not answering yet; check $LOGFILE"
}

start_it() {
  local pid
  if pid="$(running_pid)"; then
    echo "Backend already running (PID $pid)"
    return 0
  fi
  prepare
  launch
}

case "$ACTION" in
  start)   start_it ;;
  stop)    stop_it ;;
  restart) prepare; stop_it; launch ;;
  *)       die "unknown action: $ACTION" ;;
esac
