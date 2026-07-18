# Troubleshooting

## Dashboard says stale

Check receiver health and latest reading age:

```sh
curl http://127.0.0.1:5179/api/latest
curl http://127.0.0.1:5179/api/snapshots
```

## External weather unavailable

Check config and APIs:

```sh
curl http://127.0.0.1:5179/api/external-weather
```

## Wi-Fi credentials

Never commit ESP32 `secrets.py`. Use `esp32/secrets.example.py` as the template.
