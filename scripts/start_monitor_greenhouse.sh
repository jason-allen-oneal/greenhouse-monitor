#!/bin/sh
set -eu
APP_DIR=/opt/greenhouse-monitor
cd "$APP_DIR"
if ! pgrep -f "python3 monitor_greenhouse.py" >/dev/null 2>&1; then
  setsid python3 monitor_greenhouse.py > "$APP_DIR/greenhouse-monitor.log" 2>&1 < /dev/null &
  echo $! > "$APP_DIR/greenhouse-monitor.pid"
fi
