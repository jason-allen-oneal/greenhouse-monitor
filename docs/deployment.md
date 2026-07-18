# Deployment

## SENSOR_RECEIVER receiver

```sh
python3 receiver/receiver.py \
  --host 0.0.0.0 --port 8081 \
  --log /opt/greenhouse-monitor/GREENHOUSE_EDGE-readings.jsonl \
  --snapshot-log /opt/greenhouse-monitor/GREENHOUSE_EDGE-15m-snapshots.jsonl \
  --snapshot-interval 900
```

## local dashboard

```sh
cd dashboard
cp greenhouse-weather.example.json greenhouse-weather.json
node server.js
```

Environment overrides:

- `SENSOR_RECEIVER_URL`, default `http://SENSOR_RECEIVER.lan:8081`
- `GREENHOUSE_WEATHER_CONFIG`, default `dashboard/greenhouse-weather.json`
- `GREENHOUSE_LAT`, `GREENHOUSE_LON`
- `NWS_USER_AGENT`

## ESP32 firmware

Copy `esp32/secrets.example.py` to `secrets.py`, fill Wi-Fi credentials, upload both `secrets.py` and `sensor_node_main.py` to the ESP32.
