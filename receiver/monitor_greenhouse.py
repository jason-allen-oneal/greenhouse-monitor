#!/usr/bin/env python3
"""GREENHOUSE_WIFI freshness watchdog.

Runs on GREENHOUSE_EDGE. Logs status every minute and prints alerts when the ESP32
stops posting or SENSOR_RECEIVER stops receiving forwarded data.
"""
import json
import time
import urllib.request
from datetime import datetime

EDGE_RECEIVER_URL = "http://127.0.0.1:8080/latest.json"
CENTRAL_RECEIVER_URL = "http://RECEIVER_IP:8081/latest.json"
STALE_THRESHOLD_S = 600
CHECK_INTERVAL_S = 60
ALERT_COOLDOWN_S = 300


def fetch_latest(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return json.loads(response.read().decode())
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def check_freshness(data, name):
    if not data.get("ok") or not data.get("reading"):
        return False, f"{name}: no data ({data.get('error', 'empty')})"
    received_unix = data["reading"].get("received_unix")
    if received_unix is None:
        return False, f"{name}: no timestamp"
    age = max(0, time.time() - float(received_unix))
    if age > STALE_THRESHOLD_S:
        return False, f"{name}: STALE ({int(age)}s ago)"
    return True, f"{name}: OK ({int(age)}s ago)"


def main():
    print(f"greenhouse monitor started; stale threshold={STALE_THRESHOLD_S}s", flush=True)
    last_alert = 0
    while True:
        try:
            GREENHOUSE_EDGE = fetch_latest(EDGE_RECEIVER_URL)
            SENSOR_RECEIVER = fetch_latest(CENTRAL_RECEIVER_URL)
            GREENHOUSE_EDGE_ok, GREENHOUSE_EDGE_msg = check_freshness(GREENHOUSE_EDGE, "GREENHOUSE_EDGE")
            SENSOR_RECEIVER_ok, SENSOR_RECEIVER_msg = check_freshness(SENSOR_RECEIVER, "SENSOR_RECEIVER")
            stamp = datetime.now().isoformat(timespec="seconds")
            print(f"[{stamp}] {GREENHOUSE_EDGE_msg} | {SENSOR_RECEIVER_msg}", flush=True)

            now = time.time()
            if now - last_alert >= ALERT_COOLDOWN_S:
                if not GREENHOUSE_EDGE_ok and not SENSOR_RECEIVER_ok:
                    print("ALERT: ESP32 appears offline: no fresh data on GREENHOUSE_EDGE or SENSOR_RECEIVER", flush=True)
                    last_alert = now
                elif GREENHOUSE_EDGE_ok and not SENSOR_RECEIVER_ok:
                    print("ALERT: GREENHOUSE_EDGE has fresh data but SENSOR_RECEIVER does not: forwarding is broken", flush=True)
                    last_alert = now
        except Exception as exc:
            print(f"monitor loop error: {exc}", flush=True)
        time.sleep(CHECK_INTERVAL_S)


if __name__ == "__main__":
    main()
