# Sensor payloads

Example ESP32 payload:

```json
{
  "ip": "192.0.2.10",
  "node_id": "esp32-greenhouse-1",
  "free_mem": 124832,
  "wifi_ssid": "GREENHOUSE_WIFI",
  "seq": 112,
  "uptime_ms": 4053755,
  "reading": {
    "gas_ohms": 916779,
    "gas_valid": true,
    "humidity_percent": 78.244,
    "temperature_c": 24.23215,
    "pressure_hpa": 966.46,
    "temperature_f": 75.618
  }
}
```

Future fields may include rain sensor state/value, rain gauge ticks, lightning count/distance/energy, light level, wind speed, and wind direction.
