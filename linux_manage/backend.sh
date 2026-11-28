#!/usr/bin/env bash
# Start, stop and watch the monitoring backend (uvicorn, kept running by supervise.py).
#
#   backend.sh start | stop | restart | status | ensure
#
# Settings: backend/.env.server (copy .env.server.example). The backend folder
# is ../backend next to this script, or APP_DIR when set (the Server Manager
# sets it from its config.ini). App settings stay in backend/.env as before.
#
# restart  installs requirements first (only when they changed) while the
#          old server keeps serving, then swaps.
# ensure   starts the backend if it is down, or restarts it after 30 seconds
#          of not answering; meant for cron:
#   @reboot     /full/path/linux_manage/backend.sh start
#   */5 * * * * /full/path/linux_manage/backend.sh ensure
set -euo pipefail

SERVICE=backend
APP_DIR="${APP_DIR:-$(dirname "$(readlink -f "$0")")/../backend}"
# shellcheck source-path=SCRIPTDIR source=service.sh
source "$(dirname "$(readlink -f "$0")")/service.sh"
load_settings

PORT="${PORT:-${CONFIG_PORT:-8501}}"
APP="${APP:-${CONFIG_APP:-Backend:app}}"
PYTHON_BIN="${PYTHON_BIN:-$APP_DIR/venv/bin/python}"
START_TIMEOUT="${START_TIMEOUT:-120}"
HEALTH_PATH=/health
SERVER_PATTERN=uvicorn
[[ "$APP" =~ ^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$ ]] || die "APP must look like module:app, got '$APP'"
# The supervisor runs under the backend's own python unless told otherwise.
SUPERVISOR_PYTHON="${SUPERVISOR_PYTHON:-$PYTHON_BIN}"

prepare() {
  if [[ ! -x "$PYTHON_BIN" ]]; then
    [[ "$PYTHON_BIN" == "$APP_DIR/venv/bin/python" ]] || die "PYTHON_BIN not found: $PYTHON_BIN"
    echo "Creating virtual environment..."
    "${PYTHON_SYSTEM:-python3}" -m venv "$APP_DIR/venv"
  fi
  [[ -f requirements.txt ]] || return 0
  local stamp_file="$APP_DIR/venv/.requirements.sha256" sum
  sum="$(sha256sum requirements.txt | cut -d' ' -f1)"
  if [[ "$(cat "$stamp_file" 2>/dev/null || true)" == "$sum" ]]; then
    echo "Requirements unchanged"
    return 0
  fi
  echo "Installing requirements..."
  "$PYTHON_BIN" -m pip install -q --disable-pip-version-check -r requirements.txt
  echo "$sum" >"$stamp_file"
}

server_command() {
  SERVER_CMD=("$PYTHON_BIN" -m uvicorn "$APP" --host "$HOST" --port "$PORT"
    --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}"
    --timeout-graceful-shutdown "$GRACEFUL_TIMEOUT" --no-server-header)
  [[ "${ACCESS_LOG:-1}" == "0" ]] && SERVER_CMD+=(--no-access-log)
  if [[ "$SCHEME" == https ]]; then
    SERVER_CMD+=(--ssl-certfile "$TLS_CERT" --ssl-keyfile "$TLS_KEY")
  fi
}

run_service "$@"
