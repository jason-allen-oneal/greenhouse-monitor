#!/bin/sh
set -eu
PORT=${1:-/dev/ttyUSB0}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname "$SCRIPT_DIR")
FIRMWARE="$REPO_DIR/esp32/sensor_node_main.py"

if [ ! -e "$PORT" ]; then
  echo "Serial port not found: $PORT" >&2
  echo "Available ports:" >&2
  ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true
  exit 1
fi

mpremote connect "$PORT" fs cp "$FIRMWARE" :main.py
mpremote connect "$PORT" reset

echo "Flashed hardened greenhouse firmware to $PORT"
