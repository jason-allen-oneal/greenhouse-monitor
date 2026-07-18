# GREENHOUSE_WIFI Monitor

GREENHOUSE_WIFI ESP32/BME680 sensor stack, receiver, local dashboard, and local weather nowcasting.

This repository is intended to be safe to publish: real credentials, logs, raw history, and generated runtime state are ignored.

## Components

- `esp32/` - MicroPython firmware and helper tools for the BME680 sensor node.
- `receiver/` - Python HTTP receiver, JSONL logging, 15-minute snapshots, and monitor helper.
- `dashboard/` - Node.js browser dashboard with local nowcast, Open-Meteo, and NWS supplement.
- `scripts/` - startup/flashing helper scripts.
- `docs/` - architecture, deployment, payloads, and troubleshooting.

## Safety

The nowcast is experimental local sensor-based guidance, not an official weather forecast. NWS alerts and official severe-weather guidance take precedence. Do not use it for life-safety decisions.

## Quick start

```sh
cd dashboard
cp greenhouse-weather.example.json greenhouse-weather.json
node server.js
```

Then open `http://127.0.0.1:5179/`.

For ESP32 Wi-Fi credentials, copy `esp32/secrets.example.py` to `secrets.py` on the ESP32 and fill it there. Do not commit real credentials.
