#!/bin/sh
set -eu

APP_DIR=/opt/greenhouse-monitor
DASHBOARD_URL=http://127.0.0.1:8080/
FORWARD_URL=http://RECEIVER_IP:8081/api/readings

cd "$APP_DIR"

if ! pgrep -f "^python3 receiver.py --host 0.0.0.0 --port 8080" >/dev/null 2>&1; then
  setsid python3 receiver.py \
    --host 0.0.0.0 \
    --port 8080 \
    --log "$APP_DIR/readings.jsonl" \
    --forward-url "$FORWARD_URL" \
    > "$APP_DIR/receiver.log" 2>&1 < /dev/null &
fi

export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-/opt/greenhouse-monitor/.Xauthority}

xset s off >/dev/null 2>&1 || true
xset -dpms >/dev/null 2>&1 || true
xset s noblank >/dev/null 2>&1 || true
pkill xscreensaver >/dev/null 2>&1 || true

if ! pgrep -f "chromium.*$DASHBOARD_URL" >/dev/null 2>&1; then
  chromium \
    --kiosk \
    --app="$DASHBOARD_URL" \
    --password-store=basic \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --check-for-update-interval=31536000 \
    > "$APP_DIR/chromium.log" 2>&1 &
fi
