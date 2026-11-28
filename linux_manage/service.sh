# shellcheck shell=bash
# Shared by backend.sh and frontend.sh; not run on its own.
#
# The caller sets SERVICE and APP_DIR, sources this file, calls load_settings,
# sets its defaults (a CONFIG_* value from the Server Manager's config.ini
# fills any setting .env.server leaves out), then defines:
#   prepare          install dependencies / build; runs before any stop
#   server_command   fills the SERVER_CMD array (the server, in the foreground)
# and finally calls: run_service "$@"
#
# The server runs under supervise.py, which restarts it if it dies. Files,
# all inside APP_DIR:
#   .env.server            settings (PORT, HOST, TLS_CERT, TLS_KEY, ...)
#   run/<service>.pid      the supervisor; run/<service>.child.pid the server;
#                          run/<service>.health where it answers;
#                          run/<service>.config the Server Manager's defaults
#   logs/<service>.log     server output, timestamped, rotated by size
#   logs/<service>.out     this script's own messages when run from cron

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }
stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

load_settings() {
  [[ -d "$APP_DIR" ]] || die "$SERVICE directory not found: $APP_DIR"
  APP_DIR="$(cd "$APP_DIR" && pwd)"
  cd "$APP_DIR" || exit 1
  CONFIG_FILE="$APP_DIR/run/$SERVICE.config"
  # Run from cron or a shell, reuse the defaults the Server Manager last
  # passed, so a restart here keeps the same port and certificate.
  if [[ -z "${MANAGED_BY:-}" && -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
  fi
  if [[ -f .env.server ]]; then
    set -a
    # shellcheck disable=SC1091
    source ./.env.server
    set +a
  fi
  HOST="${HOST:-0.0.0.0}"
  GRACEFUL_TIMEOUT="${GRACEFUL_TIMEOUT:-30}"
  export GRACEFUL_TIMEOUT
  LOG_FILE="$APP_DIR/logs/$SERVICE.log"
  OUT_FILE="$APP_DIR/logs/$SERVICE.out"
  PID_FILE="$APP_DIR/run/$SERVICE.pid"
  CHILD_PID_FILE="$APP_DIR/run/$SERVICE.child.pid"
  HEALTH_FILE="$APP_DIR/run/$SERVICE.health"
}

# Called after the service has set PORT and HEALTH_PATH.
finish_settings() {
  # The Server Manager passes its config.ini [ssl] pair as CONFIG_TLS_*; a
  # TLS_CERT / TLS_KEY in .env.server (even empty, for plain HTTP) wins.
  TLS_CERT="${TLS_CERT-${CONFIG_TLS_CERT:-}}"
  TLS_KEY="${TLS_KEY-${CONFIG_TLS_KEY:-}}"
  if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
    die "PORT must be 1-65535, got '$PORT'"
  fi
  [[ "$GRACEFUL_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die "GRACEFUL_TIMEOUT must be a whole number of seconds, got '$GRACEFUL_TIMEOUT'"
  [[ "$START_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die "START_TIMEOUT must be a whole number of seconds, got '$START_TIMEOUT'"
  if [[ -n "${TLS_CERT:-}" || -n "${TLS_KEY:-}" ]]; then
    [[ -n "${TLS_CERT:-}" && -n "${TLS_KEY:-}" ]] || die "set both TLS_CERT and TLS_KEY in $APP_DIR/.env.server, or neither"
    [[ -r "$TLS_CERT" ]] || die "TLS_CERT not readable: $TLS_CERT"
    [[ -r "$TLS_KEY" ]] || die "TLS_KEY not readable: $TLS_KEY"
    SCHEME=https
  else
    SCHEME=http
  fi
  local health_host="$HOST"
  [[ "$health_host" == "0.0.0.0" || "$health_host" == "::" ]] && health_host=127.0.0.1
  HEALTH_URL="$SCHEME://$health_host:$PORT$HEALTH_PATH"
  SUPERVISOR_PYTHON="${SUPERVISOR_PYTHON:-$(command -v python3 || true)}"
}

# PID from a file, only if that process is alive and its command line matches.
pid_matching() {
  local file=$1 pattern=$2 pid
  [[ -f "$file" ]] || return 1
  pid="$(<"$file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$pattern" || return 1
  echo "$pid"
}

running_pid() { pid_matching "$PID_FILE" "supervise.py --name $SERVICE "; }

# Check a running server where it was started, even if the settings it was
# started with (for example the Server Manager's port) aren't in effect here.
use_running_address() {
  if running_pid >/dev/null && [[ -s "$HEALTH_FILE" ]]; then
    HEALTH_URL="$(<"$HEALTH_FILE")"
  fi
}

healthy() {
  # -k: the certificate names the public host, not 127.0.0.1.
  curl -fsk --max-time 5 -o /dev/null "$HEALTH_URL"
}

# Processes started by the old start scripts kept their PID in
# <dir>/<service>.pid. Stop such a process so it doesn't hold the port.
stop_previous_layout() {
  local old="$APP_DIR/$SERVICE.pid" pid
  pid="$(pid_matching "$old" "$SERVER_PATTERN" || true)"
  if [[ -n "$pid" ]]; then
    echo "Stopping $SERVICE started by the old scripts (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 "$((GRACEFUL_TIMEOUT + 15))"); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$old"
}

# A server whose supervisor was killed outright gets SIGTERM from the kernel
# and may still be shutting down; wait for it so the port is free.
stop_orphan() {
  local pid
  pid="$(pid_matching "$CHILD_PID_FILE" "${SERVER_PATTERN}" || true)"
  [[ -n "$pid" ]] || return 0
  echo "Waiting for the previous $SERVICE process $pid to exit..."
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$((GRACEFUL_TIMEOUT + 15))"); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
  kill -KILL "$pid" 2>/dev/null || true
}

port_free() {
  "$SUPERVISOR_PYTHON" - "$HOST" "$PORT" <<'PY'
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
family = socket.AF_INET6 if ":" in host else socket.AF_INET
with socket.socket(family, socket.SOCK_STREAM) as s:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((host, port))
    except OSError:
        sys.exit(1)
PY
}

# Start the supervisor; the caller has made sure the service isn't running.
launch() {
  local launched waited=0
  [[ -x "$SUPERVISOR_PYTHON" ]] || die "python3 not found at '$SUPERVISOR_PYTHON'; set SUPERVISOR_PYTHON in $APP_DIR/.env.server"
  stop_previous_layout
  stop_orphan
  port_free || die "port $PORT is already in use by another process; stop it or change PORT in $APP_DIR/.env.server"
  server_command
  mkdir -p "$APP_DIR/logs" "$APP_DIR/run"
  rm -f "$PID_FILE" "$CHILD_PID_FILE"
  echo "$HEALTH_URL" >"$HEALTH_FILE"
  if [[ -n "${MANAGED_BY:-}" ]]; then
    : >"$CONFIG_FILE"
    local name
    for name in CONFIG_PORT CONFIG_APP CONFIG_TLS_CERT CONFIG_TLS_KEY; do
      if [[ -n "${!name:-}" ]]; then printf '%s=%q\n' "$name" "${!name}" >>"$CONFIG_FILE"; fi
    done
  fi
  echo "$(stamp) starting $SERVICE on $SCHEME port $PORT" >>"$OUT_FILE"
  # 9>&-: the supervisor must not inherit the lock, or later commands wait on it.
  setsid "$SUPERVISOR_PYTHON" "$LIB_DIR/supervise.py" --name "$SERVICE" \
    --pid-file "$PID_FILE" --log-file "$LOG_FILE" -- "${SERVER_CMD[@]}" \
    >>"$OUT_FILE" 2>&1 </dev/null 9>&- &
  launched=$!

  echo "Waiting for $SERVICE to answer at $HEALTH_URL..."
  while (( waited < START_TIMEOUT * 2 )); do
    sleep 0.5
    waited=$((waited + 1))
    if healthy && pid_matching "$CHILD_PID_FILE" "$SERVER_PATTERN" >/dev/null; then
      echo "$SERVICE running (PID $launched) at $SCHEME://$(hostname -f 2>/dev/null || hostname):$PORT"
      return 0
    fi
    kill -0 "$launched" 2>/dev/null || break
  done

  if kill -0 "$launched" 2>/dev/null; then
    echo "$SERVICE is not answering after ${START_TIMEOUT}s; it is still starting or stuck. See $LOG_FILE" >&2
  else
    echo "FAILED: $SERVICE did not start. Recent output:" >&2
    tail -n 5 "$OUT_FILE" >&2 || true
    [[ -f "$LOG_FILE" ]] && tail -n 25 "$LOG_FILE" >&2
  fi
  return 1
}

stop_service() {
  local pid child
  stop_previous_layout
  if ! pid="$(running_pid)"; then
    echo "$SERVICE is not running"
    rm -f "$PID_FILE" "$CHILD_PID_FILE" "$HEALTH_FILE"
    return 0
  fi
  child="$(pid_matching "$CHILD_PID_FILE" "$SERVER_PATTERN" || true)"
  echo "Stopping $SERVICE (PID $pid)..."
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$((GRACEFUL_TIMEOUT + 30))"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$HEALTH_FILE"
      echo "$SERVICE stopped"
      return 0
    fi
    sleep 1
  done
  echo "$SERVICE still running after $((GRACEFUL_TIMEOUT + 30))s, killing it" >&2
  kill -KILL "$pid" 2>/dev/null || true
  [[ -n "$child" ]] && kill -KILL "$child" 2>/dev/null
  rm -f "$PID_FILE" "$CHILD_PID_FILE" "$HEALTH_FILE"
}

status_service() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "$SERVICE stopped"
    return 3
  fi
  if healthy; then
    echo "$SERVICE running (PID $pid), healthy at $HEALTH_URL"
    return 0
  fi
  echo "$SERVICE running (PID $pid) but not answering at $HEALTH_URL" >&2
  return 1
}

ensure_service() {
  local pid age
  if pid="$(running_pid)"; then
    # Still inside its start-up window (for example right after a reboot): leave it.
    age="$(ps -o etimes= -p "$pid" | tr -d ' ' || true)"
    if [[ -n "$age" ]] && (( age < START_TIMEOUT )); then
      return 0
    fi
    # A busy moment can delay one check; restart only after 30s of silence.
    for _ in 1 2 3; do
      healthy && return 0
      sleep 10
    done
    echo "$(stamp) ensure: $SERVICE not answering at $HEALTH_URL for 30s, restarting"
    stop_service
  else
    echo "$(stamp) ensure: $SERVICE not running, starting"
  fi
  prepare
  launch
}

run_service() {
  local action="${1:-}"
  case "$action" in
    start|stop|restart|status|ensure) ;;
    *) echo "Usage: $0 start|stop|restart|status|ensure" >&2; exit 2 ;;
  esac
  finish_settings

  # From cron nobody reads the output (cron would mail it), so keep it in
  # logs/<service>.out. ensure logs only when it acts.
  if [[ ! -t 1 && -z "${MANAGED_BY:-}" && "$action" != "status" ]]; then
    mkdir -p "$APP_DIR/logs"
    exec >>"$OUT_FILE" 2>&1
    [[ "$action" != "ensure" ]] && echo "$(stamp) $0 $action"
  fi

  # One command at a time: cron's ensure must not race a manual start or stop.
  mkdir -p "$APP_DIR/run"
  exec 9>"$APP_DIR/run/$SERVICE.lock"
  if [[ "$action" != "status" ]] && ! flock -w 600 9; then
    die "another $SERVICE command is still running"
  fi

  case "$action" in
    start)
      if running_pid >/dev/null; then
        echo "$SERVICE already running (PID $(running_pid))"
        return 0
      fi
      prepare
      launch ;;
    # Prepare while the old server still serves, so a restart costs seconds
    # and a failed install or build leaves the running one untouched.
    restart) prepare && stop_service && launch ;;
    stop) stop_service ;;
    status) use_running_address; status_service ;;
    ensure) use_running_address; ensure_service ;;
  esac
}
