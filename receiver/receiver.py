#!/usr/bin/env python3
import argparse
import json
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


LATEST = None
SNAPSHOTS = {
    "enabled": False,
    "interval_seconds": 1800,
    "path": None,
    "last_bucket": None,
    "last_snapshot": None,
}
UPSTREAM = {
    "url": None,
    "timeout": 3,
    "last_ok": None,
    "last_at": None,
    "last_error": None,
}


DASHBOARD_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GREENHOUSE_WIFI</title>
<style>
:root {
  color-scheme: dark;
  --bg: #101816;
  --panel: #182521;
  --panel-2: #20332d;
  --text: #eef7f2;
  --muted: #9bb2a9;
  --ok: #66e08a;
  --warn: #f3c969;
  --bad: #ff7b72;
  --accent: #80d8ff;
}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main {
  width: 100vw;
  height: 100vh;
  padding: 10px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 8px;
}
header, footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 750;
  letter-spacing: 0;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 99px;
  background: var(--warn);
}
.dot.ok { background: var(--ok); }
.dot.bad { background: var(--bad); }
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  min-height: 0;
}
.tile {
  background: var(--panel);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 8px;
  display: grid;
  grid-template-rows: auto 1fr;
  min-width: 0;
  min-height: 0;
}
.label {
  color: var(--muted);
  font-size: 12px;
  line-height: 1;
}
.value {
  align-self: end;
  font-size: 28px;
  font-weight: 760;
  line-height: 1;
  white-space: nowrap;
}
.unit {
  color: var(--muted);
  font-size: 15px;
  font-weight: 600;
}
.wide { grid-column: span 2; background: var(--panel-2); }
.wide .value { font-size: 22px; }
footer {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.2;
}
.small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 420px), (max-height: 280px) {
  main { padding: 7px; gap: 6px; }
  h1 { font-size: 17px; }
  .grid { gap: 6px; }
  .tile { padding: 7px; border-radius: 6px; }
  .label { font-size: 11px; }
  .value { font-size: 23px; }
  .wide .value { font-size: 18px; }
  footer, .status { font-size: 10px; }
}
</style>
</head>
<body>
<main>
  <header>
    <h1>GREENHOUSE_WIFI</h1>
    <div class="status"><span id="dot" class="dot"></span><span id="status">waiting</span></div>
  </header>
  <section class="grid" aria-label="Current readings">
    <div class="tile"><div class="label">Temperature</div><div class="value"><span id="temp">--</span> <span class="unit">F</span></div></div>
    <div class="tile"><div class="label">Humidity</div><div class="value"><span id="humidity">--</span> <span class="unit">%</span></div></div>
    <div class="tile"><div class="label">Pressure</div><div class="value"><span id="pressure">--</span> <span class="unit">hPa</span></div></div>
    <div class="tile"><div class="label">Gas</div><div class="value"><span id="gas">--</span> <span class="unit">ohm</span></div></div>
    <div class="tile wide"><div class="label">Upstream</div><div class="value small" id="upstream">--</div></div>
  </section>
  <footer>
    <span class="small" id="node">node --</span>
    <span id="updated">no readings yet</span>
  </footer>
