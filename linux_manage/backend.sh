#!/bin/bash
# usage: backend.sh {start|stop|restart} <dir>
set -euo pipefail

ACTION="$1"
BACK_DIR="$2"
PORT="$3"
ENTRY="$4"

[ -z "$ACTION" ] || [ -z "$BACK_DIR" ] || [ -z "$PORT" ] || [ -z "$ENTRY" ] && {
  echo "usage: $0 {start|stop|restart} <dir> <port> <entry, e.g. Backend:app>"
  exit 1
}
[ -d "$BACK_DIR" ] || { echo "Directory not found: $BACK_DIR"; exit 1; }

PY="$BACK_DIR/venv/bin/python"
PIDFILE="$BACK_DIR/backend.pid"
LOGFILE="$BACK_DIR/backend.log"

cd "$BACK_DIR"

stop_it() {
  if [ -f "$PIDFILE" ] && ps -p "$(cat "$PIDFILE")" > /dev/null 2>&1; then
    PID=$(cat "$PIDFILE")
    echo "Stopping backend (PID $PID)..."
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
    echo "Backend already running (PID $(cat "$PIDFILE"))"
    exit 0
  fi

  source venv/bin/activate
  pip install -r requirements.txt

  echo "Using entry: $ENTRY"

  nohup "$PY" -m uvicorn "$ENTRY" --host 0.0.0.0 --port "$PORT" \
    --ssl-keyfile /home/sa-prd-rdi-react-dev/SSL2026/awsbjvnval002j_jnj_com_key.pem \
    --ssl-certfile /home/sa-prd-rdi-react-dev/SSL2026/awsbjvnval002j_jnj_com_cert.pem \
    > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"

  sleep 1
  if ps -p "$(cat "$PIDFILE")" > /dev/null 2>&1; then
    echo "Backend started on :$PORT with HTTPS (PID $(cat "$PIDFILE"))"
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
  restart) stop_it; start_it ;;
  *) echo "unknown action: $ACTION"; exit 1 ;;
esac