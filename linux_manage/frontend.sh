#!/bin/bash
# usage: frontend.sh {start|stop|restart} <dir>
set -euo pipefail

ACTION="$1"
FRONT_DIR="$2"
PORT="$3"
NODE="/usr/bin/node"

[ -z "$ACTION" ] || [ -z "$FRONT_DIR" ] || [ -z "$PORT" ] && {
  echo "usage: $0 {start|stop|restart} <dir> <port>"
  exit 1
}
[ -d "$FRONT_DIR" ] || { echo "Directory not found: $FRONT_DIR"; exit 1; }

PIDFILE="$FRONT_DIR/frontend.pid"
LOGFILE="$FRONT_DIR/frontend.log"

cd "$FRONT_DIR"

stop_it() {
  if [ -f "$PIDFILE" ] && ps -p "$(cat "$PIDFILE")" > /dev/null 2>&1; then
    PID=$(cat "$PIDFILE")
    echo "Stopping frontend (PID $PID)..."
    kill "$PID"
    for i in $(seq 1 10); do
      ps -p "$PID" > /dev/null 2>&1 || break
      sleep 1
    done
    ps -p "$PID" > /dev/null 2>&1 && kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

start_it() {
  if [ -f "$PIDFILE" ] && ps -p "$(cat "$PIDFILE")" > /dev/null 2>&1; then
    echo "Frontend already running (PID $(cat "$PIDFILE"))"
    exit 0
  fi

  # Build if missing
  [ -d dist ] || npm run build

  # Ensure local serve is present
  [ -f node_modules/serve/build/main.js ] || npm i -D serve@14

  # Start serve with HTTPS
  nohup "$NODE" node_modules/serve/build/main.js -s dist -l tcp://0.0.0.0:"$PORT" \
    --ssl-cert /home/sa-prd-rdi-react-dev/SSL2026/awsbjvnval002j_jnj_com_cert.pem \
    --ssl-key /home/sa-prd-rdi-react-dev/SSL2026/awsbjvnval002j_jnj_com_key.pem \
    --no-clipboard > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"

  sleep 1
  if ps -p "$(cat "$PIDFILE")" > /dev/null 2>&1; then
    echo "Frontend started on :$PORT with HTTPS (PID $(cat "$PIDFILE"))"
  else
    echo "FAILED to start, check $LOGFILE"
    tail -20 "$LOGFILE"
    rm -f "$PIDFILE"
    exit 1
  fi
}

case "$ACTION" in
  start)   start_it ;;
  stop)    stop_it ;;
  restart) stop_it; rm -rf dist; start_it ;;
  *) echo "unknown action: $ACTION"; exit 1 ;;
esac