</main>
<script>
function fmt(value, digits) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toFixed(digits);
}
function ageText(iso) {
  if (!iso) return "no readings yet";
  const age = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (age < 90) return age + "s ago";
  return Math.round(age / 60) + "m ago";
}
function setStatus(kind, text) {
  const dot = document.getElementById("dot");
  dot.className = "dot " + kind;
  document.getElementById("status").textContent = text;
}
async function refresh() {
  try {
    const res = await fetch("/latest.json", {cache: "no-store"});
    const data = await res.json();
    const record = data.reading;
    if (!record) {
      setStatus("", "waiting");
      return;
    }
    const payload = record.payload || {};
    const reading = payload.reading || {};
    document.getElementById("temp").textContent = fmt(reading.temperature_f, 1);
    document.getElementById("humidity").textContent = fmt(reading.humidity_percent, 1);
    document.getElementById("pressure").textContent = fmt(reading.pressure_hpa, 1);
    document.getElementById("gas").textContent = reading.gas_ohms == null ? "--" : Math.round(Number(reading.gas_ohms)).toString();
    document.getElementById("node").textContent = (payload.node_id || "node --") + " " + (payload.ip || "");
    document.getElementById("updated").dataset.iso = record.received_at || "";
    document.getElementById("updated").textContent = ageText(record.received_at);
    const upstream = data.upstream || {};
    document.getElementById("upstream").textContent = upstream.url ? (upstream.last_ok ? "SENSOR_RECEIVER ok" : (upstream.last_error || "pending")) : "local only";
    const age = Math.max(0, Math.round((Date.now() - Date.parse(record.received_at)) / 1000));
    setStatus(age < 120 ? "ok" : "bad", age < 120 ? "live" : "stale");
  } catch (err) {
    setStatus("bad", "offline");
  }
}
refresh();
setInterval(refresh, 5000);
setInterval(() => {
  const current = document.getElementById("updated").dataset.iso;
  if (current) document.getElementById("updated").textContent = ageText(current);
}, 1000);
</script>
</body>
</html>
"""


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def c_to_f(value):
    return (float(value) * 9 / 5) + 32


def add_derived_readings(payload):
    if not isinstance(payload, dict):
        return payload

    reading = payload.get("reading")
    if not isinstance(reading, dict):
        return payload

    if reading.get("temperature_f") is None and reading.get("temperature_c") is not None:
        try:
            reading["temperature_f"] = round(c_to_f(reading["temperature_c"]), 3)
        except (TypeError, ValueError):
            pass
    return payload


def load_latest_snapshot():
    path = SNAPSHOTS.get("path")
    if not path:
        return

    try:
        with Path(path).open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            if size == 0:
                return
            offset = min(size, 8192)
            handle.seek(-offset, 2)
            lines = handle.read().decode(errors="replace").splitlines()
    except FileNotFoundError:
        return
    except OSError as exc:
        print(f"{utc_now()} snapshot load failed: {exc}", flush=True)
        return

    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            snapshot = json.loads(line)
        except json.JSONDecodeError:
            continue
        SNAPSHOTS["last_snapshot"] = snapshot
        SNAPSHOTS["last_bucket"] = snapshot.get("bucket_start_unix")
        return


def load_latest_record(path):
    try:
        with Path(path).open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            if size == 0:
                return None
            offset = min(size, 8192)
            handle.seek(-offset, 2)
            lines = handle.read().decode(errors="replace").splitlines()
    except FileNotFoundError:
        return None
    except OSError as exc:
        print(f"{utc_now()} latest reading load failed: {exc}", flush=True)
        return None

    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def maybe_write_snapshot(record):
    if not SNAPSHOTS.get("enabled"):
        return

    interval = int(SNAPSHOTS.get("interval_seconds") or 1800)
    received_unix = float(record.get("received_unix") or time.time())
    bucket_start = int(received_unix // interval) * interval
    if SNAPSHOTS.get("last_bucket") == bucket_start:
        return

    snapshot = {
        "snapshot_at": utc_now(),
        "bucket_start_unix": bucket_start,
        "bucket_end_unix": bucket_start + interval,
        "interval_seconds": interval,
        "record": record,
    }

    path = Path(SNAPSHOTS["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
    SNAPSHOTS["last_bucket"] = bucket_start
    SNAPSHOTS["last_snapshot"] = snapshot


def write_scheduled_snapshot(record, scheduled_unix):
    if not SNAPSHOTS.get("enabled") or record is None:
        return

    interval = int(SNAPSHOTS.get("interval_seconds") or 1800)
    bucket_start = int(scheduled_unix // interval) * interval
    if SNAPSHOTS.get("last_bucket") == bucket_start:
        return

    snapshot = {
        "snapshot_at": datetime.fromtimestamp(scheduled_unix, timezone.utc).isoformat(timespec="seconds"),
        "bucket_start_unix": bucket_start,
        "bucket_end_unix": bucket_start + interval,
        "interval_seconds": interval,
        "record": record,
    }

    path = Path(SNAPSHOTS["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
    SNAPSHOTS["last_bucket"] = bucket_start
    SNAPSHOTS["last_snapshot"] = snapshot


def next_snapshot_unix(now=None):
    interval = int(SNAPSHOTS.get("interval_seconds") or 1800)
    current = time.time() if now is None else float(now)
    return (int(current // interval) + 1) * interval


def snapshot_schedule():
    next_unix = next_snapshot_unix()
    return {
        "interval_seconds": int(SNAPSHOTS.get("interval_seconds") or 1800),
        "next_snapshot_at": datetime.fromtimestamp(next_unix, timezone.utc).isoformat(timespec="seconds"),
        "next_snapshot_unix": next_unix,
        "aligned_minutes": [0, 30] if int(SNAPSHOTS.get("interval_seconds") or 1800) == 1800 else None,
    }


def snapshot_scheduler():
    global LATEST

    while True:
        scheduled_unix = next_snapshot_unix()
        delay = max(0.5, scheduled_unix - time.time())
        time.sleep(delay)
        try:
            write_scheduled_snapshot(LATEST, scheduled_unix)
        except Exception as exc:
            print(f"{utc_now()} scheduled snapshot failed: {exc}", flush=True)


def read_snapshots(limit=96):
    path = SNAPSHOTS.get("path")
    if not path:
        return []

    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []

    snapshots = []
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            snapshots.append(json.loads(line))
        except json.JSONDecodeError:
            continue
        if len(snapshots) >= limit:
            break
    snapshots.reverse()
    return snapshots


class GREENHOUSE_WIFIHandler(BaseHTTPRequestHandler):
    log_path = Path("readings.jsonl")

    def _send_html(self, status, body):
        encoded = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/dashboard"):
            self._send_html(200, DASHBOARD_HTML)
            return
        if self.path == "/health":
            self._send_json(200, {"ok": True, "time": utc_now(), "upstream": UPSTREAM})
            return
        if path in ("/latest", "/latest.json"):
            self._send_json(200, {"ok": True, "reading": LATEST, "upstream": UPSTREAM})
            return
        if path in ("/snapshots", "/snapshots.json"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "interval_seconds": SNAPSHOTS["interval_seconds"],
                    "schedule": snapshot_schedule(),
                    "latest": SNAPSHOTS["last_snapshot"],
                    "snapshots": read_snapshots(),
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        global LATEST

        path = urlparse(self.path).path
        if path != "/api/readings":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "bad content length"})
            return

        if size < 2 or size > 8192:
            self._send_json(413, {"ok": False, "error": "invalid payload size"})
            return

        try:
            payload = json.loads(self.rfile.read(size).decode())
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": f"invalid json: {exc}"})
            return
        payload = add_derived_readings(payload)

        record = {
            "received_at": utc_now(),
            "received_unix": time.time(),
            "remote": self.client_address[0],
            "payload": payload,
        }
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
        LATEST = record
        forward_upstream(record)
        self._send_json(200, {"ok": True, "received_at": record["received_at"]})

    def log_message(self, fmt, *args):
        print(f"{utc_now()} {self.client_address[0]} {fmt % args}", flush=True)


def forward_upstream(record):
    url = UPSTREAM.get("url")
    if not url:
        return

    UPSTREAM["last_at"] = utc_now()
    try:
        payload = record.get("payload")
        if isinstance(payload, dict):
            forwarded = dict(payload)
        else:
            forwarded = {"payload": payload}
        forwarded["_GREENHOUSE_EDGE"] = {
            "received_at": record.get("received_at"),
            "received_unix": record.get("received_unix"),
            "remote": record.get("remote"),
        }
        body = json.dumps(forwarded, separators=(",", ":")).encode()
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=UPSTREAM["timeout"]) as response:
            response.read(128)
            UPSTREAM["last_ok"] = 200 <= response.status < 300
            UPSTREAM["last_error"] = None if UPSTREAM["last_ok"] else f"HTTP {response.status}"
    except Exception as exc:
        UPSTREAM["last_ok"] = False
        UPSTREAM["last_error"] = str(exc)
        print(f"{utc_now()} upstream forward failed: {exc}", flush=True)


def main():
    global LATEST

    parser = argparse.ArgumentParser(description="Receive ESP32 greenhouse readings.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--log", default="/opt/greenhouse-monitor/readings.jsonl")
    parser.add_argument("--forward-url", default=None)
    parser.add_argument("--forward-timeout", type=float, default=3)
    parser.add_argument("--snapshot-log", default=None)
    parser.add_argument("--snapshot-interval", type=int, default=1800)
    args = parser.parse_args()

    GREENHOUSE_WIFIHandler.log_path = Path(args.log)
    LATEST = load_latest_record(GREENHOUSE_WIFIHandler.log_path)
    UPSTREAM["url"] = args.forward_url
    UPSTREAM["timeout"] = args.forward_timeout
    if args.snapshot_log:
        SNAPSHOTS["enabled"] = True
        SNAPSHOTS["path"] = args.snapshot_log
        SNAPSHOTS["interval_seconds"] = args.snapshot_interval
        load_latest_snapshot()
        threading.Thread(target=snapshot_scheduler, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), GREENHOUSE_WIFIHandler)
    print(f"Listening on http://{args.host}:{args.port}", flush=True)
    print(f"Logging readings to {GREENHOUSE_WIFIHandler.log_path}", flush=True)
    if args.forward_url:
        print(f"Forwarding readings to {args.forward_url}", flush=True)
    if args.snapshot_log:
        print(
            f"Writing {args.snapshot_interval}s snapshots to {args.snapshot_log}",
            flush=True,
        )
    server.serve_forever()


if __name__ == "__main__":
    main()
