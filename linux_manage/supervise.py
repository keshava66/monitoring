#!/usr/bin/env python3
"""Keep one server process running: restart it if it dies, stop it cleanly.

Started by backend.sh / frontend.sh, never by hand:

    supervise.py --name backend --pid-file run/backend.pid --log-file logs/backend.log \\
                 -- /path/venv/bin/python -m uvicorn Backend:app --port 8501

What plain `nohup` lacks, with the standard library only:

  * restarts the server within seconds when it exits unexpectedly, backing
    off, and gives up after repeated crashes instead of looping forever
  * on SIGTERM/SIGINT forwards one SIGTERM so the server shuts down
    gracefully, and kills it if it is still there 15 s after GRACEFUL_TIMEOUT
  * takes the server down with it if the supervisor itself is killed
    (Linux), so an orphan never keeps holding the port
  * timestamps every output line and rotates the log by size

Env: GRACEFUL_TIMEOUT (30 s), RESTART_DELAY (2 s), LOG_MAX_MB (50), LOG_KEEP (5)
"""
from __future__ import annotations

import argparse
import collections
import ctypes
import logging
import logging.handlers
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

MAX_RESTART_DELAY = 30
STABLE_AFTER_SECONDS = 60
CRASH_WINDOW_SECONDS = 300
MAX_CRASHES_IN_WINDOW = 5
PR_SET_PDEATHSIG = 1
# Loaded before any fork: the child must not import or load libraries
# between fork and exec while other threads may hold the import lock.
_LIBC = ctypes.CDLL(None, use_errno=True) if sys.platform.startswith("linux") else None


class ConfigError(Exception):
    pass


