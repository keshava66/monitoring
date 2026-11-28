#!/usr/bin/env bash
# Start, stop and watch the monitoring frontend (serve, kept running by supervise.py).
#
#   frontend.sh start | stop | restart | status | ensure
#
# Settings: frontend/.env.server (copy .env.server.example). The frontend
# folder is ../frontend next to this script, or APP_DIR when set (the Server
# Manager sets it from its config.ini). Build settings stay in frontend/.env.
#
# start    builds first only when there is no build yet.
# restart  installs packages (only when package-lock.json changed) and builds
#          into dist.next while the old site keeps serving, swaps the new
#          build in, then restarts the server: seconds of downtime, and a
#          failed build leaves the running site untouched.
# ensure   starts the frontend if it is down, or restarts it after 30 seconds
#          of not answering; meant for cron:
#   @reboot     /full/path/linux_manage/frontend.sh start
#   */5 * * * * /full/path/linux_manage/frontend.sh ensure
set -euo pipefail

SERVICE=frontend
APP_DIR="${APP_DIR:-$(dirname "$(readlink -f "$0")")/../frontend}"
# shellcheck source-path=SCRIPTDIR source=service.sh
source "$(dirname "$(readlink -f "$0")")/service.sh"
load_settings

PORT="${PORT:-${CONFIG_PORT:-8502}}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
START_TIMEOUT="${START_TIMEOUT:-30}"
HEALTH_PATH=/
SERVER_PATTERN=serve
SERVE="$APP_DIR/node_modules/serve/build/main.js"
ACTION="${1:-}"

install_packages() {
  local stamp_file="$APP_DIR/node_modules/.package-lock.sha256" sum
  sum="$(sha256sum package-lock.json | cut -d' ' -f1)"
  if [[ -f "$SERVE" && "$(cat "$stamp_file" 2>/dev/null || true)" == "$sum" ]]; then
    echo "Packages unchanged"
    return 0
  fi
  echo "Installing packages..."
  "$NPM_BIN" ci --no-audit --no-fund
  echo "$sum" >"$stamp_file"
}

prepare() {
  [[ -x "$NODE_BIN" ]] || die "node not found; set NODE_BIN in $APP_DIR/.env.server"
  [[ -x "$NPM_BIN" ]] || die "npm not found; set NPM_BIN in $APP_DIR/.env.server"
  [[ -f package-lock.json ]] || die "package-lock.json missing in $APP_DIR"
  install_packages
  # A plain start reuses the existing build; restart always rebuilds.
  if [[ "$ACTION" != restart && -f dist/index.html ]]; then
    return 0
  fi
  echo "Building..."
  rm -rf dist.next
  "$NPM_BIN" run build -- --outDir dist.next --emptyOutDir
  [[ -f dist.next/index.html ]] || die "build produced no dist.next/index.html"
  rm -rf dist.prev
  [[ -d dist ]] && mv dist dist.prev
  mv dist.next dist
  rm -rf dist.prev
  echo "New build in place"
}

server_command() {
  [[ -f dist/index.html ]] || die "no build in $APP_DIR/dist; run: $0 restart"
  local listen_host="$HOST"
  [[ "$listen_host" == *:* ]] && listen_host="[$listen_host]"
  SERVER_CMD=("$NODE_BIN" "$SERVE" -s "$APP_DIR/dist" -l "tcp://$listen_host:$PORT" --no-clipboard --no-port-switching)
  if [[ "$SCHEME" == https ]]; then
    SERVER_CMD+=(--ssl-cert "$TLS_CERT" --ssl-key "$TLS_KEY")
  fi
}

run_service "$@"
