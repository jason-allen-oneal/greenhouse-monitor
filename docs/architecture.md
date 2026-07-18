# Architecture

```text
ESP32/BME680 sensor node
  -> GREENHOUSE_EDGE receiver on :8080 when joined to GREENHOUSE_WIFI AP
  -> fallback direct to SENSOR_RECEIVER receiver on :8081 when joined to house Wi-Fi

SENSOR_RECEIVER receiver
  -> stores raw JSONL readings
  -> stores 15-minute immutable snapshots

local dashboard server
  -> proxies latest/snapshots from SENSOR_RECEIVER
  -> renders browser dashboard
  -> computes local nowcast features from snapshots
  -> supplements local trends with Open-Meteo and NWS API data
```

Raw readings and generated predictions should stay separate. Do not overwrite raw sensor logs.
