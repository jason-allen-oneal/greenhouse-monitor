#!/bin/sh
set -eu

APP_DIR=/opt/greenhouse-monitor

cd "$APP_DIR"

if ! pgrep -f "^python3 receiver.py --host 0.0.0.0 --port 8081" >/dev/null 2>&1; then
  setsid python3 receiver.py \
    --host 0.0.0.0 \
    --port 8081 \
    --log "$APP_DIR/GREENHOUSE_EDGE-readings.jsonl" \
    --snapshot-log "$APP_DIR/GREENHOUSE_EDGE-15m-snapshots.jsonl" \
    --snapshot-interval 900 \
    > "$APP_DIR/receiver-8081.log" 2>&1 < /dev/null &
fi