def _integer(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = None
    if value is None or not low <= value <= high:
        raise ConfigError(f"{name} must be a whole number from {low} to {high}, got {raw!r}")
    return value


def read_config(argv=None) -> dict:
    parser = argparse.ArgumentParser(description="Keep one server process running.")
    parser.add_argument("--name", required=True)
    parser.add_argument("--pid-file", required=True, type=Path)
    parser.add_argument("--log-file", required=True, type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise ConfigError("no command to supervise; pass it after --")
    return {
        "name": args.name,
        "command": command,
        "pid_file": args.pid_file.resolve(),
        "log_file": args.log_file.resolve(),
        "graceful_timeout": _integer("GRACEFUL_TIMEOUT", 30, 1, 3600),
        "restart_delay": _integer("RESTART_DELAY", 2, 0, 300),
        "log_max_bytes": _integer("LOG_MAX_MB", 50, 1, 10240) * 1024 * 1024,
        "log_keep": _integer("LOG_KEEP", 5, 1, 100),
    }


def _stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _die_with_parent() -> None:
    # Runs in the child just before exec: if the supervisor dies, the kernel
    # sends the server SIGTERM, so it never lingers holding the port.
    _LIBC.prctl(PR_SET_PDEATHSIG, signal.SIGTERM)


class Supervisor:
    def __init__(self, config: dict):
        self.config = config
        self.name = config["name"]
        self.stopping = threading.Event()
        self.child = None
        self.signalled_child = None
        self.child_pid_file = config["pid_file"].with_suffix(".child.pid")
        config["log_file"].parent.mkdir(parents=True, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            config["log_file"], maxBytes=config["log_max_bytes"], backupCount=config["log_keep"], encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        self.log = logging.getLogger(f"supervisor.{self.name}")
        self.log.handlers[:] = [handler]
        self.log.setLevel(logging.INFO)
        self.log.propagate = False

    def note(self, message: str) -> None:
        self.log.info(f"{_stamp()} [supervisor] {message}")

    def pump(self, stream) -> None:
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                self.log.info(f"{_stamp()} {line}")
        stream.close()

    def spawn(self) -> subprocess.Popen:
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        child = subprocess.Popen(
            self.config["command"], env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            # Own session: a Ctrl+C in a terminal reaches only the supervisor,
            # which forwards a single SIGTERM (a second one makes uvicorn skip
            # its graceful shutdown).
            start_new_session=True,
            preexec_fn=_die_with_parent if _LIBC else None,
        )
        self.child_pid_file.write_text(f"{child.pid}\n")
        return child

    def request_stop(self, signum, _frame) -> None:
        if self.stopping.is_set():
            return
        self.stopping.set()
        self.note(f"{signal.Signals(signum).name} received, stopping {self.name} gracefully")
        if self.child:
            self.stop_child(self.child)

    def stop_child(self, child: subprocess.Popen) -> None:
        # Once only: a second SIGTERM makes uvicorn skip its graceful shutdown.
        if child is self.signalled_child or child.poll() is not None:
            return
        self.signalled_child = child
        child.send_signal(signal.SIGTERM)
        # The server's own graceful window, plus time for shutdown hooks.
        timer = threading.Timer(self.config["graceful_timeout"] + 15, self._force_kill, args=(child,))
        timer.daemon = True
        timer.start()

    def _force_kill(self, child: subprocess.Popen) -> None:
        if child.poll() is None:
            self.note(f"{self.name} pid {child.pid} did not stop in time, killing it")
            child.kill()

    def remove_pids(self) -> None:
        pid_file = self.config["pid_file"]
        try:
            if pid_file.read_text().strip() == str(os.getpid()):
                pid_file.unlink()
        except FileNotFoundError:
            pass
        self.child_pid_file.unlink(missing_ok=True)

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)
        self.config["pid_file"].parent.mkdir(parents=True, exist_ok=True)
        self.config["pid_file"].write_text(f"{os.getpid()}\n")
        self.note(f"supervisor pid {os.getpid()} starting {self.name}: {' '.join(self.config['command'])}")

        crashes: collections.deque = collections.deque()
        delay = self.config["restart_delay"]
        exit_code = 0
        try:
            while not self.stopping.is_set():
                started = time.monotonic()
                try:
                    self.child = self.spawn()
                except OSError as exc:
                    self.note(f"cannot start {self.name}: {exc}")
                    exit_code = 1
                    break
                if self.stopping.is_set():
                    # A stop arrived while the server was being spawned.
                    self.stop_child(self.child)
                self.note(f"{self.name} started, pid {self.child.pid}")
                reader = threading.Thread(target=self.pump, args=(self.child.stdout,), daemon=True)
                reader.start()
                code = self.child.wait()
                reader.join(timeout=5)
                self.child_pid_file.unlink(missing_ok=True)

                if self.stopping.is_set():
                    self.note(f"{self.name} stopped (exit code {code})")
                    break

                now = time.monotonic()
                ran = now - started
                if ran >= STABLE_AFTER_SECONDS:
                    crashes.clear()
                    delay = self.config["restart_delay"]
                crashes.append(now)
                while crashes and now - crashes[0] > CRASH_WINDOW_SECONDS:
                    crashes.popleft()
                if len(crashes) > MAX_CRASHES_IN_WINDOW:
                    self.note(f"{self.name} exited {len(crashes)} times within {CRASH_WINDOW_SECONDS // 60} minutes, "
                              f"giving up. Fix the error above, then start it again")
                    exit_code = 1
                    break

                self.note(f"{self.name} exited unexpectedly (exit code {code}) after {ran:.0f}s, restarting in {delay}s")
                self.stopping.wait(delay)
                delay = min(max(delay, 1) * 2, MAX_RESTART_DELAY)
        finally:
            self.remove_pids()
            self.note("supervisor stopped")
            for handler in self.log.handlers:
                handler.flush()
        return exit_code


def main(argv=None) -> int:
    try:
        config = read_config(argv)
    except ConfigError as error:
        print(f"Cannot start: {error}", file=sys.stderr)
        return 2
    return Supervisor(config).run()


if __name__ == "__main__":
    sys.exit(main())
